import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthServer } from "../auth/server.js";
import { ProductRequestError } from "../auth/organization-access.js";
import type { DatabaseRuntime, QueryRow } from "../db/runtime/index.js";
import { INTERNAL_CLIENT_ADDRESS_HEADER } from "../http/client-address.js";
import { decryptCredential, encryptCredential, providerCredentialKey } from "./crypto.js";

const subscriptionInput = z.object({
  family: z.enum(["codex", "claude"]),
  label: z.string().trim().min(1).max(100),
  credential: z.string().min(1).max(100_000),
});
const idInput = z.object({ id: z.string().uuid() });
const deviceInput = z.object({ deviceCode: z.string().min(32).max(100) });
const decisionInput = z.object({ userCode: z.string().min(1).max(40), decision: z.enum(["approve", "deny"]) });
const DEVICE_LIFETIME_MINUTES = 10;

interface SubscriptionRow extends QueryRow {
  id: string;
  organization_id: string;
  family: "codex" | "claude";
  label: string;
  encrypted_credential: string;
  created_at: Date;
}

interface TokenRow extends QueryRow {
  id: string;
  created_at: Date;
  revoked_at: Date | null;
}

interface DeviceRow extends QueryRow {
  id: string;
  status: "pending" | "approved" | "denied" | "disclosed";
  poll_interval_seconds: number;
  next_poll_at: Date;
  expires_at: Date;
  database_now: Date;
  organization_id: string | null;
  user_id: string | null;
}

/** Credentials are handed only to a Google-authenticated member or their scoped plugin token. */
export class ProviderSubscriptions {
  private readonly key: Buffer;

  constructor(
    private readonly database: DatabaseRuntime,
    private readonly auth: Pick<AuthServer, "resolveOrganizationAccess" | "rejectCookieMutation">,
    secret: string,
    private readonly publicBaseUrl?: string,
  ) {
    this.key = providerCredentialKey(secret);
  }

  async browser(request: Request): Promise<Response> {
    let access: Awaited<ReturnType<AuthServer["resolveOrganizationAccess"]>>;
    try {
      access = await this.auth.resolveOrganizationAccess(request);
    } catch (error) {
      if (error instanceof ProductRequestError) return error.response();
      throw error;
    }
    try {
      const url = new URL(request.url);
      if (url.searchParams.get("organizationSlug") !== access.organization.slug) {
        return json({ error: "organization_unavailable" }, 404);
      }
      if (request.method === "GET") {
        const [subscriptions, tokens] = await Promise.all([
          this.list(access.organization.id),
          this.database.query<TokenRow>(
            `select id, created_at, revoked_at from provider_plugin_tokens
             where organization_id = $1 and user_id = $2 order by created_at desc`,
            [access.organization.id, access.account.id],
          ),
        ]);
        return json({ subscriptions, tokens: tokens.rows.map(tokenView), canManage: access.capabilities.manageResources });
      }
      if (request.method !== "POST" && request.method !== "DELETE") return json({ error: "method_not_allowed" }, 405);
      const rejected = this.auth.rejectCookieMutation(request);
      if (rejected !== undefined) return rejected;
      const body = await boundedJson(request);
      if (url.pathname.endsWith("/token")) {
        if (request.method === "POST") {
          const token = `paseo_plugin_${randomBytes(32).toString("base64url")}`;
          const result = await this.database.query<TokenRow>(
            `insert into provider_plugin_tokens (id, organization_id, user_id, verifier)
             values ($1, $2, $3, $4) returning id, created_at, revoked_at`,
            [randomUUID(), access.organization.id, access.account.id, hash(token)],
          );
          return json({ token, summary: tokenView(result.rows[0]!) }, 201);
        }
        const { id } = idInput.parse(body);
        const result = await this.database.query(
          `update provider_plugin_tokens set revoked_at = coalesce(revoked_at, now())
           where id = $1 and organization_id = $2 and user_id = $3 returning id`,
          [id, access.organization.id, access.account.id],
        );
        return result.rowCount === 1 ? json({ revoked: true }) : json({ error: "not_found" }, 404);
      }
      if (!access.capabilities.manageResources) return json({ error: "forbidden" }, 403);
      if (request.method === "DELETE") {
        const { id } = idInput.parse(body);
        const result = await this.database.query(
          `delete from provider_subscriptions where id = $1 and organization_id = $2 returning id`,
          [id, access.organization.id],
        );
        return result.rowCount === 1 ? json({ deleted: true }) : json({ error: "not_found" }, 404);
      }
      const input = subscriptionInput.parse(body);
      const credential = validateCredential(input.family, input.credential);
      const id = randomUUID();
      const result = await this.database.query<SubscriptionRow>(
        `insert into provider_subscriptions
           (id, organization_id, family, label, encrypted_credential, created_by_user_id)
         values ($1, $2, $3, $4, $5, $6)
         returning id, organization_id, family, label, encrypted_credential, created_at`,
        [id, access.organization.id, input.family, input.label,
          encryptCredential(this.key, { organizationId: access.organization.id, id, family: input.family }, credential),
          access.account.id],
      );
      return json({ subscription: subscriptionView(result.rows[0]!) }, 201);
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof RangeError) {
        return json({ error: "invalid_request" }, 400);
      }
      throw error;
    }
  }

  async plugin(request: Request, id?: string): Promise<Response> {
    const bearer = /^Bearer (paseo_plugin_[A-Za-z0-9_-]{43})$/u.exec(request.headers.get("authorization") ?? "")?.[1];
    if (bearer === undefined) return json({ error: "unauthorized" }, 401);
    const authorized = await this.database.query<{ organization_id: string }>(
      `select token.organization_id from provider_plugin_tokens token
       join member on member.organization_id = token.organization_id and member.user_id = token.user_id
       where token.verifier = $1 and token.revoked_at is null
         and member.role in ('owner', 'admin', 'member')`,
      [hash(bearer)],
    );
    const organizationId = authorized.rows[0]?.organization_id;
    if (organizationId === undefined) return json({ error: "unauthorized" }, 401);
    if (id === undefined) return json({ subscriptions: await this.list(organizationId) });
    if (!z.string().uuid().safeParse(id).success) return json({ error: "not_found" }, 404);
    const result = await this.database.query<SubscriptionRow>(
      `select id, organization_id, family, label, encrypted_credential, created_at
       from provider_subscriptions where id = $1 and organization_id = $2`,
      [id, organizationId],
    );
    const row = result.rows[0];
    if (row === undefined) return json({ error: "not_found" }, 404);
    return json({ ...subscriptionView(row), credential: decryptCredential(this.key, {
      organizationId: row.organization_id, id: row.id, family: row.family,
    }, row.encrypted_credential) });
  }

  async deviceStart(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const deviceCode = randomBytes(32).toString("base64url");
    const userCode = randomBytes(8).toString("hex").toUpperCase().replace(/(.{4})(?=.)/gu, "$1-");
    const fingerprint = hash(request.headers.get(INTERNAL_CLIENT_ADDRESS_HEADER) ?? "unknown");
    const created = await this.database.transaction(async (tx) => {
      // ponytail: approximate capacity cap; use an advisory lock if concurrent abuse appears.
      const count = await tx.query<{ total: number; per_client: number }>(
        `select count(*)::integer as total,
                count(*) filter (where fingerprint_verifier = $1)::integer as per_client
         from provider_device_authorizations
         where status in ('pending', 'approved') and expires_at > now()`,
        [fingerprint],
      );
      if (count.rows[0]!.total >= 1000 || count.rows[0]!.per_client >= 5) return false;
      await tx.query(
        `insert into provider_device_authorizations
           (id, device_verifier, user_code_verifier, fingerprint_verifier, status, expires_at)
         values ($1, $2, $3, $4, 'pending', now() + interval '10 minutes')`,
        [randomUUID(), hash(deviceCode), hash(normalizeCode(userCode)), fingerprint],
      );
      return true;
    });
    if (!created) return json({ error: "retry_later", interval: 5 }, 429);
    const verificationUriComplete = new URL("/plugin-login", this.publicBaseUrl ?? request.url);
    verificationUriComplete.searchParams.set("code", userCode);
    return json({ deviceCode, userCode, verificationUriComplete: verificationUriComplete.toString(),
      interval: 5, expiresIn: DEVICE_LIFETIME_MINUTES * 60 }, 201);
  }

  async deviceDecide(request: Request): Promise<Response> {
    const rejected = this.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    let access: Awaited<ReturnType<AuthServer["resolveOrganizationAccess"]>>;
    try {
      access = await this.auth.resolveOrganizationAccess(request);
    } catch (error) {
      if (error instanceof ProductRequestError) return error.response();
      throw error;
    }
    let input: unknown;
    try { input = await boundedJson(request); }
    catch (error) {
      if (error instanceof SyntaxError || error instanceof RangeError) return json({ error: "invalid_request" }, 400);
      throw error;
    }
    const body = decisionInput.safeParse(input);
    if (!body.success) return json({ error: "invalid_request" }, 400);
    const outcome = await this.database.transaction(async (tx) => {
      const selected = await tx.query<DeviceRow>(
        `select *, now() as database_now from provider_device_authorizations
         where user_code_verifier = $1 for update`,
        [hash(normalizeCode(body.data.userCode))],
      );
      const row = selected.rows[0];
      if (row === undefined || row.status !== "pending" || row.expires_at <= row.database_now) return "unavailable";
      const authority = await tx.query(
        `select 1 from session join member on member.id = $3
           and member.user_id = session.user_id and member.organization_id = session.active_organization_id
         where session.id = $1 and session.user_id = $2
           and session.active_organization_id = $4 and session.expires_at > now()
           and member.role in ('owner', 'admin', 'member')
         for update of session, member`,
        [access.session.id, access.account.id, access.membership.id, access.organization.id],
      );
      if (authority.rowCount !== 1) return "forbidden";
      await tx.query(
        `update provider_device_authorizations set status = $2,
           organization_id = case when $2 = 'approved' then $3 else null end,
           user_id = case when $2 = 'approved' then $4 else null end
         where id = $1`,
        [row.id, body.data.decision === "approve" ? "approved" : "denied", access.organization.id, access.account.id],
      );
      return body.data.decision === "approve" ? "approved" : "denied";
    });
    if (outcome === "unavailable") return json({ error: "authorization_unavailable" }, 404);
    if (outcome === "forbidden") return json({ error: "forbidden" }, 403);
    return json({ status: outcome });
  }

  async devicePoll(request: Request): Promise<Response> {
    let input: unknown;
    try { input = await boundedJson(request); }
    catch (error) {
      if (error instanceof SyntaxError || error instanceof RangeError) return json({ error: "invalid_request" }, 400);
      throw error;
    }
    const body = deviceInput.safeParse(input);
    if (!body.success) return json({ error: "invalid_request" }, 400);
    const credential = `paseo_plugin_${createHash("sha256").update("paseo-plugin-device\0").update(body.data.deviceCode).digest("base64url")}`;
    const outcome = await this.database.transaction(async (tx) => {
      const selected = await tx.query<DeviceRow>(
        `select *, now() as database_now from provider_device_authorizations
         where device_verifier = $1 for update`,
        [hash(body.data.deviceCode)],
      );
      const row = selected.rows[0];
      if (row === undefined || row.expires_at <= row.database_now) return { status: "expired" };
      if (row.status === "denied" || row.status === "disclosed") return { status: row.status };
      if (row.next_poll_at > row.database_now) {
        const interval = row.poll_interval_seconds + 5;
        await tx.query(
          `update provider_device_authorizations set poll_interval_seconds = $2,
             next_poll_at = now() + ($2 * interval '1 second') where id = $1`,
          [row.id, interval],
        );
        return { status: "slow_down", interval };
      }
      await tx.query(
        `update provider_device_authorizations set next_poll_at = now() + (poll_interval_seconds * interval '1 second') where id = $1`,
        [row.id],
      );
      if (row.status !== "approved") return { status: "pending", interval: row.poll_interval_seconds };
      const membership = await tx.query(
        `select 1 from member where organization_id = $1 and user_id = $2
           and role in ('owner', 'admin', 'member') for update`,
        [row.organization_id, row.user_id],
      );
      if (membership.rowCount !== 1) {
        await tx.query(`update provider_device_authorizations set status = 'denied' where id = $1`, [row.id]);
        return { status: "denied" };
      }
      await tx.query(
        `insert into provider_plugin_tokens (id, organization_id, user_id, verifier)
         values ($1, $2, $3, $4)`,
        [randomUUID(), row.organization_id, row.user_id, hash(credential)],
      );
      await tx.query(`update provider_device_authorizations set status = 'disclosed' where id = $1`, [row.id]);
      return { status: "authorized", credential };
    });
    return json(outcome);
  }

  private async list(organizationId: string) {
    const result = await this.database.query<SubscriptionRow>(
      `select id, organization_id, family, label, encrypted_credential, created_at
       from provider_subscriptions where organization_id = $1 order by created_at desc`,
      [organizationId],
    );
    return result.rows.map(subscriptionView);
  }
}

function validateCredential(family: "codex" | "claude", value: string): string {
  if (family === "claude") {
    if (!/^sk-ant-[A-Za-z0-9_-]+$/u.test(value.trim())) throw new SyntaxError("Invalid Claude setup token");
    return value.trim();
  }
  const parsed: unknown = JSON.parse(value);
  const credential = z.object({
    auth_mode: z.literal("chatgpt"),
    tokens: z.object({ refresh_token: z.string().min(1) }).passthrough(),
  }).passthrough().parse(parsed);
  return JSON.stringify(credential);
}

async function boundedJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length") ?? 0) > 110_000) throw new RangeError("Request too large");
  const text = await request.text();
  if (text.length > 110_000) throw new RangeError("Request too large");
  return JSON.parse(text);
}

function subscriptionView(row: SubscriptionRow) {
  return { id: row.id, family: row.family, label: row.label, createdAt: row.created_at.toISOString() };
}

function tokenView(row: TokenRow) {
  return { id: row.id, createdAt: row.created_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function normalizeCode(value: string): string {
  return value.normalize("NFKC").toUpperCase().replace(/[^A-F0-9]/gu, "");
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

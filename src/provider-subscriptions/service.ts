import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthServer } from "../auth/server.js";
import { ProductRequestError } from "../auth/organization-access.js";
import type { DatabaseRuntime, QueryRow } from "../db/runtime/index.js";
import { decryptCredential, encryptCredential, providerCredentialKey } from "./crypto.js";

const subscriptionInput = z.object({
  family: z.enum(["codex", "claude"]),
  label: z.string().trim().min(1).max(100),
  credential: z.string().min(1).max(100_000),
});
const idInput = z.object({ id: z.string().uuid() });

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

/** Credentials are handed only to a Google-authenticated member or their scoped plugin token. */
export class ProviderSubscriptions {
  private readonly key: Buffer;

  constructor(
    private readonly database: DatabaseRuntime,
    private readonly auth: Pick<AuthServer, "resolveOrganizationAccess" | "rejectCookieMutation">,
    secret: string,
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

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

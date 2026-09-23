import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { z } from "zod";
import { capabilitiesFor } from "../auth/organization-policy.js";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import { ProviderSubscriptions } from "./service.js";

const ORIGIN = "https://paseo.9010.berlin";
const schema = z.object({ subscription: z.object({ id: z.string().uuid() }) });

test("Google-approved daemon reads only its workspace and stops when membership is removed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-provider-subscriptions-"));
  const { runtime } = await embeddedDatabaseRuntime(join(directory, "database"));
  try {
    await runtime.migrate();
    for (const [id, email] of [["owner-a", "a@9010.berlin"], ["owner-b", "b@9010.berlin"], ["member-a", "m@9010.berlin"]]) {
      await runtime.query(`insert into "user" (id, name, email) values ($1, $1, $2)`, [id, email]);
    }
    for (const id of ["org-a", "org-b"]) {
      await runtime.query(`insert into organization (id, name, slug) values ($1, $1, $1)`, [id]);
    }
    for (const [id, org, user, role] of [
      ["member-owner-a", "org-a", "owner-a", "owner"],
      ["member-owner-b", "org-b", "owner-b", "owner"],
      ["member-a", "org-a", "member-a", "member"],
    ]) {
      await runtime.query(`insert into member (id, organization_id, user_id, role) values ($1, $2, $3, $4)`, [id, org, user, role]);
    }
    await runtime.query(
      `insert into session (id, token, user_id, active_organization_id, expires_at)
       values ('session-member-a', 'test-session-token', 'member-a', 'org-a', now() + interval '1 hour')`,
    );
    const service = new ProviderSubscriptions(runtime, {
      resolveOrganizationAccess: async (request) => {
        const user = request.headers.get("x-test-user") ?? "";
        const organization = user === "owner-b" ? "org-b" : "org-a";
        const role = user === "member-a" ? "member" : "owner";
        return {
          session: { id: `session-${user}` },
          account: { id: user, name: user, email: `${user}@9010.berlin` },
          organization: { id: organization, name: organization, slug: organization },
          membership: { id: user === "member-a" ? "member-a" : `member-${user}`, role },
          capabilities: capabilitiesFor(role),
        };
      },
      rejectCookieMutation: (request) => request.headers.get("origin") === ORIGIN
        ? undefined : Response.json({ error: "origin" }, { status: 403 }),
    }, "test-secret-that-is-at-least-32-characters", ORIGIN);

    const create = async (org: string, user: string) => schema.parse(await (await service.browser(new Request(
      `${ORIGIN}/api/provider-subscriptions/?organizationSlug=${org}`,
      { method: "POST", headers: { origin: ORIGIN, "x-test-user": user },
        body: JSON.stringify({ family: "codex", label: `${org} account`, credential: '{"auth_mode":"chatgpt","tokens":{"refresh_token":"secret"}}' }) },
    ))).json()).subscription.id;
    const ownId = await create("org-a", "owner-a");
    const otherId = await create("org-b", "owner-b");
    const start = await service.deviceStart(new Request(`${ORIGIN}/api/provider-subscriptions/device`, { method: "POST" }));
    assert.equal(start.status, 201);
    const { deviceCode, userCode, verificationUriComplete } = z.object({ deviceCode: z.string(), userCode: z.string(), verificationUriComplete: z.string() }).parse(await start.json());
    assert.equal(new URL(verificationUriComplete).origin, ORIGIN);
    const approve = await service.deviceDecide(new Request(`${ORIGIN}/api/provider-subscriptions/device/decision`, {
      method: "POST", headers: { origin: ORIGIN, "x-test-user": "member-a" },
      body: JSON.stringify({ userCode, decision: "approve" }),
    }));
    assert.equal(approve.status, 200);
    const poll = await service.devicePoll(new Request(`${ORIGIN}/api/provider-subscriptions/device/poll`, {
      method: "POST", body: JSON.stringify({ deviceCode }),
    }));
    const { credential: token } = z.object({ status: z.literal("authorized"), credential: z.string() }).parse(await poll.json());
    assert.match(token, /^paseo_plugin_/u);
    const replay = await service.devicePoll(new Request(`${ORIGIN}/api/provider-subscriptions/device/poll`, {
      method: "POST", body: JSON.stringify({ deviceCode }),
    }));
    assert.equal(z.object({ status: z.string() }).parse(await replay.json()).status, "disclosed");
    const fetchCredential = (id: string) => service.plugin(new Request(`${ORIGIN}/api/provider-subscriptions/plugin/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    }), id);
    const own = await fetchCredential(ownId);
    assert.equal(own.status, 200);
    assert.match(await own.text(), /refresh_token/u);
    assert.equal((await fetchCredential(otherId)).status, 404);
    const stored = await runtime.query<{ encrypted_credential: string }>(
      `select encrypted_credential from provider_subscriptions where id = $1`, [ownId],
    );
    assert.doesNotMatch(stored.rows[0]!.encrypted_credential, /refresh_token|secret/u);
    await runtime.query(`delete from member where user_id = $1`, ["member-a"]);
    assert.equal((await fetchCredential(ownId)).status, 401);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

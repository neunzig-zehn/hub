import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { embeddedDatabaseRuntime } from "../../db/runtime/index.js";
import { LinearAgentRepository, type LinearAgentSession } from "./agent-store.js";
import type { LinearAgentEvent } from "./agent-events.js";

it("persists Linear delivery deduplication, cancellation, and sessions across restart and disconnect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "linear-agent-store-"));
  let bundle = await embeddedDatabaseRuntime(directory);
  const connectionId = "a581bb6c-4f92-433b-a945-5ca77c552522";
  try {
    await bundle.runtime.migrate();
    await bundle.runtime.query(
      `insert into organization (id, name, slug, created_at) values ('org', 'Org', 'org', now())`,
    );
    await bundle.runtime.query(
      `insert into linear_connections
      (id, organization_id, linear_organization_id, slug, linear_organization_name, app_user_id, access_token)
      values ($1, 'org', 'linear-org', 'linear', 'Linear', 'bot', 'token')`,
      [connectionId],
    );
    let store = new LinearAgentRepository(bundle.runtime);
    const event: LinearAgentEvent = {
      key: "stop",
      organizationId: "linear-org",
      oauthClientId: "app",
      appUserId: "bot",
      hubOrganizationId: "org",
      issueId: "issue",
      sessionId: "session",
      action: "stop",
      createdAt: new Date().toISOString(),
      title: "",
      prompt: "",
    };
    await store.enqueue(connectionId, event);
    await store.enqueue(connectionId, event);
    assert.equal((await store.pending()).length, 1);
    const session: LinearAgentSession = {
      id: "session",
      connectionId,
      organizationId: "linear-org",
      hubOrganizationId: "org",
      appUserId: "bot",
      issueId: "issue",
      daemonId: "daemon",
      agentId: "agent",
      workspaceId: "workspace",
      options: { provider: "codex", cwd: "/work", env: {}, toolPolicy: { preapproved: [] } },
      status: "stopping",
      lastEventAt: event.createdAt,
      lastEventKey: event.key,
      response: "",
      output: null,
    };
    await store.save(session);
    await store.complete(connectionId, event.key);
    await bundle.runtime.close();
    bundle = await embeddedDatabaseRuntime(directory);
    store = new LinearAgentRepository(bundle.runtime);
    assert.equal((await store.pending()).length, 0);
    assert.equal(await store.cancelledAt(connectionId, "issue", "session"), event.createdAt);
    assert.equal(await store.cancelledAt(connectionId, "issue", "other-session"), undefined);
    await store.enqueue(connectionId, event);
    assert.equal((await store.pending()).length, 0);
    await bundle.runtime.query(`delete from linear_connections where id = $1`, [connectionId]);
    assert.deepEqual(await store.sessions(), [session]); // A disconnected agent must still be interrupted.
  } finally {
    await bundle.runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

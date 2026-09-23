import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import type { DaemonRecord, LinearConnectionRecord } from "../../db/types.js";
import type { AgentEvent } from "../../daemons/agents/index.js";
import type { DaemonConnection } from "../../daemons/protocol.js";
import { createLinearWebhookSource } from "../../triggers/linear/webhook.js";
import { LINEAR_REQUIRED_SCOPES } from "./client.js";
import { LinearAgents } from "./agent.js";

function fixture() {
  const database = createMemoryDatabase();
  let authority: LinearConnectionRecord | undefined = {
    id: "connection",
    organizationId: "hub-org",
    slug: "linear",
    providerApplicationId: "app",
    linearOrganizationId: "linear-org",
    linearOrganizationName: "Test",
    appUserId: "bot",
    accessToken: "token",
    refreshToken: null,
    accessTokenExpiresAt: null,
    scopes: [...LINEAR_REQUIRED_SCOPES],
  };
  database.findLinearConnection = async () => authority;
  const daemon: DaemonRecord = {
    id: "daemon",
    slug: "host",
    machineId: "machine",
    serverId: "server",
    daemonPublicKey: "key",
    credentialVerifier: "verifier",
    permissions: [],
    registeredByApiKeyId: null,
    registeredByCliCredentialId: null,
    status: "active",
    presence: "connected",
    connectedAt: null,
    disconnectedAt: null,
    lastSeenAt: new Date(),
    createdAt: new Date(),
  };
  database.findDaemonBySlugForOrganization = async (org, slug) =>
    org === "hub-org" && slug === "host" ? daemon : undefined;
  database.findDaemonForOrganization = async (org) => (org === "hub-org" ? daemon : undefined);
  const sent = new Map<string, string>();
  const listeners = new Set<(event: AgentEvent) => void>();
  const activities = new Map<string, { type: string; body: string }>();
  let creates = 0;
  let interrupts = 0;
  let online = true;
  let loseSend = false;
  const live: DaemonConnection = {
    getProviderSnapshot: async () => ({
      entries: [],
      generatedAt: new Date().toISOString(),
      requestId: "snapshot",
    }),
    refreshProviderSnapshot: async () => {},
    agents: {
      create: async () => {
        creates++;
        return { id: "agent", workspaceId: "workspace", status: "idle" };
      },
      get: async () => ({ id: "agent", workspaceId: "workspace", status: "running" }),
      send: async (_id, key, prompt) => {
        sent.set(key, prompt);
        if (loseSend) {
          loseSend = false;
          throw new Error("lost acknowledgement");
        }
      },
      restore: async () => false,
      control: async () => {
        interrupts++;
      },
      watch: async (_id, listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
  const create = () => {
    const agents = new LinearAgents({
      database,
      clientId: "app",
      environment: {
        LINEAR_AGENT_DAEMON: "host",
        LINEAR_AGENT_CWD: "/work",
        LINEAR_AGENT_PROVIDER: "codex",
        LINEAR_AGENT_MODE: "auto-review",
      },
      api: {
        createAgentActivity: async (activity) => {
          activities.set(activity.id, activity);
        },
      },
    });
    agents.connectionForDaemon = () => (online ? live : undefined);
    return agents;
  };
  const agents = create();
  const webhook = createLinearWebhookSource({
    signingSecret: "secret",
    acceptAgentEvent: (payload) => agents.accept(payload),
    accept: async () => {
      throw new Error("Agent events must not create a trigger");
    },
  });
  const deliver = async (payload: object, signature = true) => {
    const body = JSON.stringify({ ...payload, webhookTimestamp: Date.now() });
    return webhook.handle(
      new Request("https://hub.test/events", {
        method: "POST",
        body,
        headers: {
          "linear-delivery": "delivery",
          "linear-event": "AgentSessionEvent",
          "linear-signature": signature
            ? createHmac("sha256", "secret").update(body).digest("hex")
            : "bad",
        },
      }),
    );
  };
  return {
    database,
    agents,
    create,
    deliver,
    sent,
    activities,
    creates: () => creates,
    interrupts: () => interrupts,
    offline: () => {
      online = false;
    },
    online: () => {
      online = true;
    },
    removeWriteScope: () => {
      authority!.scopes = authority!.scopes.filter((scope) => scope !== "write");
    },
    grantWriteScope: () => {
      authority!.scopes.push("write");
    },
    revoke: () => {
      authority = undefined;
    },
    loseSend: () => {
      loseSend = true;
    },
    async emit(event: import("../../daemons/protocol.js").DaemonAgentStreamEvent) {
      for (const listener of listeners)
        listener({
          type: "agent_stream",
          agentId: "agent",
          timestamp: new Date().toISOString(),
          event,
        });
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}
function sessionEvent(action = "created", offset = 0) {
  return {
    type: "AgentSessionEvent",
    action,
    organizationId: "linear-org",
    oauthClientId: "app",
    appUserId: "bot",
    createdAt: new Date(Date.now() + offset).toISOString(),
    promptContext: "Fix the ticket",
    agentSession: {
      id: "session",
      appUserId: "bot",
      organizationId: "linear-org",
      issue: { id: "issue", title: "Ticket" },
    },
    ...(action === "prompted"
      ? {
          agentActivity: {
            id: `prompt-${offset}`,
            agentSessionId: "session",
            content: { type: "prompt", body: "Also check the tests" },
          },
        }
      : {}),
  };
}
function unassign(offset = 1000) {
  return {
    type: "AppUserNotification",
    action: "issueUnassignedFromYou",
    organizationId: "linear-org",
    oauthClientId: "app",
    appUserId: "bot",
    createdAt: new Date(Date.now() + offset).toISOString(),
    notification: { id: `unassigned-${offset}`, issueId: "issue" },
  };
}

describe("native Linear agents", () => {
  it("keeps native sessions queued until Agent Activity write access is granted", async () => {
    const f = fixture();
    f.removeWriteScope();
    await f.deliver(sessionEvent());
    await f.agents.tick();
    assert.equal(f.creates(), 0);
    assert.equal(f.activities.size, 0);
    assert.equal((await f.database.linearAgents.pending()).length, 1);
    f.grantWriteScope();
    await f.agents.tick();
    assert.equal(f.creates(), 1);
    assert.equal(f.sent.size, 1);
    assert.equal((await f.database.linearAgents.pending()).length, 0);
    await f.agents.stop();
  });

  it("verifies webhooks, deduplicates assignment/mention, continues comments, and returns the final response", async () => {
    const f = fixture();
    assert.equal((await f.deliver(sessionEvent(), false)).status, 401);
    assert.equal((await f.database.linearAgents.pending()).length, 0);
    assert.equal((await f.deliver(sessionEvent())).status, 200);
    await f.agents.tick();
    await f.deliver(sessionEvent());
    await f.agents.tick();
    assert.equal(f.creates(), 1);
    assert.equal(f.sent.size, 1);
    await f.deliver(sessionEvent("prompted", 1000));
    await f.agents.tick();
    assert.equal(f.creates(), 1);
    assert.equal(f.sent.size, 2);
    await f.emit({
      type: "timeline",
      provider: "codex",
      item: { type: "assistant_message", messageId: "answer", text: "Fixed " },
    });
    await f.emit({
      type: "timeline",
      provider: "codex",
      item: { type: "assistant_message", messageId: "answer", text: "and tested." },
    });
    await f.emit({ type: "turn_completed", provider: "codex" });
    await f.agents.tick();
    assert(
      [...f.activities.values()].some(
        (item) => item.type === "response" && item.body === "Fixed and tested.",
      ),
    );
    await f.agents.stop();
  });
  it("persists unassignment while offline and interrupts after reconnect; late assignments cannot restart work", async () => {
    const f = fixture();
    await f.deliver(sessionEvent());
    await f.agents.tick();
    f.offline();
    await f.deliver(unassign());
    await f.agents.tick();
    assert.equal(f.interrupts(), 0);
    assert.equal(
      (await f.database.linearAgents.session("connection", "session"))?.status,
      "stopping",
    );
    f.online();
    const recovered = f.create();
    await f.agents.stop();
    await recovered.tick();
    assert.equal(f.interrupts(), 1);
    assert.equal(
      (await f.database.linearAgents.session("connection", "session"))?.status,
      "stopped",
    );
    const delayed = sessionEvent();
    delayed.agentSession.id = "delayed-session";
    await f.deliver(delayed);
    await recovered.tick();
    assert.equal(f.creates(), 1);
    await recovered.stop();
  });
  it("honors Stop before a delayed creation and rejects other app identities", async () => {
    const f = fixture();
    const stop = {
      ...sessionEvent("prompted", 1000),
      agentActivity: {
        id: "stop",
        agentSessionId: "session",
        signal: "stop",
        content: { type: "prompt", body: "Stop" },
      },
    };
    await f.deliver(stop);
    await f.deliver(sessionEvent());
    await f.agents.tick();
    assert.equal(f.creates(), 0);
    assert.equal(f.activities.size, 0);
    await f.deliver({ ...sessionEvent(), oauthClientId: "other-app" });
    assert.equal((await f.database.linearAgents.pending()).length, 0);
    await f.agents.stop();
  });
  it("retries a lost send acknowledgement with the same daemon message and halts revoked sessions", async () => {
    const f = fixture();
    f.loseSend();
    await f.deliver(sessionEvent());
    await f.agents.tick();
    await f.emit({
      type: "timeline",
      provider: "codex",
      item: { type: "assistant_message", text: "Completed before retry." },
    });
    await f.emit({ type: "turn_completed", provider: "codex" });
    await f.agents.tick();
    assert.equal((await f.database.linearAgents.session("connection", "session"))?.status, "idle");
    assert([...f.activities.values()].some((item) => item.body === "Completed before retry."));
    await f.deliver(sessionEvent("prompted", 1000));
    await f.agents.tick();
    assert.equal(f.creates(), 1);
    assert.equal(f.sent.size, 2);
    f.revoke();
    await f.agents.tick();
    assert.equal(f.interrupts(), 1);
    assert.equal(
      (await f.database.linearAgents.session("connection", "session"))?.status,
      "stopped",
    );
    await f.agents.stop();
  });
});

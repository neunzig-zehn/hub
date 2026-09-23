import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Database, LinearConnectionRecord } from "../../db/types.js";
import type { AgentEvent } from "../../daemons/agents/index.js";
import type { DaemonConnection } from "../../daemons/protocol.js";
import { logger } from "../../logger.js";
import { linearConnectionRequiresReauthorization, type LinearApiClient } from "./client.js";
import { parseLinearAgentEvent, type LinearAgentEvent } from "./agent-events.js";
import type { LinearAgentSession } from "./agent-store.js";

/** Stable UUIDs make daemon delivery and Linear activity retries idempotent. */
export function linearAgentId(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class LinearAgents {
  connectionForDaemon: (id: string) => DaemonConnection | undefined = () => undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private processing: Promise<void> | undefined;
  private readonly watchers = new Map<string, { connection: DaemonConnection; stop: () => void }>();
  private readonly callbacks = new Set<Promise<void>>();
  constructor(
    private readonly options: {
      database: Database;
      api: Pick<LinearApiClient, "createAgentActivity">;
      clientId: string;
      environment: NodeJS.ProcessEnv;
    },
  ) {}

  async accept(payload: unknown): Promise<boolean> {
    const event = parseLinearAgentEvent(payload);
    if (!event) return false;
    const connection = await this.authority(event.organizationId, event.appUserId);
    if (!connection || event.oauthClientId !== this.options.clientId) return true;
    await this.options.database.linearAgents.enqueue(connection.id, {
      ...event,
      hubOrganizationId: connection.organizationId,
    });
    // Acknowledge independently so an offline daemon cannot delay another issue's ten-second deadline.
    if (event.sessionId && (event.action === "created" || event.action === "prompted")) {
      const ack = this.activity(
        event.organizationId,
        event.sessionId,
        `${event.key}:ack`,
        "thought",
        "Paseo received your request.",
      ).catch((error) => logger.warn({ err: error }, "Linear acknowledgement will retry"));
      this.callbacks.add(ack);
      void ack.finally(() => this.callbacks.delete(ack));
    }
    // Intake only persists; slow daemon RPCs never hold Linear's five-second webhook response.
    this.wake();
    return true;
  }

  async start(): Promise<void> {
    this.timer ??= setInterval(() => this.wake(), 1000);
    this.timer.unref();
    this.wake();
  }
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.processing;
    for (const watcher of this.watchers.values()) watcher.stop();
    this.watchers.clear();
    await Promise.all(this.callbacks);
  }
  private wake(): void {
    if (!this.timer || this.processing) return;
    this.processing = this.tick()
      .catch((error) => {
        logger.error({ err: error }, "Linear agent queue failed");
      })
      .finally(() => {
        this.processing = undefined;
      });
  }
  async tick(): Promise<void> {
    const db = this.options.database;
    // ponytail: process at most 50 deliveries serially; add per-issue workers if queue throughput grows.
    for (const { connectionId, event } of await db.linearAgents.pending()) {
      if (event.oauthClientId !== this.options.clientId) continue;
      try {
        await db.withAdvisoryLock(`linear-agent:${connectionId}:${event.issueId}`, async () => {
          // Another Hub process may already have handled this event while we waited for the lock.
          if (
            !(await db.linearAgents.pending()).some(
              (item) => item.connectionId === connectionId && item.event.key === event.key,
            )
          )
            return;
          const connection = await this.authority(event.organizationId, event.appUserId);
          if (
            connection?.id === connectionId &&
            connection.organizationId === event.hubOrganizationId
          )
            await this.handle(connection, event);
          await db.linearAgents.complete(connectionId, event.key);
        });
      } catch (error) {
        logger.warn({ err: error, sessionId: event.sessionId }, "Linear agent event will retry");
      }
    }
    for (const session of await db.linearAgents.sessions()) {
      try {
        await db.withAdvisoryLock(
          `linear-agent:${session.connectionId}:${session.issueId}`,
          async () => {
            const current = await db.linearAgents.session(session.connectionId, session.id);
            if (current) await this.reconcile(current);
          },
        );
      } catch (error) {
        logger.warn({ err: error, sessionId: session.id }, "Linear agent session will retry");
      }
    }
  }

  private async authority(
    organizationId: string,
    appUserId: string,
  ): Promise<LinearConnectionRecord | undefined> {
    const connection = await this.options.database.findLinearConnection(organizationId);
    return connection?.appUserId === appUserId &&
      connection.providerApplicationId === this.options.clientId &&
      !linearConnectionRequiresReauthorization(connection)
      ? connection
      : undefined;
  }
  private async handle(connection: LinearConnectionRecord, event: LinearAgentEvent): Promise<void> {
    const store = this.options.database.linearAgents;
    if (event.action === "unassigned") {
      for (const session of await store.sessions()) {
        if (
          session.connectionId === connection.id &&
          session.issueId === event.issueId &&
          Date.parse(session.lastEventAt) <= Date.parse(event.createdAt)
        ) {
          await this.stopSession(session);
        }
      }
      return;
    }
    const sessionId = event.sessionId!;
    let session = await store.session(connection.id, sessionId);
    if (event.action === "stop") {
      if (session && Date.parse(session.lastEventAt) <= Date.parse(event.createdAt))
        await this.stopSession(session);
      return;
    }
    const cancelledAt = await store.cancelledAt(connection.id, event.issueId, sessionId);
    if (cancelledAt && Date.parse(event.createdAt) <= Date.parse(cancelledAt)) return;
    if (session && Date.parse(event.createdAt) < Date.parse(session.lastEventAt)) return;
    await this.activity(
      event.organizationId,
      sessionId,
      `${event.key}:ack`,
      "thought",
      "Paseo received your request.",
    );
    if (!session) {
      session = await this.newSession(connection, event, sessionId);
      if (!session) return;
      await store.save(session);
    }
    const daemon = await this.options.database.findDaemonForOrganization(
      connection.organizationId,
      session.daemonId,
    );
    if (!daemon || daemon.status !== "active")
      throw new Error("Linear agent daemon access revoked");
    const live = this.connectionForDaemon(session.daemonId);
    if (!live) throw new Error("Linear agent daemon offline");
    if (!session.agentId) {
      const agent = await live.agents.create(
        linearAgentId(`${connection.id}:${session.id}`),
        session.options,
      );
      session.agentId = agent.id;
      session.workspaceId = agent.workspaceId;
      await store.save(session);
    }
    await this.watch(session, live);
    if (session.lastEventKey !== event.key) {
      session.status = "running";
      session.lastEventAt = event.createdAt;
      session.lastEventKey = event.key;
      session.response = "";
      session.output = null;
      await store.save(session);
    }
    await live.agents.send(
      session.agentId,
      linearAgentId(`${connection.id}:${event.key}`),
      event.prompt,
    );
  }

  private async newSession(
    connection: LinearConnectionRecord,
    event: LinearAgentEvent,
    sessionId: string,
  ): Promise<LinearAgentSession | undefined> {
    const env = this.options.environment;
    const slug = env["LINEAR_AGENT_DAEMON"];
    const cwd = env["LINEAR_AGENT_CWD"];
    const provider = env["LINEAR_AGENT_PROVIDER"];
    const mode = env["LINEAR_AGENT_MODE"];
    if (!slug || !cwd || !isAbsolute(cwd) || !provider || !mode) {
      await this.activity(
        event.organizationId,
        sessionId,
        `${event.key}:config`,
        "error",
        "Paseo's Linear agent is not configured. Ask the Hub operator to set its daemon, working directory, provider, and permission mode.",
      );
      return undefined;
    }
    const daemon = await this.options.database.findDaemonBySlugForOrganization(
      connection.organizationId,
      slug,
    );
    if (!daemon || daemon.status !== "active") {
      await this.activity(
        event.organizationId,
        sessionId,
        `${event.key}:daemon`,
        "error",
        "The configured Paseo daemon is unavailable in this workspace.",
      );
      return undefined;
    }
    return {
      id: sessionId,
      connectionId: connection.id,
      organizationId: event.organizationId,
      hubOrganizationId: connection.organizationId,
      appUserId: event.appUserId,
      issueId: event.issueId,
      daemonId: daemon.id,
      agentId: null,
      workspaceId: null,
      status: "running",
      lastEventAt: event.createdAt,
      lastEventKey: event.key,
      response: "",
      output: null,
      options: {
        provider,
        mode,
        cwd,
        title: event.title,
        workspaceTitle: event.title,
        ...(env["LINEAR_AGENT_MODEL"] ? { model: env["LINEAR_AGENT_MODEL"] } : {}),
        ...(env["LINEAR_AGENT_BASE_BRANCH"]
          ? {
              worktree: {
                mode: "branch-off" as const,
                newBranch: `paseo/linear-${sessionId}`,
                base: env["LINEAR_AGENT_BASE_BRANCH"],
              },
            }
          : {}),
        env: {},
        toolPolicy: { preapproved: [] },
      },
    };
  }

  private async stopSession(session: LinearAgentSession): Promise<void> {
    session.status = "stopping";
    session.output = {
      id: linearAgentId(`${session.id}:${session.lastEventKey}:stopped`),
      type: "response",
      body: "Paseo stopped working on this issue.",
    };
    await this.options.database.linearAgents.save(session);
    await this.reconcile(session);
  }

  private async reconcile(session: LinearAgentSession): Promise<void> {
    const authority = await this.authority(session.organizationId, session.appUserId);
    if (
      authority?.id !== session.connectionId ||
      authority.organizationId !== session.hubOrganizationId
    ) {
      // Revoking Linear access also halts work already accepted under that connection.
      session.status = "stopping";
      session.output = null;
      await this.options.database.linearAgents.save(session);
    }
    if (
      session.status === "running" &&
      Date.now() - Date.parse(session.lastEventAt) > 30 * 60_000
    ) {
      session.status = "stopping";
      session.output = {
        id: linearAgentId(`${session.id}:${session.lastEventKey}:timeout`),
        type: "error",
        body: "Paseo stopped after the 30-minute session limit. Send a follow-up to continue.",
      };
      await this.options.database.linearAgents.save(session);
    }
    const live = this.connectionForDaemon(session.daemonId);
    if (session.status === "stopping") {
      if (session.agentId && session.workspaceId) {
        if (!live) return; // Keep the stop durable until the daemon reconnects.
        await live.agents.control(session.agentId, session.workspaceId, "interrupt");
      }
      session.status = "stopped";
      this.unwatch(session);
      await this.options.database.linearAgents.save(session);
    } else if (session.status === "running" && live && session.agentId) {
      await this.recoverWatch(session, live);
    }

    if (
      session.output &&
      authority?.id === session.connectionId &&
      authority.organizationId === session.hubOrganizationId
    ) {
      await this.options.api.createAgentActivity({
        linearOrganizationId: session.organizationId,
        agentSessionId: session.id,
        ...session.output,
      });
      session.output = null;
      await this.options.database.linearAgents.save(session);
    }
    if (session.status !== "running") this.unwatch(session);
  }
  private async recoverWatch(session: LinearAgentSession, live: DaemonConnection): Promise<void> {
    const recovering =
      !this.watchers.has(session.id) || this.watchers.get(session.id)?.connection !== live;
    await this.watch(session, live);
    if (recovering) {
      const agent = await live.agents.get(session.agentId!);
      if (agent.status !== "running" && agent.status !== "initializing") {
        session.status = "idle";
        session.output = {
          id: linearAgentId(`${session.id}:${session.lastEventKey}:recovery`),
          type: "error",
          body: "Paseo reconnected after this agent stopped. Its final response was not received; send a follow-up to continue.",
        };
        await this.options.database.linearAgents.save(session);
      }
    }
  }
  private unwatch(session: LinearAgentSession): void {
    this.watchers.get(session.id)?.stop();
    this.watchers.delete(session.id);
  }
  private async watch(session: LinearAgentSession, connection: DaemonConnection): Promise<void> {
    if (this.watchers.get(session.id)?.connection === connection || !session.agentId) return;
    this.unwatch(session);
    const stop = await connection.agents.watch(session.agentId, (event) => {
      const task = this.onEvent(session, event).catch((error) => {
        logger.error({ err: error, sessionId: session.id }, "Linear agent activity failed");
      });
      this.callbacks.add(task);
      void task.finally(() => this.callbacks.delete(task));
    });
    this.watchers.set(session.id, { connection, stop });
  }
  private async onEvent(locator: LinearAgentSession, event: AgentEvent): Promise<void> {
    if (event.type !== "agent_stream") return;
    const stream = event.event;
    await this.options.database.withAdvisoryLock(
      `linear-agent:${locator.connectionId}:${locator.issueId}`,
      async () => {
        const session = await this.options.database.linearAgents.session(
          locator.connectionId,
          locator.id,
        );
        if (!session || session.status !== "running") return;
        if (
          stream.type === "timeline" &&
          stream.item.type === "assistant_message" &&
          stream.item.text
        ) {
          session.response = stream.item.text.slice(-100_000);
        } else if (
          stream.type === "turn_completed" ||
          stream.type === "turn_failed" ||
          stream.type === "turn_canceled" ||
          stream.type === "permission_requested"
        ) {
          let type: "response" | "error" | "elicitation" = "error";
          let body = "Paseo stopped.";
          if (stream.type === "permission_requested") {
            type = "elicitation";
            body =
              "Paseo needs permission. Open this agent in Paseo to review the request, then send a follow-up here.";
          } else if (stream.type === "turn_completed") {
            type = "response";
            body = session.response || "Paseo finished without a text response.";
          } else if (stream.type === "turn_failed") {
            body =
              "Paseo could not complete this request. Check the agent in Paseo and send a follow-up to retry.";
          }
          session.output = {
            id: linearAgentId(`${session.id}:${session.lastEventKey}:${stream.type}`),
            type,
            body,
          };
          if (stream.type !== "permission_requested") session.status = "idle";
        } else return;
        await this.options.database.linearAgents.save(session);
      },
    );
  }
  private activity(
    organizationId: string,
    sessionId: string,
    key: string,
    type: "thought" | "error",
    body: string,
  ): Promise<void> {
    return this.options.api.createAgentActivity({
      linearOrganizationId: organizationId,
      agentSessionId: sessionId,
      id: linearAgentId(`${sessionId}:${key}`),
      type,
      body,
    });
  }
}

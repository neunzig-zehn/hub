import type { QueryHandle } from "../../db/runtime/index.js";
import type { LinearAgentEvent } from "./agent-events.js";
import type { DaemonCreateAgentOptions } from "../../daemons/protocol.js";

export interface LinearAgentSession {
  id: string;
  connectionId: string;
  organizationId: string;
  hubOrganizationId: string;
  appUserId: string;
  issueId: string;
  daemonId: string;
  agentId: string | null;
  workspaceId: string | null;
  options: DaemonCreateAgentOptions;
  status: "running" | "idle" | "stopping" | "stopped";
  lastEventAt: string;
  lastEventKey: string;
  response: string;
  output: { id: string; type: "response" | "error" | "elicitation"; body: string } | null;
}
export interface LinearAgentStore {
  enqueue(connectionId: string, event: LinearAgentEvent): Promise<void>;
  pending(): Promise<{ connectionId: string; event: LinearAgentEvent }[]>;
  complete(connectionId: string, key: string): Promise<void>;
  cancelledAt(
    connectionId: string,
    issueId: string,
    sessionId: string,
  ): Promise<string | undefined>;
  session(connectionId: string, id: string): Promise<LinearAgentSession | undefined>;
  sessions(): Promise<LinearAgentSession[]>;
  save(session: LinearAgentSession): Promise<void>;
}

export class LinearAgentRepository implements LinearAgentStore {
  constructor(private readonly db: QueryHandle) {}
  async enqueue(connectionId: string, event: LinearAgentEvent): Promise<void> {
    await this.db.query(
      `insert into linear_agent_events (connection_id, event_key, issue_id, data)
      values ($1, $2, $3, $4::jsonb) on conflict do nothing`,
      [connectionId, event.key, event.issueId, JSON.stringify(event)],
    );
  }
  async pending() {
    const result = await this.db.query<{ connection_id: string; data: LinearAgentEvent }>(
      `select connection_id, data from linear_agent_events where completed = false order by received_at, event_key limit 50`,
    );
    return result.rows.map((row) => ({ connectionId: row.connection_id, event: row.data }));
  }
  async complete(connectionId: string, key: string): Promise<void> {
    await this.db.query(
      `update linear_agent_events set completed = true where connection_id = $1 and event_key = $2`,
      [connectionId, key],
    );
  }
  async cancelledAt(
    connectionId: string,
    issueId: string,
    sessionId: string,
  ): Promise<string | undefined> {
    const result = await this.db.query<{ at: string }>(
      `select data->>'createdAt' as at from linear_agent_events
      where connection_id = $1 and issue_id = $2 and (data->>'action' = 'unassigned' or (data->>'action' = 'stop' and data->>'sessionId' = $3))
      order by (data->>'createdAt')::timestamptz desc limit 1`,
      [connectionId, issueId, sessionId],
    );
    return result.rows[0]?.at;
  }
  async session(connectionId: string, id: string): Promise<LinearAgentSession | undefined> {
    const result = await this.db.query<{ data: LinearAgentSession }>(
      `select data from linear_agent_sessions where connection_id = $1 and id = $2`,
      [connectionId, id],
    );
    return result.rows[0]?.data;
  }
  async sessions(): Promise<LinearAgentSession[]> {
    const result = await this.db.query<{ data: LinearAgentSession }>(
      `select data from linear_agent_sessions where data->>'status' in ('running', 'stopping') or data->'output' != 'null'::jsonb`,
    );
    return result.rows.map((row) => row.data);
  }
  async save(session: LinearAgentSession): Promise<void> {
    await this.db.query(
      `insert into linear_agent_sessions (connection_id, id, data) values ($1, $2, $3::jsonb)
      on conflict (connection_id, id) do update set data = excluded.data`,
      [session.connectionId, session.id, JSON.stringify(session)],
    );
  }
}

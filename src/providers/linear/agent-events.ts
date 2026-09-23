import { z } from "zod";

const id = z.string().min(1);
const base = z.object({
  organizationId: id,
  oauthClientId: id,
  appUserId: id,
  createdAt: z.string().datetime(),
});
const sessionEvent = base.extend({
  type: z.literal("AgentSessionEvent"),
  action: z.enum(["created", "prompted"]),
  promptContext: z.string().nullish(),
  agentSession: z.object({
    id,
    appUserId: id,
    organizationId: id,
    issue: z.object({ id, title: z.string(), description: z.string().nullish() }).nullish(),
    issueId: id.nullish(),
    comment: z.object({ body: z.string() }).nullish(),
  }),
  agentActivity: z
    .object({
      id,
      agentSessionId: id,
      signal: z.string().nullish(),
      content: z.object({ type: z.literal("prompt"), body: z.string() }),
    })
    .nullish(),
});
const unassignedEvent = base.extend({
  type: z.literal("AppUserNotification"),
  action: z.literal("issueUnassignedFromYou"),
  notification: z.object({ id, issueId: id.optional(), issue: z.object({ id }).optional() }),
});

export interface LinearAgentEvent {
  key: string;
  hubOrganizationId?: string;
  organizationId: string;
  oauthClientId: string;
  appUserId: string;
  issueId: string;
  sessionId: string | null;
  action: "created" | "prompted" | "stop" | "unassigned";
  createdAt: string;
  title: string;
  prompt: string;
}

export function parseLinearAgentEvent(payload: unknown): LinearAgentEvent | undefined {
  const envelope = z.object({ type: z.string(), action: z.string() }).safeParse(payload);
  if (!envelope.success) return undefined;
  if (
    envelope.data.type === "AppUserNotification" &&
    envelope.data.action === "issueUnassignedFromYou"
  ) {
    const value = unassignedEvent.parse(payload);
    const issueId = value.notification.issueId ?? value.notification.issue?.id;
    if (!issueId) throw new Error("Linear unassignment has no issue");
    return {
      ...value,
      key: value.notification.id,
      issueId,
      sessionId: null,
      action: "unassigned",
      title: "",
      prompt: "",
    };
  }
  if (envelope.data.type !== "AgentSessionEvent") return undefined;
  return parseSessionEvent(sessionEvent.parse(payload));
}

function parseSessionEvent(value: z.infer<typeof sessionEvent>): LinearAgentEvent {
  const session = value.agentSession;
  if (session.appUserId !== value.appUserId || session.organizationId !== value.organizationId)
    throw new Error("Linear session identity mismatch");
  const issueId = session.issueId ?? session.issue?.id;
  if (!issueId) throw new Error("Linear agent session has no issue");
  if (
    value.action === "prompted" &&
    (!value.agentActivity || value.agentActivity.agentSessionId !== session.id)
  )
    throw new Error("Linear prompt activity is missing or belongs to another session");
  return {
    key: value.action === "created" ? `created:${session.id}` : value.agentActivity!.id,
    organizationId: value.organizationId,
    oauthClientId: value.oauthClientId,
    appUserId: value.appUserId,
    issueId,
    sessionId: session.id,
    action: value.agentActivity?.signal === "stop" ? "stop" : value.action,
    createdAt: value.createdAt,
    title: session.issue?.title ?? "Linear issue",
    prompt:
      value.action === "prompted"
        ? value.agentActivity!.content.body
        : (value.promptContext ??
          [session.issue?.title, session.issue?.description, session.comment?.body]
            .filter(Boolean)
            .join("\n\n")),
  };
}

# Linear agents

Paseo can receive issue delegation and comment mentions as a native Linear agent, without a
Hub trigger. Each Linear agent session uses its own Paseo agent; follow-up prompts continue it.
Final responses appear in the Linear session. Removing the delegate or using Linear's Stop action
interrupts that agent. The human assignee stays unchanged.

Configure the Linear application to deliver **Agent session events** and **Inbox notifications**
to `/api/integrations/linear/events`. Keep Issue and Comment events enabled if you also use
ordinary Hub triggers. Reconnect the workspace from Connections to grant `app:mentionable` and
`app:assignable`, in addition to `read` and `comments:create`, with `actor=app`.

The operator must explicitly configure the execution target:

| Environment variable       | Value                                                          |
| -------------------------- | -------------------------------------------------------------- |
| `LINEAR_AGENT_DAEMON`      | Slug of an enrolled daemon in the connected Hub organization   |
| `LINEAR_AGENT_CWD`         | Absolute working directory on that daemon                      |
| `LINEAR_AGENT_PROVIDER`    | Installed provider ID, such as `codex`                         |
| `LINEAR_AGENT_MODE`        | Provider permission mode, such as `auto-review`                |
| `LINEAR_AGENT_MODEL`       | Optional model ID; omitted uses the provider default           |
| `LINEAR_AGENT_BASE_BRANCH` | Optional Git base ref; creates a separate worktree per session |

These settings apply to new sessions. The daemon and working directory must already exist.
No credentials are copied to the agent by this integration; it uses the daemon's provider account.
All public-team members who can mention or delegate the installed Linear agent can invoke it
with these configured execution permissions. Limit the Linear app's team access accordingly.

Webhook signatures and timestamps are verified before intake. PostgreSQL stores event deduplication,
session mappings, pending cancellations, and response delivery. An offline daemon keeps requests
queued; a stop remains pending until the daemon reconnects. Work stops after 30 minutes without
a new prompt. A new prompt can resume the same session.

If Hub loses the final agent response during a restart, Linear receives an explicit recovery error
instead of a fabricated result. Send a follow-up to continue. Permission requests must be reviewed
in Paseo; the Linear conversation does not automatically approve daemon permissions.

/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- event handlers are local to this settings form */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { useRouteTenant } from "../projects/context.js";
import { PageHeader } from "../components/app/page.js";
import { Section } from "../components/app/section.js";
import { FormField } from "../components/app/form-field.js";
import { DataCell, DataRow, DataTable } from "../components/app/data-table.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";

const snapshotSchema = z.object({
  subscriptions: z.array(z.object({ id: z.string(), family: z.enum(["codex", "claude"]), label: z.string(), createdAt: z.string() })),
  tokens: z.array(z.object({ id: z.string(), createdAt: z.string(), revokedAt: z.string().nullable() })),
  canManage: z.boolean(),
});
type Snapshot = z.infer<typeof snapshotSchema>;
const TABLE_COLUMNS = [{ header: "Name" }, { header: "Provider" }, { header: "" }] as const;
const EMPTY_TABLE = { title: "No subscriptions", description: "Add a Codex or Claude subscription to offer it to the workspace." };

export function ProvidersPage() {
  const { organization } = useRouteTenant();
  const endpoint = `/api/provider-subscriptions/?organizationSlug=${encodeURIComponent(organization.slug)}`;
  const tokenEndpoint = `/api/provider-subscriptions/token?organizationSlug=${encodeURIComponent(organization.slug)}`;
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [family, setFamily] = useState<"codex" | "claude">("codex");
  const [label, setLabel] = useState("");
  const [claudeToken, setClaudeToken] = useState("");
  const [codexFile, setCodexFile] = useState<File>();

  const load = useCallback(async () => {
    const response = await fetch(endpoint, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("Provider accounts could not be loaded.");
    setSnapshot(snapshotSchema.parse(await response.json()));
  }, [endpoint]);
  useEffect(() => {
    void load().catch((cause: unknown) => setError(message(cause)));
  }, [load]);

  async function send(url: string, method: "POST" | "DELETE", body: unknown) {
    const response = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Hub rejected the request (${response.status}).`);
    const result: unknown = await response.json();
    return result;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setError(undefined);
    try {
      const credential = family === "codex" ? await codexFile?.text() : claudeToken;
      if (!credential) throw new Error("Choose a Codex auth.json file or enter a Claude setup token.");
      await send(endpoint, "POST", { family, label, credential });
      setLabel("");
      setClaudeToken("");
      setCodexFile(undefined);
      form.reset();
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(undefined);
    try {
      await send(endpoint, "DELETE", { id });
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function revokeToken(id: string) {
    setBusy(true);
    setError(undefined);
    try {
      await send(tokenEndpoint, "DELETE", { id });
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title="Providers" description="Workspace subscriptions for Codex and Claude. Members can use these on connected daemons." />
      {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
      <Section title="Workspace accounts" description="Only admins can add or remove subscriptions. Credentials are encrypted and never shown again.">
        <DataTable label="Provider accounts" columns={TABLE_COLUMNS} empty={EMPTY_TABLE} isEmpty={snapshot?.subscriptions.length === 0}>
          {snapshot?.subscriptions.map((item) => (
            <DataRow key={item.id}>
              <DataCell>{item.label}</DataCell>
              <DataCell>{item.family === "codex" ? "Codex" : "Claude"}</DataCell>
              <DataCell align="end">{snapshot.canManage && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void remove(item.id)}>Remove</Button>}</DataCell>
            </DataRow>
          ))}
        </DataTable>
      </Section>
      {snapshot?.canManage && (
        <Section title="Add subscription">
          <form onSubmit={(event) => void submit(event)} className="grid max-w-xl gap-4">
            <FormField id="provider-family" label="Provider">{(control) => <select {...control} value={family} onChange={(event) => setFamily(event.target.value === "claude" ? "claude" : "codex")} className="h-9 rounded-md border bg-background px-3 text-sm"><option value="codex">Codex CLI</option><option value="claude">Claude CLI</option></select>}</FormField>
            <FormField id="provider-label" label="Account name" kind="text" name="label" value={label} onChange={setLabel} required maxLength={100} />
            {family === "codex" ? (
              <FormField id="codex-auth" label="Codex auth.json" description="Select the auth.json from a signed-in Codex CLI. The browser uploads it to this Hub.">{(control) => <Input {...control} type="file" accept=".json,application/json" onChange={(event) => setCodexFile(event.target.files?.[0])} />}</FormField>
            ) : (
              <FormField id="claude-token" label="Claude setup token" description="Create one with claude setup-token." kind="secret" name="credential" value={claudeToken} onChange={setClaudeToken} required />
            )}
            <Button type="submit" disabled={busy}>Add account</Button>
          </form>
        </Section>
      )}
      <Section title="Connected Paseo plugins" description="Sign in from the Router page in Paseo with your Google account. Revoke daemon access here when no longer needed.">
        <div className="grid max-w-xl gap-3">
          {snapshot?.tokens.every((item) => item.revokedAt !== null) && <p className="text-sm text-muted-foreground">No connected plugins yet.</p>}
          {snapshot?.tokens.filter((item) => item.revokedAt === null).map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border p-3 text-sm"><span>Created {new Date(item.createdAt).toLocaleDateString()}</span><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void revokeToken(item.id)}>Revoke</Button></div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "The request failed.";
}

/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- approval buttons bind this login request */
import { createFileRoute } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useActiveAccount } from "../../auth/active-account.js";
import { AuthCard } from "../../components/app/auth-layout.js";
import { Button } from "../../components/ui/button.js";

export const Route = createFileRoute("/_shell/plugin-login")({
  staticData: { breadcrumb: "Plugin login" },
  component: PluginLogin,
});

function PluginLogin() {
  const account = useActiveAccount();
  const [code] = useState(() =>
    typeof window === "undefined"
      ? undefined
      : (new URLSearchParams(window.location.search).get("code") ?? undefined),
  );
  const [outcome, setOutcome] = useState<"approved" | "denied">();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function decide(decision: "approve" | "deny") {
    if (code === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/provider-subscriptions/device/decision", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userCode: code, decision }),
      });
      if (!response.ok) throw new Error("This login request has expired or is unavailable.");
      setOutcome(decision === "approve" ? "approved" : "denied");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  }

  let content: ReactNode;
  if (code === undefined) {
    content = <p role="alert">Open this page from the Router in Paseo.</p>;
  } else if (outcome !== undefined) {
    content = <p role="status">Login {outcome}. You can return to Paseo.</p>;
  } else {
    content = (
      <div className="grid gap-5">
        <p>
          Request code: <span className="text-foreground">{code}</span>. Approve only if this
          matches the code in your Paseo Router.
        </p>
        <p>
          The daemon will be able to read and use the shared Codex and Claude subscriptions in{" "}
          <span className="text-foreground">{account.organization.name}</span>. You can revoke its
          access on Providers.
        </p>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div className="flex gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void decide("deny")}
          >
            Deny
          </Button>
          <Button type="button" disabled={busy} onClick={() => void decide("approve")}>
            Approve plugin login
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-lg">
      <AuthCard
        titleId="plugin-login-heading"
        title="Paseo plugin login"
        description="Connect a Paseo daemon to your Google account in this Hub workspace."
      >
        {content}
      </AuthCard>
    </div>
  );
}

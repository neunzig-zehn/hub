import { createFileRoute } from "@tanstack/react-router";
import { getApplication } from "../../../server/runtime.js";

export const Route = createFileRoute("/api/provider-subscriptions/token")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        (await getApplication()).providerSubscriptions?.browser(request)
        ?? Response.json({ error: "unavailable" }, { status: 503 }),
      DELETE: async ({ request }) =>
        (await getApplication()).providerSubscriptions?.browser(request)
        ?? Response.json({ error: "unavailable" }, { status: 503 }),
    },
  },
});

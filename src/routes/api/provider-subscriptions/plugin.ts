import { createFileRoute } from "@tanstack/react-router";
import { getApplication } from "../../../server/runtime.js";

export const Route = createFileRoute("/api/provider-subscriptions/plugin")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        (await getApplication()).providerSubscriptions?.plugin(request)
        ?? Response.json({ error: "unavailable" }, { status: 503 }),
    },
  },
});

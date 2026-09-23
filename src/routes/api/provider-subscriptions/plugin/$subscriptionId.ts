import { createFileRoute } from "@tanstack/react-router";
import { getApplication } from "../../../../server/runtime.js";

export const Route = createFileRoute("/api/provider-subscriptions/plugin/$subscriptionId")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        (await getApplication()).providerSubscriptions?.plugin(
          request,
          new URL(request.url).pathname.split("/").at(-1) ?? "",
        )
        ?? Response.json({ error: "unavailable" }, { status: 503 }),
    },
  },
});

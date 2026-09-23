import { createFileRoute } from "@tanstack/react-router";
import { getApplication } from "../../../server/runtime.js";

async function handle(request: Request) {
  const service = (await getApplication()).providerSubscriptions;
  return service === null || service === undefined
    ? Response.json({ error: "unavailable" }, { status: 503 })
    : service.browser(request);
}

export const Route = createFileRoute("/api/provider-subscriptions/")({
  server: { handlers: { GET: ({ request }) => handle(request), POST: ({ request }) => handle(request), DELETE: ({ request }) => handle(request) } },
});

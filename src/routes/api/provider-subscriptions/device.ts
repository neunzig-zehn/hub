import { createFileRoute } from "@tanstack/react-router";
import { getApplication } from "../../../server/runtime.js";

export const Route = createFileRoute("/api/provider-subscriptions/device")({
  server: { handlers: { POST: async ({ request }) =>
    (await getApplication()).providerSubscriptions?.deviceStart(request)
    ?? Response.json({ error: "unavailable" }, { status: 503 }) } },
});

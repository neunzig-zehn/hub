import { createFileRoute } from "@tanstack/react-router";
import { ProvidersPage } from "../../../../provider-subscriptions/page.js";

export const Route = createFileRoute("/_shell/o/$organizationSlug/providers")({
  staticData: { breadcrumb: "Providers" },
  component: ProvidersPage,
});

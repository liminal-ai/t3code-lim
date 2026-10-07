// Fork-only (agent comms): the Comms admin page.
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { CommsPage, type CommsTab } from "../comms/CommsPage";

function CommsRouteView() {
  const { tab } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <CommsPage
      tab={tab}
      onTabChange={(next) => void navigate({ to: "/comms", search: { tab: next } })}
    />
  );
}

export const Route = createFileRoute("/comms")({
  validateSearch: (raw: Record<string, unknown>): { tab: CommsTab } => ({
    tab: raw.tab === "groups" ? "groups" : "agents",
  }),
  component: CommsRouteView,
});

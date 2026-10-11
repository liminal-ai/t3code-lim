// Fork-only (artifacts): the Artifacts page; `?id=` is the open artifact.
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { ArtifactsPage } from "../artifacts/ArtifactsPage";

function ArtifactsRouteView() {
  const { id } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <ArtifactsPage
      selectedId={id}
      onSelect={(next) => void navigate({ to: "/artifacts", search: next ? { id: next } : {} })}
    />
  );
}

export const Route = createFileRoute("/artifacts")({
  validateSearch: (raw: Record<string, unknown>): { id?: string } =>
    typeof raw.id === "string" && raw.id.length > 0 ? { id: raw.id } : {},
  component: ArtifactsRouteView,
});

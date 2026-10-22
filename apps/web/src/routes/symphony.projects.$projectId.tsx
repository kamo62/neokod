import { createFileRoute } from "@tanstack/react-router";
import { SymphonyProjectId } from "@neokod/contracts";

import { SymphonyProjectView } from "../components/symphony/SymphonyProjectView";
import { parseProjectTab, type ProjectTab } from "../components/symphony/symphonyProjectTabs";

function ProjectRoute() {
  const { projectId } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <SymphonyProjectView
      projectId={SymphonyProjectId.make(projectId)}
      tab={tab ?? "board"}
      onTabChange={(next) => void navigate({ search: { tab: next }, replace: true })}
    />
  );
}

export const Route = createFileRoute("/symphony/projects/$projectId")({
  validateSearch: (search: Record<string, unknown>): { tab?: ProjectTab } => {
    const tab = parseProjectTab(search.tab);
    return tab === undefined ? {} : { tab };
  },
  component: ProjectRoute,
});

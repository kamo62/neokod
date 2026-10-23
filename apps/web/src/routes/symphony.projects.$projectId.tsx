import { createFileRoute } from "@tanstack/react-router";
import { SymphonyProjectId } from "@neokod/contracts";

import { SymphonyProjectView } from "../components/symphony/SymphonyProjectView";
import {
  DEFAULT_WORK_FILTER,
  parseProjectSearch,
  type ProjectTab,
  type WorkFilter,
} from "../components/symphony/symphonyProjectTabs";

function ProjectRoute() {
  const { projectId } = Route.useParams();
  const { tab, filter } = Route.useSearch();
  const navigate = Route.useNavigate();
  const resolvedTab = tab ?? "work";
  const resolvedFilter = filter ?? DEFAULT_WORK_FILTER;
  return (
    <SymphonyProjectView
      projectId={SymphonyProjectId.make(projectId)}
      tab={resolvedTab}
      filter={resolvedFilter}
      onTabChange={(next: ProjectTab) =>
        void navigate({
          search: { tab: next, ...(next === "work" ? { filter: resolvedFilter } : {}) },
          replace: true,
        })
      }
      onFilterChange={(next: WorkFilter) =>
        void navigate({ search: { tab: "work", filter: next }, replace: true })
      }
    />
  );
}

export const Route = createFileRoute("/symphony/projects/$projectId")({
  validateSearch: (search: Record<string, unknown>): { tab?: ProjectTab; filter?: WorkFilter } =>
    parseProjectSearch(search),
  component: ProjectRoute,
});

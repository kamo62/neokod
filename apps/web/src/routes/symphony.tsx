import { Outlet, createFileRoute, useLocation, useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { SidebarInset } from "../components/ui/sidebar";
import { useUiStateStore } from "../uiStateStore";

function SymphonyRouteLayout() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const runId = useParams({
    strict: false,
    select: (params) => params.runId ?? null,
  });
  const setOperatingMode = useUiStateStore((state) => state.setOperatingMode);
  const setModeViewSnapshot = useUiStateStore((state) => state.setModeViewSnapshot);

  useEffect(() => {
    setOperatingMode("symphony");
    setModeViewSnapshot("symphony", {
      route: pathname,
      selection: runId,
    });
  }, [pathname, runId, setModeViewSnapshot, setOperatingMode]);

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <Outlet />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/symphony")({
  component: SymphonyRouteLayout,
});

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/symphony/settings")({
  beforeLoad: () => {
    throw redirect({ to: "/symphony" });
  },
});

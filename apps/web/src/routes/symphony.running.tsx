import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/symphony/running")({
  beforeLoad: () => {
    throw redirect({ to: "/symphony" });
  },
});

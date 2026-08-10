import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/symphony/workflows")({
  beforeLoad: () => {
    throw redirect({ to: "/symphony" });
  },
});

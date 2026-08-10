import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/symphony/attention")({
  beforeLoad: () => {
    throw redirect({ to: "/symphony" });
  },
});

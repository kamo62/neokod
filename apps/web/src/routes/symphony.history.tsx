import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/symphony/history")({
  beforeLoad: () => {
    throw redirect({ to: "/symphony" });
  },
});

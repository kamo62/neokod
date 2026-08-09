import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/symphony/queue")({
  beforeLoad: () => {
    throw redirect({ to: "/symphony" });
  },
});

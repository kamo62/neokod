import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/symphony/reviews")({
  beforeLoad: () => {
    throw redirect({ to: "/symphony" });
  },
});

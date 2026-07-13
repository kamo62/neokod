import { createFileRoute } from "@tanstack/react-router";

import { NoActiveThreadState } from "../components/NoActiveThreadState";

export const Route = createFileRoute("/_chat/")({
  component: NoActiveThreadState,
});

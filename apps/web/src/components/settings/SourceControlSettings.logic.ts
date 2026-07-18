export type SourceControlDiscoveryView =
  | "waiting-for-environment"
  | "loading"
  | "empty"
  | "results";

export function resolveSourceControlDiscoveryView(input: {
  readonly hasEnvironment: boolean;
  readonly isPending: boolean;
  readonly hasData: boolean;
  readonly hasDiscoveryItems: boolean;
}): SourceControlDiscoveryView {
  if (!input.hasEnvironment) {
    return "waiting-for-environment";
  }
  if (input.isPending && !input.hasData) {
    return "loading";
  }
  if (input.hasDiscoveryItems) {
    return "results";
  }
  return "empty";
}

// The auth status has already been narrowed away from "authenticated" by the caller;
// this only decides how to present the remaining "needs attention" states.
export type SourceControlAuthSummaryStatus = "unauthenticated" | "unknown";

export type SourceControlAuthSummary =
  | { readonly kind: "unauthenticated-guidance" }
  | { readonly kind: "text"; readonly text: string };

/**
 * Picks the copy shown for a provider row that is not (yet) authenticated. When the
 * discovery probe supplied a specific remediation detail (e.g. "install the Azure DevOps
 * CLI extension"), that detail is surfaced directly instead of the generic hard-coded
 * "sign in" copy, and instead of the generic installHint for unverifiable states, so the
 * hint the server produced actually reaches the user instead of being silently dropped.
 */
export function resolveSourceControlAuthSummary(input: {
  readonly authStatus: SourceControlAuthSummaryStatus;
  readonly authDetail: string | null;
  readonly label: string;
  readonly installHint: string;
}): SourceControlAuthSummary {
  if (input.authStatus === "unauthenticated") {
    return input.authDetail
      ? { kind: "text", text: `${input.label} is not ready on this server. ${input.authDetail}` }
      : { kind: "unauthenticated-guidance" };
  }

  return {
    kind: "text",
    text: `Could not verify ${input.label}. ${input.authDetail ?? input.installHint}`,
  };
}

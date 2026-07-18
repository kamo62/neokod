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

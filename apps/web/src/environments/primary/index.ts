export {
  getPrimaryKnownEnvironment,
  readPrimaryEnvironmentDescriptor,
  resetPrimaryEnvironmentDescriptorForTests,
  resolveInitialPrimaryEnvironmentDescriptor,
  writePrimaryEnvironmentDescriptor,
  __resetPrimaryEnvironmentBootstrapForTests,
  __resetPrimaryEnvironmentDescriptorBootstrapForTests,
} from "./context";

export {
  resolveInitialPrimaryEnvironmentDescriptor as ensurePrimaryEnvironmentReady,
  writePrimaryEnvironmentDescriptor as updatePrimaryEnvironmentDescriptor,
} from "./context";

export { PrimaryEnvironmentHttpClient } from "./httpClient";

export {
  DesktopEnvironmentBootstrapIncompleteError,
  isDesktopEnvironmentBootstrapIncompleteError,
  isPrimaryEnvironmentProtocolUnsupportedError,
  isPrimaryEnvironmentUrlInvalidError,
  isPrimaryEnvironmentTargetRejectedError,
  PrimaryEnvironmentProtocolUnsupportedError,
  PrimaryEnvironmentUrlInvalidError,
  PrimaryEnvironmentTargetRejectedError,
  readPrimaryEnvironmentTarget,
  resolvePrimaryEnvironmentHttpUrl,
  resolveDesktopEnvironmentBootstrapTarget,
  isLoopbackHostname,
  type PrimaryEnvironmentTarget,
} from "./target";

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
  ACCESS_TOKEN_STORAGE_KEY,
  __resetPrimaryAccessTokenForTests,
  checkPrimaryAccessToken,
  clearPrimaryAccessToken,
  initializePrimaryAccessToken,
  readPrimaryAccessGate,
  readPrimaryAccessToken,
  reportPrimaryAccessResult,
  storePrimaryAccessToken,
  subscribePrimaryAccessGate,
  subscribePrimaryAccessToken,
  type PrimaryAccessGate,
  type PrimaryAccessTokenCheck,
} from "./accessToken";

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

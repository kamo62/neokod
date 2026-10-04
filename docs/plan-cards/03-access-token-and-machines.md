# S3 cards: access token and remote machines (A1, A2, B1 to B4)

Base commit da7655bb2, branch fix/symphony-runner-and-config-wip. Paths are relative to the repo root. Cards are in dependency order: A1, A1b, A1c, A2, B1, B2, B2b, B3, B3b, B4. Sections follow at the end.

Conventions used below. "Base" means commit da7655bb2. Every line number was read at base. The server keeps the existing `ServerConfig.loopbackAuthToken` field name for the access token (renaming it touches the desktop bootstrap contract and 8 test fixtures and is out of scope); its doc comment is rewritten in A1. `isServerBindAuthorized` lives in `apps/server/src/config.ts:218`, not in `cli/config.ts`. The test command for a server test file is `pnpm exec vp test run <file>` from `apps/server` (confirmed working on `src/startupAccess.test.ts`).

Cards A1 and A1b and A1c are the "W2.1" work split into three commits so each stays reviewable. A2 is the web half. B1 to B4 are W5 slices 1, 2, 3 and 1b.

---

### A1 Stable access token for every web-mode launch, explicit CORS origins

- Problem: `neokod serve` runs with no credential unless `--strict-transport` is passed. `cli/config.ts:368-372` mints a token only when `strictTransport && transport === "loopback" && mode === "web"`, so the default launch has `loopbackAuthToken === undefined` and `WslBearerAuth.resolveExpectedToken` (`transport/WslBearerAuth.ts:79-88`) returns `null`, which makes `authorizeHttpRequest` and `consumeWebSocketTicket` pass everything. CORS is wildcard in production because `browserApiCorsLayer` (`http.ts:35-50`) passes no `allowedOrigins`, and Effect treats an empty list as `*` (`.repos/effect-smol/packages/effect/src/unstable/http/HttpMiddleware.ts:316-331`). Even when a token is minted today it is per launch (README and `startupAccess.ts:93-95` say so), is printed in clear text (`startupAccess.ts:92`) and is logged inside the startup URL (`serverRuntimeStartup.ts:466-468`, `annotateLogs({ startupUrl })`, and again in the failure hint at `:281-283`).
- Files to change:
  - `apps/server/src/accessToken.ts` (new): token validation, source precedence, persistence.
  - `apps/server/src/accessToken.test.ts` (new).
  - `apps/server/src/config.ts` : `ServerConfig` type, `loopbackAuthToken` doc (line 77-83), add two optional fields after it; `layerTest` needs no edit because the new fields are optional.
  - `apps/server/src/cli/config.ts` : add `accessTokenFileFlag` (after line 78), env key `accessToken` in `EnvServerConfig` (after line 172), `CliServerFlags.accessTokenFile` (line 175-188), `sharedServerCommandFlags` (line 204-222), `normalizedFlags` (line 252-265), token resolution (line 355-372), config literal (line 405), `resolveCliProjectConfig` (line 416-436), new `options.accessTokenPolicy`.
  - `apps/server/src/cli/config.test.ts` : `emptyFlags` (line 20-34), test at line 93 (rename and rewrite).
  - `apps/server/src/http.ts` : `browserApiCorsLayer` (line 35-50).
  - `apps/server/src/httpCors.ts` : delete the unused `browserApiCorsHeaders` (line 9-13, wildcard constant, no importers: `git grep browserApiCorsHeaders` shows only its definition).
  - `apps/server/src/transport/LocalTransportAuth.ts` : comment only at line 94-97.
  - `apps/server/src/startupAccess.ts` : `HeadlessServeAccessInfo` (line 8-11), `formatHeadlessServeOutput` (line 89-99), `issueHeadlessServeAccessInfo` (line 101-112).
  - `apps/server/src/startupAccess.test.ts` : lines 8-23.
  - `apps/server/src/serverRuntimeStartup.ts` : `resolveStartupBrowserTarget` (line 252-269) and the log at line 466-468.
  - `apps/server/src/server.test.ts` : new tests near line 925 (CORS block).
  - `apps/server/src/transport/WslBearerAuth.test.ts` : regression-pin tests.
  - `apps/server/src/transport/LocalTransportAuth.test.ts` : one regression-pin test.
  - No change needed in `server.ts:383-391`, `ws.ts:2589-2590`, `orchestration/http.ts:31,50,64,82` and `http.ts:78,95`: they all call `WslBearerAuth.authorizeHttpRequest` or `authorizeWebSocketUpgrade`, which read the token from `ServerConfig`. Verified by reading each.
- Change:
  1. Create `apps/server/src/accessToken.ts`. It must not import `config.ts` at runtime (config.ts imports its type), and must not use `ServerSecretStore` because that service needs `ServerConfig`, which does not exist yet when `resolveServerConfig` runs. Copy the create-exclusive pattern from `secrets/ServerSecretStore.ts:219-236` (`fs.open(path, { flag: "wx", mode: 0o600 })`, `writeAll`, `sync`, `chmod 0o600`) and the lost-race handling from `:238-278` (on "already exists", read the file).
     ```ts
     export const ACCESS_TOKEN_MIN_LENGTH = 32;
     export const ACCESS_TOKEN_FILE_NAME = "access-token";
     export const AccessTokenSource = Schema.Literals(["flag-file", "env", "default-file", "generated"]);
     export type AccessTokenSource = typeof AccessTokenSource.Type;
     export interface ResolvedAccessToken {
       readonly token: string;
       readonly source: AccessTokenSource;
       readonly filePath: string | undefined; // set for flag-file, default-file, generated
     }
     export class AccessTokenError extends Schema.TaggedErrorClass<AccessTokenError>()("AccessTokenError", {
       reason: Schema.Literals(["too_short", "invalid_characters", "unreadable", "unwritable"]),
       source: AccessTokenSource,
       cause: Schema.optional(Schema.Defect()),
     }) {
       override get message(): string { /* names the source and reason, never the value */ }
     }
     export const normalizeAccessToken = (raw: string, source: AccessTokenSource) => /* Effect<string, AccessTokenError> */;
     export const resolveAccessToken = Effect.fn("accessToken.resolve")(function* (input: {
       readonly baseDir: string;
       readonly envToken: string | undefined;
       readonly tokenFile: string | undefined;
       readonly generate: boolean;
     }): Effect.fn.Return<Option.Option<ResolvedAccessToken>, AccessTokenError, FileSystem.FileSystem | Path.Path> { ... });
     ```
     `normalizeAccessToken`: `trim()`, then fail `too_short` if length < 32, then fail `invalid_characters` unless `/^[\x21-\x7e]+$/` matches (the value goes into an HTTP header).
     Precedence inside `resolveAccessToken`, first match wins: (a) `tokenFile` (flag): read the file, normalize with source `flag-file`; a missing or unreadable file is an `unreadable` error, never a fallback. (b) `envToken` (`NEOKOD_ACCESS_TOKEN`): normalize with source `env`; a short value is an error, never a fallback. (c) `<baseDir>/access-token` if it exists: normalize with source `default-file`, then best-effort `chmod 0o600` (ignore failure, Windows has no modes). (d) if `generate`: `NodeCrypto.randomBytes(32).toString("base64url")` (43 chars), create the file exclusively with mode 0o600, source `generated`. (e) otherwise `Option.none()`.
  2. `config.ts`: change the `loopbackAuthToken` comment to say it is the access token for the HTTP bearer and the WebSocket ticket, stable across launches for web mode, per-launch only when a desktop bootstrap supplies it. Add after it:
     ```ts
     readonly accessTokenSource?: AccessTokenSource;   // import type from "./accessToken.ts"
     readonly accessTokenFilePath?: string;            // for the startup message only
     ```
     Update the `strictTransport` comment (line 94-101): it now only enables Host/Origin validation; the token no longer depends on it.
  3. `cli/config.ts` flags and env. Add:
     ```ts
     export const accessTokenFileFlag = Flag.string("access-token-file").pipe(
       Flag.withDescription(
         "Read the access token from this file (at least 32 characters). Overrides NEOKOD_ACCESS_TOKEN.",
       ),
       Flag.optional,
     );
     ```
     Put it in `sharedServerCommandFlags` as `accessTokenFile: accessTokenFileFlag`, add `readonly accessTokenFile: Option.Option<string>` to `CliServerFlags`, `accessTokenFile: flags.accessTokenFile ?? Option.none()` to `normalizedFlags`, and `accessTokenFile: Option.none()` in `resolveCliProjectConfig`. In `EnvServerConfig` add
     `accessToken: Config.redacted("NEOKOD_ACCESS_TOKEN").pipe(Config.option, Config.map(Option.map(Redacted.value)), Config.map(Option.getOrUndefined))` (import `* as Redacted from "effect/Redacted"`; `Config.redacted` exists at `.repos/effect-smol/packages/effect/src/Config.ts:1316`). There is no legacy `T3CODE_ACCESS_TOKEN` name, so do not use `envConfig`.
  4. `cli/config.ts` resolution. Extend the third parameter of `resolveServerConfig` with `readonly accessTokenPolicy?: "generate" | "read-only"` (default `"generate"`). Replace lines 362-372 with:
     ```ts
     const wantsAccessToken =
       mode === "web" && transport === "loopback" && bootstrapLoopbackToken === undefined;
     const resolvedAccessToken = wantsAccessToken
       ? yield *
         resolveAccessToken({
           baseDir,
           envToken: env.accessToken,
           tokenFile: Option.getOrUndefined(normalizedFlags.accessTokenFile),
           generate: (options?.accessTokenPolicy ?? "generate") === "generate",
         })
       : Option.none<ResolvedAccessToken>();
     const loopbackAuthToken =
       bootstrapLoopbackToken ??
       Option.getOrUndefined(Option.map(resolvedAccessToken, (r) => r.token));
     ```
     In the config literal add `...(Option.isSome(resolvedAccessToken) ? { accessTokenSource: resolvedAccessToken.value.source, ...(resolvedAccessToken.value.filePath !== undefined ? { accessTokenFilePath: resolvedAccessToken.value.filePath } : {}) } : {})` (the repo spreads optional keys; `exactOptionalPropertyTypes` is on). `strictTransport` stays exactly as is and no longer gates the token. `mode: "desktop"` without a bootstrap token still gets no token (unchanged, see Open questions). `resolveCliProjectConfig` passes `{ accessTokenPolicy: "read-only" }` so that `neokod project ...` never creates the file.
  5. `http.ts` CORS. Replace the body of `browserApiCorsLayer` so that when `config.loopbackAuthToken` is a non-empty string it uses a predicate, and otherwise keeps the current behaviour (needed by the legacy desktop bootstrap without a token and by existing tests). `HttpRouter.cors` only accepts arrays, so call the middleware form, which is exactly what `HttpRouter.cors` wraps (`HttpRouter.ts:1196`):
     ```ts
     import { HttpMiddleware } from "effect/unstable/http"; // add to the existing import list
     export const makeBrowserOriginPredicate =
       (config: Pick<ServerConfig.ServerConfig["Service"], "devUrl" | "publicOrigins">) =>
       (origin: string): boolean => {
         if (origin === config.devUrl?.origin || DESKTOP_RENDERER_ORIGINS.includes(origin))
           return true;
         if ((config.publicOrigins ?? []).includes(origin)) return true;
         try {
           const url = new URL(origin);
           return (
             (url.protocol === "http:" || url.protocol === "https:") &&
             isLoopbackHostname(url.hostname)
           );
         } catch {
           return false;
         }
       };
     // in the layer, when a token is configured:
     return HttpRouter.middleware(
       HttpMiddleware.cors({
         allowedOrigins: makeBrowserOriginPredicate(config),
         allowedMethods: browserApiCorsAllowedMethods,
         allowedHeaders: browserApiCorsAllowedHeaders,
         credentials: devOrigin !== undefined,
         maxAge: 600,
       }),
       { global: true },
     );
     ```
     Loopback origins of any port are allowed because `LocalTransportAuth.ts:151-157` already treats them as local, and the owner's own Mac UI at `http://localhost:<port>` must be able to call a remote machine (card B2). The token is still required on every request.
  6. `LocalTransportAuth.ts:94-97`: replace the comment with "Host/Origin validation is opt-in (NEOKOD_STRICT_TRANSPORT) on the loopback bind. The access token, not this check, is the credential." No logic change.
  7. `startupAccess.ts`: replace `loopbackAuthToken` in `HeadlessServeAccessInfo` with
     `readonly accessTokenSource: AccessTokenSource | undefined; readonly accessTokenFilePath: string | undefined;`, fill them from `serverConfig` in `issueHeadlessServeAccessInfo`, and print (never the token value):
     ```
     Neokod server is ready.
     Local URL: http://localhost:3773
     Access token: generated and stored in /home/kamo/.neokod/access-token (mode 0600)
     Open the URL and paste the token when asked. Read it with: cat /home/kamo/.neokod/access-token
     ```
     Source wording: `generated` -> "generated and stored in <path> (mode 0600)"; `default-file` -> "stored in <path>"; `flag-file` -> "read from <path>"; `env` -> "from NEOKOD_ACCESS_TOKEN". The second line (the "Open the URL..." line) is printed whenever a source exists. When the source is `undefined` (desktop bootstrap without token) print only the first two lines, as today.
  8. `serverRuntimeStartup.ts:252-269`: delete the `loopbackAuthToken` branch so `resolveStartupBrowserTarget` returns `baseTarget` only. The auto-opened URL carries no token: `ExternalLauncherBrowserSpawnError` (`process/externalLauncher.ts:385-390`) records `target` and `args`, so a tokened URL would leak into error data and traces. The browser asks for the token once and stores it (card A2).
  9. Do not log the token anywhere. After steps 7 and 8, `git grep -n "loopbackAuthToken" apps/server/src` must show only: config types, the resolution above, `WslBearerAuth.ts`, tests.
- Do not: put the token in any log, span attribute, error `message`, `serverRuntimeStatePath` file or startup URL. Do not fall back to a generated token when a configured token is too short (fail startup). Do not key the token on `strictTransport` or on `startupPresentation` (the browser-opening `start` and the headless `serve` must behave the same). Do not generate the token inside `resolveCliProjectConfig` (it would create files from `neokod project list`). Do not edit `CHANGELOG.md` (release tooling owns it, `scripts/check-changelog-version.ts`).
- Tests (each new test below must FAIL at base):
  - `apps/server/src/accessToken.test.ts` (new, `it.layer(NodeServices.layer)`, temp dir via `FileSystem.makeTempDirectoryScoped({ prefix: "neokod-access-token-" })`): "rejects a 31 character token" (`flip` gives `AccessTokenError` with reason `too_short`, and `JSON.stringify(error)` does not contain the value); "rejects whitespace inside the token" (`invalid_characters`); "generates 43 characters and writes mode 0600 once" (`(yield* fs.stat(p)).mode & 0o777 === 0o600`, second call returns the same token with source `default-file`); "flag file beats env beats default file" (three sources present, assert each in turn by removing the higher one); "file with trailing newline is trimmed"; "read-only policy returns none and creates nothing when no source exists" (`generate: false`, then `fs.exists` is false); "an existing default file is returned when exclusive create loses the race" (pre-create the file with a valid 40 char token, call with `generate: true`, expect that token and source `default-file`).
  - `apps/server/src/cli/config.test.ts`: add `accessTokenFile: Option.none()` to `emptyFlags`. Rewrite the test at line 93 as `"web mode has a stable access token; strict-transport only toggles Host/Origin validation"`: temp `baseDir` from `FileSystem.makeTempDirectoryScoped` (the old test used a shared `tmpdir()/neokod-cli-strict-transport`, which would now persist a file across runs), env layer as in the old test with `NEOKOD_HOME: baseDir`. Resolve twice with `{ ...emptyFlags, mode: Option.some("web") }`; assert `first.loopbackAuthToken` is a string of length >= 32, equals `second.loopbackAuthToken`, `first.accessTokenSource === "generated"`, `second.accessTokenSource === "default-file"`, `first.strictTransport === false`, file mode 0o600. Resolve a third time with `strictTransport: Option.some(true)` and assert the same token and `strictTransport === true`. Add: `"NEOKOD_ACCESS_TOKEN wins over the default file and creates no file"` (env `"e".repeat(32)`, assert source `env`, `fs.exists(join(baseDir,"access-token"))` false); `"--access-token-file wins over env"`; `"a too-short NEOKOD_ACCESS_TOKEN fails startup"` (`Effect.flip`, `_tag === "AccessTokenError"`); `"desktop mode without a bootstrap token generates no token and no file"`; `"read-only policy never creates the file and reuses an existing one"` (call with `{ accessTokenPolicy: "read-only" }` before and after a generate).
  - `apps/server/src/startupAccess.test.ts`: replace the test at line 15-23. New assertions: output for source `generated` contains `generated and stored in /tmp/x/access-token`, and `expect(output).not.toContain` of a sample token string passed nowhere (assert the formatter signature has no token field by TypeScript, plus assert output lines equal the 4 line template exactly); source `undefined` equals `"Neokod server is ready.\nLocal URL: http://localhost:3773\n"`.
  - `apps/server/src/server.test.ts`, new tests inside `it.layer(NodeServices.layer)("server router seam", ...)` after the test at line 925, using `buildAppUnderTest({ config: { loopbackAuthToken: TOKEN, publicOrigins: ["https://neokod.example.com"] } })` with `const TOKEN = "t".repeat(40)`: "with a token, a foreign Origin gets no CORS allow-origin header" (GET `/.well-known/neokod/environment` with `authorization: Bearer TOKEN` and `origin: https://evil.example.com`: status 200, `headers["access-control-allow-origin"]` is `undefined`); "with a token, public, loopback and desktop origins are echoed" (origins `https://neokod.example.com`, `http://localhost:5733`, `neokod://app` each echoed exactly); "with a token, a preflight from a foreign origin gets no allow-origin" (OPTIONS with `access-control-request-headers: authorization`); "with a token, the descriptor and dispatch require the bearer" (descriptor without header: 401 and body `code: "wsl_bearer_invalid"`; POST `/api/orchestration/dispatch` without header: 401). Keep the existing tests at lines 925-955 and 1085-1160 unchanged (no token: wildcard still applies).
  - `apps/server/src/transport/WslBearerAuth.test.ts` (regression pins, pass at base): with `makeAuth("loopback", "t".repeat(40))`: "rejects a same-length wrong token", "rejects `bearer <token>` with a lowercase scheme", "rejects `Bearer  <token>` with two spaces". They document that the comparison goes through `timingSafeEqualUtf8` (`crypto/serverCrypto.ts:23`) and that no other form is accepted.
  - `apps/server/src/transport/LocalTransportAuth.test.ts` (regression pin): "with strict-transport off and a token configured, a foreign Host still passes validation (the bearer is the credential)": `withAuth({ strictTransport: false, loopbackAuthToken: "t".repeat(40) })("http://evil.example.com/", {})`.
- Verify: from `apps/server`: `pnpm exec vp test run src/accessToken.test.ts src/cli/config.test.ts src/startupAccess.test.ts src/server.test.ts src/transport/WslBearerAuth.test.ts src/transport/LocalTransportAuth.test.ts` all green; `pnpm exec tsgo --noEmit` clean. From the repo root `vp check` and `vp run typecheck`. Manual: `NEOKOD_HOME=$(mktemp -d) node apps/server/dist/bin.mjs serve --port 4999` (after the owner's normal build), then `curl -i localhost:4999/.well-known/neokod/environment` returns 401, the same with `-H "Authorization: Bearer $(cat $NEOKOD_HOME/access-token)"` returns 200, restarting the server leaves `access-token` unchanged, and `grep -r "$(cat $NEOKOD_HOME/access-token)" $NEOKOD_HOME/userdata/logs` prints nothing.
- Depends on: none. Effort: M. Commit message: `feat(server): stable access token for web-mode serve and explicit CORS origins`

---

### A1b Project CLI sends the access token to a running server

- Problem: `neokod project add|list|remove` talks to a running server through `makeLiveServerClient` and calls `snapshot({ headers: {} })` and `dispatch({ headers: {}, ... })` (`cli/project.ts:299-320`). After A1 the server answers 401, `tryResolveLiveProjectExecutionMode` (`cli/project.ts:328-352`) treats any failure as "no live server", deletes the runtime state file (`clearPersistedServerRuntimeState`, line 351) and falls back to writing the SQLite database directly while the server is still running.
- Files to change:
  - `apps/server/src/cli/project.ts` : `fetchLiveOrchestrationSnapshot` (line 299), `dispatchLiveOrchestrationCommand` (line 310), `tryResolveLiveProjectExecutionMode` (line 328), callers at line 382 and the dispatch call sites near line 420-430.
  - `apps/server/src/cli/project.test.ts` : add tests (read the file first to reuse its live-server fixture; `git grep -n "serverRuntimeStatePath\|live" apps/server/src/cli/project.test.ts` shows how live mode is faked).
- Change:
  1. Thread the token: give both live helpers a second parameter `accessToken: string | undefined` and send `headers: accessToken === undefined ? {} : { authorization: \`Bearer ${accessToken}\` }`. Callers pass `config.loopbackAuthToken`(set by`resolveCliProjectConfig`in A1 through the read-only policy: env`NEOKOD_ACCESS_TOKEN`, else `<baseDir>/access-token` if present).
  2. In `tryResolveLiveProjectExecutionMode`, before the generic failure branch, if `attempted.failure` is a `ProjectLiveServerDeclaredResponseError` with `code === "wsl_bearer_invalid"`, do not clear the state file and do not fall back. Fail the command with a new tagged error `ProjectLiveServerUnauthorizedError` (add to the `ProjectCommandError` union at line 143-152) whose message is `The running Neokod server requires an access token. Set NEOKOD_ACCESS_TOKEN or use the same --base-dir as the server.`
  3. Keep the 1 second timeout and every other failure path as is.
- Do not: print the token; fall back to offline mode on a 401 (that is the dual-writer hazard W5 warns about); generate a token file from this command.
- Tests (must FAIL at base): extend `cli/project.test.ts` with "sends the bearer header to the live server" (capture the request headers at the fake live endpoint, assert `authorization === "Bearer " + token`), "a 401 from the live server fails the command and keeps the runtime state file" (assert the failure `_tag === "ProjectLiveServerUnauthorizedError"` and `fs.exists(config.serverRuntimeStatePath)` is true afterwards), and "no token set sends no header" (regression).
- Verify: from `apps/server`: `pnpm exec vp test run src/cli/project.test.ts` and `pnpm exec tsgo --noEmit`.
- Depends on: A1. Effort: S. Commit message: `fix(server): project CLI authenticates to a running server with the access token`

---

### A1c Docs: one account of the access token

- Problem: README, `docs/architecture/connection-runtime.md` and `docs/operations/self-hosting.md` each describe a different transport. README (`:72-89`, `:93-95`, `:99-105`) says `serve` mints a per-launch token and prints it, and that the listener "validates `Host` and `Origin` on every request"; both are only true with `--strict-transport`. `connection-runtime.md:33` says native primary and `neokod serve` are "Direct, unauthenticated" and `:42-46` says bootstraps "carry no secret". `self-hosting.md:12-23` says the server has no application authentication and `:182` and `:189` say never to bind non-loopback. None describes the stable token.
- Files to change:
  - `README.md` : "npx / npm CLI" (`:63-89`), "Local access boundary" (`:91-95`), "Security posture" (`:97-107`), "Running behind a reverse proxy" (`:109-113`).
  - `docs/architecture/connection-runtime.md` : lines 10-12 (no saved targets, kept until B2), 19-20 (resolver ownership), 29-46 (access matrix and the two paragraphs after it).
  - `docs/operations/self-hosting.md` : "Read this before you expose it" (`:10-30`), the paragraph at `:182-184`, Troubleshooting row at `:189`.
- Change:
  1. README: replace the per-launch token text with: `serve` and `start` always require an access token in web mode. Source order: `--access-token-file`, `NEOKOD_ACCESS_TOKEN` (both need at least 32 characters), `<base-dir>/access-token` (mode 0600, created on first start and then kept). The startup output names the source but never prints the token. Open the URL, paste the token once; the browser remembers it. A page address of the form `http://host:3773/#access-token=<token>` is also accepted and is stripped from the address bar. Document `--strict-transport` as Host/Origin validation only.
  2. Reword the first sentence of "Security posture" (`:99`, "validates `Host` and `Origin` on every request") to say validation is opt-in through `--strict-transport`. Fix the "Security posture" bullets to match: delete the sentence "The checks return immediately only when the legacy desktop bootstrap supplied no loopback token" and the bullet that says the token is "never persisted" for serve; state that CORS allows only the declared public origins, the dev origin, desktop renderer origins and loopback origins when a token is set.
  3. `connection-runtime.md`: access matrix row `Native primary / neokod serve`: Discovery "Loopback URL or window origin", HTTP `Authorization: Bearer <access token>`, WebSocket "Bearer-protected ticket request, then one single-use ticket", Persistence "Cache only; the token lives in the server base directory and in the browser (A2)". Replace the "carry no secret" paragraph with the actual rule. State in the ownership list that `ConnectionResolver` also obtains a ticket for an authenticated loopback target (`packages/client-runtime/src/connection/resolver.ts:39-70`). Leave the sentence "There are no saved remote targets" until B2 lands.
  4. `self-hosting.md`: replace the first paragraph of "Read this before you expose it" with the same token rule, keep the reverse-proxy recommendation, and add that the token is a second factor behind the proxy. Do not mention `--host` yet (B1 adds it).
  5. Style: plain sentences, no em dashes.
- Do not: document `--host`, Tailscale or saved machines here (B1, B2). Do not paste a real token. Do not change `docs/operations/self-hosting.md` proxy YAML.
- Tests: none (docs). Add a grep check to Verify.
- Verify: from the repo root `vp check` (formatting of markdown) passes; `git grep -n "per-launch\|Direct, unauthenticated\|carry no secret\|no application authentication" README.md docs/architecture/connection-runtime.md docs/operations/self-hosting.md` returns no hit that still describes the old behaviour (the only allowed remaining mention of "per-launch" is for the desktop bootstrap token).
- Depends on: A1. Effort: S. Commit message: `docs: describe the stable access token and fix contradictory transport docs`

---

### A2 Web client: access token prompt, storage and bearer on HTTP and WebSocket ticket

- Problem: after A1 every web-mode server answers 401 until the client sends `Authorization: Bearer <token>`. The web client only knows the token from the page address and never keeps it: `readLoopbackAuthTokenFromWindow` (`apps/web/src/environments/primary/target.ts:112-118`) reads `?loopbackAuthToken=` on every call and nothing stores it, so a reload without the query string loses it. Four more defects make a simple "store it" change insufficient. (1) `makePrimaryEnvironmentHttpLayer` (`environments/primary/httpLayer.ts:7-28`) reads the token once when the layer is built, and `primaryHttpRuntime` (`lib/runtime.ts:15-17`) memoizes that layer, so a token entered later is never used. (2) The registration cache signature in `connection/platform.ts:221` contains the WSL token but not the loopback token, so a changed token is not noticed. (3) With no token, `loadPrimaryConnectionRegistration` (line 107) fails with 401 and the failure is swallowed by `Effect.option` (`platform.ts:230`), so the app shows an empty shell and retries every 3 seconds (`PLATFORM_POLL_INTERVAL`, line 42). (4) The Electron branch drops the desktop token: `validateTargetUrls` returns `transport: { _tag: "Loopback" }` for a desktop loopback bootstrap (`target.ts:248-260`) although `DesktopEnvironmentBootstrap` carries `loopbackAuthToken` (`packages/contracts/src/ipc.ts:282`, produced at `apps/desktop/src/ipc/methods/window.ts:81-83`). I read this but did not run the desktop app, so confirm it before and after this card.
- Files to change:
  - `apps/web/src/environments/primary/accessToken.ts` (new) and `accessToken.test.ts` (new).
  - `apps/web/src/environments/primary/target.ts` : replace `readLoopbackAuthTokenFromWindow` (line 106-118) and its two callers (line 395, 429); forward the desktop token in `validateTargetUrls` (line 248-260).
  - `apps/web/src/environments/primary/httpLayer.ts` : read the bearer per request.
  - `apps/web/src/environments/primary/index.ts` : export the new module's public functions.
  - `apps/web/src/connection/platform.ts` : `loadPrimaryConnectionRegistration` (line 107-138), signature (line 221), 401 reporting (line 226-231).
  - `apps/web/src/components/AccessTokenPrompt.tsx` and `AccessTokenGate.tsx` (new), `AccessTokenPrompt.browser.tsx` (new).
  - `apps/web/src/routes/__root.tsx` : mount at line 89 next to `<SessionExpiredBanner />`.
  - `apps/web/src/components/SessionExpiredBanner.tsx` and `SessionExpiredBanner.logic.ts` : desktop only, copy fix.
  - `apps/web/src/components/settings/ConnectionsSettings.tsx` : "Forget access token" row (inside the "This environment" section that starts at line 240, after the "Browser access" row that ends at line 260).
  - `apps/web/src/main.tsx` : call `initializePrimaryAccessToken()` before `getRouter(history)` (line 17).
  - `packages/client-runtime`: no change. `connection/resolver.ts:39-70` already turns `entry.loopbackAuthToken` into a bearer plus a ticket (`transport/wslBearer.ts:resolveLoopbackWebSocketUrl`), and `state/shellSnapshotHttp.ts:30-31` already sends the bearer through `effectiveAuthorization(prepared)`. Verified by reading both.
- Change:
  1. Storage decision: `localStorage`, key `neokod:primary-access-token:v1`, plus an in-memory copy. Reason: every read site is synchronous (`readPrimaryEnvironmentTarget` runs on each 3 second poll and on each HTTP request), and IndexedDB is asynchronous. `sessionStorage` would force re-entry on every new tab and browser restart, which defeats a stable token. A cookie would add CSRF exposure. The residual risk is that any XSS on the UI origin can read the token, which is the same exposure as IndexedDB; this is documented, not mitigated (B2 stores remote-machine tokens in IndexedDB for the same reason). The token is per origin by construction of `localStorage`.
  2. New `accessToken.ts`:
     ```ts
     export const ACCESS_TOKEN_STORAGE_KEY = "neokod:primary-access-token:v1";
     export type PrimaryAccessTokenCheck = "accepted" | "rejected" | "unreachable";
     export type PrimaryAccessGate = "unknown" | "ok" | "required" | "rejected";
     export function initializePrimaryAccessToken(): void; // idempotent, safe without window
     export function readPrimaryAccessToken(): string | undefined; // calls initialize first
     export function storePrimaryAccessToken(token: string): void; // trims, ignores empty
     export function clearPrimaryAccessToken(): void;
     export function subscribePrimaryAccessToken(listener: () => void): () => void;
     export function readPrimaryAccessGate(): PrimaryAccessGate;
     export function reportPrimaryAccessResult(result: "ok" | "unauthorized"): void;
     export function subscribePrimaryAccessGate(listener: () => void): () => void;
     export function checkPrimaryAccessToken(
       token: string,
       fetchImpl?: typeof fetch,
     ): Promise<PrimaryAccessTokenCheck>;
     export function __resetPrimaryAccessTokenForTests(): void;
     ```
     `initializePrimaryAccessToken`: do nothing when `typeof window === "undefined"` or `window.desktopBridge !== undefined` (desktop supplies its own credential through the bootstrap). Otherwise read the URL once: the query key `loopbackAuthToken` (existing, documented in the old README) and the fragment key `access-token` (`new URLSearchParams(window.location.hash.slice(1))`). If one is present, store it (URL wins over a stored value), then remove only those keys and call `window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash)` so other query parameters and fragments survive. Then load `localStorage.getItem(KEY)` into memory. Wrap every `localStorage` call in try/catch; if storage is unavailable keep the value in memory only.
     `reportPrimaryAccessResult("unauthorized")` sets the gate to `"rejected"` when a token is held and `"required"` when none is; `"ok"` sets `"ok"`. Notify subscribers only on change.
     `checkPrimaryAccessToken`: `GET resolvePrimaryEnvironmentHttpUrl("/.well-known/neokod/environment")` with `authorization: Bearer <token>`; status 200 is `"accepted"`, 401 is `"rejected"`, any other status or a thrown fetch is `"unreachable"`. Never log the token or the request headers.
  3. `target.ts`: delete `readLoopbackAuthTokenFromWindow`; both callers use `readPrimaryAccessToken()` (import from `./accessToken`). In `validateTargetUrls`, the desktop loopback branch (line 248-260) must return `transport: { _tag: "Loopback", ...(bootstrap.loopbackAuthToken !== undefined ? { loopbackAuthToken: bootstrap.loopbackAuthToken } : {}) }`, narrowing on `bootstrap.transport === "loopback"` (the field exists only on that union member). The browser branch (line 261-275) keeps using `input.loopbackAuthToken`.
  4. `httpLayer.ts`: resolve the bearer inside `HttpClient.mapRequest` on every request instead of at layer build:
     ```ts
     const currentBearer = (): string | undefined => {
       const resolved = readPrimaryEnvironmentTarget();
       return resolved.transport._tag === "Loopback"
         ? resolved.transport.loopbackAuthToken
         : resolved.transport.token;
     };
     // Layer.effect(HttpClient.HttpClient, Effect.map(HttpClient.HttpClient, (client) =>
     //   client.pipe(HttpClient.mapRequest((request) => { const t = currentBearer(); return t === undefined ? request : HttpClientRequest.bearerToken(request, t); }))))
     ```
     Return that layer always (no early `return baseLayer`). `readPrimaryEnvironmentTarget` can throw for an invalid target; let the throw surface as before (it already surfaced when the layer was built).
  5. `platform.ts`: (a) extract `export const primaryRegistrationSignature = (target: PrimaryEnvironmentTarget): string` returning `${tag}|${http}|${ws}|${token}` where `token` is the WSL token or the loopback token or `""`, and use it at line 221. (b) In `loadPrimaryConnectionRegistration`, after `descriptorFor`, call `reportPrimaryAccessResult("ok")`; add `Effect.tapError((error) => error._tag === "ConnectionBlockedError" && error.reason === "authentication" ? Effect.sync(() => reportPrimaryAccessResult("unauthorized")) : Effect.void)` before the existing `Effect.tapError` warning. `mapRemoteEnvironmentError` already maps 401 (declared `EnvironmentWslBearerInvalidError` and undeclared status 401) to that reason (`packages/client-runtime/src/connection/errors.ts:25-31,57-61`). (c) Avoid a 401 request every 3 seconds: keep `const unauthorizedSignature = yield* Ref.make<string | null>(null)` next to `cacheRef`; when the primary load fails with that reason store the signature, and skip the fetch while `signature === stored`. A new token changes the signature, so the next poll retries.
  6. `AccessTokenPrompt.tsx` (presentational, no atoms):
     ```ts
     export function AccessTokenPrompt(props: {
       readonly reason: "required" | "rejected";
       readonly hasStoredToken: boolean;
       readonly verify: (token: string) => Promise<PrimaryAccessTokenCheck>;
       readonly onAccepted: (token: string) => void;
       readonly onForget: () => void;
     }): JSX.Element;
     ```
     Render a fixed full-screen layer (`fixed inset-0 z-100 flex items-center justify-center bg-background`) with the existing `Button` (`components/ui/button`) and `Input` (`components/ui/input`). Texts (exact): title `Enter access token`; body for `required`: `This Neokod server needs an access token. Run "cat <base-dir>/access-token" on the server (the path is printed when the server starts).`; body for `rejected`: `The saved access token was not accepted. It may have been replaced on the server. Enter the current token.`; label `Access token`; `<Input type="password" autoComplete="off" spellCheck={false}>`; primary button `Connect` (disabled while empty or checking); inline errors: `That token was not accepted.` for `rejected`, `Could not reach the server. Check the address and try again.` for `unreachable`; when `hasStoredToken`, a secondary button `Forget saved token`. On submit call `verify`; on `accepted` call `onAccepted`; otherwise show the error and keep the field.
  7. `AccessTokenGate.tsx` wires state: `useSyncExternalStore` over `subscribePrimaryAccessGate`/`readPrimaryAccessGate`, and the existing connection state as in `SessionExpiredBanner.tsx:20-26` (`usePrimaryEnvironmentId`, `useEnvironmentQuery(environmentCatalog.stateAtom(...))`, `isSessionExpiredConnectionState`). Render nothing when `window.desktopBridge !== undefined`. Show `<AccessTokenPrompt reason="rejected">` when the gate is `"rejected"` or `isSessionExpiredConnectionState(state)`; `reason="required"` when the gate is `"required"`. `verify = checkPrimaryAccessToken`; `onAccepted = (t) => { storePrimaryAccessToken(t); window.location.reload(); }`; `onForget = () => { clearPrimaryAccessToken(); window.location.reload(); }`. Reload is deliberate: `primaryHttpRuntime`, the descriptor cache in `environments/primary/context.ts` and the tracing exporter are built once per page and a reload resets all of them.
  8. Stored token rejected: the prompt appears with the `rejected` text. The stored token is kept until the user submits a new one or presses `Forget saved token` (a server restart that regenerates nothing, or a typo in a proxy, must not erase a good token). No retry loop runs: the supervisor parks in `blocked` on an authentication failure (`SessionExpiredBanner.logic.ts:11-19`), and step 5c suppresses the poll.
  9. `routes/__root.tsx` line 89: render `<AccessTokenGate />` before `<SessionExpiredBanner />`. In `SessionExpiredBanner.tsx` add `if (window.desktopBridge === undefined) return null;` after the hooks and change the copy to `Session expired. The desktop backend restarted. Reload.`; update the stale comment in `SessionExpiredBanner.logic.ts:5-19` ("dev loopback token rotates") to say the token can be rejected after a server or desktop restart.
  10. `ConnectionsSettings.tsx`: inside "This environment", when `usesBrowserOrigin` or `window.desktopBridge === undefined`, add `<SettingsRow title="Access token" description="Saved in this browser for this server." control={<Button variant="outline" size="xs" onClick={forget}>Forget</Button>} />` shown only when `readPrimaryAccessToken() !== undefined`. `forget` calls `clearPrimaryAccessToken()` then `window.location.reload()`.
  11. `main.tsx`: call `initializePrimaryAccessToken()` once, before `getRouter(history)`, so the fragment or query token is gone from the address bar before the router reads `window.location`.
- Do not: keep the token in the URL after reading it; put it in `sessionStorage`, a cookie, a log line, a span attribute or an error message; prompt in the Electron renderer (there is no human-entered token there); clear the stored token automatically on a 401; touch `packages/client-runtime` (its resolver and snapshot loader already carry the bearer).
- Tests (each new test below must FAIL at base):
  - `apps/web/src/environments/primary/accessToken.test.ts` (new, `@effect/vitest` like `target.test.ts`; stub `window` and `localStorage` with `vi.stubGlobal` and call `__resetPrimaryAccessTokenForTests()` in `afterEach`): "stores a ?loopbackAuthToken value and strips it from the address" (stub `window.location` with `href: "http://h:3773/chat?loopbackAuthToken=tok&x=1#a"`, `history: { state: null, replaceState: vi.fn() }`; expect `replaceState` called with `(null, "", "/chat?x=1#a")`, `localStorage` holds `tok`, `readPrimaryAccessToken() === "tok"`); "reads #access-token= and keeps other fragment keys"; "falls back to the stored token"; "a URL token replaces a stored token"; "ignores URL and storage when window.desktopBridge exists"; "keeps the token in memory when localStorage throws"; "clear removes storage and notifies subscribers"; "reportPrimaryAccessResult maps unauthorized to required without a token and rejected with one"; `checkPrimaryAccessToken` with a mocked `fetch`: 200 gives `accepted`, 401 gives `rejected`, 500 gives `unreachable`, a throw gives `unreachable`, and the request carries `authorization: Bearer t` and targets `/.well-known/neokod/environment`.
  - `apps/web/src/environments/primary/target.test.ts`: "window-origin target carries the stored access token" (stub `window.location.origin = "https://neokod.example.com"`, pre-store a token; expect `transport` toEqual `{ _tag: "Loopback", loopbackAuthToken: "stored" }`), and "desktop loopback bootstrap forwards its token" (`resolveDesktopEnvironmentBootstrapTarget({ id: "primary", label: "Local", transport: "loopback", httpBaseUrl: "http://127.0.0.1:3773", wsBaseUrl: "ws://127.0.0.1:3773", loopbackAuthToken: "desktop-token" })` has `transport.loopbackAuthToken === "desktop-token"`). Keep the existing "credential-free" test.
  - `apps/web/src/environments/primary/httpLayer.test.ts`: "attaches the stored token and sees a token stored after the layer was built" (build the layer, issue a request, assert no `authorization`; call `storePrimaryAccessToken("late")`; issue a second request on the same layer instance and assert `Bearer late`). Reuse the `window`/`fetch` stubbing already in that file (lines 12-38).
  - `apps/web/src/connection/platform.test.ts`: "primaryRegistrationSignature changes when the loopback token changes" and "is stable for the same inputs".
  - `apps/web/src/components/AccessTokenPrompt.browser.tsx` (new, mirrors `SubagentsPanel.browser.tsx`: `import "~/index.css"`, `renderBrowserHarness` from `../test/browser/render`, `page` from `vite-plus/test/browser/context`): render with `reason="required"` and `verify` returning `"rejected"`; fill the field (`await page.getByLabelText("Access token").fill("abc")`), click `Connect`, assert `That token was not accepted.` is visible and `onAccepted` was not called; then with `verify` returning `"accepted"` assert `onAccepted` called with `abc`; with `"unreachable"` assert the reach error; with `hasStoredToken` assert `Forget saved token` is visible and calls `onForget`; with `reason="rejected"` assert the rejected body text. Feasible because `AccessTokenPrompt` has no atom or router dependency by design.
- Verify: from `apps/web`: `pnpm exec vp test run src/environments/primary/accessToken.test.ts src/environments/primary/target.test.ts src/environments/primary/httpLayer.test.ts src/connection/platform.test.ts`, then `pnpm exec vp test run --project browser src/components/AccessTokenPrompt.browser.tsx` (the browser project is defined in `apps/web/vite.config.ts` as `name: "browser"`; if the project flag differs, run `pnpm exec vp test run src/components/AccessTokenPrompt.browser.tsx`), then `pnpm exec tsgo --noEmit`. Repo root: `vp check` and `vp run typecheck`. Manual: against a server from A1, open `http://localhost:<port>/` in a clean profile, see the prompt, enter a wrong token (inline error), enter the right token (app loads), reload (no prompt), open `/#access-token=<token>` in a second profile (app loads and the address bar loses the fragment), press Forget in Settings > Connections (prompt returns).
- Depends on: A1. Effort: M. Commit message: `feat(web): access token prompt, persisted token and bearer on every primary request`

---

### B1 Server: `--host`, token-gated non-loopback bind, multi-value public origins, optional Tailscale login allowlist

- Problem: the listener cannot leave loopback. `isServerBindAuthorized` (`apps/server/src/config.ts:218-222`) accepts only `127.0.0.1` with the `loopback` transport, or a wildcard with the desktop `wsl-bearer` transport and token. `cli/config.ts:352` hard-codes `const host = bootstrap?.host ?? "127.0.0.1"`, there is no `--host` flag, and the test at `cli/config.test.ts:120` ("honors ordinary CLI flags without exposing a host override") plus the self-hosting guide (`docs/operations/self-hosting.md:22-23`) pin that absence. `--public-host` and `--public-origin` take one value each (`cli/config.ts:61-72`, `:406-407`). `LocalTransportAuth.validate` returns immediately unless `strictTransport` is set (`transport/LocalTransportAuth.ts:98-100`), so a non-loopback listener would have no Host or Origin check by default, and it accepts `Origin: null` (line 142).
- Files to change:
  - `apps/server/src/config.ts` : `ServerConfig.host` type (line 69), new optional `tailscaleAllowLogins`, `isServerBindAuthorized` (line 218-222), new `isLoopbackBindHost`.
  - `apps/server/src/cli/config.ts` : `hostFlag`, `publicHostFlag` and `publicOriginFlag` (line 61-72), `EnvServerConfig` (line 160-167), `CliServerFlags` (line 175-188), `sharedServerCommandFlags` (line 204-222), `normalizedFlags` (line 252-265), host/public resolution (line 351-354), config literal (line 399, 406-407), `resolveCliProjectConfig` (line 416-436), new `assertServerBindAuthorized`.
  - `apps/server/src/cli/server.ts` : `runServerCommand` (line 8-20).
  - `apps/server/src/server.ts` : message at line 117-123 (keep the guard, change the text).
  - `apps/server/src/startupAccess.ts` : `isLoopbackHost` (line 15-27) delegates to the new helper.
  - `apps/server/src/transport/LocalTransportAuth.ts` : `validate` (line 94-161).
  - `packages/contracts/src/environmentHttp.ts` : `TransportOriginInvalidReason` (line 38).
  - `apps/server/src/cli/config.test.ts`, `apps/server/src/transport/LocalTransportAuth.test.ts`.
  - `docs/operations/self-hosting.md`, `README.md`.
- Change:
  1. `config.ts`: widen `readonly host: string` (was `"127.0.0.1" | "0.0.0.0"`). Check usages compile: `server.ts:128-141` passes it to `hostname`/`host`, `serverRuntimeState.ts:43`, `serverRuntimeStartup.ts:256-258,417`, `startupAccess.ts:101-111` all accept `string`. Add after `strictTransport`:
     ```ts
     /** Lower-cased `Tailscale-User-Login` values allowed through (NEOKOD_TAILSCALE_ALLOW_LOGINS). Empty or absent disables the check. */
     readonly tailscaleAllowLogins?: ReadonlyArray<string>;
     ```
     Add and export
     ```ts
     export const isLoopbackBindHost = (host: string): boolean =>
       host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");
     export function isServerBindAuthorized(
       config: Pick<
         ServerConfig["Service"],
         "host" | "transport" | "wslBearerToken" | "loopbackAuthToken"
       >,
     ): boolean {
       if (config.transport === "wsl-bearer") {
         return config.host === "0.0.0.0" && Boolean(config.wslBearerToken?.trim());
       }
       if (isLoopbackBindHost(config.host)) return true;
       return Boolean(config.loopbackAuthToken?.trim());
     }
     ```
     This keeps every existing outcome (wildcard with `loopback` and no token is still `false`; `wsl-bearer` on `127.0.0.1` is still `false`) and adds exactly one new allowed case: a non-loopback host on the `loopback` transport with a non-blank token. In `startupAccess.ts` change `isLoopbackHost` to `!host || host.length === 0 || isLoopbackBindHost(host)` (import from `./config.ts`, which that file already imports; do not import the other direction, it would create a cycle).
  2. `cli/config.ts` flags. Add
     ```ts
     export const hostFlag = Flag.string("host").pipe(
       Flag.withDescription(
         "Address to listen on: an IP literal such as a Tailscale address (100.x.y.z) or 0.0.0.0. Default 127.0.0.1. A non-loopback address requires an access token (equivalent to NEOKOD_HOST).",
       ),
       Flag.optional,
     );
     ```
     Change `publicHostFlag` and `publicOriginFlag` to `Flag.string(...).pipe(Flag.withDescription(...), Flag.atLeast(0))` (repeatable; `Flag.atLeast` is defined at `.repos/effect-smol/packages/effect/src/unstable/cli/Flag.ts:758`, min 0 allowed by `Param.atLeast`). `CliServerFlags.publicHost` and `.publicOrigin` become `ReadonlyArray<string>`, and `host: Option.Option<string>` is added; `resolveCliProjectConfig` passes `host: Option.none()`, `publicHost: []`, `publicOrigin: []`. Env: add `host: Config.string("NEOKOD_HOST")` and `tailscaleAllowLogins: Config.string("NEOKOD_TAILSCALE_ALLOW_LOGINS")`, both `Config.option` then `Option.getOrUndefined` like the neighbours; keep `NEOKOD_PUBLIC_HOST` and `NEOKOD_PUBLIC_ORIGIN` and accept comma separated lists in them.
  3. Resolution rules in `resolveServerConfig` (replace line 351-354):
     - `host`: `bootstrap?.host ?? flag ?? env ?? "127.0.0.1"`. The desktop bootstrap wins so a stray `NEOKOD_HOST` cannot widen the discriminated desktop bootstrap (`packages/contracts/src/desktopBootstrap.ts:21-36`). Trim, strip one pair of `[ ]`, then require `NodeNet.isIP(value) !== 0` (`import * as NodeNet from "node:net"`). Hostnames are rejected on purpose, so no DNS lookup decides the bind. Failure: `ServerHostInvalidError` (Schema.TaggedErrorClass, field `host`, message `--host must be an IP address such as 100.81.180.76 or 0.0.0.0, got "<value>".`).
     - `publicHosts`: flags then env values, split on `,`, trimmed, empties dropped, de-duplicated. Each value goes through `normalizePublicHost`: `const url = new URL(\`http://${value}\`)`, reject (error `ServerPublicAddressInvalidError`, fields `kind: "host" | "origin"`, `value`) when `url.port !== ""`, `url.pathname !== "/"`, `url.search`, `url.hash`, `url.username`or`url.password`is non-empty; return`url.hostname`lower-cased with IPv6 brackets stripped (the comparison in`LocalTransportAuth.ts:128` is on the bare hostname).
     - `publicOrigins`: same splitting; each goes through `normalizePublicOrigin`: `new URL(value)`, protocol must be `http:` or `https:`, `pathname === "/"`, no search or hash; return `url.origin`.
     - `tailscaleAllowLogins`: split on `,`, trim, lower-case, drop empties; included in the config only when non-empty (`...(logins.length > 0 ? { tailscaleAllowLogins: logins } : {})`).
     - Export `assertServerBindAuthorized = (config) => Effect<void, ServerBindRefusedError | ServerConfigConflictError>` which fails with `ServerBindRefusedError` when `!isServerBindAuthorized(config)`; message: `Refusing to listen on <host>: a non-loopback address needs an access token. Use --mode web (default), or set NEOKOD_ACCESS_TOKEN or --access-token-file.` It also fails with `ServerConfigConflictError` (message `NEOKOD_TAILSCALE_ALLOW_LOGINS only works behind "tailscale serve" with a loopback bind. Remove it or bind 127.0.0.1.`) when `tailscaleAllowLogins` is set and the host is not loopback, because a direct connection carries no trustworthy `Tailscale-User-Login` header.
  4. `cli/server.ts` `runServerCommand`: after `resolveServerConfig(...)` add `yield* assertServerBindAuthorized(config);` before `runServer`. Do not call it from `resolveCliProjectConfig`, so `neokod project list` never refuses because `NEOKOD_HOST` is exported in the shell. Keep `server.ts:117-123` as a second guard; change its text to `Refusing to bind the server: a non-loopback host requires an access token or the private wsl-bearer desktop bootstrap.`
  5. `LocalTransportAuth.ts` `validate`:
     - Replace the early return at line 98-100 with `const loopbackBind = isLoopbackBindHost(config.host); if (!config.strictTransport && loopbackBind && !hasTailscaleAllowlist) return;`, so a non-loopback bind always validates and the tailscale check below always runs when configured. Keep the existing `wsl-bearer` early return (line 111-113) before both.
     - Host rule on a non-loopback bind: accept a loopback hostname, a declared public host, or any IP literal (`NodeNet.isIP(parsed.hostname) !== 0`). An IP literal in `Host` cannot come from a DNS rebinding page, because rebinding needs a hostname. Names such as `wv-htpc.<tailnet>.ts.net` or `box.local` must be declared with `--public-host`. The loopback bind keeps today's rule (loopback names plus declared hosts, no IP literals).
     - Origin rule on a non-loopback bind: same list as today (`neokod://app`, `neokod-dev://app`, dev origin, declared public origins, self origin, loopback hostnames, declared public hostnames) except that `Origin: null` is rejected (`invalid_origin`). On the loopback bind `null` stays accepted (the packaged desktop file origin needs it).
     - After the Host and Origin checks add `validateTailscaleLogin`: when `config.tailscaleAllowLogins` is non-empty, require that `request.remoteAddress` is `Option.some(addr)` with `addr` equal to `127.0.0.1`, `::1` or `::ffff:127.0.0.1`, and that the `tailscale-user-login` header, lower-cased, is in the list; otherwise `failInvalid("tailscale_login_not_allowed", "an allowed Tailscale login", <header or "no Tailscale-User-Login header">)`. A missing `remoteAddress` fails closed. The header is never read when the list is empty, and it is never a credential: the bearer check in `WslBearerAuth` still runs for every route.
     - Add the literal `"tailscale_login_not_allowed"` to `TransportOriginInvalidReason` in `packages/contracts/src/environmentHttp.ts:38` (schema-only change; no runtime logic in contracts).
  6. Docs. In `docs/operations/self-hosting.md` delete the sentences that say there is deliberately no `--host` flag, that "a test pins that absence" (lines 22-23) and "Do not work around this by trying to bind a non-loopback address" (lines 182-183), reword the troubleshooting row at line 189 to `A non-loopback host was configured without an access token.`, and add a section `## Use with Tailscale` with these two routes, in this order:

     ```
     # Route 1 (recommended): keep Neokod on loopback, let Tailscale terminate HTTPS
     neokod serve --port 3773 --strict-transport \
       --public-host wv-htpc.<tailnet>.ts.net --public-origin https://wv-htpc.<tailnet>.ts.net
     tailscale serve --bg --https=443 http://127.0.0.1:3773
     # open https://wv-htpc.<tailnet>.ts.net and paste the access token once
     # undo: tailscale serve --https=443 off     (verify with: tailscale serve status)

     # Route 2: listen on the tailnet address directly (plain HTTP over the encrypted tailnet)
     neokod serve --host "$(tailscale ip -4)" --port 3773
     # open http://100.81.180.76:3773
     ```

     State that Authelia is not in either route, so the access token is the only credential; that MagicDNS and HTTPS certificates must be enabled in the tailnet admin console for route 1; that `--host 0.0.0.0` also exposes the LAN and every interface; that on route 2 the page is not a secure context, so browser notifications are unavailable (`apps/web/src/notifications/browserNotification.ts:17`); and describe `NEOKOD_TAILSCALE_ALLOW_LOGINS=you@example.com` as an extra filter that only works on route 1, that it also blocks any other proxy using the same listener (for example the Authelia route), and that it never replaces the token. Add one sentence and a link to this section in `README.md` under "Running behind a reverse proxy" (`:109`), and change `README.md:95` ("The only non-loopback exception is a desktop-managed WSL backend") to also name `--host` with an access token.

- Do not: let a hostname into `--host`; trust `Tailscale-User-Login` from a non-loopback peer or when no allowlist is configured; treat the header as authentication; weaken the `wsl-bearer` branch of `isServerBindAuthorized`; call `assertServerBindAuthorized` from the project CLI path; make `--public-origin` accept a path or `*`.
- Tests (each new test below must FAIL at base):
  - `apps/server/src/cli/config.test.ts`: add `host: Option.none()`, `publicHost: []`, `publicOrigin: []` to `emptyFlags` (line 20-34). Rename the test at line 120 to `"defaults the listen host to loopback"`; the assertions stay (`host: "127.0.0.1"`). New tests: "--host binds a tailnet address" (`mode: web`, `host: Option.some("100.81.180.76")`, temp `NEOKOD_HOME`; expect `resolved.host`), "NEOKOD_HOST is used when no flag is given and the flag wins over it", "the desktop bootstrap host wins over NEOKOD_HOST" (use `openBootstrapFd("loopback")`, env `NEOKOD_HOST: "0.0.0.0"`, expect `"127.0.0.1"`), "--host rejects a hostname" (`Effect.flip`, `_tag === "ServerHostInvalidError"`), "public hosts and origins merge, normalise and de-duplicate" (flags `["A.ts.net","b.local"]`, env `NEOKOD_PUBLIC_HOST: "c.example.com, a.ts.net"` gives `["a.ts.net","b.local","c.example.com"]`; origin `"https://A.ts.net/"` gives `"https://a.ts.net"`), "rejects a public origin with a path or a non-http scheme", "tailscale allow logins are lower-cased and conflict with a non-loopback bind" (`assertServerBindAuthorized` fails with `ServerConfigConflictError`). Extend the test at line 297 into a table: `{127.0.0.1, loopback, no token}` true; `{::1, loopback, no token}` true; `{100.81.180.76, loopback, token "t".repeat(40)}` true; `{100.81.180.76, loopback, no token}` false; `{0.0.0.0, loopback, token "   "}` false; `{0.0.0.0, wsl-bearer, token "x"}` true; `{127.0.0.1, wsl-bearer, token "x"}` false. Add "assertServerBindAuthorized names the host and the missing token" (message contains `100.81.180.76` and `access token`).
  - `apps/server/src/transport/LocalTransportAuth.test.ts` (reuse `makeAuth` and `withAuth`, lines 8-37): "a non-loopback bind validates even when strict-transport is off" (`withAuth({ host: "100.81.180.76", strictTransport: false })("http://evil.example.com/", {})` fails `invalid_host`); "a non-loopback bind accepts IP literal Hosts" (`http://100.81.180.76:3773/` and `http://[fd7a:115c:a1e0::1]:3773/`); "a non-loopback bind needs declared public hosts for names" (`wv-htpc.tail1.ts.net` fails, then passes with `publicHosts: ["wv-htpc.tail1.ts.net"]`); "a non-loopback bind rejects Origin null and accepts a localhost origin" (`origin: "null"` fails `invalid_origin`; `origin: "http://localhost:3773"` passes); "a loopback bind still accepts Origin null" (regression pin). Tailscale: build the request with `HttpServerRequest.fromWeb(new Request(url, { headers })).modify({ remoteAddress: Option.some("127.0.0.1") })` and add `makeAuth({ tailscaleAllowLogins: ["kamo@example.com"], strictTransport: false })`: "allows a listed login case-insensitively", "rejects a missing header with tailscale_login_not_allowed", "rejects another login", "rejects when the peer is not loopback even with a listed login", "rejects when the peer address is unknown", "ignores the header entirely when no allowlist is set".
- Verify: from `apps/server`: `pnpm exec vp test run src/cli/config.test.ts src/transport/LocalTransportAuth.test.ts src/startupAccess.test.ts` and `pnpm exec tsgo --noEmit`; from `packages/contracts`: `pnpm exec tsgo --noEmit`. Repo root `vp check`, `vp run typecheck`. Manual (on the server, with A1 merged): `neokod serve --host 100.81.180.76 --port 3773` prints `Local URL: http://100.81.180.76:3773`; from the Mac `curl -i http://100.81.180.76:3773/.well-known/neokod/environment` returns 401, with the bearer returns 200, with `-H "Host: evil.example.com"` returns 403; `ss -ltn | grep 3773` on the server shows only the tailnet address; `NEOKOD_ACCESS_TOKEN=short neokod serve --host 0.0.0.0` exits with the token length error.
- Depends on: A1, A1c (both edit `docs/operations/self-hosting.md` and `README.md`). Effort: M. Commit message: `feat(server): --host for token-gated non-loopback binds, multi-value public origins, optional Tailscale login filter`

---

### B2 Client runtime core: `RemoteConnectionTarget`, catalog v3, registry register, setEnabled, remove, setToken

- Problem: the runtime can only hold in-memory targets. `ConnectionTarget` is a union of `PrimaryConnectionTarget` and `WslConnectionTarget` (`packages/client-runtime/src/connection/model.ts:28`), the schema-v2 catalog is an empty struct (`platform/storageDocument.ts:10-12`, `normalizeConnectionCatalogDocument` always returns the empty document, line 25-29), and `EnvironmentRegistry` (`connection/registry.ts:39-79`) has only `registerPlatform`, `reconcilePlatform` and `retryNow`. Entries are keyed by `EnvironmentId` and `installEntryLocked` (line 287-311) overwrites whatever holds that id, so a second server with a copied `environment-id` file would silently replace a machine. `primaryEnvironmentIdAtom` (`apps/web/src/state/primaryEnvironment.ts:5-10`) returns the first entry whose tag is `PrimaryConnectionTarget`, so a remote machine must never use that tag.
- Files to change (all under `packages/client-runtime/src/` unless noted):
  - `packages/shared/src/loopbackHost.ts` (new) and the `"./loopbackHost"` export in `packages/shared/package.json` (follow the existing entry shape, for example `"./Net"` at line 46).
  - `connection/model.ts` : add `RemoteConnectionTarget` and put it in `ConnectionTarget` (line 28).
  - `connection/catalog.ts` : `ConnectionCatalogEntry` (line 6-11), `RemoteMachineRecord`, `RemoteConnectionRegistration`, `connectionRegistrationCatalogEntry` (line 35-).
  - `connection/remoteMachines.ts` (new) : URL validation, errors, `RemoteMachineStore` service.
  - `platform/storageDocument.ts` : schema version 3.
  - `platform/storageDocument.test.ts` : update.
  - `environment/descriptor.ts` : optional bearer.
  - `connection/resolver.ts` : remote branch inside `prepare` (line 29-90).
  - `connection/registry.ts` : service interface (line 39-79), `make` (line 91-), `start` (line 281-285), `acquireSupervisor` (line 208-226), `installEntryLocked` (line 287-311), `installPlatformRegistration` (line 313-334), `removePlatformEnvironment` (line 336-370).
  - `connection/presentation.ts` : `connectionCatalogDisplayUrl` (line 84-91).
  - `connection/errors.ts` : neutral wording (lines 33 and 62).
  - `connection/index.ts` : exports.
  - `connection/registry.test.ts` (new), `connection/remoteMachines.test.ts` (new), `connection/resolver.test.ts`, `connection/presentation.test.ts` (extend).
  - `apps/web/src/state/primaryEnvironment.test.ts` (new).
- Change:
  1. `packages/shared/src/loopbackHost.ts`: `export function isLoopbackHostname(hostname: string): boolean` with the body already duplicated at `apps/server/src/http.ts:52-58` and `apps/web/src/environments/primary/target.ts:187-189` (trim, lower-case, strip one pair of brackets, then `127.0.0.1`, `::1`, `localhost`). Import it as `@neokod/shared/loopbackHost` in the new client-runtime code. Do not touch the two existing copies in this card.
  2. `model.ts`:
     ```ts
     export class RemoteConnectionTarget extends Schema.TaggedClass<RemoteConnectionTarget>()(
       "RemoteConnectionTarget",
       {
         ...ConnectionTargetBase,
         connectionId: Schema.String,
         httpBaseUrl: Schema.String,
         wsBaseUrl: Schema.String,
       },
     ) {}
     export const ConnectionTarget = Schema.Union([
       PrimaryConnectionTarget,
       WslConnectionTarget,
       RemoteConnectionTarget,
     ]);
     ```
     `connectionId` is `remote:<environmentId>`. Reusing `WslConnectionTarget` is wrong: `isDesktopLocalConnectionTarget` (`apps/web/src/connection/desktopLocal.ts:26-32`) and the WSL cleanup logic key on that tag.
  3. `catalog.ts`. Persisted record (this is the "persisted RemoteConnectionTarget" of the plan, named `RemoteMachineRecord` so it does not clash with the runtime tag):
     ```ts
     export const RemoteMachineRecord = Schema.Struct({
       id: EnvironmentId, // the machine's environment id from its descriptor; unique key
       label: Schema.String,
       baseUrl: Schema.String, // normalised origin, trailing slash, no path (see remoteMachines.ts)
       tokenRef: Schema.String, // key into the document's credentials; equals id today
       enabled: Schema.Boolean,
     });
     export type RemoteMachineRecord = typeof RemoteMachineRecord.Type;
     export class RemoteConnectionRegistration extends Schema.TaggedClass<RemoteConnectionRegistration>()(
       "RemoteConnectionRegistration",
       { target: RemoteConnectionTarget, token: Schema.String, enabled: Schema.Boolean },
     ) {}
     ```
     Extend `ConnectionCatalogEntry` with `readonly enabled?: boolean;` (absent means enabled, so existing fixtures such as `apps/web/src/test/browser/fixtures.ts` and the supervisor tests keep compiling) and `readonly remoteBearerToken?: string;`. `connectionRegistrationCatalogEntry` leaves `enabled` unset for the two platform tags. Add `connectionRegistrationCatalogEntry` handling for the new tag (it takes `PlatformConnectionRegistration | RemoteConnectionRegistration`). Do not add the remote registration to `PlatformConnectionRegistration` (that union is reconciled and removed by the host stream).
  4. `storageDocument.ts`:
     ```ts
     const StoredRemoteMachineCredential = Schema.Struct({
       ref: Schema.String,
       token: Schema.String,
     });
     export const ConnectionCatalogDocument = Schema.Struct({
       schemaVersion: Schema.Literal(3),
       machines: Schema.Array(RemoteMachineRecord),
       credentials: Schema.Array(StoredRemoteMachineCredential),
     });
     const ConnectionCatalogDocumentV2 = Schema.Struct({ schemaVersion: Schema.Literal(2) });
     export const StoredConnectionCatalogDocument = Schema.Union([
       ConnectionCatalogDocument,
       ConnectionCatalogDocumentV2,
       LegacyConnectionCatalogDocument,
     ]);
     export const EMPTY_CONNECTION_CATALOG_DOCUMENT: ConnectionCatalogDocument = Object.freeze({
       schemaVersion: 3,
       machines: [],
       credentials: [],
     });
     export function normalizeConnectionCatalogDocument(
       document: StoredConnectionCatalogDocument,
     ): ConnectionCatalogDocument {
       return document.schemaVersion === 3 ? document : EMPTY_CONNECTION_CATALOG_DOCUMENT;
     }
     ```
     v1 and v2 still decode and are discarded exactly as today (the v1 shape carries T3 pairing credentials and must not be migrated). One document holds records and tokens, so a single write is atomic: there is no second file that can drift. A `credentials` entry with no matching machine, or a machine whose `tokenRef` has no credential, is dropped on load with a warning (done in `remoteMachines.ts`, step 5).
  5. New `connection/remoteMachines.ts`:
     ```ts
     export type RemoteBaseUrlError = "invalid_url" | "scheme" | "userinfo" | "path";
     export function normalizeRemoteBaseUrl(raw: string): Result.Result<string, RemoteBaseUrlError>;
     ```
     Rules: `new URL(raw.trim())` (throw maps to `invalid_url`); protocol `https:` is accepted; `http:` is accepted only when `isLoopbackHostname(url.hostname)`; anything else is `scheme`; non-empty `username` or `password` is `userinfo`; `pathname` other than `/` (after removing one trailing slash) or any search or hash is `path`; result is `url.origin + "/"`. Errors and service:
     ```ts
     export class DuplicateEnvironmentError extends Schema.TaggedErrorClass<DuplicateEnvironmentError>()(
       "DuplicateEnvironmentError",
       { environmentId: EnvironmentId, existingLabel: Schema.String },
     ) {}
     export class EnvironmentDisabledError extends Schema.TaggedErrorClass<EnvironmentDisabledError>()(
       "EnvironmentDisabledError",
       { environmentId: EnvironmentId },
     ) {}
     export class PlatformEnvironmentProtectedError extends Schema.TaggedErrorClass<PlatformEnvironmentProtectedError>()(
       "PlatformEnvironmentProtectedError",
       { environmentId: EnvironmentId },
     ) {}
     export class ConnectionCatalogWriteError extends Schema.TaggedErrorClass<ConnectionCatalogWriteError>()(
       "ConnectionCatalogWriteError",
       { detail: Schema.String },
     ) {}
     export interface StoredRemoteMachine {
       readonly record: RemoteMachineRecord;
       readonly token: string;
     }
     export class RemoteMachineStore extends Context.Service<
       RemoteMachineStore,
       {
         readonly load: Effect.Effect<ReadonlyArray<StoredRemoteMachine>>; // never fails: a corrupt document is quarantined by the adapter and loads as empty
         readonly save: (
           machines: ReadonlyArray<StoredRemoteMachine>,
         ) => Effect.Effect<void, ConnectionCatalogWriteError>; // whole-document atomic write
       }
     >()("@neokod/client-runtime/connection/remoteMachines/RemoteMachineStore") {}
     export const storedMachinesFromDocument: (
       doc: ConnectionCatalogDocument,
     ) => ReadonlyArray<StoredRemoteMachine>;
     export const documentFromStoredMachines: (
       machines: ReadonlyArray<StoredRemoteMachine>,
     ) => ConnectionCatalogDocument;
     export function remoteRegistrationFromStored(
       machine: StoredRemoteMachine,
     ): RemoteConnectionRegistration; // httpBaseUrl = baseUrl, wsBaseUrl = deriveWsBaseUrl(baseUrl), connectionId = `remote:${id}`
     ```
     `storedMachinesFromDocument` skips and logs records whose `tokenRef` has no credential or whose `baseUrl` fails `normalizeRemoteBaseUrl`.
  6. `environment/descriptor.ts`: add `readonly bearerToken?: string` to the input. When present, run the request with the client wrapped as `HttpClient.mapRequest((request) => HttpClientRequest.bearerToken(request, bearerToken))`. This is the logic currently private to `apps/web/src/connection/platform.ts:86-104` (`descriptorFor`); B2b makes the web code call this instead, so the logic lives once. The descriptor endpoint declares no `headers` schema (`packages/contracts/src/environmentHttp.ts:112-117`), so the bearer cannot be passed as an endpoint argument.
  7. `resolver.ts`: add a branch for `target._tag === "RemoteConnectionTarget"` before the WSL code at line 73. Token missing: `credentialMissingError(target.connectionId)`. Then fetch the descriptor with the bearer and compare: `descriptor.environmentId !== target.environmentId` fails with `environmentMismatchError({ expected, actual })` (defined in `connection/errors.ts:16` and currently unused). Then obtain the ticket exactly like the authenticated loopback path (`resolveLoopbackWebSocketUrl`, line 54-58) and return `loopbackAuthorization: { _tag: "LoopbackBearer", token }` and `wslBearerAuthorization: null`. The `Loopback` name is historical (it is the stable-token bearer plus ticket flow added by A1); leave a one-line comment instead of renaming types in this card. Map errors with `mapRemoteEnvironmentError`.
  8. `registry.ts`. Add to the service interface (exact signatures):
     ```ts
     readonly register: (registration: RemoteConnectionRegistration) => Effect.Effect<void, DuplicateEnvironmentError | ConnectionCatalogWriteError>;
     readonly setEnabled: (environmentId: EnvironmentId, enabled: boolean) => Effect.Effect<void, EnvironmentNotRegisteredError | PlatformEnvironmentProtectedError | ConnectionCatalogWriteError>;
     readonly setToken: (environmentId: EnvironmentId, token: string) => Effect.Effect<void, EnvironmentNotRegisteredError | PlatformEnvironmentProtectedError | ConnectionCatalogWriteError>;
     readonly remove: (environmentId: EnvironmentId) => Effect.Effect<void, EnvironmentNotRegisteredError | PlatformEnvironmentProtectedError | ConnectionCatalogWriteError>;
     ```
     Change `state` to fail with `EnvironmentNotRegisteredError | EnvironmentDisabledError`. In `make` read `const remoteStore = yield* RemoteMachineStore`, create `const machines = yield* Ref.make<ReadonlyMap<EnvironmentId, StoredRemoteMachine>>(new Map())` and `const catalogLock = yield* Semaphore.make(1)`.
     - `start`: after the `getAndSet(started)` guard, `remoteStore.load`, fill `machines`, and for each call `installEntryLocked(connectionRegistrationCatalogEntry(remoteRegistrationFromStored(m)))` inside `withLeaseLock`.
     - `installEntryLocked`: when `entry.enabled === false`, write the entry into `entries` but do not call `createServiceScope`. The existing `closeServiceScope` call stays first.
     - `acquireSupervisor`: after `getEntry`, `if (entry.enabled === false) return yield* new EnvironmentDisabledError({ environmentId })`. `followStream` already turns a failing `acquireSupervisor` into an empty stream (line 250-275), so disabled machines produce no state stream.
     - `register`: `catalogLock.withPermits(1)`: if `entries` already holds `target.environmentId` (any tag, including the primary) fail `DuplicateEnvironmentError({ environmentId, existingLabel: existing.target.label })`; build `StoredRemoteMachine` (`tokenRef = id`), `remoteStore.save([...machines.values(), next])`, and only after the save succeeds update `machines` and call `installEntryLocked`. A failed save leaves memory unchanged.
     - `setEnabled`, `setToken`, `remove`: same shape. Look up the entry (`EnvironmentNotRegisteredError` when absent); if it is not a `RemoteConnectionTarget` fail `PlatformEnvironmentProtectedError`. Save first, then apply: `setEnabled(false)` calls `closeServiceScope` and rewrites the entry with `enabled: false` (cached shell and thread data stay); `setEnabled(true)` rewrites the entry and `createServiceScope`; `setToken` rewrites `remoteBearerToken` (the changed entry makes `acquireSupervisor` close and rebuild the scope, line 215-222, which also clears a `blocked` authentication state); `remove` reuses the teardown in `removePlatformEnvironment` (extract its body into a private `teardownEnvironment(environmentId)` used by both: close scope, delete from `entries`, `cache.clear`, `ownedDataCleanup.clear`).
     - `installPlatformRegistration`: if `entries` holds that id as a `RemoteConnectionTarget`, the platform entry wins: log a warning, remove the machine from `machines`, `remoteStore.save` (ignore failure with a warning) and continue. This covers the owner adding the same server they browse from.
     - Reconnect storms: do not add retry logic. The supervisor already backs off and parks on `ConnectionBlockedError` (`connection/supervisor.ts`, `SupervisorConnectionPhase` `blocked`).
  9. `presentation.ts:84-91`: add `case "RemoteConnectionTarget": return entry.target.httpBaseUrl;`. `errors.ts:33` and `:62`: change the wording to `The environment credential was rejected.` and `The environment rejected its bearer credential.` (these strings are shown for any bearer target now). `connection/index.ts`: `export * from "./remoteMachines.ts";`.
  10. Do not touch `apps/web/src/state/primaryEnvironment.ts`; add its test only.
- Do not: reuse the `PrimaryConnectionTarget` tag or `WslConnectionTarget` for remote machines; revive pairing, DPoP, relay, SSH or the old profile and credential store split from history (see below); migrate v1 data; connect a disabled machine, even briefly; write the in-memory state before the save succeeds; render or log `remoteBearerToken` anywhere (it is inside `ConnectionCatalogEntry`, which the UI atoms can read, so UI code must treat it as write-only).
- Reuse from history (`git show 4c12112f1^:<path>`): reuse the shape of `connection/registry.ts` lines 389-472 (`register`) and 544-604 (`remove`), the test scaffolding in `connection/registry.test.ts` (fixtures `TARGET`, `SECOND_TARGET`, fake `ConnectionDriver`, `Connectivity`, `ConnectionWakeups`), and the idea in `connection/resolver.ts` that a bearer target fetches a descriptor and checks the environment id. Do not reuse `credentialStore.ts` and `profileStore.ts` (two stores that can disagree; replaced by one document), `onboarding.ts`, `authorization/*`, `relay/*`, or anything that touches `DPoP`.
- Tests (each new test must FAIL at base, because the symbols do not exist; the document tests fail because version 3 is not accepted):
  - `platform/storageDocument.test.ts`: change the two existing tests to expect the v3 empty document; add "decodes a v3 document with machines and credentials", "a v2 document normalises to the empty v3 document", "a v1 document with credentials is discarded", "rejects schemaVersion 4".
  - `connection/remoteMachines.test.ts` (new): `normalizeRemoteBaseUrl` table: `https://wv-htpc.tail1.ts.net` gives `https://wv-htpc.tail1.ts.net/`; `https://host:8443/` keeps the port; `http://localhost:3773` and `http://[::1]:3773` accepted; `http://100.81.180.76:3773` gives `scheme`; `ftp://x` gives `scheme`; `https://u:p@host` gives `userinfo`; `https://host/app` gives `path`; `https://host/?a=1` gives `path`; `not a url` gives `invalid_url`. `storedMachinesFromDocument` drops a record with a missing credential and one with a bad URL.
  - `connection/registry.test.ts` (new, adapted from the history file, with an in-memory `RemoteMachineStore` backed by a `Ref` that can be told to fail `save`): "register persists then installs", "register rejects a duplicate environment id with the existing label and leaves the store untouched", "register rejects the primary's environment id", "a failed save leaves the registry unchanged", "setEnabled(false) closes the supervisor, keeps the entry and the cache, and state() fails with EnvironmentDisabledError", "setEnabled(true) connects again", "setToken rebuilds the supervisor", "remove clears the entry, the cache and owned data, and saves without the machine", "setEnabled, setToken and remove on a platform environment fail with PlatformEnvironmentProtectedError", "start loads persisted machines and does not connect disabled ones", "a platform registration with the same id as a stored remote machine wins and drops the machine".
  - `connection/resolver.test.ts`: "remote target uses the stored token for the ticket and returns a loopback bearer", "remote target fails with environmentMismatchError when the descriptor id differs", "remote target without a token fails with credentialMissingError". Reuse the fake `HttpClient` already used in that file (`loopbackAuthToken: "launch-token"` case at line 68).
  - `connection/presentation.test.ts`: `connectionCatalogDisplayUrl` returns the base URL for a remote entry.
  - `apps/web/src/state/primaryEnvironment.test.ts` (new): with a catalog that holds only a `RemoteConnectionTarget` entry, `primaryEnvironmentIdAtom` is `null`; with a primary and a remote entry it returns the primary regardless of insertion order. Build the registry state the way `apps/web/src/test/browser/fixtures.ts` builds its catalog fixture.
- Verify: from `packages/client-runtime`: `pnpm exec vp test run src/platform/storageDocument.test.ts src/connection/remoteMachines.test.ts src/connection/registry.test.ts src/connection/resolver.test.ts src/connection/presentation.test.ts src/connection/supervisor.test.ts` then `pnpm exec tsgo --noEmit`; from `apps/web`: `pnpm exec vp test run src/state/primaryEnvironment.test.ts` and `pnpm exec tsgo --noEmit` (adding a union member can break exhaustive switches; the compiler lists them, the known sites are `connection/presentation.ts:84` and nothing else in `apps/web` switches on the tag). From `packages/shared`: `pnpm exec tsgo --noEmit`. Repo root: `vp check`, `vp run typecheck`.
- Depends on: A1 (descriptor requires the bearer), B1 for a reachable remote. Effort: L. Commit message: `feat(client-runtime): persisted remote machines with register, enable, token and remove`

---

### B2b Persistence adapters and atom commands for remote machines

- Problem: B2 defines `RemoteMachineStore` but nothing implements it. The browser catalog store only reads (`makeCatalogStore` in `apps/web/src/connection/storage.ts:253-310` exposes `read` and writes once to normalise). The desktop store is a stub that ignores what it is given: `get` in `apps/desktop/src/app/DesktopConnectionCatalogStore.ts` always returns `Option.some(canonicalEmptyCatalog)` and `set` discards its argument and rewrites the empty document, so nothing could be saved. The web layer also duplicates the descriptor fetch (`apps/web/src/connection/platform.ts:86-104`).
- Files to change:
  - `apps/web/src/connection/storage.ts` : `CatalogStore` (line 249-251), `makeCatalogStore` (line 253-310), `connectionStorageLayer` (line 312-), `decodeCatalog` and `encodeCatalog` (line 191-203).
  - `apps/web/src/connection/storage.test.ts` : extend.
  - `apps/web/src/connection/platform.ts` : replace `descriptorFor` (line 86-104) by `fetchRemoteEnvironmentDescriptor({ httpBaseUrl, bearerToken })`.
  - `apps/desktop/src/app/DesktopConnectionCatalogStore.ts` and `.test.ts` : real encrypt and decrypt.
  - `packages/client-runtime/src/state/connections.ts` : commands (next to `retryNow`, line 80-87).
- Change:
  1. Web store. Give `CatalogStore` a `write: (document: ConnectionCatalogDocumentType) => Effect<void, ConnectionTransientError>` that holds the existing `lock` semaphore, encodes with `encodeCatalog`, calls `backend.write(encoded)` and only then replaces the cached `state` `Ref`. IndexedDB `put` runs in one transaction (`writeDatabaseValue`, line 124-141) so the write is all or nothing; the desktop bridge path (`makeCatalogBackend`, line 212-247) is already atomic in the main process (B2b step 2). A decode failure keeps the existing quarantine behaviour (`backend.quarantine`, defined at line 244 and used at line 282-285) and loads as empty, so a corrupt catalog cannot block start (T3 issue 4750). In `connectionStorageLayer` build the store with `RemoteMachineStore.of({ load: Effect.map(catalog.read, storedMachinesFromDocument), save: (machines) => catalog.write(documentFromStoredMachines(machines)).pipe(Effect.mapError((e) => new ConnectionCatalogWriteError({ detail: e.message }))) })` and return `Context.make(EnvironmentCacheStore, cacheStore).pipe(Context.add(RemoteMachineStore, remoteStore))` (`Context.add` is at `.repos/effect-smol/packages/effect/src/Context.ts:722`). Token storage in the browser is therefore the IndexedDB `catalog` object store, same origin as the UI, same exposure as card A2's `localStorage` token (an XSS on the UI origin exposes every saved token). Do not add a second token store.
  2. Desktop store. Restore real behaviour from `git show 549ff8923^:apps/desktop/src/app/DesktopConnectionCatalogStore.ts` (422 lines; the parts to reuse are `get` using `safeStorage.decryptString` with base64 decoding, and `set` encrypting the string it receives). Keep today's atomic temp-file plus `rename` write (`writeCatalog`, the `.tmp` plus `fileSystem.rename` block), the fail-open rule (an undecryptable or corrupt file is renamed to `connection-catalog.json.corrupt-<epoch>` and `get` returns `Option.none()`, so the local environment still registers; this is the behaviour commit `259d12578` introduced and the existing test "replaces an undecryptable legacy catalog with the empty catalog" pins), and the `savedEnvironmentRegistryPath` purge. `set(catalog)` must encrypt and write the string it receives and return `false` when `isEncryptionAvailable` is false (the renderer then reports "Desktop secure storage is unavailable", `apps/web/src/connection/storage.ts:222-231`). Remove `canonicalEmptyCatalog` and the `ConnectionCatalogDocument` import. Update the empty-document expectations in the tests to v3.
  3. Web platform: delete `descriptorFor` and call the shared function; for WSL and loopback registrations pass the same `bearerToken` they pass today (`platform.ts:107-115`, `:157`). Behaviour must not change; the existing `platform.test.ts` and `desktopLocal.test.ts` stay green.
  4. Atom commands in `state/connections.ts` (next to `retryNow`, line 80-87), all with `createRuntimeCommand(runtime, { label, scheduler: commandScheduler, concurrency: serial, execute })` and returned from `createEnvironmentCatalogAtoms`: `registerRemoteMachine` (input `RemoteConnectionRegistration`), `setRemoteMachineEnabled` (input `{ environmentId, enabled }`), `setRemoteMachineToken` (input `{ environmentId, token }`), `removeRemoteMachine` (input `EnvironmentId`). Each calls the matching registry method. Add `verifyRemoteMachine = (input: { baseUrl: string; token: string }) => Effect<ExecutionEnvironmentDescriptor, ConnectionAttemptError | RemoteBaseUrlErrorWrapper>` as a plain exported Effect function (not an atom) in `connection/remoteMachines.ts`: `normalizeRemoteBaseUrl`, then `fetchRemoteEnvironmentDescriptor({ httpBaseUrl, bearerToken, timeoutMs: 10_000 })` mapped with `mapRemoteEnvironmentError`. B3 calls it before `register`.
- Do not: store tokens in `localStorage` or in a second IndexedDB store; change `DATABASE_VERSION` (the `catalog` store already exists); weaken the desktop fail-open behaviour (a bad catalog must never stop the primary environment from registering); log the catalog string or the decrypted document.
- Tests (must FAIL at base):
  - `apps/web/src/connection/storage.test.ts` (read the file first and reuse its fake `CatalogBackend`): "write stores the encoded v3 document and updates the cache", "a failing backend write leaves the cached document unchanged and fails", "a corrupt document is quarantined and loads as empty", "RemoteMachineStore round-trips a machine and its token", "concurrent saves are serialised" (fire two `save` calls with `Effect.all` concurrency 2, assert the final backend value equals the second call's input and no interleaving).
  - `apps/desktop/src/app/DesktopConnectionCatalogStore.test.ts` (reuse its fake `ElectronSafeStorage`): "set encrypts and persists the given catalog and get returns it", "set returns false and writes nothing when encryption is unavailable", "an undecryptable file is renamed aside and get returns none", "the file on disk does not contain the token in clear text" (assert `readFileString` of the catalog path does not include the token substring).
  - `packages/client-runtime/src/connection/remoteMachines.test.ts`: "verifyRemoteMachine returns the descriptor and sends the bearer", "verifyRemoteMachine maps 401 to a blocked authentication error", "verifyRemoteMachine rejects an http non-loopback URL before any request" (assert the fake HttpClient saw zero requests).
- Verify: `pnpm exec vp test run src/connection/storage.test.ts src/connection/platform.test.ts src/connection/desktopLocal.test.ts` from `apps/web`; `pnpm exec vp test run src/app/DesktopConnectionCatalogStore.test.ts` from `apps/desktop`; `pnpm exec vp test run src/connection/remoteMachines.test.ts` from `packages/client-runtime`; each package `pnpm exec tsgo --noEmit`; repo root `vp check` and `vp run typecheck`.
- Depends on: B2, and A2 (both cards edit `apps/web/src/connection/platform.ts`; land A2 first to avoid a conflict). Effort: M. Commit message: `feat(web,desktop): persist remote machines in the connection catalog and add machine commands`

---

### B3 Settings > Connections "Machines": add, enable switch, remove, status, last error

- Problem: `ConnectionsSettings` (`apps/web/src/components/settings/ConnectionsSettings.tsx`, 305 lines) shows only "This environment" and the WSL backend (`SettingsSection title="This environment"`, line 240). There is no list of saved machines and no way to add, switch off, re-token or remove one. The runtime has no disabled state in what the UI sees: `EnvironmentConnectionPhase` is `available | offline | connecting | reconnecting | connected | error` (`packages/client-runtime/src/connection/presentation.ts:6-12`) and a blocked authentication failure is indistinguishable from any other `error` (`presentConnectionState`, line 26-55). The shared `Switch` (`apps/web/src/components/ui/switch.tsx:9`) draws the unchecked track with `bg-input`, which is `--line-strong`: `#565656` on the dark card `#1f1f1f` is about 2.3:1 and `#b9b9b9` on the light panel `#f7f7f7` is about 1.8:1 (values from `apps/web/src/index.css:402,504,444,487`, ratios computed by hand, not measured in a browser), below the 3:1 non-text contrast floor. That is the T3 complaint (issues 14979, 15051) that a switched-off machine is hard to see.
- Files to change:
  - `packages/client-runtime/src/connection/presentation.ts` : `EnvironmentConnectionPhase` (line 6), `EnvironmentConnectionPresentation` (line 14-18), `presentConnectionState` (line 26), `connectionStatusText` (line 57-77), `connectionPhaseMessage` (line 93-), new `presentEnvironmentEntry`.
  - `packages/client-runtime/src/state/presentation.ts` : `presentationAtom` (line 32-47) uses `presentEnvironmentEntry`.
  - `packages/client-runtime/src/connection/presentation.test.ts`.
  - `apps/web/src/components/settings/ConnectionsSettings.logic.ts` and `.logic.test.ts` (new functions).
  - `apps/web/src/components/settings/MachinesSection.tsx` (new), `AddMachineDialog.tsx` (new), `MachinesSection.browser.tsx` (new).
  - `apps/web/src/components/settings/ConnectionsSettings.tsx` : mount `<MachinesSection />` after the "This environment" section (after line 261, before the `AlertDialog` at line 263).
- Change:
  1. Presentation. Add `"disabled"` to `EnvironmentConnectionPhase` and `readonly blocked?: ConnectionBlockedReason;` to `EnvironmentConnectionPresentation` (optional key so existing literals in tests still compile; import `ConnectionBlockedReason` from `./model.ts`, defined at `model.ts:44-50`). In the `blocked` case of `presentConnectionState` add `...(state.lastFailure?._tag === "ConnectionBlockedError" ? { blocked: state.lastFailure.reason } : {})`. Add:
     ```ts
     export function presentEnvironmentEntry(
       entry: ConnectionCatalogEntry,
       state: SupervisorConnectionState,
     ): EnvironmentConnectionPresentation {
       return entry.enabled === false
         ? { phase: "disabled", error: null, traceId: null }
         : presentEnvironmentConnection(state);
     }
     ```
     `connectionStatusText`: `case "disabled": return "Disabled";`. `connectionPhaseMessage`: `case "disabled": return \`${label} is disabled\`;`placed before the network-offline check so a disabled machine never reads "You are offline". In`state/presentation.ts`replace`presentEnvironmentConnection(state)`by`presentEnvironmentEntry(entry, state)`. The compiler lists every exhaustive `switch` on the phase; fix each by adding the case.
  2. `ConnectionsSettings.logic.ts` (pure, unit tested):
     ```ts
     export type MachineStatus =
       | "connected"
       | "connecting"
       | "offline"
       | "auth-failed"
       | "disabled";
     export function resolveMachineStatus(
       connection: EnvironmentConnectionPresentation,
     ): MachineStatus;
     export function machineStatusLabel(status: MachineStatus): string; // "Connected" | "Connecting" | "Offline" | "Auth failed" | "Disabled"
     export function describeMachineRegistrationError(error: unknown): string;
     ```
     `resolveMachineStatus`: phase `disabled` gives `disabled`; `connected` gives `connected`; `error` with `blocked === "authentication"` gives `auth-failed`; `connecting` and `available` give `connecting`; `reconnecting`, `offline` and any other `error` give `offline`. `describeMachineRegistrationError` (exact strings): `RemoteBaseUrlError` `invalid_url` gives `That is not a valid address.`; `scheme` gives `Use an https:// address. http:// is only allowed for localhost.`; `userinfo` gives `Remove the user name and password from the address.`; `path` gives `Use the server address without a path, for example https://wv-htpc.example.ts.net.`; `ConnectionBlockedError` with reason `authentication` gives `The machine rejected this token.`; other `ConnectionBlockedError` gives its `detail`; `ConnectionTransientError` gives `Could not reach the machine: ${detail}`; `DuplicateEnvironmentError` gives `This machine is already added as "${existingLabel}". If you copied the Neokod data folder from another machine, delete userdata/environment-id in that data folder on one of them and restart it.`; `ConnectionCatalogWriteError` gives `Could not save the machine on this device: ${detail}`; anything else gives `Something went wrong.`.
  3. `MachinesSection.tsx`. Split into a presentational `MachinesList` and a container `MachinesSection`:
     `ts
     export interface MachineRowModel {
       readonly environmentId: EnvironmentId;
       readonly label: string;
       readonly displayUrl: string | null;
       readonly status: MachineStatus;
       readonly lastError: string | null;
       readonly serverVersion: string | null;
       readonly os: string | null;
     }
     export function MachinesList(props: {
       readonly machines: ReadonlyArray<MachineRowModel>;
       readonly busyEnvironmentId: EnvironmentId | null;
       readonly onAdd: () => void;
       readonly onToggle: (id: EnvironmentId, enabled: boolean) => void;
       readonly onRetry: (id: EnvironmentId) => void;
       readonly onUpdateToken: (id: EnvironmentId) => void;
       readonly onRemove: (id: EnvironmentId) => void;
     }): JSX.Element;
     `
     The container builds rows from `useEnvironments()` (`apps/web/src/state/environments.ts:34`) keeping only `environment.entry.target._tag === "RemoteConnectionTarget"`, with `status = resolveMachineStatus(environment.connection)`, `lastError = environment.connection.error`, `serverVersion = environment.serverConfig?.environment.serverVersion ?? null`, `os = environment.serverConfig?.environment.platform.os ?? null`. Commands come from `useAtomCommand(environmentCatalog.registerRemoteMachine | setRemoteMachineEnabled | setRemoteMachineToken | removeRemoteMachine | retryNow, { reportFailure: false })` (B2b step 4), the same hook ChatView uses for `retryNow` (`ChatView.tsx:1060`); failures go through `squashAtomCommandFailure` and a `stackedThreadToast` with title `Could not <verb> machine` and description from `describeMachineRegistrationError`.
     Layout, one `SettingsSection title="Machines"` with `headerAction={<Button size="xs" onClick={onAdd}>Add machine</Button>}`. Empty state row (`SettingsRow`): title `No machines yet`, description `Add another computer that runs Neokod to start threads on it. Its address and access token stay on this device.` Each machine is a `SettingsRow`: title the label plus a status `Badge` (`size="sm"`; variants from `components/ui/badge.tsx:23-33`: connected `success`, connecting `info`, offline `warning`, auth-failed `error`, disabled `outline`); description `displayUrl` and, when known, `Neokod ${serverVersion} on ${os}`; `status` slot shows `lastError` in `text-destructive` for offline and auth-failed; `control` holds, left to right: a visible text `Enabled` or `Disabled` (so state is never only a colour), the `Switch` (`aria-label={\`Enable ${label}\`}`, `checked={status !== "disabled"}`, disabled while `busyEnvironmentId === environmentId`), `Retry`(outline, only for offline and connecting-after-failure),`Update token`(outline, only for auth-failed), and`Remove`(ghost, destructive text). A disabled row gets`className="opacity-80"`on its text, never on the switch.
Switch contrast: pass`className="data-unchecked:bg-text-tertiary"`to the`Switch` in this list (`cn`merges the conflicting`data-unchecked:bg-input`; `bg-text-tertiary`exists through`--color-text-tertiary`, `index.css:55`). Computed contrast: dark `#8a8a8a`on card`#1f1f1f`is about 4.7:1, light`#767676`on panel`#f7f7f7`is about 4.2:1. Do not change`components/ui/switch.tsx`itself (it is shared by every settings page; that is a separate UI decision).
Remove: reuse the`AlertDialog` pattern in this file (`ConnectionsSettings.tsx:263-302`): title `Remove ${label}?`, description `This deletes the saved address, the access token and the cached data for this machine from this device. Threads and projects on the machine are not touched.`, buttons `Cancel`and`Remove`. After removal the thread list drops that machine's projects because the registry clears its cache (B2).
  4. `AddMachineDialog.tsx` (`Dialog` from `components/ui/dialog.tsx`). Fields: `Address` (placeholder `https://wv-htpc.your-tailnet.ts.net`), `Access token` (`type="password"`, `autoComplete="off"`), `Name` (shown after verification, prefilled with the machine's own label, editable). Button `Check connection` calls `verifyRemoteMachine({ baseUrl, token })` (B2b) through `remoteHttpRuntime.runPromiseExit(...)` (`apps/web/src/lib/runtime.ts:13`). On success show a summary line `Found ${descriptor.label}, Neokod ${descriptor.serverVersion}, ${descriptor.platform.os} ${descriptor.platform.arch}` and enable `Add machine`. `Add machine` builds `new RemoteConnectionRegistration({ target: new RemoteConnectionTarget({ environmentId: descriptor.environmentId, label: name, connectionId: \`remote:${descriptor.environmentId}\`, httpBaseUrl: normalizedBaseUrl, wsBaseUrl: deriveWsBaseUrl(normalizedBaseUrl) }), token, enabled: true })`and calls`registerRemoteMachine`. Any change to the address or token after a successful check clears the summary and disables `Add machine`again. Errors render under the form using`describeMachineRegistrationError`. The same dialog component with `mode="token"`(no address or name fields, prefilled read-only address) serves`Update token`and calls`setRemoteMachineToken`after a successful check against the stored address and the same environment id (a descriptor with a different`environmentId`shows`This address belongs to a different machine.`).
  5. The remote server must accept this UI's origin. When the owner opens the UI from `https://neokod.mashdev.xyz` and adds `https://wv-htpc.<tailnet>.ts.net`, the machine needs `--public-origin https://neokod.mashdev.xyz` (card B1). Show this hint in the dialog under a failed check whose cause is a fetch error: `If this page is not served from the machine itself, start the machine with --public-origin <this page's origin>.` using `window.location.origin`.
- Do not: show, log or put the token in a toast, an error string or the DOM outside the password field; hide the enable state (it must be readable without colour); change `components/ui/switch.tsx` or other settings pages; list the primary or WSL environments in "Machines" (filter on `RemoteConnectionTarget` only); call `register` before a successful `Check connection`.
- Tests (each new test must FAIL at base, since the symbols do not exist):
  - `packages/client-runtime/src/connection/presentation.test.ts`: "a disabled entry presents phase disabled regardless of state" (`presentEnvironmentEntry({ target, wslBearerToken: Option.none(), enabled: false }, connectedState).phase === "disabled"`), "a blocked authentication failure sets blocked to authentication", "a blocked configuration failure sets blocked to configuration", "connectionStatusText(disabled) is Disabled". Reuse the state fixture helpers already in that file.
  - `apps/web/src/components/settings/ConnectionsSettings.logic.test.ts` (new): `resolveMachineStatus` table for all seven phase and `blocked` combinations; `describeMachineRegistrationError` for each class listed in step 2 (construct `DuplicateEnvironmentError`, `ConnectionBlockedError`, `ConnectionTransientError` from `@neokod/client-runtime/connection`).
  - `apps/web/src/components/settings/MachinesSection.browser.tsx` (new; mirror `SubagentsPanel.browser.tsx` imports): render `MachinesList` with one row per status. Assert: all five badge texts are visible; the disabled row shows `Disabled` text next to an unchecked switch; clicking the switch calls `onToggle(id, true)`; `Retry` appears only on the offline row and `Update token` only on the auth-failed row; the empty list shows `No machines yet`; the remove button calls `onRemove`. Contrast test: for `theme of ["light", "dark"]` set `document.documentElement.classList.toggle("dark", theme === "dark")`, render the list with a disabled row, read the unchecked switch's `getComputedStyle(el).backgroundColor` and its nearest `[class*="bg-card"]` ancestor's background, convert both to RGB through a 1 pixel `canvas` `fillStyle` round trip (the CSS uses `color-mix`, so `getComputedStyle` may return `color(srgb ...)`), compute the WCAG ratio and `expect(ratio).toBeGreaterThanOrEqual(3)`. If the assertion fails with the suggested class, adjust the class (not the threshold).
- Verify: from `packages/client-runtime`: `pnpm exec vp test run src/connection/presentation.test.ts` and `pnpm exec tsgo --noEmit`; from `apps/web`: `pnpm exec vp test run src/components/settings/ConnectionsSettings.logic.test.ts`, then `pnpm exec vp test run src/components/settings/MachinesSection.browser.tsx` (browser project; if the `--project browser` flag is needed use it, see `apps/web/vite.config.ts:50`), then `pnpm exec tsgo --noEmit`; repo root `vp check` and `vp run typecheck`. Manual: add the server over Tailscale, see `Connected`, flip the switch off (status `Disabled`, `Enabled`/`Disabled` text flips, no socket to the machine in the server's access log), flip on (connects), rotate the server token file and restart (status `Auth failed` within one backoff, `Update token` fixes it), remove (row and its projects disappear).
- Depends on: B2, B2b. Effort: M. Commit message: `feat(web): Machines list in Settings > Connections with enable switch, status and add/remove`

---

### B3b "Run on" picker, reconnect banner and add-project for a remote machine

- Problem: the picker lists every machine that holds a project with the same logical key but draws all of them alike. `logicalProjectEnvironments` (`apps/web/src/components/ChatView.tsx:1528-1559`) builds `{ environmentId, projectId, label, isPrimary }` and `BranchToolbarEnvironmentSelector.tsx:70-86` renders them with no status, so an offline or switched-off machine looks selectable. A reconnect banner already exists for the thread's own environment (`composerBannerItems`, `ChatView.tsx:1719-1752`, buttons `Reconnect` and `Connections`) but treats every non-connected phase as "unavailable, reconnect", which is wrong for a disabled machine (reconnect cannot help; `retryNow` on a disabled machine fails after B2) and has no path to fix a rejected token. The add-project flow (`CommandPalette.tsx:1214-1356`, `handleAddProjectForEnvironment`) works against any listed environment and already browses the machine's own file system (`filesystemEnvironment.browse`, line 655-668) and hides the native folder picker for non-local machines (`canOpenProjectFromFileManager`, line 1613-1625), but it always sends `createWorkspaceRootIfMissing: true` (line 1302), so a mistyped path on a remote machine silently creates a directory there, and the environment list offers disabled machines (`addProjectEnvironmentOptions`, line 537-560).
- Files to change:
  - `apps/web/src/components/BranchToolbar.logic.ts` : `EnvironmentOption` (line 8-13), new `buildEnvironmentOptions`.
  - `apps/web/src/components/BranchToolbar.logic.test.ts` (exists; extend it).
  - `apps/web/src/components/BranchToolbarEnvironmentSelector.tsx` (89 lines): item rendering (line 42-56 locked label, line 70-86 popup items).
  - `apps/web/src/components/BranchToolbar.tsx` : the mobile menu list (line 141-159) gets the same marks.
  - `apps/web/src/components/ChatView.tsx` : `logicalProjectEnvironments` (line 1528-1559) calls the new builder; banner (line 1719-1752); `onEnvironmentChange` (line 2323-2341) rejects disabled targets.
  - `apps/web/src/components/CommandPalette.tsx` : `AddProjectEnvironmentOption` (line 169) and `addProjectEnvironmentOptions` (line 537-560), `handleAddProjectForEnvironment` (line 1214-1356), `addProjectEnvironmentItems` (line 957-969).
- Change:
  1. `BranchToolbar.logic.ts`:
     ```ts
     export type EnvironmentOptionStatus =
       | "connected"
       | "connecting"
       | "offline"
       | "auth-failed"
       | "disabled";
     export interface EnvironmentOption {
       environmentId: EnvironmentId;
       projectId: ProjectId;
       label: string;
       isPrimary: boolean;
       status: EnvironmentOptionStatus;
     }
     export function buildEnvironmentOptions(input: {
       readonly projects: ReadonlyArray<{ environmentId: EnvironmentId; id: ProjectId }>;
       readonly primaryEnvironmentId: EnvironmentId | null;
       readonly environmentById: ReadonlyMap<
         EnvironmentId,
         { label: string; connection: EnvironmentConnectionPresentation }
       >;
     }): EnvironmentOption[];
     ```
     Move the loop and sort currently inline in `ChatView.tsx:1528-1559` into it unchanged (dedupe by environment, primary first, then label), and add `status: resolveMachineStatus(connection)` (import from `./settings/ConnectionsSettings.logic`; a missing environment gives `offline`). `ChatView` passes `projects` already filtered to the logical key, so the filter stays in `ChatView`. The primary environment reports `connected` or `connecting` through the same function.
  2. Selector. In the popup (`BranchToolbarEnvironmentSelector.tsx:70-86`) and the mobile list (`BranchToolbar.tsx:141-159`): a `disabled` option renders as a disabled item (`SelectItem disabled`, `MenuRadioItem disabled`) with the trailing text `Disabled`; `offline`, `auth-failed` and `connecting` options stay selectable and show a trailing text (`Offline`, `Auth failed`, `Connecting`) in `text-muted-foreground`; `connected` shows nothing. The trigger (`SelectTrigger`, line 62) and the locked label (line 42-55) show a small `WifiOffIcon` (`lucide-react`, already used in `ChatView.tsx` for the banner) when the active option is not `connected`. Selection of offline machines is allowed so a draft can be prepared; sending is already blocked by the banner copy "Reconnect this environment before sending messages" (`ChatView.tsx:1732`).
  3. `ChatView.tsx` `onEnvironmentChange` (line 2323-2341): after finding `target` add `if (target.status === "disabled") return;`. Threads never move: `envLocked` (line 2314-2318) already blocks the picker once the thread has messages or a live session; do not change it.
  4. Banner (`ChatView.tsx:1719-1752`). Branch on the active environment's status: `disabled`: title `${label}: Disabled`, description `This machine is switched off on this device. Turn it on to use it.`, primary action `Turn on` which calls the `setRemoteMachineEnabled` atom command with `enabled: true`, secondary `Connections`; `auth-failed`: title `${label}: Auth failed`, description `The machine rejected the saved access token.`, primary action `Update token` (navigates to `/settings/connections`, where the row shows `Update token`), no `Reconnect`; every other non-connected status keeps today's `Reconnect` and `Connections` buttons. `activeEnvironmentUnavailable` (line 1497-1498) is already true for `disabled` because the phase is not `connected`.
  5. Add project on a machine (`CommandPalette.tsx`). (a) `addProjectEnvironmentOptions`: skip environments whose `connection.phase === "disabled"`; add `status: EnvironmentOptionStatus` and, in `addProjectEnvironmentItems` (line 957-969), set `description` to `${option.environmentId}` for connected machines and to `Offline` or `Auth failed` for the others. (b) At the top of `handleAddProjectForEnvironment`, look up the environment; when its phase is not `connected` show the toast `Failed to add project` / `${label} is not connected. Reconnect it in Settings > Connections, then try again.` and return. (c) Send `createWorkspaceRootIfMissing: false` when `environment.entry.target._tag === "RemoteConnectionTarget"`, and keep `true` for the primary and desktop-local environments (their behaviour does not change). (d) In the failure toast for a remote machine, prefix the description with `${label}: ` so the server's `Workspace root does not exist: <path>` reads as a statement about that machine. (e) Browsing and typing: the typed path and `~` are resolved on the machine (the browse call and the dispatch both carry the machine's `environmentId`), so no client path normalisation is added; `isUnsupportedWindowsProjectPath(rawCwd, input.platform)` already receives the machine's platform from its descriptor.
  6. The clone flow (`isRemoteProjectCloneFlow`, `sourceControlEnvironment.cloneRepository`) is keyed by `environmentId` and therefore already clones on the chosen machine. The word "remote" in those identifiers means a git remote, not a machine. Leave it unchanged.
- Do not: allow selecting a disabled machine; move an existing thread between machines; change `createWorkspaceRootIfMissing` for the primary or WSL environments; add client-side path rewriting; show the native folder picker for a remote machine (it stays gated by `canOpenProjectFromFileManager`).
- Tests (each must FAIL at base):
  - `apps/web/src/components/BranchToolbar.logic.test.ts`: "buildEnvironmentOptions keeps primary first and sorts the rest by label", "marks a disabled machine disabled and an auth-failed machine auth-failed", "a missing environment is offline", "dedupes two projects in one environment".
  - `apps/web/src/components/BranchToolbarEnvironmentSelector.browser.tsx` (new): render with three options (connected, offline, disabled); open the select; assert the disabled item has `aria-disabled="true"` and the text `Disabled`, the offline item is enabled and shows `Offline`, clicking the connected item calls `onEnvironmentChange` once and clicking the disabled item does not.
  - `apps/web/src/components/CommandPalette.logic.test.ts` (exists; the option mapping is inline in `CommandPalette.tsx:537-560`, so extract `buildAddProjectEnvironmentOptions` into `CommandPalette.logic.ts` and test it there): disabled machines are omitted; offline machines are included with status `offline`; primary first.
  - For the `createWorkspaceRootIfMissing` rule extract a pure `shouldCreateWorkspaceRootIfMissing(target: ConnectionTarget): boolean` into `CommandPalette.logic.ts` (`false` only for `RemoteConnectionTarget`) and unit test it for the three target tags.
- Verify: from `apps/web`: `pnpm exec vp test run src/components/BranchToolbar.logic.test.ts src/components/CommandPalette.logic.test.ts`, `pnpm exec vp test run src/components/BranchToolbarEnvironmentSelector.browser.tsx`, `pnpm exec tsgo --noEmit`; repo root `vp check`, `vp run typecheck`. Manual with two machines holding the same repository: the picker lists both, the switched-off one is greyed with `Disabled`, the offline one shows `Offline`, a new draft on the offline machine shows the banner with `Reconnect`, add-project on the remote machine with a path that does not exist fails with `<machine>: Workspace root does not exist: ...` and creates nothing on that machine (`ls` over SSH).
- Depends on: B3. Effort: M. Commit message: `feat(web): mark offline and disabled machines in the Run on picker and stop remote add-project creating folders`

---

### B4 Tailscale helper: do not revive the package, document the commands

- Problem: the plan asks whether to revive `packages/tailscale` from history (`git show 4c12112f1^:packages/tailscale`, `tailscale.ts` 356 lines, `tailscale.test.ts` 278 lines). It was deleted in `4c12112f1` together with `apps/desktop/src/backend/tailscaleEndpointProvider.ts` and has no consumer today (`git grep -i tailscale -- apps packages` returns nothing).
- Files to change: none for the recommended path. The two commands are documented by B1 in `docs/operations/self-hosting.md` ("Use with Tailscale").
- Change (decision):
  1. Compile check, read only, no build run. The helper's imports map onto current APIs: `@neokod/shared/hostProcess` exports `HostProcessPlatform` (`packages/shared/src/hostProcess.ts:5`, subpath `./hostProcess` in `packages/shared/package.json:138`); `ChildProcess`, `ChildProcessSpawner` come from `effect/unstable/process` (present at `.repos/effect-smol/packages/effect/src/unstable/process/`, and used by `apps/server/src/processRunner.ts:302`); `Stream.decodeText`, `Stream.runFold` with a thunk initial value, `Schema.decodeEffect`, `Effect.timeoutOption` and `Duration.fromInputUnsafe` all exist in the vendored Effect. It would need these edits to compile: rename `@t3tools/shared` to `@neokod/shared`, recreate `package.json` (`name: "@neokod/tailscale"`), `tsconfig.json` and the workspace entry, and fix `probeTailscaleHttpsEndpoint`, which still requests `/.well-known/t3/environment` (the path is `/.well-known/neokod/environment`, see `packages/client-runtime/src/environment/descriptor.ts`). I could not confirm it compiles because builds are out of scope for this task.
  2. Recommendation: document the two shell commands (B1) and do not revive the package now. Reasons: (a) the package duplicates `ProcessRunner` (`apps/server/src/processRunner.ts:140-161`, which already provides spawn, timeout and output limits); (b) the only feature that needs it is a Settings button that runs `tailscale serve` from the server process, and an RPC that lets any authenticated client change the machine's network exposure raises the blast radius of a leaked token from "agents on this box" to "also re-publishes the box"; (c) nothing else depends on it, so the cost is carried with no user.
  3. If the owner later wants Settings to show the tailnet name and the exact command, implement it read-only in `apps/server/src/tailscale/TailscaleStatus.ts` using `ProcessRunner.run({ command: "tailscale", args: ["status", "--json"], timeout: "1500 millis", timeoutBehavior: "timedOutResult" })` and copy only the three pure functions from history (`isTailscaleIpv4Address`, `parseTailscaleStatus`, `buildTailscaleHttpsBaseUrl`, about 70 lines of `tailscale.ts:142-182` and `:236-246`) plus the matching cases from `tailscale.test.ts` lines 81-131. Expose one RPC `serverGetTailscaleStatus` returning `{ magicDnsName, tailnetIpv4Addresses }` and render the commands as text with a copy button. Do not add `ensureTailscaleServe` or `disableTailscaleServe`.
- Do not: restore `ensureTailscaleServe` or `disableTailscaleServe` behind an RPC; restore `apps/desktop/src/backend/tailscaleEndpointProvider.ts` (it advertises endpoints for pairing, which is excluded); add a `packages/tailscale` workspace.
- Tests: none for the recommended path. For the optional read-only status, port `tailscale.test.ts` cases "detects Tailnet IPv4 addresses", "parses MagicDNS names from tailscale status", "parses status facts", "preserves status decoding failures without exposing cause text", "builds clean HTTPS base URLs" unchanged, and add "returns an unavailable status when the tailscale binary is missing" using a fake `ProcessRunner` that fails with `ProcessSpawnError`.
- Verify: for the recommended path, `git grep -n "tailscale serve --bg --https=443" docs/operations/self-hosting.md` finds the documented command and `git grep -ni "tailscale" -- apps packages` still returns nothing.
- Depends on: B1 (documents the commands). Effort: S (decision plus docs already in B1); the optional status row is S to M. Commit message: `docs: record the decision not to revive the Tailscale helper`

---

## Threat-model checklist (state after A1, A2, B1, B2, B2b, B3, B3b)

Assumption: the owner follows route 1 (`neokod serve --strict-transport --public-host ... --public-origin ...` on loopback plus `tailscale serve`) or route 2 (`--host <tailnet IP>`), and the token comes from the mode 0600 file. A holder of a valid token can do everything the service user can do (the RPC surface includes file read and write, terminals and agent dispatch, `README.md:103`). The checklist is about who can obtain that ability.

An attacker on the tailnet (another device or user on the tailnet, no token):

- Can: open a TCP connection to the listener, fetch the static web app (no secrets in it), see HTTP 401 on everything else.
- Cannot: read the environment descriptor (A1 guards it, `http.ts:78`), the shell or thread snapshots, dispatch commands (`orchestration/http.ts:31,50,64,82`), upgrade `/ws` (`ws.ts:2589`, ticket needs the bearer first), post traces (`http.ts:95`), or read attachments (signed asset URLs, `assets/AssetAccess.ts`). Cannot guess a generated token (43 characters, 256 bits). A weak user-supplied token of 32 characters is only as strong as its source; there is no attempt throttling (Open question 2).
- Extra control: Tailscale ACLs should restrict port 443 or the bind port to the owner's devices. With `NEOKOD_TAILSCALE_ALLOW_LOGINS` on route 1, other tailnet users are also refused before the token check.
- With a stolen token: full control. Rotate by deleting `<base-dir>/access-token` and restarting.

An attacker on the LAN:

- Route 1 (loopback bind) and route 2 (tailnet IP bind): the listener is not reachable on LAN addresses. `ss -ltn` must show only `127.0.0.1` or the `100.x` address.
- `--host 0.0.0.0` or a LAN IP: reachable, plain HTTP, so the bearer and the ticket cross the LAN unencrypted and can be sniffed. Do not use this without TLS in front. Not recommended in the docs.
- Host and Origin validation always runs on a non-loopback bind (B1), so a hostname that is not declared is refused with 403.

A malicious web page in the owner's browser (on the Mac or the server's browser):

- Cannot: call the API without the token (401); read the token (it is in `localStorage` or IndexedDB of the UI origin only, other origins cannot read it); get a CORS allow header for its own origin (A1 allows only declared public origins, the dev origin, desktop origins and loopback origins); mint a WebSocket ticket (the ticket request carries `Authorization`, so it needs a preflight that CORS refuses); abuse DNS rebinding (the page's own origin has an empty `localStorage`, the request has no token, and `--strict-transport` rejects the foreign Host).
- Can: load the public static files; a page served from another `http://localhost:<port>` on the same machine is an allowed CORS origin but still has no token.
- Residual: an XSS in the UI origin reads every saved token (`localStorage` for the primary, IndexedDB for machines). Adding a remote machine means trusting its content in the UI origin. CSP posture was not reviewed (Unverified).
- The `?loopbackAuthToken=` query form still sends the token in the first HTTP request (proxy and Referer logs). The `#access-token=` fragment never leaves the browser. The docs should recommend the fragment (A1c step 1).

A local process on the server:

- Same OS user: can already do anything the service can; can read `<base-dir>/access-token`.
- Other OS user or a container without access to the file: can connect to `127.0.0.1:<port>` but gets 401. Cannot read the file (mode 0600, `chmod` also repaired on load).
- Can forge `Tailscale-User-Login` only if it can connect to loopback; the header is an extra restriction and never a credential, so forging it gains nothing without the token.
- `NEOKOD_ACCESS_TOKEN` in the environment is visible to the same user in `/proc/<pid>/environ`. The file source avoids that. Terminals strip `NEOKOD_*` (`terminal/Manager.ts:1087`); provider child processes were not checked (Unverified).
- The project CLI (A1b) authenticates with the same token and refuses to fall back to writing the database when the server answers 401.

Other cases:

- Authelia and Cloudflare route: still works, and the token is now a second factor behind Authelia. An Authelia compromise or a sibling `*.mashdev.xyz` app no longer reaches Neokod without the token. Neokod uses no cookies, so shared cookie domains do not help an attacker.
- A saved remote machine that is compromised: sees only the token it was added with and can return hostile content to the UI (see residual XSS). It cannot read other machines' tokens from the server side.
- A cloned data directory: a second machine with the same `environment-id` is refused at `register` (B2), so one machine cannot silently replace another.

## Manual test script (owner, from the Mac over Tailscale to the server)

Names: server `wv-htpc`, tailnet IP `100.81.180.76`, port `13773`, MagicDNS name `wv-htpc.<tailnet>.ts.net`. Replace `<tailnet>`. Run the numbered steps in order. Expected results follow the arrow. Do not paste the token into chat or tickets.

Part 1: token on the server (SSH to the server).

1. Update and restart the service on the branch that contains A1 to B3b. `ls -l ~/.neokod/access-token` -> one file, `-rw-------`. `wc -c ~/.neokod/access-token` -> 43 or 44 (with newline if you edit it by hand; generated files have no newline).
2. `sha256sum ~/.neokod/access-token`, `systemctl --user restart neokod`, `sha256sum ~/.neokod/access-token` -> identical hashes.
3. `journalctl --user -u neokod --since "10 min ago" | grep -c "$(cat ~/.neokod/access-token)"` -> `0`.
4. Start line (adjust to the unit file): `neokod serve --port 13773 --strict-transport --public-host wv-htpc.<tailnet>.ts.net --public-origin https://wv-htpc.<tailnet>.ts.net --public-origin https://neokod.mashdev.xyz`, then `tailscale serve --bg --https=443 http://127.0.0.1:13773` and `tailscale serve status` -> one HTTPS 443 entry pointing at `127.0.0.1:13773`.

Part 2: HTTP behaviour (shell on the Mac). Put the token in a variable without echoing it: `read -s T`. 5. `curl -si https://wv-htpc.<tailnet>.ts.net/.well-known/neokod/environment | head -1` -> `HTTP/2 401`. 6. `curl -s -H "Authorization: Bearer $T" https://wv-htpc.<tailnet>.ts.net/.well-known/neokod/environment` -> JSON with `serverVersion`. With `Bearer wrong` -> 401. 7. `curl -si -X POST https://wv-htpc.<tailnet>.ts.net/api/orchestration/dispatch -H 'content-type: application/json' -d '{}' | head -1` -> `401`. 8. Cross-origin preflight: `curl -si -X OPTIONS https://wv-htpc.<tailnet>.ts.net/api/orchestration/dispatch -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization' | grep -ic access-control-allow-origin` -> `0`. Repeat with `Origin: https://neokod.mashdev.xyz` -> `1`. 9. WebSocket without a ticket: `curl -si -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==' https://wv-htpc.<tailnet>.ts.net/ws | head -1` -> a 401 or 403 status line, never `101`. 10. Cross-site page: open `https://example.com`, DevTools console, run `fetch("https://wv-htpc.<tailnet>.ts.net/api/orchestration/shell").then(r => r.status).catch(e => String(e))` -> a CORS failure (no readable status). Then the same with `{ headers: { authorization: "Bearer x" } }` -> blocked at preflight. 11. Foreign Host (skip if Tailscale refuses the unknown name before Neokod sees it): `curl -sik --resolve evil.test:443:100.81.180.76 https://evil.test/.well-known/neokod/environment | head -1` -> `403` with body `transport_origin_invalid`.

Part 3: browser first load (Mac, a fresh browser profile). 12. Open `https://wv-htpc.<tailnet>.ts.net/` -> the "Enter access token" screen, nothing else usable. Enter a wrong value -> "That token was not accepted." Enter the right token -> the app loads. Reload -> no prompt. DevTools > Application > Local Storage shows the key `neokod:primary-access-token:v1`. 13. In a second fresh profile open `https://wv-htpc.<tailnet>.ts.net/#access-token=<token>` -> app loads, the address bar no longer shows `#access-token`. Settings > Connections > "Access token" > Forget -> the prompt returns. 14. On the server delete `~/.neokod/access-token` and restart. In the first profile reload -> the prompt appears with "The saved access token was not accepted". Enter the new token -> works.

Part 4: direct bind (route 2). Stop `tailscale serve` (`tailscale serve --https=443 off`), restart with `neokod serve --host 100.81.180.76 --port 13773`. 15. Server: `ss -ltn | grep 13773` -> only `100.81.180.76:13773`. Startup output prints `Local URL: http://100.81.180.76:13773` and the token file path, not the token. 16. Mac: `curl -si http://100.81.180.76:13773/.well-known/neokod/environment | head -1` -> 401, with the bearer -> 200. From a device not on the tailnet (phone, Tailscale off): the address is unreachable. 17. `NEOKOD_ACCESS_TOKEN=short neokod serve --host 100.81.180.76` -> exits at once with a message that the token is shorter than 32 characters. 18. `NEOKOD_TAILSCALE_ALLOW_LOGINS=you@example.com neokod serve --host 100.81.180.76` -> exits with the "only works behind tailscale serve" message.

Part 5: Authelia route. 19. Open `https://neokod.mashdev.xyz` in a fresh profile -> Authelia login, then the token prompt, then the app. DevTools Network: API requests carry `Authorization` and return 200. If any request returns 401 or 302 after login, record the status and the request path (see the Authelia item under Unverified).

Part 6: saved machines (needs B2 to B3b; run the Mac's own Neokod, desktop app or `neokod serve` on the Mac). 20. Settings > Connections > Machines > Add machine. Address `https://wv-htpc.<tailnet>.ts.net`, the token. `Check connection` -> "Found ..., Neokod <version>, linux x64". Add. Status `Connected`. 21. Add the same address again -> `This machine is already added as "<label>"...` and no second row. 22. Flip the switch off -> `Disabled` text and badge, switch visibly off in light and dark theme. On the server `journalctl --user -u neokod -f` shows no new WebSocket from the Mac. Flip on -> `Connected`. 23. "Run on" picker in a draft thread of a project present on both machines -> both listed; switch the machine off and re-open the picker -> it is greyed with `Disabled`. 24. `systemctl --user stop neokod` on the server -> row `Offline` with a last error, banner `Reconnect` in a thread on that machine. Start it again -> `Connected` without a manual action. 25. Delete `~/.neokod/access-token`, restart -> row `Auth failed`, banner offers `Update token`; update the token -> `Connected`. 26. Add project on the remote machine with a path that does not exist (`~/does-not-exist-123`) -> toast `<machine>: Workspace root does not exist`; on the server `ls ~/does-not-exist-123` -> not found. 27. Remove the machine (confirm) -> row gone and its projects leave the sidebar. Mac DevTools > Application > IndexedDB > `neokod:connection-runtime` > `catalog` -> the stored document has `machines: []` and `credentials: []`.

## Open questions

1. Saved machines over plain HTTP on the tailnet. B2 follows the brief ("https unless loopback"). That makes route 2 (`http://100.81.180.76:13773`) unusable as a saved machine, because Neokod has no TLS listener. Recommendation: also allow `http://` for Tailscale addresses only (`100.64.0.0/10` and `fd7a:115c:a1e0::/48`), since WireGuard encrypts the hop. It is one extra branch in `normalizeRemoteBaseUrl` plus two test rows. Decide before B2.
2. Attempt throttling. The server has none. A generated token makes guessing infeasible, but a user-supplied 32 character token and a public route make a small per-IP backoff on repeated 401 worth considering. Not specified in any card.
3. `NEOKOD_TAILSCALE_ALLOW_LOGINS` requires the header on every request, so it also blocks the Authelia route on the same listener. Accept this, or make the filter apply only to requests that carry `Tailscale-User-Login` (weaker, never a credential either way)?
4. `--mode desktop` without a desktop bootstrap token still runs unauthenticated (A1 only covers web mode). Should startup refuse that combination outside the real desktop launch?
5. Auto-opened browser URL carries no token (A1 step 8) so it cannot reach process arguments or error traces. The cost is one paste per browser. Confirm, or approve a fragment-only token URL.
6. The stored token is never deleted automatically after a 401 (A2 step 8). Confirm that keeping it until the user replaces or forgets it is the wanted behaviour.
7. Browser machine tokens are plaintext in IndexedDB (desktop encrypts through `safeStorage`). Accept, given the same XSS exposure applies to the primary token?
8. CORS allows loopback origins on any port when a token is configured (needed so the Mac's own UI can call a remote machine). Accept, or require the owner to list `--public-origin http://localhost:<port>` explicitly?
9. Keep `?loopbackAuthToken=` as a supported input (A2) or deprecate it in favour of `#access-token=` only? The query form leaks into proxy logs.
10. Rename `ServerConfig.loopbackAuthToken` and the `Loopback*` transport and authorization names to `accessToken` once these cards land? Not done here to keep the diffs small.
11. Threads on an offline machine: T3 shows them as "Working" (issue 4852). None of these cards changes thread status derivation. Needs its own card after the Sidebar and thread lifecycle code is read.
12. The server and the owner's Node version: plan section 4 moves the service to Node 24. These cards do not depend on it.

## Unverified

- No build, typecheck or full test run was done (read only rule). Every code snippet was written against code I read, but compile status is unconfirmed. Highest risk: `Config.redacted(...).pipe(Config.option, ...)` typing (A1), `Flag.atLeast(0)` accepting a zero minimum at runtime (read in `Param.ts:1646-1654`, not run), `HttpRouter.middleware(HttpMiddleware.cors(...), { global: true })` typing (A1), `HttpServerRequest.modify({ remoteAddress })` in tests (B1), `Context.add` chaining (B2b).
- The test command was confirmed for `apps/server` only (`pnpm exec vp test run src/startupAccess.test.ts`, 6 passed). The browser project invocation for `*.browser.tsx` was not run.
- Desktop token handling: `validateTargetUrls` drops `loopbackAuthToken` for a desktop loopback bootstrap (read at `target.ts:248-260`), so the desktop renderer may already fail against its own token-protected server on this branch. Not run on the desktop. A2 fixes it and its test pins it.
- Authelia: whether `Authorization: Bearer ...` on same-origin requests passes through Authelia's forward-auth unchanged was not tested (manual step 19).
- `tailscale serve` details: the command forms come from the deleted helper (`ensureTailscaleServe`, `disableTailscaleServe` in `git show 4c12112f1^:packages/tailscale/src/tailscale.ts`) and `plan.md` 4.1; I did not run them. I also did not confirm that Tailscale overwrites a client-supplied `Tailscale-User-Login` header, which is another reason the header is never a credential.
- `request.remoteAddress` being populated for HTTP and WebSocket upgrades on the Node server was not checked beyond its type (`HttpIncomingMessage.ts:66`). The allowlist fails closed when it is absent.
- Browser behaviour of `http://100.x` as an insecure context (notifications are known to be disabled, `browserNotification.ts:17`; other APIs such as `crypto.subtle` in `connection/runtime.ts` were not exercised).
- Contrast ratios in B3 were computed by hand from the CSS variables in `index.css`, not measured in a browser. The B3 browser test measures them.
- Whether provider CLI child processes inherit `NEOKOD_ACCESS_TOKEN` was not checked (terminals strip `NEOKOD_*`, `terminal/Manager.ts:1087`).
- Browser trace export (`observability/clientTracing.ts`) before the token is entered will receive 401s; I did not check whether the OTLP exporter logs these as warnings.
- Existing registry behaviour relies on `Equal.equals` treating plain catalog entries structurally (`registry.ts:217,299`); B2 adds fields to those entries and assumes that still holds. There is no registry test at HEAD to confirm it (`connection/registry.test.ts` does not exist; the history file is the fixture source).
- CSP and XSS hardening of the web app were not reviewed.

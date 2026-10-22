The checkout matches `cc054117d28edda1729effb4ee65c75abe3c2f1b`. I’ll review only the listed corrections and their direct callers, checking which old findings the source now closes. I’ll leave the existing documentation changes untouched and run no tests, builds or provider commands.The locked maintenance recheck and idle-first pending-request cleanup are present in the integrated source. One issue remains with the claimed five-second probe bound: Effect waits for cancellation cleanup, and beta.78’s spawner can wait indefinitely for a child that ignores TERM. I’m checking the exact path and what the new fixtures cover before finalising that finding.One actionable P2 remains at `cc054117d28edda1729effb4ee65c75abe3c2f1b`: the five-second version probes are not bounded through subprocess cleanup. Keep that prior finding open.

## Finding

### P2: Probe timeout can wait indefinitely for the real spawner’s cleanup

Locations:

- [`opencodeRuntime.ts:533–539`](apps/server/src/provider/opencodeRuntime.ts#L533), runtime-start timeout.
- [`OpenCodeDriver.ts:129–136`](apps/server/src/provider/Drivers/OpenCodeDriver.ts#L129), hydration and maintenance timeout.
- [`opencodeRuntime.ts:485–489`](apps/server/src/provider/opencodeRuntime.ts#L485), underlying command spawn.

Trigger: the configured executable hangs during `--version`, produces no output and ignores SIGTERM.

The timer interrupts `runOpenCodeCommand`, but that command owns an ordinary scoped spawner. Beta.78’s finalizer sends TERM and then waits on `Deferred.await(exitSignal)` without a deadline ([vendored spawner:483–492](.repos/effect-smol/packages/platform-node-shared/src/NodeChildProcessSpawner.ts#L483)). Effect’s timeout waits for the losing fibre’s interruption and finalizers before returning `Option.none`.

Consequently:

- Provider hydration can still block server initialisation.
- Runtime startup can remain stuck before `serve` and its readiness deadline.
- Maintenance can hold the shared command lock indefinitely while probing.

The new TestClock cases use interruptible fake effects/handles without this real finalizer. The real-spawner fixtures now answer `--version` normally, so they do not cover this trigger.

Action: bound subprocess termination and exit-waiting as well as command collection, then add one owned real-spawner fixture that ignores TERM. Merely adding `forceKillAfter` is insufficient in this beta.78 implementation: its timeout wraps signal delivery, not the subsequent exit wait. Do not detach timeout cleanup and silently leave an untracked probe running.

## Explicit closure of previous findings

| Previous issue                                              | Source verdict                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial TERM before ownership validation                    | Closed for the POSIX guarded server path. Ownership is checked before TERM and again before KILL at [`opencodeRuntime.ts:169–194`](apps/server/src/provider/opencodeRuntime.ts#L169).                                                                                                                                            |
| Unobservable owner treated as dead                          | Closed. Observation preserves `unknown`; reconciliation retains the entry without signalling. Darwin absence requires exit 1 with empty stdout and stderr. See [`OpenCodeServerLedger.ts:270–282`](apps/server/src/provider/OpenCodeServerLedger.ts#L270) and [:742–768](apps/server/src/provider/OpenCodeServerLedger.ts#L742). |
| Automatic spawner finalizer bypasses server ownership guard | Closed for the reviewed server-spawn path. The private scope is never closed, so its non-zero-exit finalizer cannot follow a guard refusal. No `unref()` exit-cleanup path is enabled.                                                                                                                                           |
| Idle-first Stop leaves pending requests unresolved          | Closed. Abort-marked idle reaches the shared interrupted settlement, which clears both pending maps and emits their resolution events before completion.                                                                                                                                                                         |
| Delayed old abort error/idle settles the new turn           | Closed under the ordered-stream contract. Admission retains the marker; terminal echoes are consumed until subsequent new-turn progress releases it. Ordinary errors remain failures, and errors after marker release are not suppressed. This is not protocol-level turn correlation.                                           |
| Cached legacy updater survives a 1→2 replacement            | Closed for local instances. Revalidation executes inside the acquired command lock, after queueing, before the updater runs. The withheld-lock/version-flip test exercises that ordering.                                                                                                                                        |
| Unknown major permits destructive legacy update             | Closed for local instances when the probe settles. Unknown returns a blocking reason; known 2.x is refused; known 1.x retains the updater path.                                                                                                                                                                                  |
| Unbounded hydration/runtime version probes                  | Still open for the cancellation-cleanup trigger above. The timer and unknown-result branches exist, but do not establish a hard completion bound.                                                                                                                                                                                |

### Cleanup and attribution qualifications

The server acquisition is uninterruptible through spawn and birth-token capture until the guarded release is registered. Tracking occurs afterwards, so tracking failure or interruption does not remove that cleanup owner. Release terminates before invoking forget; the production forget action requires confirmed group disappearance.

For this concrete spawn, the private scope owns no streamed-input or additional-FD fibres. I found no separate scope-resource leak once the child exits. An unverifiable surviving process is deliberately not killed; retained ledger evidence is not proof of successful shutdown.

The abort correction still depends on an uninterrupted ordered stream and terminal-before-new-progress ordering. The pinned legacy source supports that sequence. A genuinely external cancellation before the new turn’s own progress remains indistinguishable from an old cancellation echo.

Windows is not covered by the POSIX birth-identity closure: its explicit `child.kill`/`taskkill` path remains different, and the real-spawner fixtures skip Windows. No Windows execution or equivalent ownership proof is established here.

## O2 next step

Proceed with the already-planned bounded parity spike using the existing [`AcpSessionRuntime`](apps/server/src/provider/acp/AcpSessionRuntime.ts), rather than introducing another transport. Check one session’s prompt, permission/input, cancel-then-next-turn ordering and event draining first; record any concrete gaps before expanding to resume, configuration or text generation. External ACP workers do not establish Neokod integration, and the current HTTP adapter remains deliberately unsupported for CLI 2.

This was read-only source review. No tests, checks, builds, installs, app/provider actions, edits, commits, pushes, agents or external messages were performed. Public source was read; no live CLI, remote connection, tracker, build or UI proof is claimed. The harness identifies `github-copilot/gpt-6.1-sol`; actual effort verification remains with main’s session metadata.

import { HostProcessPlatform } from "@neokod/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import {
  isWorkspaceSameOrInside,
  readWorkspaceIdentityEvidence,
  workspaceIdentitiesMatch,
  type WorkspaceIdentityEvidence,
} from "../vcs/WorkspaceIdentity.ts";
import type { WorktreeAdmission } from "./worktreeAdmission.ts";

/**
 * One in-process gate for managed worktree admission and removal.
 *
 * The orchestration engine holds the gate while it decides and commits an
 * admitting command. Removal holds a reservation from just before it reads
 * surviving links until the driver has settled. An admission therefore either
 * commits first (and is visible to removal) or sees the reservation and is
 * rejected. External Git and editor processes are outside this gate.
 */

export class WorktreeAdmissionBlockedError extends Error {
  readonly workspacePath: string;
  readonly commandType: string;

  constructor(workspacePath: string, commandType: string, detail?: string) {
    super(
      detail ?? `Workspace ${workspacePath} is being removed. Retry after the removal completes.`,
    );
    this.name = "WorktreeAdmissionBlockedError";
    this.workspacePath = workspacePath;
    this.commandType = commandType;
  }
}

export class WorktreeRemovalLeaseConflictError extends Error {
  readonly workspacePath: string;
  readonly reason: "overlapping-removal" | "identity-unknown";

  constructor(workspacePath: string, reason: "overlapping-removal" | "identity-unknown") {
    super(
      reason === "overlapping-removal"
        ? `Another removal already covers ${workspacePath}.`
        : `Unable to establish a stable filesystem identity for ${workspacePath}.`,
    );
    this.name = "WorktreeRemovalLeaseConflictError";
    this.workspacePath = workspacePath;
    this.reason = reason;
  }
}

export interface WorktreeRemovalLeaseShape {
  readonly withAdmission: <A, E, R>(
    commandType: string,
    admission: WorktreeAdmission,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | WorktreeAdmissionBlockedError, R>;

  readonly recordPreparedWorktree: (workspacePath: string) => Effect.Effect<void>;

  readonly withRemovalReservation: <A, E, R>(
    target: WorkspaceIdentityEvidence,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | WorktreeRemovalLeaseConflictError, R>;

  readonly withRemovalReservationForPath: <A, E, R>(
    workspacePath: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | WorktreeRemovalLeaseConflictError, R>;

  readonly hasReservations: Effect.Effect<boolean>;
}

export class WorktreeRemovalLease extends Context.Service<
  WorktreeRemovalLease,
  WorktreeRemovalLeaseShape
>()("neokod/git/WorktreeRemovalLease") {}

export const WorktreeRemovalLeaseLive = Layer.effect(
  WorktreeRemovalLease,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hostPlatform = yield* HostProcessPlatform;
    const gate = yield* Semaphore.make(1);
    const reservations = yield* Ref.make<ReadonlyArray<WorkspaceIdentityEvidence>>([]);
    const preparedWorktrees = yield* Ref.make<ReadonlyMap<string, WorkspaceIdentityEvidence>>(
      new Map(),
    );

    const isSameOrInside = (target: WorkspaceIdentityEvidence, candidatePath: string) =>
      isWorkspaceSameOrInside({ target, candidatePath }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(HostProcessPlatform, hostPlatform),
      );

    const readIdentity = (workspacePath: string) =>
      readWorkspaceIdentityEvidence(workspacePath).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

    const recordPreparedWorktree: WorktreeRemovalLeaseShape["recordPreparedWorktree"] = (
      workspacePath,
    ) =>
      readIdentity(workspacePath).pipe(
        Effect.flatMap((identity) =>
          identity.exists && identity.device !== null && identity.inode !== null
            ? Ref.update(preparedWorktrees, (current) => {
                const next = new Map(current);
                next.set(workspacePath, identity);
                next.set(identity.physicalPath, identity);
                return next.size > 512 ? new Map([...next.entries()].slice(next.size - 512)) : next;
              })
            : Effect.void,
        ),
        Effect.orElseSucceed(() => undefined),
      );

    const checkPreparedWorktree = (workspacePath: string, commandType: string) =>
      Effect.gen(function* () {
        const current = yield* readIdentity(workspacePath).pipe(
          Effect.mapError(
            () =>
              new WorktreeAdmissionBlockedError(
                workspacePath,
                commandType,
                `Unable to verify the prepared worktree ${workspacePath}. Retry the attachment.`,
              ),
          ),
        );
        if (!current.exists) {
          return yield* Effect.fail(
            new WorktreeAdmissionBlockedError(
              workspacePath,
              commandType,
              `The worktree ${workspacePath} does not exist. Prepare it before attaching a thread.`,
            ),
          );
        }
        const prepared = yield* Ref.get(preparedWorktrees);
        const expected = prepared.get(workspacePath) ?? prepared.get(current.physicalPath);
        if (expected !== undefined && workspaceIdentitiesMatch(expected, current) !== "same") {
          return yield* Effect.fail(
            new WorktreeAdmissionBlockedError(
              workspacePath,
              commandType,
              `The prepared worktree ${workspacePath} was removed or replaced before it was attached. Prepare it again.`,
            ),
          );
        }
      });

    const clearPreparedWorktrees = (target: WorkspaceIdentityEvidence) =>
      Ref.update(preparedWorktrees, (current) => {
        const next = new Map(current);
        const prefix = `${target.physicalPath}${path.sep}`;
        for (const [key, identity] of current) {
          if (
            key === target.physicalPath ||
            key.startsWith(prefix) ||
            workspaceIdentitiesMatch(target, identity) === "same"
          ) {
            next.delete(key);
          }
        }
        return next;
      });

    const withAdmission: WorktreeRemovalLeaseShape["withAdmission"] = (
      commandType,
      admission,
      effect,
    ) =>
      gate.withPermit(
        Effect.gen(function* () {
          for (const preparedPath of admission.preparedWorktreePaths) {
            yield* checkPreparedWorktree(preparedPath, commandType);
          }
          const leased = yield* Ref.get(reservations);
          if (leased.length > 0) {
            for (const workspacePath of admission.workspacePaths) {
              // Read candidate identity once so parent and child overlaps are
              // both evaluated with the same filesystem evidence.
              const candidate = yield* readIdentity(workspacePath).pipe(
                Effect.mapError(
                  () => new WorktreeAdmissionBlockedError(workspacePath, commandType),
                ),
              );
              for (const reservation of leased) {
                const overlaps = yield* Effect.all([
                  isSameOrInside(reservation, candidate.physicalPath),
                  isSameOrInside(candidate, reservation.physicalPath),
                ]).pipe(
                  Effect.mapError(
                    () => new WorktreeAdmissionBlockedError(workspacePath, commandType),
                  ),
                );
                if (overlaps[0] || overlaps[1]) {
                  return yield* Effect.fail(
                    new WorktreeAdmissionBlockedError(workspacePath, commandType),
                  );
                }
              }
            }
          }
          return yield* effect;
        }),
      );

    const withRemovalReservation: WorktreeRemovalLeaseShape["withRemovalReservation"] = (
      target,
      effect,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            gate.withPermit(
              Effect.gen(function* () {
                const leased = yield* Ref.get(reservations);
                for (const reservation of leased) {
                  const overlaps = yield* Effect.all([
                    isSameOrInside(reservation, target.physicalPath),
                    isSameOrInside(target, reservation.physicalPath),
                  ]).pipe(
                    Effect.mapError(
                      () =>
                        new WorktreeRemovalLeaseConflictError(
                          target.physicalPath,
                          "identity-unknown",
                        ),
                    ),
                  );
                  if (overlaps[0] || overlaps[1]) {
                    return yield* Effect.fail(
                      new WorktreeRemovalLeaseConflictError(
                        target.physicalPath,
                        "overlapping-removal",
                      ),
                    );
                  }
                }
                yield* Ref.update(reservations, (current) => [...current, target]);
              }),
            ),
            () =>
              gate
                .withPermit(
                  Ref.update(reservations, (current) =>
                    current.filter((reservation) => reservation !== target),
                  ),
                )
                .pipe(Effect.orDie),
          );
          return yield* effect.pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? clearPreparedWorktrees(target) : Effect.void,
            ),
          );
        }),
      );

    const withRemovalReservationForPath: WorktreeRemovalLeaseShape["withRemovalReservationForPath"] =
      (workspacePath, effect) =>
        Effect.gen(function* () {
          const identity = yield* readIdentity(workspacePath).pipe(
            Effect.mapError(
              () => new WorktreeRemovalLeaseConflictError(workspacePath, "identity-unknown"),
            ),
          );
          if (identity.exists && (identity.device === null || identity.inode === null)) {
            return yield* Effect.fail(
              new WorktreeRemovalLeaseConflictError(workspacePath, "identity-unknown"),
            );
          }
          return yield* withRemovalReservation(identity, effect);
        });

    return {
      withAdmission,
      recordPreparedWorktree,
      withRemovalReservation,
      withRemovalReservationForPath,
      hasReservations: Ref.get(reservations).pipe(Effect.map((leased) => leased.length > 0)),
    } satisfies WorktreeRemovalLeaseShape;
  }),
);

import { ProjectWriteFileError } from "@neokod/contracts";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@neokod/client-runtime/state/runtime";
import * as Schema from "effect/Schema";

export interface FileSaveCoordinatorOptions<A, E> {
  readonly debounceMs: number;
  readonly persist: (contents: string) => Promise<AtomCommandResult<A, E>>;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onConfirmed: (contents: string) => void;
  readonly canWrite?: () => boolean;
  readonly onConflict?: () => void;
  readonly isConflict?: (result: AtomCommandResult<A, E>) => boolean;
  readonly initiallyConflicted?: boolean;
}

const isProjectWriteFileError = Schema.is(ProjectWriteFileError);

/** True when a write failed because the disk hash no longer matches. */
export function isFileChangedOnDisk(result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag !== "Failure") return false;
  const error = squashAtomCommandFailure(result);
  return isProjectWriteFileError(error) && error.failure === "file_changed_on_disk";
}

export interface FileSaveBaselinePersistOptions<A, E> {
  readonly write: (input: {
    readonly contents: string;
    readonly expectedHash: string | undefined;
  }) => Promise<AtomCommandResult<A, E>>;
  readonly confirmedHash: (value: A) => string | undefined;
  readonly onConfirmedHash?: (contentHash: string) => void;
}

/**
 * The last content hash this client confirmed for one open file. The file
 * panel owns one baseline across editor remounts, so a source/rendered switch
 * cannot fall back to a stale read hash while an earlier surface save is still
 * in flight. Server reads only seed the baseline before the first local
 * confirmation; an external write keeps the old baseline and must conflict.
 * An explicit overwrite drops the precondition for good, so a rerender cannot
 * reseed it from a stale read before the unconditional write lands.
 */
export class FileSaveBaseline {
  private contentHash: string | undefined;
  /**
   * True once the hash is authoritative: seeded by a read, acknowledged by a
   * local write, or deliberately dropped for an explicit overwrite. A rerender
   * must not reseed a hash after either of the last two.
   */
  private seeded: boolean;

  constructor(initialHash: string | undefined) {
    this.contentHash = initialHash;
    this.seeded = initialHash !== undefined;
  }

  get expectedHash(): string | undefined {
    return this.contentHash;
  }

  adoptInitialHash(contentHash: string | undefined): void {
    if (this.seeded) return;
    this.contentHash = contentHash;
    if (contentHash !== undefined) this.seeded = true;
  }

  /**
   * Drops the precondition for an explicit Overwrite. Marking the baseline as
   * seeded stops a rerender from adopting a stale read hash before the write.
   */
  clear(): void {
    this.contentHash = undefined;
    this.seeded = true;
  }

  async persist<A, E>(
    contents: string,
    options: FileSaveBaselinePersistOptions<A, E>,
  ): Promise<AtomCommandResult<A, E>> {
    const result = await options.write({
      contents,
      expectedHash: this.contentHash,
    });
    if (result._tag === "Success") {
      const contentHash = options.confirmedHash(result.value);
      if (contentHash !== undefined) {
        this.contentHash = contentHash;
        this.seeded = true;
        options.onConfirmedHash?.(contentHash);
      }
    }
    return result;
  }
}

export class FileSaveCoordinator<A = unknown, E = unknown> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestContents = "";
  private latestRevision = 0;
  private confirmedRevision = 0;
  private lastChangeAt = 0;
  private saving = false;
  private disposed = false;
  private conflicted = false;

  constructor(private readonly options: FileSaveCoordinatorOptions<A, E>) {
    this.conflicted = options.initiallyConflicted ?? false;
  }

  get hasUnsavedEdits(): boolean {
    return this.latestRevision > this.confirmedRevision;
  }

  change(contents: string): void {
    if (this.options.canWrite?.() === false) return;
    this.latestContents = contents;
    this.latestRevision += 1;
    this.lastChangeAt = Date.now();
    this.options.onPendingChange(true);
    // Keep recording the user's buffer while conflicted, but never schedule a
    // write until the conflict has been explicitly resolved.
    if (this.conflicted) return;
    this.schedule(this.options.debounceMs);
  }

  /** Stops scheduling when a remounted editor still shows a conflict. */
  markConflicted(): void {
    this.conflicted = true;
    this.clearTimer();
  }

  /** Clears the conflict so the caller can reload or retry with a fresh hash. */
  resolveConflict(): void {
    this.conflicted = false;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    if (this.conflicted) return;
    if (this.hasUnsavedEdits) void this.persistLatest();
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persistLatest();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private async persistLatest(): Promise<void> {
    if (this.saving || this.conflicted || !this.hasUnsavedEdits) return;

    this.saving = true;
    const contents = this.latestContents;
    const revision = this.latestRevision;
    const result = await this.options.persist(contents);
    this.saving = false;
    if (result._tag === "Failure" && this.options.isConflict?.(result) === true) {
      this.conflicted = true;
      this.clearTimer();
      this.options.onConflict?.();
      return;
    }

    const succeeded = result._tag === "Success";
    if (succeeded) {
      this.confirmedRevision = Math.max(this.confirmedRevision, revision);
      this.options.onConfirmed(contents);
    }

    if (revision === this.latestRevision) {
      if (succeeded) this.options.onPendingChange(false);
      return;
    }

    const remainingDebounce = Math.max(
      0,
      this.options.debounceMs - (Date.now() - this.lastChangeAt),
    );
    if (this.disposed) {
      void this.persistLatest();
    } else {
      this.schedule(remainingDebounce);
    }
  }
}

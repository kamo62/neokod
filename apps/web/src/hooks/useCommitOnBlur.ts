import { type ChangeEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";

export type CommitOnBlurOptions = {
  /**
   * Commit when Enter is pressed. Disable for multi-line elements, where
   * Enter must insert a newline instead. Defaults to true.
   */
  readonly commitOnEnter?: boolean;
  /**
   * Called once when the first keystroke starts a buffered edit, before the
   * text is committed. Lets an owner claim the edit at its starting revision.
   */
  readonly onBeginEdit?: (() => void) | undefined;
  /** Called on blur when a buffered edit ends without a changed value. */
  readonly onDiscardEdit?: (() => void) | undefined;
};

export interface CommitOnBlurBuffer {
  /** Text observed at focus, or typed by the user. */
  readonly draft: string | null;
  /** True once a keystroke owns the text; focus alone never starts an edit. */
  readonly beganEdit: boolean;
}

const idleCommitOnBlurBuffer: CommitOnBlurBuffer = {
  draft: null,
  beganEdit: false,
};

/** Capture the text shown at focus without claiming an edit. */
export function focusCommitOnBlurBuffer(value: string): CommitOnBlurBuffer {
  return { draft: value, beganEdit: false };
}

/** The first keystroke owns its text until blur. */
export function typeCommitOnBlurBuffer(text: string): CommitOnBlurBuffer {
  return { draft: text, beganEdit: true };
}

/**
 * The text to display for the current buffer and upstream value.
 *
 * A clean focus snapshot keeps following the authoritative value. Only typed
 * text owns the buffer and survives upstream updates.
 */
export function displayCommitOnBlurValue(buffer: CommitOnBlurBuffer, value: string): string {
  return buffer.beganEdit ? (buffer.draft ?? value) : value;
}

export interface CommitOnBlurOutcome {
  readonly buffer: CommitOnBlurBuffer;
  /** Text to commit on blur, or null when the buffer does not own a change. */
  readonly commit: string | null;
  /** True when a typed buffer returned to the upstream value. */
  readonly discard: boolean;
}

/** Settle a buffer on blur, reporting any commit or discarded ownership. */
export function endCommitOnBlurBuffer(
  buffer: CommitOnBlurBuffer,
  value: string,
): CommitOnBlurOutcome {
  // Focus observes text but does not own it. An external update while the
  // field is clean is authoritative, never an untouched snapshot to write back.
  if (!buffer.beganEdit) {
    return { buffer: idleCommitOnBlurBuffer, commit: null, discard: false };
  }
  const next = buffer.draft ?? value;
  const commit = next !== value ? next : null;
  return {
    buffer: idleCommitOnBlurBuffer,
    commit,
    discard: commit === null,
  };
}

/**
 * Buffer text input locally so keystrokes don't cause a settings-wide
 * re-render (and optionally a server RPC round-trip) on every character.
 * `onCommit` fires on blur and, unless disabled, on Enter.
 *
 * Focus observes the current text but does not own it. While the buffer is
 * clean the field keeps following the upstream `value`, including an external
 * update after focus. The first keystroke owns the text until blur, so an
 * optimistic settings update or a reset cannot clobber an in-progress edit.
 *
 * Returns a bag of props that should be spread onto an `<Input>` or
 * `<Textarea>`:
 *
 *   const bag = useCommitOnBlur(instance.displayName ?? "", (next) => {...});
 *   <Input {...bag} placeholder="e.g. Work" />
 */
export function useCommitOnBlur<
  E extends HTMLInputElement | HTMLTextAreaElement = HTMLInputElement,
>(value: string, onCommit: (next: string) => void, options: CommitOnBlurOptions = {}) {
  const [buffer, setBuffer] = useState<CommitOnBlurBuffer>(idleCommitOnBlurBuffer);
  const bufferRef = useRef<CommitOnBlurBuffer>(idleCommitOnBlurBuffer);
  const discardEdit = useRef(options.onDiscardEdit);

  useEffect(() => {
    discardEdit.current = options.onDiscardEdit;
  }, [options.onDiscardEdit]);

  const applyBuffer = (next: CommitOnBlurBuffer) => {
    bufferRef.current = next;
    setBuffer(next);
  };

  // Navigating away can unmount a focused field without a blur. Its buffered
  // text is gone, so the owner must not keep claiming an edit it no longer has.
  useEffect(
    () => () => {
      if (!bufferRef.current.beganEdit) return;
      bufferRef.current = idleCommitOnBlurBuffer;
      discardEdit.current?.();
    },
    [],
  );

  return {
    value: displayCommitOnBlurValue(buffer, value),
    onChange: (event: ChangeEvent<E>) => {
      if (!bufferRef.current.beganEdit) {
        options.onBeginEdit?.();
      }
      applyBuffer(typeCommitOnBlurBuffer(event.target.value));
    },
    onFocus: () => {
      applyBuffer(focusCommitOnBlurBuffer(value));
    },
    onBlur: () => {
      const outcome = endCommitOnBlurBuffer(bufferRef.current, value);
      applyBuffer(outcome.buffer);
      if (outcome.commit !== null) {
        onCommit(outcome.commit);
      } else if (outcome.discard) {
        options.onDiscardEdit?.();
      }
    },
    onKeyDown: (event: KeyboardEvent<E>) => {
      if (options.commitOnEnter !== false && event.key === "Enter") {
        event.preventDefault();
        event.currentTarget.blur();
      }
    },
  };
}

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

/**
 * Buffer text input locally so keystrokes don't cause a settings-wide
 * re-render (and optionally a server RPC round-trip) on every character.
 * `onCommit` fires on blur and, unless disabled, on Enter.
 *
 * The draft resynchronizes from the upstream `value` only when the input
 * is not focused, so an external push (e.g. an optimistic settings
 * update from the user's own commit, or a reset to defaults) doesn't
 * clobber an in-progress edit.
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
  const [draft, setDraft] = useState<string | null>(null);
  const beganEdit = useRef(false);
  const discardEdit = useRef(options.onDiscardEdit);

  useEffect(() => {
    discardEdit.current = options.onDiscardEdit;
  }, [options.onDiscardEdit]);

  // Navigating away can unmount a focused field without a blur. Its buffered
  // text is gone, so the owner must not keep claiming an edit it no longer has.
  useEffect(
    () => () => {
      if (!beganEdit.current) return;
      beganEdit.current = false;
      discardEdit.current?.();
    },
    [],
  );

  return {
    value: draft ?? value,
    onChange: (event: ChangeEvent<E>) => {
      if (!beganEdit.current) {
        beganEdit.current = true;
        options.onBeginEdit?.();
      }
      setDraft(event.target.value);
    },
    onFocus: () => {
      beganEdit.current = false;
      setDraft(value);
    },
    onBlur: () => {
      const next = draft ?? value;
      const began = beganEdit.current;
      beganEdit.current = false;
      setDraft(null);
      if (next !== value) {
        onCommit(next);
      } else if (began) {
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

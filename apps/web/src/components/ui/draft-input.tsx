"use client";

import type * as React from "react";

import { useCommitOnBlur } from "~/hooks/useCommitOnBlur";
import { Input, type InputProps } from "./input";
import { Textarea } from "./textarea";

export type DraftInputProps = Omit<InputProps, "value" | "onChange" | "defaultValue"> & {
  readonly value: string;
  readonly onCommit: (next: string) => void;
};

/**
 * Text `<Input>` that buffers keystrokes locally and invokes `onCommit`
 * only when the user finishes editing (blur or Enter). Prevents each
 * keystroke from triggering a settings-wide re-render or a server RPC
 * round-trip, which otherwise makes fields backed by a server-hydrated
 * value feel laggy.
 */
export function DraftInput({ value, onCommit, ...rest }: DraftInputProps) {
  const bag = useCommitOnBlur(value, onCommit);
  return <Input {...rest} {...bag} />;
}

export type DraftTextareaProps = Omit<
  React.ComponentProps<typeof Textarea>,
  "value" | "onChange" | "defaultValue"
> & {
  readonly value: string;
  readonly onCommit: (next: string) => void;
};

/**
 * Multi-line `<Textarea>` that buffers keystrokes locally and invokes
 * `onCommit` only on blur. Enter inserts a newline, so multi-line values
 * keep their line breaks while the parent only sees committed text.
 */
export function DraftTextarea({ value, onCommit, ...rest }: DraftTextareaProps) {
  const bag = useCommitOnBlur<HTMLTextAreaElement>(value, onCommit, { commitOnEnter: false });
  return <Textarea {...rest} {...bag} />;
}

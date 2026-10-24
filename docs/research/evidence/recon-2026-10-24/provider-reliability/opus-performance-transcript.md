**Verdict: ACCEPT.** I found no blocking defects in the four files against HEAD `0c05baa3f`. Only those four files have changes; nothing else in the tree is modified.

## Boundary correctness

**`apps/server/src/terminal/Manager.ts`**

- Lines 1003–1007, 1050–1053 and 1099–1102 match upstream #23819 line for line.
- The new scan start is safe because of how the leftover text is stored between chunks:
  - The leftover is only set by `sanitizeTerminalHistoryChunk`, or cleared to `""` on exit, stop and restart. The only caller is at line 2010. Nothing trims it from the front, so an unfinished sequence always starts at position 0.
  - When that sequence is OSC, DCS, PM or APC, the earlier call already scanned all of it and found no terminator. The one exception is a trailing `ESC`, whose `\` may arrive in the next chunk. Restarting the scan at `length - 1` covers exactly that case.
  - When the leftover is an unfinished CSI, C1 CSI or ESC-with-intermediates, those parsers consume everything up to the end of the leftover. The bytes they can stop on early are intermediates (0x20–0x2f), and none of those can start a string sequence. Any later string sequence therefore starts at or after the boundary, so the `Math.max(...)` change never affects it.
  - A string sequence that starts after a terminator found in this call also sits past the scan start, so it scans normally.
- The parser still works on JavaScript string characters (UTF-16 code units), not bytes, as before. Content, stripping rules and the C1 ST (0x9c) / BEL / `ESC \` handling are unchanged.

**`apps/server/src/vcs/GitVcsDriverCore.ts`**

- Lines 665–668 and 684–687 now skip the line buffer only when `onLine` is undefined. Before the change, `emitCompleteLines` only ever called `onLine` when it was set, and the line buffer is local. Skipping it changes nothing visible.
- Byte counting, the cap error (`outputLength`), cutting the chunk at `maxOutputBytes`, ending the decoder with a U+FFFD replacement character on truncation, and returning only `text` are all unchanged.
- Real callers:
  - The only code that passes line callbacks is `commit` (lines 1878–1887), via `executeRaw` (lines 825–837). It sets both callbacks whenever `onOutputLine` is present.
  - Every other `execute` and `runGitStdout*` caller passes none, so they now skip line scanning. That is the intended gain.
- This is the upstream #23953 change adapted to local code. Upstream's separate line decoder does not exist here, and that adaptation is correct.

## Test quality

- **`Manager.test.ts:1367–1432`**
  - The bound at line 1422 counts work done, not time, so it does not depend on timing.
  - The first sequence ends with `ESC` exactly at a 4,096-character chunk edge. An off-by-one (scan start at `length` instead of `length - 1`) would merge it with the following `ESC]11;?BEL`, and the history check would fail. So the test protects the boundary case.
  - It also checks the saved history and the history after reopening.
  - It replaces `String.prototype.charCodeAt` while it runs and restores it in `ensuring`. I found no `concurrent` usage in the file, so other tests should not be affected.
- **`GitVcsDriverCore.test.ts:109–183`**
  - These tests prove the results are the same with and without callbacks. They cover UTF-8 split across one-byte chunks, NUL, CRLF, output with no final newline, and both cap modes (marker and error).
  - They would also pass on HEAD, so they do not prove the scan is skipped. That is acceptable for a change that only affects speed.

## Non-blocking notes

1. **`GitVcsDriverCore.test.ts:160`** asserts `"Updating 雪\rdone"` as one line, which records current Neokod behaviour: only `\n` splits lines. Upstream's test expects `"Updating 雪", "done"`. If you later port upstream's handling of `\r` progress lines, update this assertion on purpose.
2. **Remaining cost in `Manager.ts:1002`**, already present before this change and the same upstream: each chunk still copies the whole leftover when joining it to new data, and the leftover has no size limit for a sequence that never ends. The change removes the repeated character scanning but not that copying.
3. The large-read counter at test line 1422 also counts any other code that reads strings over 4,096 characters while it runs. Today that only makes the bound stricter.

## Proof limits

- I ran no tests, linters, typecheck or builds, as this was a read-only review. Pass results and timing figures come only from the worker's report in `/tmp`, and I did not rerun its measurement scripts.
- I did not confirm that the Manager test fails on HEAD. The worker reports 1,368,145 reads against a limit of 262,242, and that figure is consistent with a rescan cost that grows quadratically.
- I checked upstream by fetching the diffs for #23819 (GitHub page) and #23953 (raw diff).
- Not checked: Windows, a real PTY, a real `git` binary, and the `commit` progress path end to end.

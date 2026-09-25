/**
 * Terminal-safe text (shared by the CLI output path and the console logger).
 *
 * Untrusted text reaches the terminal from many places: competitor and own
 * page titles, imported questions, content item titles, memory search hits,
 * stored reports. Printed raw, ANSI/OSC/CSI escape sequences and other C0/C1
 * control characters could retitle the terminal, move the cursor, erase or
 * overwrite lines, or conceal text (including this application's own
 * warnings), and bidi/invisible characters could make what the operator reads
 * differ from what is stored. `forTerminal` replaces every such character with
 * a VISIBLE marker (e.g. `[U+001B]`), so nothing is hidden and nothing can
 * rewrite the screen. Newlines and tabs are kept. The rules are the same as
 * `forTerminal` in src/approvals/display.ts (approval review output).
 *
 * `stripControlChars` is the ingestion-side helper: it removes C0/C1 controls
 * (not bidi marks, which legitimate right-to-left text uses) before untrusted
 * text is stored.
 */

// C0 controls except \t and \n, DEL, C1 controls; bidi controls, zero-width and other invisible characters.
const UNSAFE_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

// C0 controls except \t and \n, DEL, and C1 controls (no bidi or invisible formatting characters).
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

function marker(ch: string): string {
  return `[U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`;
}

/** Replace control, bidi, and invisible characters with visible `[U+XXXX]` markers (newlines and tabs are kept). Idempotent. */
export function forTerminal(text: string | null | undefined): string {
  if (text === null || text === undefined) return '';
  return String(text).replace(UNSAFE_RE, marker);
}

/** True when `forTerminal` would change the text (worth a visible warning). */
export function hasUnsafeTerminalChars(text: string | null | undefined): boolean {
  if (!text) return false;
  UNSAFE_RE.lastIndex = 0;
  const found = UNSAFE_RE.test(String(text));
  UNSAFE_RE.lastIndex = 0;
  return found;
}

/**
 * Remove C0 (except \t and \n), DEL, and C1 control characters from untrusted
 * text at ingestion. Each one is replaced with `replacement` (a space by
 * default, so words stay apart). A carriage return is a C0 control too: pass
 * text through this only after line endings were handled if they matter.
 */
export function stripControlChars(text: string, replacement = ' '): string {
  return text.replace(CONTROL_RE, replacement);
}

/** Replace C0/C1 control characters (including a lone carriage return and ESC) with visible markers; bidi marks are kept. */
export function markControlChars(text: string): string {
  return text.replace(CONTROL_RE, marker);
}

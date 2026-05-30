//@ backend dafny

// The faithful core of the edit_file tool (src/tools/base.ts) — VERIFIED.
//
// edit_file finds `old` in a file and replaces it: not-found is an error, more
// than one occurrence without replace_all is an error, otherwise it splices.
// Here the *decision* and the single-occurrence *splice* are proved correct.
//
// Strings are modeled as arrays of single-character strings (`string[]`); the
// shell projects `string <-> string[]` via `[...s]` / `s.join("")` — a trusted
// boundary, exactly like permissions.ts trusts `path.resolve().split("/")`.
//
// Properties (proofs in edit.dfy):
//   E1 soundness — editFile's verdict (NotFound / Ambiguous / Replaced) matches
//                  the occurrence count, branch for branch
//   E2 identity  — replacing text that does not occur leaves the content unchanged
//   E3 splice    — replacing `old` with `old` is a no-op (the splice touches
//                  exactly the matched span and nothing else)

export type Edit =
  | { kind: "NotFound" }
  | { kind: "Ambiguous" }
  | { kind: "Replaced" };

/** `old` occurs in `hay` starting at index 0. (decreases on `old` — always in bounds) */
export function matchesAt(hay: string[], old: string[]): boolean {
  //@ decreases old.length
  if (old.length === 0) return true;
  if (hay.length === 0) return false;
  if (hay[0] !== old[0]) return false;
  return matchesAt(hay.slice(1), old.slice(1));
}

/** Drop the first `old.length` characters (the matched prefix). Total — never out of bounds. */
export function dropMatch(hay: string[], old: string[]): string[] {
  //@ decreases old.length
  if (old.length === 0) return hay;
  if (hay.length === 0) return hay;
  return dropMatch(hay.slice(1), old.slice(1));
}

/** `old` occurs somewhere in `hay`. (decreases on `hay` — advances one char) */
export function occurs(hay: string[], old: string[]): boolean {
  //@ decreases hay.length
  if (hay.length === 0) return false;
  if (matchesAt(hay, old)) return true;
  return occurs(hay.slice(1), old);
}

/** The suffix after the first occurrence of `old` (or [] if none). */
export function afterFirst(hay: string[], old: string[]): string[] {
  //@ decreases hay.length
  if (hay.length === 0) return [];
  if (matchesAt(hay, old)) return dropMatch(hay, old);
  return afterFirst(hay.slice(1), old);
}

/** Replace the first occurrence of `old` with `repl`. (= hay.replace(old, repl)) */
export function replaceFirst(hay: string[], old: string[], repl: string[]): string[] {
  //@ decreases hay.length
  if (hay.length === 0) return hay;
  if (matchesAt(hay, old)) return [...repl, ...dropMatch(hay, old)];
  return [hay[0], ...replaceFirst(hay.slice(1), old, repl)];
}

/** True iff `old` occurs more than once (a first match, then another after it). */
export function manyOcc(hay: string[], old: string[]): boolean {
  return occurs(hay, old) && occurs(afterFirst(hay, old), old);
}

/**
 * The edit decision, mirroring editFileTool's verdict. The shell does the actual
 * splice: `replaceFirst` (verified) on a Replaced verdict without replace_all,
 * or its own all-occurrence join (trusted) with replace_all.
 */
export function editFile(content: string[], old: string[], all: boolean): Edit {
  //@ requires old.length > 0
  //@ ensures (\result.kind === "NotFound") === !occurs(content, old)
  //@ ensures (\result.kind === "Ambiguous") === (manyOcc(content, old) && !all)
  //@ ensures (\result.kind === "Replaced") === (occurs(content, old) && (!manyOcc(content, old) || all))
  if (!occurs(content, old)) return { kind: "NotFound" };
  if (manyOcc(content, old) && !all) return { kind: "Ambiguous" };
  return { kind: "Replaced" };
}

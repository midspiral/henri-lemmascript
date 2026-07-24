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

// Loop-form implementations. The recursive equations that E1–E4 are proved
// against remain each function's Dafny SPEC BODY (filled in edit.dfy); the
// loops below are the `by method` bodies Dafny verifies against them. The
// loops exist because JS gives us neither tail calls nor deep stacks: the
// original recursive forms overflowed on files past ~8KB (and the per-step
// `.slice(1)` copies made them quadratic before that).

/** `old` occurs in `hay` starting at index `p`. Index-based — no copies. */
//@ pure
//@ verify
export function matchesFrom(hay: string[], old: string[], p: number): boolean {
  //@ requires 0 <= p && p <= hay.length
  //@ type p nat
  //@ type j nat
  if (old.length > hay.length - p) return false;
  let j = 0;
  while (j < old.length) {
    //@ invariant 0 <= j && j <= old.length
    //@ invariant p + old.length <= hay.length
    //@ invariant matchesAt(hay.slice(p), old) === matchesAt(hay.slice(p + j), old.slice(j))
    //@ decreases old.length - j
    if (hay[p + j] !== old[j]) return false;
    j = j + 1;
  }
  return true;
}

/** `old` occurs in `hay` starting at index 0. */
//@ pure
//@ verify
export function matchesAt(hay: string[], old: string[]): boolean {
  //@ type j nat
  if (old.length > hay.length) return false;
  let j = 0;
  while (j < old.length) {
    //@ invariant 0 <= j && j <= old.length
    //@ invariant old.length <= hay.length
    //@ invariant matchesAt(hay, old) === matchesAt(hay.slice(j), old.slice(j))
    //@ decreases old.length - j
    if (hay[j] !== old[j]) return false;
    j = j + 1;
  }
  return true;
}

/** Drop the first `old.length` characters (the matched prefix). Total — never out of bounds. */
//@ pure
//@ verify
export function dropMatch(hay: string[], old: string[]): string[] {
  //@ type k nat
  let k = 0;
  while (k < old.length && k < hay.length) {
    //@ invariant 0 <= k && k <= old.length && k <= hay.length
    //@ invariant dropMatch(hay, old) === dropMatch(hay.slice(k), old.slice(k))
    //@ decreases old.length - k
    k = k + 1;
  }
  return hay.slice(k);
}

/** `old` occurs somewhere in `hay`. */
//@ pure
//@ verify
export function occurs(hay: string[], old: string[]): boolean {
  //@ type p nat
  let p = 0;
  while (p < hay.length) {
    //@ invariant 0 <= p && p <= hay.length
    //@ invariant occurs(hay, old) === occurs(hay.slice(p), old)
    //@ decreases hay.length - p
    if (matchesFrom(hay, old, p)) return true;
    p = p + 1;
  }
  return false;
}

/** The suffix after the first occurrence of `old` (or [] if none). */
//@ pure
//@ verify
export function afterFirst(hay: string[], old: string[]): string[] {
  //@ type p nat
  let p = 0;
  while (p < hay.length) {
    //@ invariant 0 <= p && p <= hay.length
    //@ invariant afterFirst(hay, old) === afterFirst(hay.slice(p), old)
    //@ decreases hay.length - p
    if (matchesFrom(hay, old, p)) return dropMatch(hay.slice(p), old);
    p = p + 1;
  }
  return [];
}

/** Replace the first occurrence of `old` with `repl`. (= hay.replace(old, repl)) */
//@ pure
//@ verify
export function replaceFirst(hay: string[], old: string[], repl: string[]): string[] {
  //@ type p nat
  let p = 0;
  while (p < hay.length) {
    //@ invariant 0 <= p && p <= hay.length
    //@ invariant forall(q, 0 <= q && q < p ==> !matchesAt(hay.slice(q), old))
    //@ decreases hay.length - p
    if (matchesFrom(hay, old, p)) {
      return [...hay.slice(0, p), ...repl, ...dropMatch(hay.slice(p), old)];
    }
    p = p + 1;
  }
  return hay;
}

/** True iff `old` occurs more than once (a first match, then another after it). */
//@ verify
export function manyOcc(hay: string[], old: string[]): boolean {
  return occurs(hay, old) && occurs(afterFirst(hay, old), old);
}

/**
 * The edit decision, mirroring editFileTool's verdict. The shell does the actual
 * splice: `replaceFirst` (verified) on a Replaced verdict without replace_all,
 * or its own all-occurrence join (trusted) with replace_all.
 */
export function editFile(content: string[], old: string[], all: boolean): Edit {
  //@ verify
  //@ contract The edit verdict matches the occurrence count exactly — NotFound when old does not occur, Ambiguous when it occurs more than once without replace-all, and Replaced otherwise.
  //@ requires old.length > 0
  //@ ensures (\result.kind === "NotFound") === !occurs(content, old)
  //@ ensures (\result.kind === "Ambiguous") === (manyOcc(content, old) && !all)
  //@ ensures (\result.kind === "Replaced") === (occurs(content, old) && (!manyOcc(content, old) || all))
  if (!occurs(content, old)) return { kind: "NotFound" };
  if (manyOcc(content, old) && !all) return { kind: "Ambiguous" };
  return { kind: "Replaced" };
}

// ── Splice faithfulness, surfaced as theorems ───────────────────────────────
// These are pure carriers: the statement lives here (//@ ensures), the inductive
// proof lives in edit.dfy as the generated `_ensures` lemma body. A reader of
// this file sees exactly what is guaranteed about the splice; the .dfy holds how.

/** E2 — replacing text that does not occur leaves the content unchanged. */
export function noMatchIdentity(hay: string[], old: string[], repl: string[]): boolean {
  //@ verify
  //@ contract Replacing text that does not occur leaves the content unchanged.
  //@ requires !occurs(hay, old)
  //@ ensures replaceFirst(hay, old, repl) === hay
  return true;
}

/** E3 — replacing `old` with `old` is a no-op: the splice touches exactly the matched span. */
export function spliceNoop(hay: string[], old: string[]): boolean {
  //@ verify
  //@ contract Replacing old with itself is a no-op — the splice touches exactly the matched span and nothing else.
  //@ ensures replaceFirst(hay, old, old) === hay
  return true;
}

/** E4 — a single splice changes the length by exactly repl.length - old.length. */
export function spliceLength(hay: string[], old: string[], repl: string[]): boolean {
  //@ verify
  //@ contract A single splice changes the content length by exactly repl.length minus old.length.
  //@ requires occurs(hay, old)
  //@ ensures replaceFirst(hay, old, repl).length === hay.length - old.length + repl.length
  return true;
}

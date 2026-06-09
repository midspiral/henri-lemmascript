//@ backend dafny

// Faithful core of the GVE executor's ref-resolution discipline (src/gve/execute.ts and
// gate.ts's validatePlan) — VERIFIED.
//
// Each plan step is abstracted to the symbolic refs it READS and the name it BINDS; the
// real executor/validator project onto this (a trusted boundary, like edit.ts's
// `string <-> string[]`). An optional bind is modeled as a 0-or-1 length list to stay in
// the verifiable fragment; names are plain strings.
//
// `executePlan` resolves refs IN ORDER, so a step may only read a name bound by an
// EARLIER step (`execOk`). `validatePlan` originally checked refs against ALL binds —
// forward included (`okAllBinds`) — which is too weak. The theorems (proved in
// exec_core.dfy) are:
//   forwardRefGap     — `okAllBinds` passes a forward-ref plan that `execOk` rejects
//                       (the all-binds shortcut is unsound).
//   fixIsStrengthening — `execOk(steps, []) ==> okAllBinds(steps)` (the in-order check
//                       only ever removes the unsafe forward-ref plans).
// As in edit.ts, this file holds the functions; the proofs live in exec_core.dfy.

export type EStep = { reads: string[]; bind: string[] };

/** `y` occurs in `xs`. */
export function contains(xs: string[], y: string): boolean {
  //@ verify
  //@ decreases xs.length
  if (xs.length === 0) return false;
  if (xs[0] === y) return true;
  return contains(xs.slice(1), y);
}

/** Every name in `reads` is present in `bound`. */
export function allBound(reads: string[], bound: string[]): boolean {
  //@ verify
  //@ decreases reads.length
  if (reads.length === 0) return true;
  if (!contains(bound, reads[0])) return false;
  return allBound(reads.slice(1), bound);
}

/** The names bound by all of `steps` (the all-binds set the old validator used). */
export function allBinds(steps: EStep[]): string[] {
  //@ verify
  //@ decreases steps.length
  if (steps.length === 0) return [];
  return steps[0].bind.concat(allBinds(steps.slice(1)));
}

/** Every step's reads are in the (constant) set `b`. */
export function allReadsBound(steps: EStep[], b: string[]): boolean {
  //@ verify
  //@ decreases steps.length
  if (steps.length === 0) return true;
  if (!allBound(steps[0].reads, b)) return false;
  return allReadsBound(steps.slice(1), b);
}

/** Old validator: every ref is in the FULL all-binds set (forward refs slip through). */
export function okAllBinds(steps: EStep[]): boolean {
  //@ verify
  return allReadsBound(steps, allBinds(steps));
}

/** Executor / fixed validator: in order, each step's reads are bound by then. */
export function execOk(steps: EStep[], bound: string[]): boolean {
  //@ verify
  //@ decreases steps.length
  if (steps.length === 0) return true;
  if (!allBound(steps[0].reads, bound)) return false;
  return execOk(steps.slice(1), bound.concat(steps[0].bind));
}

// ═══════════════════════════════════════════════════════════════════════════
// The two theorems, surfaced. Each //@ ensures states the property; the proof is
// the generated `_ensures` lemma body in exec_core.dfy. The supporting induction
// lemmas (containsConcat, allBoundConcat, strengthenGen) stay in exec_core.dfy —
// their statements are about appending to the bound set, which //@ specs can't
// write.
// ═══════════════════════════════════════════════════════════════════════════

/** The two-step forward-ref plan: step 0 READS `x`, step 1 BINDS `x` — so the
 *  read precedes the bind (the witness the executor must reject). */
export function forwardRefPlan(): EStep[] {
  //@ verify
  return [{ reads: ["x"], bind: [] }, { reads: [], bind: ["x"] }];
}

// forwardRefGap — the old all-binds check ACCEPTS a forward-ref plan that
// in-order execution REJECTS. So checking refs against the full bind set
// (forward included) is unsound; the witness proves the gap is real.
export function forwardRefGap(): boolean {
  //@ verify
  //@ ensures okAllBinds(forwardRefPlan()) === true
  //@ ensures execOk(forwardRefPlan(), []) === false
  return true;
}

// fixIsStrengthening — the fixed in-order check is a strengthening of the old
// one: any plan execution accepts, the all-binds check also accepts. So swapping
// in the in-order check only ever removes the unsafe forward-ref plans, never a
// safe one.
export function fixIsStrengthening(steps: EStep[]): boolean {
  //@ verify
  //@ ensures execOk(steps, []) ==> okAllBinds(steps)
  return true;
}

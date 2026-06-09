//@ backend dafny

// The access decision — the pure core of henri's permission system.
//
// VERIFICATION TARGET (Phase 1). Written in LemmaScript's computational
// fragment so it is extracted to Dafny and proved. The interactive, stateful
// wrapper that prompts the user and records grants lives in permission-gate.ts
// (unverified shell).
//
// Properties (see DESIGN.md §3.1 and permissions.dfy for the proofs):
//   P1 soundness   — decide() == "Allow" iff isAllowed() (no other path to Allow)
//   P2 containment — a path that escapes cwd is never auto-granted
//   P3 monotonicity— adding a grant never turns Allow into Deny/Prompt
//   P4 reject-safe — rejectPrompts only rewrites Prompt -> Deny

export type Outcome = "Allow" | "Deny" | "Prompt";

/** A per-path session grant: "this tool may touch this (normalized) path". */
export interface PathGrant {
  tool: string;
  segs: string[];
}

export interface PermState {
  autoAllow: Set<string>; // tools always allowed, no prompt
  autoAllowCwd: Set<string>; // path-tools auto-allowed within cwd
  allowedTools: Set<string>; // session "always allow this tool"
  allowedBashCommands: Set<string>; // session "always allow this exact command"
  allowedPaths: PathGrant[]; // session per-path grants
  allowAll: boolean; // allow everything this session
  rejectPrompts: boolean; // automation: deny instead of prompting
}

export type Req =
  | { kind: "bash"; command: string }
  | { kind: "path"; tool: string; segs: string[]; absolute: boolean }
  | { kind: "other"; tool: string };

/** Structural equality of two segment sequences (runtime-correct; === on arrays is reference equality). */
export function seqEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  if (a[0] !== b[0]) return false;
  return seqEq(a.slice(1), b.slice(1));
}

/** Resolve "." and ".." against a sequence of path segments, left to right. */
export function normalizeFrom(acc: string[], segs: string[]): string[] {
  //@ decreases segs.length
  if (segs.length === 0) return acc;
  const s = segs[0];
  const rest = segs.slice(1);
  if (s === "..") return normalizeFrom(acc.slice(0, acc.length > 0 ? acc.length - 1 : 0), rest);
  if (s === "" || s === ".") return normalizeFrom(acc, rest);
  return normalizeFrom([...acc, s], rest);
}

export function normalize(segs: string[]): string[] {
  return normalizeFrom([], segs);
}

/** Resolve a requested path (relative to cwd, or absolute) to normalized segments. */
export function resolvePath(cwd: string[], segs: string[], absolute: boolean): string[] {
  return absolute ? normalize(segs) : normalize([...cwd, ...segs]);
}

/** True iff `base` is a segment-prefix of `p`. */
export function isPrefix(base: string[], p: string[]): boolean {
  if (base.length === 0) return true;
  if (p.length === 0) return false;
  if (base[0] !== p[0]) return false;
  return isPrefix(base.slice(1), p.slice(1));
}

/** True iff `p` is `base` or a descendant of it (segment-prefix containment). */
export function isWithin(base: string[], p: string[]): boolean {
  return isPrefix(base, p);
}

/** True iff some recorded grant covers (tool, resolved path). */
export function pathGranted(grants: PathGrant[], tool: string, resolved: string[]): boolean {
  if (grants.length === 0) return false;
  const g = grants[0];
  if (g.tool === tool && seqEq(g.segs, resolved)) return true;
  return pathGranted(grants.slice(1), tool, resolved);
}

/**
 * The justification predicate: true exactly when the call has a recorded reason
 * to be allowed. This IS the soundness contract — decide() returns "Allow" iff
 * isAllowed() holds, so there is no unjustified path to Allow.
 */
export function isAllowed(st: PermState, cwd: string[], req: Req): boolean {
  if (st.allowAll) return true;
  switch (req.kind) {
    case "bash":
      return st.autoAllow.has("bash") || st.allowedBashCommands.has(req.command);
    case "path": {
      if (st.autoAllow.has(req.tool)) return true;
      const resolved = resolvePath(cwd, req.segs, req.absolute);
      return pathGranted(st.allowedPaths, req.tool, resolved) || (st.autoAllowCwd.has(req.tool) && isWithin(cwd, resolved));
    }
    case "other":
      return st.autoAllow.has(req.tool) || st.allowedTools.has(req.tool);
  }
}

/**
 * The pure access decision. Mirrors henri's PermissionManager.check(): assumes
 * the call requires permission (the gate short-circuits no-permission tools).
 */
export function decide(st: PermState, cwd: string[], req: Req): Outcome {
  //@ ensures (\result === "Allow") === isAllowed(st, cwd, req)
  if (isAllowed(st, cwd, req)) return "Allow";
  if (st.rejectPrompts) return "Deny";
  return "Prompt";
}

// ═══════════════════════════════════════════════════════════════════════════
// Verified properties, surfaced as theorems. Each //@ ensures states a property;
// the proof is the generated `_ensures` lemma body in permissions.dfy. P1
// (soundness) is the ensures already on decide() above — it ties decide()==="Allow"
// to isAllowed(), so the containment/monotonicity theorems below are phrased over
// the isAllowed() predicate directly. State-update properties are phrased
// relationally (a second state `st2` with field-equality / subset requires)
// because //@ specs cannot construct an update.
// ═══════════════════════════════════════════════════════════════════════════

// P2 containment (the headline). A path-tool call that is justified — no blanket
// allow, no autoAllow, no explicit per-path grant — must resolve INSIDE cwd. So
// auto-allow-in-cwd can never reach outside the working directory.
export function autoGrantImpliesWithin(st: PermState, cwd: string[], req: Req): boolean {
  //@ verify
  //@ requires req.kind === "path"
  //@ requires !st.allowAll
  //@ requires !st.autoAllow.has(req.tool)
  //@ requires !pathGranted(st.allowedPaths, req.tool, resolvePath(cwd, req.segs, req.absolute))
  //@ requires isAllowed(st, cwd, req)
  //@ ensures isWithin(cwd, resolvePath(cwd, req.segs, req.absolute))
  return true;
}

// P2 dual — a path that escapes cwd, with no other grant, is never justified
// (so decide() can never auto-Allow it).
export function noEscape(st: PermState, cwd: string[], req: Req): boolean {
  //@ verify
  //@ requires req.kind === "path"
  //@ requires !st.allowAll
  //@ requires !st.autoAllow.has(req.tool)
  //@ requires !pathGranted(st.allowedPaths, req.tool, resolvePath(cwd, req.segs, req.absolute))
  //@ requires !isWithin(cwd, resolvePath(cwd, req.segs, req.absolute))
  //@ ensures !isAllowed(st, cwd, req)
  return true;
}

// P3 monotonicity — growing any of the grant SETS never revokes a justification.
// st2 dominates st on every grant set (autoAllow, autoAllowCwd, allowedTools,
// allowedBashCommands all ⊇ st's) with allowAll and the per-path grants
// unchanged; then a prior justification still holds. This single fact is what
// "adding a session grant / a hook's auto-allow can only loosen, never tighten"
// rests on — and what hooks.dfy's H4 link composes with (mergePerms only grows
// autoAllow/autoAllowCwd). The per-path-grant case (appending to allowedPaths)
// is P3_GrantPathMonotone in permissions.dfy: its statement needs list append,
// which //@ specs cannot express, so it stays a Dafny lemma.
export function grantMonotone(st: PermState, st2: PermState, cwd: string[], req: Req): boolean {
  //@ verify
  //@ requires st2.allowAll === st.allowAll
  //@ requires st2.allowedPaths === st.allowedPaths
  //@ requires st.autoAllow <= st2.autoAllow
  //@ requires st.autoAllowCwd <= st2.autoAllowCwd
  //@ requires st.allowedTools <= st2.allowedTools
  //@ requires st.allowedBashCommands <= st2.allowedBashCommands
  //@ requires isAllowed(st, cwd, req)
  //@ ensures isAllowed(st2, cwd, req)
  return true;
}

// P3 corollary — allow-all justifies everything.
export function allowAllGrantsEverything(st: PermState, cwd: string[], req: Req): boolean {
  //@ verify
  //@ requires st.allowAll
  //@ ensures isAllowed(st, cwd, req)
  return true;
}

// P4 reject-safe — enabling rejectPrompts only ever rewrites Prompt → Deny: the
// outcome is never Prompt, and it is Allow exactly when the unmodified state
// would Allow (rejectPrompts changes no justification). st2 is st with
// rejectPrompts on, everything else equal; \result is decide() under st2.
export function rejectIsDenyOnly(st: PermState, st2: PermState, cwd: string[], req: Req): Outcome {
  //@ verify
  //@ requires st2.rejectPrompts
  //@ requires st2.allowAll === st.allowAll
  //@ requires st2.autoAllow === st.autoAllow
  //@ requires st2.autoAllowCwd === st.autoAllowCwd
  //@ requires st2.allowedTools === st.allowedTools
  //@ requires st2.allowedBashCommands === st.allowedBashCommands
  //@ requires st2.allowedPaths === st.allowedPaths
  //@ ensures (\result === "Allow") === isAllowed(st, cwd, req)
  //@ ensures \result !== "Prompt"
  return decide(st2, cwd, req);
}

// The access decision — the pure core of henri's permission system.
//
// VERIFICATION TARGET (Phase 1). This module is written in LemmaScript's
// computational fragment (no I/O, no mutable closures) so it can be annotated
// and proved later. The interactive, stateful wrapper that prompts the user and
// records grants lives in permission-gate.ts (unverified shell).
//
// Properties to prove (see DESIGN.md §3.1):
//   P1 soundness   — decide() == "Allow" only with a recorded justification
//   P2 containment — a path that escapes cwd is never auto-granted
//   P3 monotonicity— adding a grant never turns Allow into Deny/Prompt
//   P4 reject-safe — rejectPrompts only rewrites Prompt -> Deny

export type Outcome = "Allow" | "Deny" | "Prompt";

export interface PermState {
  autoAllow: Set<string>; // tools always allowed, no prompt
  autoAllowCwd: Set<string>; // path-tools auto-allowed within cwd
  allowedTools: Set<string>; // session "always allow this tool"
  allowedBashCommands: Set<string>; // session "always allow this exact command"
  allowedPaths: Map<string, Set<string>>; // tool -> allowed path-keys
  allowAll: boolean; // allow everything this session
  rejectPrompts: boolean; // automation: deny instead of prompting
}

export type Req =
  | { kind: "bash"; command: string }
  | { kind: "path"; tool: string; segs: string[]; absolute: boolean }
  | { kind: "other"; tool: string };

/** Resolve "." and ".." against a sequence of path segments. */
export function normalize(segs: string[]): string[] {
  let out: string[] = [];
  for (const s of segs) {
    if (s === "..") {
      out = out.slice(0, out.length > 0 ? out.length - 1 : 0);
    } else if (s !== "" && s !== ".") {
      out = [...out, s];
    }
  }
  return out;
}

/** Resolve a requested path (relative to cwd, or absolute) to normalized segments. */
export function resolvePath(cwd: string[], segs: string[], absolute: boolean): string[] {
  return absolute ? normalize(segs) : normalize([...cwd, ...segs]);
}

/** True iff `p` is `base` or a descendant of it (segment-prefix containment). */
export function isWithin(base: string[], p: string[]): boolean {
  if (p.length < base.length) return false;
  let i = 0;
  while (i < base.length) {
    if (p[i] !== base[i]) return false;
    i = i + 1;
  }
  return true;
}

/** Stable key for an allowed-path set. */
export function pathKey(segs: string[]): string {
  return "/" + segs.join("/");
}

/**
 * The pure access decision, mirroring henri's PermissionManager.check()
 * branch-for-branch. Assumes the call requires permission (the gate
 * short-circuits no-permission tools before calling this).
 */
export function decide(st: PermState, cwd: string[], req: Req): Outcome {
  if (st.allowAll) return "Allow";

  const toolName = req.kind === "bash" ? "bash" : req.tool;
  if (st.autoAllow.has(toolName)) return "Allow";

  if (req.kind === "bash") {
    if (st.allowedBashCommands.has(req.command)) return "Allow";
  } else if (req.kind === "path") {
    const resolved = resolvePath(cwd, req.segs, req.absolute);
    const key = pathKey(resolved);
    const allowed = st.allowedPaths.get(req.tool);
    if (allowed !== undefined && allowed.has(key)) return "Allow";
    if (st.autoAllowCwd.has(req.tool) && isWithin(cwd, resolved)) return "Allow";
  } else {
    if (st.allowedTools.has(req.tool)) return "Allow";
  }

  if (st.rejectPrompts) return "Deny";
  return "Prompt";
}

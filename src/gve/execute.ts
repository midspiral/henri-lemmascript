// Execute an ADMITTED plan (DESIGN_GVE.md §3, Stage 2).
//
// The FAITHFUL EXECUTOR — the dominant trust-boundary residue named in §8. It runs
// EXACTLY the verified plan, in order, with no out-of-band tool calls; and it resolves
// symbolic refs (`@bind`) only into ARGUMENT slots — runtime data is never re-interpreted
// as plan structure (the structure is fixed before execution, so a tool result can fill
// an argument but cannot add, remove, or redirect a step). Linear plans only for now: a
// conditional needs an executable guard the DSL does not yet carry, so it is refused
// rather than guessed.
import type { Tool } from "../tools/base.ts";
import type { Workflow, Arg } from "guardians";

export type ExecStep = { tool: string; args: Record<string, string | number>; result: string; bind?: string };
export type ExecResult =
  | { ok: true; steps: ExecStep[]; bindings: Record<string, string> }
  | { ok: false; error: string; steps: ExecStep[] };

export interface ExecOptions {
  // Runtime residual (DESIGN_GVE.md §9): consulted before each tool runs, for the axes
  // static verification does not cover (e.g. destructive paths). Deny ⇒ stop.
  check?: (tool: Tool, args: Record<string, string | number>) => Promise<boolean>;
  onStep?: (step: ExecStep) => void;
  signal?: AbortSignal;
}

function resolveArg(
  v: Arg,
  bindings: Record<string, string>,
): { ok: true; val: string | number } | { ok: false; ref: string } {
  if (typeof v === "object") {
    const val = bindings[v.ref];
    if (val === undefined) return { ok: false, ref: v.ref };
    return { ok: true, val };
  }
  return { ok: true, val: v };
}

export async function executePlan(plan: Workflow, tools: Tool[], opts: ExecOptions = {}): Promise<ExecResult> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const bindings: Record<string, string> = {};
  const steps: ExecStep[] = [];
  for (const s of plan.steps) {
    if ("cond" in s) {
      return { ok: false, error: "conditional execution not yet supported (linear plans only)", steps };
    }
    const tool = byName.get(s.tool);
    if (!tool) return { ok: false, error: `unknown tool: ${s.tool}`, steps };
    const args: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(s.args)) {
      const r = resolveArg(v, bindings);
      if (!r.ok) return { ok: false, error: `unbound ref @${r.ref} in ${s.tool}.${k}`, steps };
      args[k] = r.val;
    }
    if (opts.check && !(await opts.check(tool, args))) {
      return { ok: false, error: `denied at runtime: ${s.tool}`, steps };
    }
    const result = await tool.execute(args, opts.signal);
    const step: ExecStep = { tool: s.tool, args, result };
    if (s.bind) {
      bindings[s.bind] = result;
      step.bind = s.bind;
    }
    steps.push(step);
    if (opts.onStep) opts.onStep(step);
    if (opts.signal?.aborted) return { ok: false, error: "interrupted", steps };
  }
  return { ok: true, steps, bindings };
}

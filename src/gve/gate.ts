// The verify-before-execute gate (DESIGN_GVE.md §3, Stage 2). Given a plan and a
// policy, decide whether henri may execute it. The SAFETY DECISION is the proved
// guardians verdict; this module adds only well-formedness validation and a
// human-readable reason — it makes no taint decision of its own.
import { verify } from "guardians";
import type { Workflow, Step, ToolStep, Arg, Policy, Verdict } from "guardians";

export type GateResult = {
  admit: boolean;
  verdict: Verdict;
  reason: string;
};

function isSymRef(a: Arg): a is { ref: string } {
  return typeof a === "object" && a !== null && "ref" in a;
}
function isCond(s: Step): s is { cond: string; thenSteps: Step[]; elseSteps: Step[] } {
  return "cond" in s;
}

// Flatten to tool steps across both branches of every conditional.
function toolSteps(steps: Step[]): ToolStep[] {
  const out: ToolStep[] = [];
  for (const s of steps) {
    if (isCond(s)) out.push(...toolSteps(s.thenSteps), ...toolSteps(s.elseSteps));
    else out.push(s);
  }
  return out;
}

// Well-formedness: every tool is allowed, and every symbolic ref names some bind in
// the plan. (Strict lexical scoping across conditional branches is a refinement; the
// proved taint check is tool-order based and does not depend on it.)
export function validatePlan(plan: Workflow, policy: Policy): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const steps = toolSteps(plan.steps);
  const binds = new Set<string>();
  for (const s of steps) if (s.bind) binds.add(s.bind);
  for (const s of steps) {
    if (!policy.allowedTools.includes(s.tool)) errors.push(`tool not allowed: ${s.tool}`);
    for (const [k, v] of Object.entries(s.args)) {
      if (isSymRef(v) && !binds.has(v.ref)) errors.push(`unbound ref @${v.ref} in ${s.tool}.${k}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// Reporting only: name the source→sink rules whose tools occur in source-before-sink
// order. NOT the gate (the gate is the proved `verdict.taintWf`); this only explains it.
function firingRules(plan: Workflow, policy: Policy): string[] {
  const seq = toolSteps(plan.steps).map((s) => s.tool);
  const fired: string[] = [];
  for (const r of policy.taintRules) {
    const si = seq.indexOf(r.sourceTool);
    if (si < 0) continue;
    if (seq.indexOf(r.sinkTool, si + 1) >= 0) fired.push(r.name);
  }
  return fired;
}

export function gatePlan(plan: Workflow, policy: Policy): GateResult {
  const v = verify(plan, policy);
  // Gate on PROVED fields only: taintWf (sound over-approx) and automaton. NOT v.ok,
  // which folds in the unverified taintPrecise (see guardians index.ts).
  const admit = !v.taintWf && !v.automaton;
  let reason: string;
  if (admit) {
    reason = "admitted: no source→sink flow proven (taintWf=false)";
  } else if (v.taintWf) {
    const rules = firingRules(plan, policy);
    reason = `rejected: proved taint check flags a source→sink flow${rules.length ? ` [${rules.join(", ")}]` : ""}`;
  } else {
    reason = "rejected: automaton policy violation";
  }
  return { admit, verdict: v, reason };
}

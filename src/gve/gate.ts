// The verify-before-execute gate (DESIGN_GVE.md §3, Stage 2). Given a plan and a
// policy, decide whether henri may execute it. The SAFETY DECISION is the proved
// guardians verdict; this module adds only well-formedness validation and a
// human-readable reason — it makes no taint decision of its own.
import { verify } from "guardians";
import type { Workflow, Step, ToolStep, Arg, Policy, Verdict } from "guardians";
import { execOk, type EStep } from "./exec_core.ts";

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

// Project a tool step onto exec_core's abstraction — the SymRef names it reads and the
// name it binds. This is the trusted boundary (the `string <-> string[]` analog).
function toEStep(s: ToolStep): EStep {
  const reads: string[] = [];
  for (const v of Object.values(s.args)) if (isSymRef(v)) reads.push(v.ref);
  return { reads, bind: s.bind ? [s.bind] : [] };
}

// Reporting only: which refs are unbound at their point of use. NOT the decision — that
// is the verified execOk in validatePlan.
function unboundRefs(steps: ToolStep[]): string[] {
  const errs: string[] = [];
  const bound = new Set<string>();
  for (const s of steps) {
    for (const [k, v] of Object.entries(s.args)) {
      if (isSymRef(v) && !bound.has(v.ref)) errs.push(`unbound ref @${v.ref} in ${s.tool}.${k}`);
    }
    if (s.bind) bound.add(s.bind);
  }
  return errs;
}

// Well-formedness: every tool is allowed, and refs resolve in order. The ref-resolution
// DECISION is the VERIFIED `exec_core.execOk`, run over the projected plan — so the proven
// function is the one that actually runs, not a re-implementation. (execOk is the in-order
// check; exec_core.dfy proves it sound — `fixIsStrengthening` — and the all-binds shortcut
// `validatePlan` used before unsound — `forwardRefGap`.) The tool-allowed check and the
// error messages are unverified shell.
export function validatePlan(plan: Workflow, policy: Policy): { ok: boolean; errors: string[] } {
  const steps = toolSteps(plan.steps);
  const errors: string[] = [];
  for (const s of steps) {
    if (!policy.allowedTools.includes(s.tool)) errors.push(`tool not allowed: ${s.tool}`);
  }
  if (!execOk(steps.map(toEStep), [])) errors.push(...unboundRefs(steps));
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

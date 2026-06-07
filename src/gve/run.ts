// Generate-verify-execute orchestration (DESIGN_GVE.md §3). Generate a plan from the
// model, then run the pure pipeline parse → validate → verify(gate). Execution of an
// admitted plan is Stage 2 (stubbed here). The pure half (processPlanText) and the
// provider seam (planViaProvider) are both offline-testable.
import type { Provider } from "../providers/index.ts";
import type { Policy, Workflow } from "guardians";
import { userMessage } from "../messages.ts";
import { getDefaultTools } from "../tools/base.ts";
import { color, panel } from "../ui.ts";
import { planSystemPrompt } from "./prompt.ts";
import { parsePlan, renderLiterate } from "./plan.ts";
import { validatePlan, gatePlan, type GateResult } from "./gate.ts";
import { exfilPolicy } from "./policy.ts";

export type PlanOutcome =
  | { stage: "parse"; error: string; raw: string }
  | { stage: "validate"; plan: Workflow; literate: string; errors: string[] }
  | { stage: "gate"; plan: Workflow; literate: string; gate: GateResult };

// Pure: model text → outcome. The SAFETY DECISION is gatePlan's proved verdict.
export function processPlanText(text: string, policy: Policy): PlanOutcome {
  const parsed = parsePlan(text);
  if (!parsed.ok) return { stage: "parse", error: parsed.error, raw: text };
  const literate = renderLiterate(parsed.plan);
  const val = validatePlan(parsed.plan, policy);
  if (!val.ok) return { stage: "validate", plan: parsed.plan, literate, errors: val.errors };
  return { stage: "gate", plan: parsed.plan, literate, gate: gatePlan(parsed.plan, policy) };
}

// Drive the provider for a plan, then run the pipeline. Provider-only side effect.
export async function planViaProvider(
  provider: Provider,
  task: string,
  signal?: AbortSignal,
): Promise<{ text: string; outcome: PlanOutcome }> {
  const system = planSystemPrompt(getDefaultTools());
  let text = "";
  for await (const ev of provider.stream([userMessage(task)], [], system, signal)) {
    if (ev.text) text += ev.text;
  }
  return { text, outcome: processPlanText(text, exfilPolicy()) };
}

export function printOutcome(task: string, outcome: PlanOutcome): void {
  console.log(panel(task, { title: "Task", border: "blue" }));
  if (outcome.stage === "parse") {
    console.log(color.red("✗ could not parse a plan from the model output:"));
    console.log(color.dim(`  ${outcome.error}`));
    console.log(panel(outcome.raw.slice(0, 600), { title: "raw output" }));
    return;
  }
  console.log(panel(outcome.literate, { title: "Plan (verified DSL)" }));
  if (outcome.stage === "validate") {
    console.log(color.yellow(`✗ malformed plan: ${outcome.errors.join("; ")}`));
    return;
  }
  const { gate } = outcome;
  if (gate.admit) {
    console.log(color.green("✓ VERIFIED SAFE before execution — no untrusted→sink flow proven."));
    console.log(color.dim("  (execution of the admitted plan is Stage 2; not run here.)"));
  } else {
    console.log(color.red("✗ REJECTED before execution — plan not run."));
    console.log(color.dim(`  ${gate.reason}`));
  }
}

export async function runPlanMode(provider: Provider, task: string, signal?: AbortSignal): Promise<void> {
  const { outcome } = await planViaProvider(provider, task, signal);
  printOutcome(task, outcome);
}

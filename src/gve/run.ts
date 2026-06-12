// Generate-verify-execute orchestration (DESIGN_GVE.md §3). Generate a plan from the
// model, run the pure pipeline parse → validate → verify(gate), and execute an admitted
// plan behind the permission gate. A rejected plan is reported and stopped — the human
// decides. The pure half (processPlanText) and the provider seam (planViaProvider) are
// both offline-testable.
import * as readline from "node:readline/promises";
import type { Provider } from "../providers/index.ts";
import type { Policy, Workflow } from "guardians";
import { userMessage } from "../messages.ts";
import { getDefaultTools } from "../tools/base.ts";
import { DEFAULT_AUTO_ALLOW_CWD, DEFAULT_PATH_BASED, InteractiveGate, emptyState } from "../permission-gate.ts";
import { color, panel, truncate } from "../ui.ts";
import { planSystemPrompt } from "./prompt.ts";
import { parsePlan, renderLiterate } from "./plan.ts";
import { validatePlan, gatePlan, type GateResult } from "./gate.ts";
import { executePlan } from "./execute.ts";
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
  } else {
    console.log(color.red("✗ REJECTED before execution — plan not run."));
    console.log(color.dim(`  ${gate.reason}`));
  }
}

export async function runPlanMode(provider: Provider, task: string, signal?: AbortSignal): Promise<void> {
  const { outcome } = await planViaProvider(provider, task, signal);
  printOutcome(task, outcome);
  if (outcome.stage !== "gate" || !outcome.gate.admit) return;

  // Execute the admitted plan. The plan's data-flow safety is proved; henri's verified
  // permission gate stays on as the RUNTIME RESIDUAL (DESIGN_GVE.md §9) for the axes the
  // static check does not cover (e.g. a destructive but untainted path).
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const gate = new InteractiveGate(
    emptyState(new Set(), new Set(DEFAULT_AUTO_ALLOW_CWD), false),
    new Set(DEFAULT_PATH_BASED),
    (q) => rl.question(q),
  );
  console.log(color.dim("\nExecuting verified-safe plan…"));
  const exec = await executePlan(outcome.plan, getDefaultTools(), {
    signal,
    check: (tool, args) => gate.check(tool, { id: "", name: tool.name, args }),
    onStep: (st) => console.log(panel(truncate(st.result), { title: `${st.tool}${st.bind ? ` → ${st.bind}` : ""}` })),
  });
  rl.close();
  if (exec.ok) console.log(color.green(`✓ executed ${exec.steps.length} step(s)`));
  else console.log(color.red(`✗ execution stopped: ${exec.error}`));
}

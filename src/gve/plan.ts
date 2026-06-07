// Parse a model's plan output into the verified-kernel plan DSL, and render a plan
// back to a human-readable (literate) preview. Both are pure (offline-testable).
//
// The DSL is guardians' `Workflow` — a step list of tool calls with symbolic result
// bindings (`bind`) and references (`{ ref }`), plus nested conditionals. Parsing is
// strict: an unparseable or off-schema plan is rejected before it can be gated.
import type { Workflow, Step, ToolStep, CondStep, Arg } from "guardians";

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function isArg(x: unknown): x is Arg {
  if (typeof x === "string" || typeof x === "number") return true;
  return isObj(x) && typeof x["ref"] === "string" && Object.keys(x).length === 1;
}
function isArgs(x: unknown): x is Record<string, Arg> {
  return isObj(x) && Object.values(x).every(isArg);
}

// Returns a Step or an error message (string).
function parseStep(x: unknown): Step | string {
  if (!isObj(x)) return "a step must be an object";
  if ("cond" in x) {
    if (typeof x["cond"] !== "string") return "conditional 'cond' must be a string";
    const t = parseSteps(x["thenSteps"]);
    if (typeof t === "string") return `thenSteps: ${t}`;
    const e = parseSteps(x["elseSteps"]);
    if (typeof e === "string") return `elseSteps: ${e}`;
    const cond: CondStep = { cond: x["cond"], thenSteps: t, elseSteps: e };
    return cond;
  }
  if (typeof x["tool"] === "string" && isArgs(x["args"]) && (x["bind"] === undefined || typeof x["bind"] === "string")) {
    const step: ToolStep = { tool: x["tool"], args: x["args"] };
    if (typeof x["bind"] === "string") step.bind = x["bind"];
    return step;
  }
  return "a step must be a tool call (tool/args) or a conditional (cond/thenSteps/elseSteps)";
}
function parseSteps(x: unknown): Step[] | string {
  if (!Array.isArray(x)) return "'steps' must be an array";
  const out: Step[] = [];
  for (const s of x) {
    const r = parseStep(s);
    if (typeof r === "string") return r;
    out.push(r);
  }
  return out;
}

// Pull the JSON object out of model output: prefer a fenced block, else the span from
// the first '{' to the last '}'. (Shell-side heuristic — the plan is validated after.)
function extractJson(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  return body.slice(start, end + 1);
}

export function parsePlan(text: string): { ok: true; plan: Workflow } | { ok: false; error: string } {
  const json = extractJson(text);
  if (json === null) return { ok: false, error: "no JSON object found in the model output" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  if (!isObj(parsed)) return { ok: false, error: "top-level plan is not an object" };
  const steps = parseSteps(parsed["steps"]);
  if (typeof steps === "string") return { ok: false, error: steps };
  return { ok: true, plan: { steps } };
}

// Literate preview of a plan (DESIGN_GVE.md §3, intentional programming): the same AST
// the gate verifies, shown to the human before execution.
export function renderLiterate(plan: Workflow): string {
  const argStr = (args: Record<string, Arg>): string =>
    Object.entries(args)
      .map(([k, v]) => `${k}=${typeof v === "object" ? "@" + v.ref : JSON.stringify(v)}`)
      .join(", ");
  const lines: string[] = [];
  const walk = (steps: Step[], indent: string): void => {
    let i = 1;
    for (const s of steps) {
      if ("cond" in s) {
        lines.push(`${indent}if ${s.cond}:`);
        walk(s.thenSteps, indent + "    ");
        lines.push(`${indent}else:`);
        walk(s.elseSteps, indent + "    ");
      } else {
        const bind = s.bind ? `  → ${s.bind}` : "";
        lines.push(`${indent}${i}. ${s.tool}(${argStr(s.args)})${bind}`);
      }
      i += 1;
    }
  };
  walk(plan.steps, "");
  return lines.join("\n");
}

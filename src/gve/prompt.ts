// The planner system prompt (DESIGN_GVE.md §3-4): instruct the model to emit a whole
// workflow PLAN in the verified DSL — not to call tools one at a time. The plan is
// formally verified against the security policy before any tool runs.
import type { Tool } from "../tools/base.ts";

export function planSystemPrompt(tools: Tool[]): string {
  const toolLines = tools.map((t) => {
    const props = (t.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    return `- ${t.name}(${Object.keys(props).join(", ")}): ${t.description}`;
  });
  return `You are Henri's PLANNER. Rather than calling tools one at a time, you output a
complete WORKFLOW PLAN as a single JSON object. The plan is FORMALLY VERIFIED against a
security policy before any tool runs: a plan that routes untrusted or sensitive data
into an external sink (an outbound request, or a shell command) is REJECTED and never
executed. Design a plan that keeps such data away from those sinks.

Available tools:
${toolLines.join("\n")}

Output ONLY this JSON object — no prose:
{
  "steps": [
    { "tool": "<name>", "args": { "<param>": <value> }, "bind": "<result-name>" },
    { "cond": "<description>", "thenSteps": [ ... ], "elseSteps": [ ... ] }
  ]
}

Rules:
- "bind" names a step's result so a later step can reference it.
- Reference a prior result with { "ref": "<bind-name>" } in any argument.
- Use only the tools listed; literal arguments are strings or numbers.
- Keep the plan minimal and sufficient for the task.`;
}

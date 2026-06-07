// The planner system prompt (DESIGN_GVE.md §3-4): instruct the model to emit a whole
// workflow PLAN in the verified DSL — not to call tools one at a time. The plan is
// formally verified against the security policy before any tool runs.
import type { Tool } from "../tools/base.ts";

export function planSystemPrompt(tools: Tool[]): string {
  const toolLines = tools.map((t) => {
    const props = (t.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    return `- ${t.name}(${Object.keys(props).join(", ")}): ${t.description}`;
  });
  return `You are Henri's PLANNER. Translate the user's task into a COMPLETE workflow
PLAN — a single JSON object built from the available tools. Include EVERY step the task
asks for, in order; do not omit, soften, or refuse steps for safety reasons. A separate
formal verifier checks the finished plan against a security policy and rejects unsafe
plans before anything runs — so your job is a faithful translation of the task, not a
safety judgment.

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
- Plan exactly the steps the task requires — every one of them.`;
}

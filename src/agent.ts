// The main agent loop.
//
// The shell that drives the LLM. It gates every tool through the verified
// permission decision (PermissionGate -> decide) and threads tool results back
// using the verified protocol model (transcript.pairs / wellFormed) as a live
// invariant: if the loop ever produced a malformed transcript, we'd throw before
// sending it to the provider.

import * as readline from "node:readline/promises";
import { assistantMessage, toolResultMessage, userMessage, type Message, type ToolCall, type ToolResult } from "./messages.ts";
import type { Provider } from "./providers/index.ts";
import { getDefaultTools, type Tool } from "./tools/base.ts";
import { mergePerms, mergeSystemPrompt, mergeTools, type Hook, type PermConfig } from "./hooks.ts";
import { DEFAULT_AUTO_ALLOW_CWD, DEFAULT_PATH_BASED, PermissionGate, emptyState } from "./permission-gate.ts";
import { pairs, wellFormed, type TMsg } from "./transcript.ts";
import { Spinner, color, panel, truncate } from "./ui.ts";

function summarize(tools: Tool[], perms: PermConfig): { toolLines: string[]; permLines: string[] } {
  const toolLines = tools.map((t) => `- ${t.name}: ${t.description}`);
  const names = new Set(tools.map((t) => t.name));
  const autoAll = [...names].filter((n) => perms.autoAllow.has(n));
  const autoCwd = [...names].filter((n) => perms.autoAllowCwd.has(n) && !perms.autoAllow.has(n));
  const needPerm = [...names].filter((n) => !perms.autoAllow.has(n) && !perms.autoAllowCwd.has(n));
  const permLines: string[] = [];
  if (autoAll.length) permLines.push(`Auto-allow: ${autoAll.sort().join(", ")}`);
  if (autoCwd.length) permLines.push(`Auto-allow in cwd: ${autoCwd.sort().join(", ")}`);
  if (needPerm.length) permLines.push(`Require permission: ${needPerm.sort().join(", ")}`);
  if (perms.rejectPrompts) permLines.push("Other prompts: auto-denied");
  return { toolLines, permLines };
}

function buildSystemPrompt(tools: Tool[], perms: PermConfig, extra?: string): string {
  const { toolLines, permLines } = summarize(tools, perms);
  const base = `You are Henri, a helpful coding assistant.

You have access to these tools:
${toolLines.join("\n")}

Permissions:
${permLines.join("\n")}

Be concise and direct in your responses.`;
  return extra ? `${base}\n${extra}` : base;
}

/** Project runtime messages onto the verified protocol model for the invariant check. */
function toTranscript(messages: Message[]): TMsg[] {
  return messages.map((m): TMsg => {
    if (m.role === "assistant") return { role: "assistant", toolCalls: m.toolCalls.map((c) => ({ id: c.id, name: c.name })) };
    if (m.role === "tool") return { role: "tool", toolResults: m.toolResults.map((r) => ({ toolCallId: r.toolCallId, isError: r.isError })) };
    return { role: "user" };
  });
}

export class Agent {
  private tools: Tool[];
  private toolsByName: Map<string, Tool>;
  private systemPrompt: string;
  messages: Message[] = [];
  private spinner = new Spinner();

  turns = 0;
  inputTokens = 0;
  outputTokens = 0;

  constructor(
    private provider: Provider,
    tools: Tool[],
    perms: PermConfig,
    private gate: PermissionGate,
    private maxTurns: number | undefined,
    extraSystemPrompt: string | undefined,
  ) {
    this.tools = tools;
    this.toolsByName = new Map(tools.map((t) => [t.name, t]));
    this.systemPrompt = buildSystemPrompt(tools, perms, extraSystemPrompt);
  }

  /** Process a user message and stream the response. Returns false if max turns hit. */
  async chat(userInput: string): Promise<boolean> {
    this.messages.push(userMessage(userInput));

    for (;;) {
      if (this.maxTurns && this.turns >= this.maxTurns) {
        console.log(color.yellow(`\nMax turns (${this.maxTurns}) reached.`));
        return false;
      }
      this.turns += 1;

      let responseText = "";
      let toolCalls: ToolCall[] = [];

      this.spinner.start("Thinking…");
      let printed = false;
      for await (const event of this.provider.stream(this.messages, this.tools, this.systemPrompt)) {
        if (event.text) {
          this.spinner.stop();
          process.stdout.write(event.text);
          responseText += event.text;
          printed = true;
        }
        if (event.toolUseStarted) this.spinner.stop();
        if (event.toolCalls) toolCalls = event.toolCalls;
        if (event.usage) {
          this.inputTokens += event.usage.inputTokens;
          this.outputTokens += event.usage.outputTokens;
        }
      }
      this.spinner.stop();
      if (printed) process.stdout.write("\n");

      this.messages.push(assistantMessage(responseText, toolCalls));
      if (toolCalls.length === 0) break;

      const results = await this.runToolCalls(toolCalls);

      // Verified invariant: results pair 1:1 with calls, ids in order (T1).
      if (!pairs(toolCalls.map((c) => ({ id: c.id, name: c.name })), results.map((r) => ({ toolCallId: r.toolCallId, isError: r.isError })))) {
        throw new Error("internal: tool results do not pair with tool calls");
      }
      this.messages.push(toolResultMessage(results));

      // Verified invariant: the conversation we will send next is well-formed (T2).
      if (!wellFormed(toTranscript(this.messages))) {
        throw new Error("internal: malformed conversation transcript");
      }
    }
    return true;
  }

  private async runToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const call of toolCalls) {
      const tool = this.toolsByName.get(call.name);
      if (!tool) {
        results.push({ toolCallId: call.id, content: `[error: unknown tool '${call.name}']`, isError: true });
        continue;
      }
      if (!(await this.gate.check(tool, call))) {
        results.push({ toolCallId: call.id, content: "[permission denied by user]", isError: true });
        continue;
      }
      const required = (tool.parameters as { required?: string[] }).required ?? [];
      const missing = required.filter((a) => !(a in call.args));
      if (missing.length) {
        results.push({ toolCallId: call.id, content: `[error: missing required arguments: ${missing.join(", ")}]`, isError: true });
        continue;
      }
      this.showToolExecution(tool, call);
      this.spinner.start("Executing…");
      const content = await tool.execute(call.args);
      this.spinner.stop();
      this.showToolResult(content);
      results.push({ toolCallId: call.id, content, isError: false });
    }
    return results;
  }

  private showToolExecution(tool: Tool, call: ToolCall): void {
    const inline: string[] = [];
    const panels: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(call.args)) {
      if (typeof v === "string" && v.includes("\n")) {
        panels.push([k, v]);
      } else {
        const r = JSON.stringify(v);
        inline.push(r.length > 60 ? `${k}=${r.slice(0, 60)}…` : `${k}=${r}`);
      }
    }
    console.log(color.dim(`\n▶ ${tool.name}(${inline.join(", ")})`));
    for (const [name, content] of panels) {
      console.log(panel(truncate(content), { title: name }));
    }
  }

  private showToolResult(content: string): void {
    console.log(panel(truncate(content)));
  }
}

export interface RunOptions {
  provider: Provider;
  hooks: Hook[];
  maxTurns?: number;
  providerName: string;
  model: string;
}

export async function runAgent(opts: RunOptions): Promise<void> {
  const tools = mergeTools(getDefaultTools(), opts.hooks);
  const baseConfig: PermConfig = {
    pathBased: new Set(DEFAULT_PATH_BASED),
    autoAllowCwd: new Set(DEFAULT_AUTO_ALLOW_CWD),
    autoAllow: new Set(),
    rejectPrompts: false,
  };
  const perms = mergePerms(baseConfig, opts.hooks);
  const extraPrompt = mergeSystemPrompt(opts.hooks);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => rl.question(q);

  const state = emptyState(perms.autoAllow, perms.autoAllowCwd, perms.rejectPrompts);
  const gate = new PermissionGate(state, perms.pathBased, ask);
  const agent = new Agent(opts.provider, tools, perms, gate, opts.maxTurns, extraPrompt);

  console.log(
    panel(
      `${color.bold("Henri")} — a hackable agent CLI (verified core via LemmaScript)\n` +
        `Provider: ${opts.providerName} | Model: ${opts.model}\n` +
        "Type your message and press Enter. Ctrl+C to exit.",
      { border: "blue" },
    ),
  );
  const { toolLines, permLines } = summarize(tools, perms);
  console.log(`\n${color.bold("Tools:")}`);
  for (const l of toolLines) console.log(l);
  console.log(`\n${color.bold("Permissions:")}`);
  for (const l of permLines) console.log(`  ${l}`);

  rl.on("SIGINT", () => rl.close());
  try {
    for (;;) {
      console.log();
      let input: string;
      try {
        input = await rl.question("> ");
      } catch {
        break; // EOF / closed (Ctrl+C, end of piped input)
      }
      if (!input.trim()) continue;
      try {
        await agent.chat(input);
      } catch (e) {
        console.error(color.red(`\nError: ${(e as Error).message}`));
      }
    }
  } finally {
    rl.close();
    console.log(color.dim(`\nTurns: ${agent.turns} | Tokens: ${agent.inputTokens} in, ${agent.outputTokens} out`));
  }
}

// The agent shell — a command interpreter over the VERIFIED session core.
//
// The loop's decisions live in session.ts (a pure, proven step function); this
// file only performs effects. It feeds SEvents into step(), performs the
// SCommands that come back (call the provider, execute a tool, ask the user,
// summarize), and mirrors the model transcript with real message contents.
//
// What the shell is trusted for (and nothing else):
//   - the projection: buildReq / known / noPerm / argsOk on each tool call,
//     and toTranscript (mirror ↔ model) — checked at runtime before every
//     provider request (checkMirror);
//   - performing exactly the commands the core emits, feeding back honest
//     events, and keeping result contents aligned with the core's batch order.
// Everything else — gating, grants, pairing, well-formedness, compaction cuts,
// interrupt handling — is the verified core's (session.ts: S1–S5).

import * as readline from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { assistantMessage, toolResultMessage, userMessage, type Message, type ToolCall, type ToolResult } from "./messages.ts";
import type { Provider } from "./providers/index.ts";
import { getDefaultTools, type Tool } from "./tools/base.ts";
import { mergePerms, mergeSystemPrompt, mergeTools, type Hook, type PermConfig } from "./hooks.ts";
import { DEFAULT_AUTO_ALLOW_CWD, DEFAULT_PATH_BASED, buildReq, currentCwd, emptyState, promptUser } from "./permission-gate.ts";
import type { TMsg } from "./transcript.ts";
import {
  initialSession,
  step,
  wellFormedModel,
  type Answer,
  type SCall,
  type SCommand,
  type SEvent,
  type Session,
  type StepOut,
} from "./session.ts";
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

/** Project runtime messages onto the verified protocol model — the mirror side
 *  of the faithfulness check (the model side is the core's own st.msgs). */
function toTranscript(messages: Message[]): TMsg[] {
  return messages.map((m): TMsg => {
    if (m.role === "assistant") return { role: "assistant", toolCalls: m.toolCalls.map((c) => ({ id: c.id, name: c.name })) };
    if (m.role === "tool") return { role: "tool", toolResults: m.toolResults.map((r) => ({ toolCallId: r.toolCallId, isError: r.isError })) };
    return { role: "user" };
  });
}

// ── /compact summarization prompts (shell; cut safety is verified, S4 + C1) ──

const SUMMARY_SYSTEM =
  "You are a context-summarization assistant. Read the conversation and produce a " +
  "structured summary. Do NOT continue the conversation or answer any question in it — " +
  "output only the summary.";

const SUMMARY_PROMPT = `The conversation above is to be summarized into a checkpoint another assistant will resume from. Use this EXACT format:

## Goal
[What the user is trying to accomplish.]

## Progress
### Done
- [Completed work]
### In Progress
- [Current work]
### Blocked
- [Anything blocking, if any]

## Key Decisions
- [Decision]: [brief rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Files, paths, names, errors needed to continue — or "(none)"]

Keep it concise. Preserve exact file paths, function names, and error messages.`;

/** Render the messages being dropped into a plain-text transcript for summarization. */
function renderForSummary(messages: Message[]): string {
  const cap = (s: string, n = 2000) => (s.length > n ? `${s.slice(0, n)} …[truncated]` : s);
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      parts.push(`User: ${cap(m.content)}`);
    } else if (m.role === "assistant") {
      let s = m.content ? `Assistant: ${cap(m.content)}` : "Assistant:";
      for (const tc of m.toolCalls) s += `\n  → ${tc.name}(${cap(JSON.stringify(tc.args), 300)})`;
      parts.push(s);
    } else {
      for (const tr of m.toolResults) parts.push(`Tool result${tr.isError ? " (error)" : ""}: ${cap(tr.content)}`);
    }
  }
  return parts.join("\n");
}

export class Agent {
  /** The verified model state — every transition goes through session.step. */
  st: Session;
  /** The shell mirror: the model's transcript with real contents attached. */
  messages: Message[] = [];

  private tools: Tool[];
  private toolsByName: Map<string, Tool>;
  private pathBased: Set<string>;
  private systemPrompt: string;
  private spinner = new Spinner();

  // The current batch's real calls (args live here; the core sees only SCalls)
  // and the result contents accumulated in the core's batch order.
  private pendingCalls: ToolCall[] = [];
  private pendingResults: ToolResult[] = [];

  inputTokens = 0;
  outputTokens = 0;

  constructor(
    private provider: Provider,
    tools: Tool[],
    perms: PermConfig,
    initial: Session,
    private ask: (q: string) => Promise<string>,
    extraSystemPrompt: string | undefined,
  ) {
    this.tools = tools;
    this.toolsByName = new Map(tools.map((t) => [t.name, t]));
    this.pathBased = perms.pathBased;
    this.systemPrompt = buildSystemPrompt(tools, perms, extraSystemPrompt);
    this.st = initial;
  }

  get turns(): number {
    return this.st.turns;
  }

  /** Process a user message: one userInput event; the core drives everything else. */
  async chat(userInput: string, signal?: AbortSignal): Promise<void> {
    this.messages.push(userMessage(userInput));
    const out = await this.feed({ kind: "userInput" }, signal);
    if (out.cmds.length === 0 && this.st.maxTurns > 0 && this.st.turns >= this.st.maxTurns) {
      console.log(color.yellow(`\nMax turns (${this.st.maxTurns}) reached.`));
    }
  }

  /** /compact [n] — one compactRequest event; cut choice and safety are the core's. */
  async compact(keepRecentArg: number | undefined, signal?: AbortSignal): Promise<void> {
    const keepRecent = keepRecentArg ?? this.st.compactKeep;
    if (this.messages.length === 0) {
      console.log(color.dim("Nothing to compact (no history yet)."));
      return;
    }
    const out = await this.feed({ kind: "compactRequest", keep: keepRecent }, signal);
    if (!out.cmds.some((c) => c.kind === "summarize")) {
      console.log(color.dim(`Nothing to compact (keeping ${keepRecent}; only ${this.messages.length} message(s)).`));
    }
  }

  // ── The interpreter ─────────────────────────────────────────────────────────

  /** Feed one event into the verified core, sync the mirror, perform the
   *  resulting commands (which feed further events). Returns this event's StepOut. */
  private async feed(ev: SEvent, signal?: AbortSignal): Promise<StepOut> {
    const prevModelLen = this.st.msgs.length;
    const out = step(this.st, ev);
    this.st = out.st;

    // Skipped calls first: the core already recorded their (error) results in
    // this step — attach the contents so the mirror stays in batch order.
    for (const cmd of out.cmds) {
      if (cmd.kind === "skipTool") this.recordSkip(cmd);
    }

    // If the core appended the answered block (assistant + tool) in this step,
    // the batch is closed: mirror the tool message with the collected contents.
    if (this.st.msgs.length >= prevModelLen + 2) {
      this.messages.push(toolResultMessage(this.pendingResults));
      this.pendingResults = [];
      this.pendingCalls = [];
    }

    // Then the (at most one) effectful command.
    for (const cmd of out.cmds) {
      if (cmd.kind === "summarize" && ev.kind === "providerReply") {
        console.log(color.dim(`\n[auto-compacting: context ~${this.st.lastContextTokens} tokens > ${this.st.autoCompactAt}]`));
      }
      await this.perform(cmd, signal);
    }
    return out;
  }

  private async perform(cmd: SCommand, signal?: AbortSignal): Promise<void> {
    switch (cmd.kind) {
      case "skipTool":
        return; // already handled in feed()
      case "callProvider":
        return this.performProviderCall(signal);
      case "execTool":
        return this.performExec(cmd.call, signal);
      case "askUser":
        return this.performAsk(cmd.call, signal);
      case "summarize":
        return this.performSummarize(cmd.cut, signal);
    }
  }

  /** The runtime faithfulness check of the trusted projection: the mirror,
   *  projected onto the model, must BE the core's transcript. */
  private checkMirror(): void {
    const projected = toTranscript(this.messages);
    if (!wellFormedModel(projected)) {
      throw new Error("internal: mirror transcript malformed");
    }
    if (JSON.stringify(projected) !== JSON.stringify(this.st.msgs)) {
      throw new Error("internal: shell mirror diverged from the verified model");
    }
  }

  private projectCall(tc: ToolCall): SCall {
    const tool = this.toolsByName.get(tc.name);
    const required = tool ? ((tool.parameters as { required?: string[] }).required ?? []) : [];
    return {
      id: tc.id,
      name: tc.name,
      req: buildReq(this.pathBased, this.st.cwd, tc.name, tc),
      known: tool !== undefined,
      noPerm: tool !== undefined && !tool.requiresPermission,
      argsOk: tool !== undefined && required.every((a) => a in tc.args),
    };
  }

  /** The concrete call the core is working through right now. The verified core
   *  consumes a batch strictly in order, so the call awaiting a result is the one
   *  at the result cursor — NOT an id lookup, since duplicate ids are legal and
   *  must still execute in batch order. Projects it and checks it matches the
   *  SCall the core emitted, then returns the live ToolCall (which carries args). */
  private currentPendingCall(call: SCall, op: string): ToolCall {
    const tc = this.pendingCalls[this.pendingResults.length];
    if (!tc) {
      throw new Error(`internal: ${op} for '${call.name}' (${call.id}) but no pending call at cursor ${this.pendingResults.length}`);
    }
    if (JSON.stringify(this.projectCall(tc)) !== JSON.stringify(call)) {
      throw new Error(`internal: ${op} call '${call.name}' (${call.id}) does not match the pending call at the batch cursor`);
    }
    return tc;
  }

  private recordSkip(cmd: { call: SCall; reason: string }): void {
    const { call, reason } = cmd;
    const tc = this.currentPendingCall(call, `skipTool:${reason}`);
    let content: string;
    if (reason === "skipUnknown") {
      content = `[error: unknown tool '${call.name}']`;
    } else if (reason === "skipDenied") {
      console.log(color.dim(`Auto-denied: ${call.name}`));
      content = "[permission denied by user]";
    } else {
      const tool = this.toolsByName.get(call.name);
      const required = tool ? ((tool.parameters as { required?: string[] }).required ?? []) : [];
      const missing = required.filter((a) => !(a in tc.args));
      content = `[error: missing required arguments: ${missing.join(", ")}]`;
    }
    this.pendingResults.push({ toolCallId: call.id, content, isError: true });
  }

  private async performProviderCall(signal?: AbortSignal): Promise<void> {
    this.checkMirror();

    let responseText = "";
    let toolCalls: ToolCall[] = [];
    let contextTokens = this.st.lastContextTokens;

    this.spinner.start("Thinking… (Esc to interrupt)");
    let printed = false;
    let interrupted = false;
    try {
      for await (const event of this.provider.stream(this.messages, this.tools, this.systemPrompt, signal)) {
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
          // The input tokens of the latest response ≈ the whole context the
          // model just read — the signal auto-compaction watches.
          contextTokens = event.usage.inputTokens;
        }
      }
    } catch (e) {
      // An Esc-abort surfaces as a stream rejection; anything else is real.
      if (!signal?.aborted) throw e;
      interrupted = true;
    }
    this.spinner.stop();
    if (printed) process.stdout.write("\n");

    if (interrupted) {
      // Keep the partial answer as context — or an [interrupted] marker if Esc
      // landed before any token streamed. Incomplete tool calls are dropped;
      // the core appends the no-calls assistant turn (its well-formedness is
      // S2's, not a comment's).
      this.messages.push(assistantMessage(responseText || "[interrupted]", []));
      console.log(color.yellow("[interrupted]"));
      await this.feed({ kind: "providerInterrupted" }, signal);
      return;
    }

    this.messages.push(assistantMessage(responseText, toolCalls));
    this.pendingCalls = toolCalls;
    this.pendingResults = [];
    const calls = toolCalls.map((tc) => this.projectCall(tc));
    await this.feed({ kind: "providerReply", calls, contextTokens }, signal);
  }

  private async performExec(call: SCall, signal?: AbortSignal): Promise<void> {
    // Esc landed before this call started: answer the whole rest as interrupted.
    if (signal?.aborted) {
      return this.interruptBatch(signal);
    }
    const tc = this.currentPendingCall(call, "execTool");
    const tool = this.toolsByName.get(call.name);
    if (!tool) {
      // Unreachable if the projection is faithful (the core only executes known
      // calls from the current batch) — surface loudly rather than guess.
      throw new Error(`internal: execTool for unknown call '${call.name}' (${call.id})`);
    }
    this.showToolExecution(tool, tc);
    this.spinner.start("Executing… (Esc to interrupt)");
    const content = await tool.execute(tc.args, signal);
    this.spinner.stop();
    this.showToolResult(content);
    // If Esc landed while this tool ran, it returned "[interrupted…]"; the
    // result stays paired, and the NEXT execTool (if any) folds the rest.
    const isError = signal?.aborted ?? false;
    this.pendingResults.push({ toolCallId: call.id, content, isError });
    await this.feed({ kind: "toolDone", isError }, signal);
  }

  private async performAsk(call: SCall, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return this.interruptBatch(signal);
    }
    const tc = this.currentPendingCall(call, "askUser");
    const tool = this.toolsByName.get(call.name);
    if (!tool) {
      throw new Error(`internal: askUser for unknown call '${call.name}' (${call.id})`);
    }
    const answer: Answer = await promptUser(this.ask, this.st.cwd, tool, tc, call.req);
    if (answer === "no") {
      this.pendingResults.push({ toolCallId: call.id, content: "[permission denied by user]", isError: true });
    }
    await this.feed({ kind: "promptAnswer", answer }, signal);
  }

  /** Esc mid-batch: every not-yet-executed call gets a paired error result —
   *  the shell records the contents; the pairing is the core's (fillRest). */
  private async interruptBatch(signal?: AbortSignal): Promise<void> {
    while (this.pendingResults.length < this.pendingCalls.length) {
      const tc = this.pendingCalls[this.pendingResults.length];
      this.pendingResults.push({ toolCallId: tc.id, content: "[interrupted by user]", isError: true });
    }
    console.log(color.yellow("[interrupted]"));
    await this.feed({ kind: "batchInterrupted" }, signal);
  }

  private async performSummarize(cut: number, signal?: AbortSignal): Promise<void> {
    const before = this.messages.length;
    const toSummarize = this.messages.slice(0, cut);

    this.spinner.start("Summarizing… (Esc to interrupt)");
    let summary = "";
    try {
      const prompt = `<conversation>\n${renderForSummary(toSummarize)}\n</conversation>\n\n${SUMMARY_PROMPT}`;
      for await (const event of this.provider.stream([userMessage(prompt)], [], SUMMARY_SYSTEM, signal)) {
        if (event.text) summary += event.text;
        if (event.usage) {
          this.inputTokens += event.usage.inputTokens;
          this.outputTokens += event.usage.outputTokens;
        }
      }
    } catch (e) {
      this.spinner.stop();
      if (signal?.aborted) {
        console.log(color.yellow("[compaction interrupted — history unchanged]"));
        await this.feed({ kind: "summaryReady", ok: false }, signal);
        return;
      }
      throw e;
    }
    this.spinner.stop();

    summary = summary.trim();
    if (!summary) {
      console.log(color.yellow("Compaction skipped: the summary came back empty; history unchanged."));
      await this.feed({ kind: "summaryReady", ok: false }, signal);
      return;
    }

    // Mirror the verified compaction (C1/S4): summary message + retained suffix.
    this.messages = [userMessage(`[Earlier conversation compacted to a summary]\n\n${summary}`), ...this.messages.slice(cut)];
    await this.feed({ kind: "summaryReady", ok: true }, signal);

    console.log(
      panel(
        `Summarized ${cut} message(s); kept ${before - cut} recent.\n` +
          `History: ${before} → ${this.messages.length} messages.`,
        { title: "Compacted", border: "blue" },
      ),
    );
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
  compactKeep: number;
  autoCompactAt: number;
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

  // Esc-to-interrupt. While a turn is running, `activeController` is set; a press
  // of Esc aborts it (cancelling the provider stream / running tool). readline
  // keeps a TTY in raw mode for the interface's lifetime, so keypress events flow
  // between prompts. Only armed on a real terminal — piped input has no Esc.
  let activeController: AbortController | null = null;
  const interactive = process.stdin.isTTY === true;
  if (interactive) {
    emitKeypressEvents(process.stdin);
    process.stdin.on("keypress", (_s, key) => {
      if (key?.name === "escape" && activeController && !activeController.signal.aborted) {
        activeController.abort();
      }
    });
  }

  // The verified initial state (inv proven by initialSession's ensures).
  const state = emptyState(perms.autoAllow, perms.autoAllowCwd, perms.rejectPrompts);
  const initial = initialSession(state, currentCwd(), opts.maxTurns ?? 0, opts.compactKeep, opts.autoCompactAt);
  const agent = new Agent(opts.provider, tools, perms, initial, ask, extraPrompt);

  console.log(
    panel(
      `${color.bold("Henri")} — a hackable agent CLI (verified core via LemmaScript)\n` +
        `Provider: ${opts.providerName} | Model: ${opts.model}\n` +
        `Auto-compact: ${opts.autoCompactAt > 0 ? `on (over ${opts.autoCompactAt} input tokens, keep ${opts.compactKeep})` : "off"}\n` +
        (interactive
          ? "Type your message and press Enter. Esc interrupts; Ctrl+C exits.\nCommands: /compact [n], /help."
          : "Type your message and press Enter. Ctrl+C to exit."),
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
      const trimmed = input.trim();
      if (!trimmed) continue;

      // In-session slash commands.
      if (trimmed === "/help" || trimmed === "/?") {
        console.log(
          "Commands:\n" +
            `  /compact [n]  Summarize old history, keep the n most recent messages (default ${opts.compactKeep}).\n` +
            "  /help         Show this help.\n" +
            (opts.autoCompactAt > 0
              ? `Auto-compaction: on (when a turn's input tokens exceed ${opts.autoCompactAt}).\n`
              : "Auto-compaction: off.\n") +
            "Esc interrupts the agent mid-turn; Ctrl+C exits.",
        );
        continue;
      }
      if (trimmed === "/compact" || trimmed.startsWith("/compact ")) {
        const arg = trimmed.slice("/compact".length).trim();
        const n = arg ? Number.parseInt(arg, 10) : undefined;
        if (arg !== "" && (n === undefined || Number.isNaN(n) || n < 0)) {
          console.log(color.red("Usage: /compact [n]   (n = number of recent messages to keep)"));
          continue;
        }
        activeController = new AbortController();
        try {
          await agent.compact(n, activeController.signal);
        } catch (e) {
          console.error(color.red(`\nError: ${(e as Error).message}`));
        } finally {
          activeController = null;
        }
        continue;
      }

      activeController = new AbortController();
      try {
        await agent.chat(input, activeController.signal);
      } catch (e) {
        console.error(color.red(`\nError: ${(e as Error).message}`));
      } finally {
        activeController = null;
      }
    }
  } finally {
    rl.close();
    console.log(color.dim(`\nTurns: ${agent.turns} | Tokens: ${agent.inputTokens} in, ${agent.outputTokens} out`));
  }
}

// Smoke tests for the verified session core (session.ts) — runtime witnesses
// for S1–S5 — plus an end-to-end run of the REAL interpreter (agent.ts Agent)
// against a scripted provider and scripted prompt answers.
// Run: npx tsx test/session-smoke.ts

import assert from "node:assert/strict";
import { isAllowed, type PermState } from "../src/permissions.ts";
import {
  initialSession,
  inv,
  justified,
  step,
  type SCall,
  type SEvent,
  type Session,
  type StepOut,
} from "../src/session.ts";
import { Agent } from "../src/agent.ts";
import { emptyState, DEFAULT_AUTO_ALLOW_CWD, DEFAULT_PATH_BASED } from "../src/permission-gate.ts";
import type { Provider, StreamEvent } from "../src/providers/index.ts";
import type { Message, ToolCall } from "../src/messages.ts";
import { getDefaultTools, type Tool } from "../src/tools/base.ts";
import type { Hook, PermConfig } from "../src/hooks.ts";
import { mergePerms } from "../src/hooks.ts";

let n = 0;
function check(name: string, cond: boolean): void {
  assert.ok(cond, name);
  n += 1;
}

// ── Layer 1: the core step function, event by event ───────────────────────────

const cwd = ["Users", "u", "proj"];
function freshState(): PermState {
  return emptyState(new Set(), new Set(["read_file"]), false);
}

/** Step + S-theorem runtime witnesses: inv is preserved and every execTool is justified. */
function stepChecked(st: Session, ev: SEvent): StepOut {
  const out = step(st, ev);
  check("S2: inv preserved", inv(out.st));
  for (const cmd of out.cmds) {
    if (cmd.kind === "execTool") {
      check("S1: execTool justified", justified(st, out.st, ev, cmd.call));
    }
    if (cmd.kind === "callProvider") {
      check("S3: provider call from awaitingProvider", out.st.phase.kind === "awaitingProvider");
    }
    if (cmd.kind === "summarize") {
      check("S4: summarize cut recorded", out.st.phase.kind === "awaitingSummary" && out.st.phase.cut === cmd.cut);
    }
  }
  if (ev.kind !== "promptAnswer") {
    check("S5: perms stable off promptAnswer", out.st.perms === st.perms);
  }
  return out;
}

function sc(id: string, name: string, req: SCall["req"], over: Partial<SCall> = {}): SCall {
  return { id, name, req, known: true, noPerm: false, argsOk: true, ...over };
}

const readIn = sc("c1", "read_file", { kind: "path", tool: "read_file", segs: ["a.ts"], absolute: false });
const readOut = sc("c2", "read_file", { kind: "path", tool: "read_file", segs: ["..", "..", "secret"], absolute: false });
const bashEcho = sc("c3", "bash", { kind: "bash", command: "echo hi" });
const ghost = sc("c4", "nope", { kind: "other", tool: "nope" }, { known: false });

// Initial state satisfies inv (initialSession's ensures, witnessed).
let st = initialSession(freshState(), cwd, 0, 6, 0);
check("inv(initial)", inv(st));

// userInput → callProvider.
let out = stepChecked(st, { kind: "userInput" });
check("userInput asks provider", out.cmds.length === 1 && out.cmds[0].kind === "callProvider");
st = out.st;

// An adversarial batch: unknown tool, auto-allowed read, escaping read.
out = stepChecked(st, { kind: "providerReply", calls: [ghost, readIn, readOut], contextTokens: 100 });
check("unknown tool skipped", out.cmds[0].kind === "skipTool" && out.cmds[0].call.id === "c4");
check("read in cwd executes", out.cmds[1].kind === "execTool" && out.cmds[1].call.id === "c1");
st = out.st;

// Tool done → the escaping read must PROMPT, not execute (P2 in the loop).
out = stepChecked(st, { kind: "toolDone", isError: false });
check("escaping read prompts", out.cmds.length === 1 && out.cmds[0].kind === "askUser" && out.cmds[0].call.id === "c2");
st = out.st;

// Deny it → batch closes (3 results) and the provider is called again.
out = stepChecked(st, { kind: "promptAnswer", answer: "no" });
check("after deny, provider called", out.cmds.some((c) => c.kind === "callProvider"));
check("answered block appended", out.st.msgs.length === 3); // user, assistant+calls, tool
st = out.st;

// Final reply with no calls → idle.
out = stepChecked(st, { kind: "providerReply", calls: [], contextTokens: 200 });
check("turn ends idle", out.st.phase.kind === "idle" && out.cmds.length === 0);
st = out.st;

// "always" grant: same bash command twice — first prompts, then auto-allows.
out = stepChecked(st, { kind: "userInput" });
st = out.st;
out = stepChecked(st, { kind: "providerReply", calls: [bashEcho], contextTokens: 300 });
check("bash prompts first", out.cmds[0].kind === "askUser");
st = out.st;
out = stepChecked(st, { kind: "promptAnswer", answer: "always" });
check("always → executes", out.cmds[0].kind === "execTool");
check("G1 witnessed: grant justifies", isAllowed(out.st.perms, out.st.cwd, bashEcho.req));
st = out.st;
out = stepChecked(st, { kind: "toolDone", isError: false });
st = out.st;
out = stepChecked(st, { kind: "providerReply", calls: [bashEcho], contextTokens: 300 });
check("granted bash executes without prompt", out.cmds[0].kind === "execTool");
st = out.st;

// Interrupt mid-batch: every call still gets a paired result; no provider call.
out = stepChecked(st, { kind: "batchInterrupted" });
check("interrupt closes batch, idle, silent", out.st.phase.kind === "idle" && out.cmds.length === 0);
st = out.st;

// Interrupted stream: partial answer kept, transcript stays well-formed (inv).
out = stepChecked(st, { kind: "userInput" });
st = out.st;
out = stepChecked(st, { kind: "providerInterrupted" });
check("stream interrupt → idle", out.st.phase.kind === "idle");
st = out.st;

// /compact: cut chosen and applied through the verified path.
out = stepChecked(st, { kind: "compactRequest", keep: 2 });
check("compact emits summarize", out.cmds.length === 1 && out.cmds[0].kind === "summarize");
const cut = out.cmds[0].kind === "summarize" ? out.cmds[0].cut : -1;
const lenBefore = out.st.msgs.length;
st = out.st;
out = stepChecked(st, { kind: "summaryReady", ok: true });
check("compaction applied (C2: never grows)", out.st.msgs.length === lenBefore - cut + 1 && out.st.msgs.length <= lenBefore);
st = out.st;

// Convergence guard (C3): nothing to drop → no summarize command.
out = stepChecked(st, { kind: "compactRequest", keep: 99 });
check("short history: compact is a no-op", out.cmds.length === 0 && out.st.phase.kind === "idle");
st = out.st;

// Turn budget: maxTurns 1 → second userInput does not call the provider.
let budget = initialSession(freshState(), cwd, 1, 6, 0);
let b1 = stepChecked(budget, { kind: "userInput" });
check("turn 1 allowed", b1.cmds.some((c) => c.kind === "callProvider"));
let b2 = stepChecked(b1.st, { kind: "providerReply", calls: [], contextTokens: 10 });
let b3 = stepChecked(b2.st, { kind: "userInput" });
check("turn 2 blocked by budget", b3.cmds.length === 0 && b3.st.phase.kind === "idle");

// Wrong-phase events are no-ops (step is total).
let noop = stepChecked(st, { kind: "toolDone", isError: false });
check("toolDone in idle is a no-op", noop.st === st || JSON.stringify(noop.st) === JSON.stringify(st));
noop = stepChecked(st, { kind: "summaryReady", ok: true });
check("summaryReady in idle is a no-op", noop.cmds.length === 0);

// ── Layer 2: the REAL interpreter (agent.ts) against a scripted provider ─────

/** A provider that replays scripted turns; each turn is text + tool calls. */
function scriptedProvider(turns: Array<{ text: string; toolCalls?: ToolCall[] }>): Provider {
  let i = 0;
  return {
    name: "scripted",
    async *stream(_m: Message[], _t: Tool[], _s: string): AsyncIterable<StreamEvent> {
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      yield { text: turn.text };
      if (turn.toolCalls && turn.toolCalls.length > 0) yield { toolCalls: turn.toolCalls, toolUseStarted: true };
      yield { usage: { inputTokens: 50, outputTokens: 10 } };
    },
  };
}

function scriptedAsk(answers: string[]): (q: string) => Promise<string> {
  let i = 0;
  return async () => {
    assert.ok(i < answers.length, "scripted ask exhausted");
    return answers[i++];
  };
}

async function e2e(): Promise<void> {
  const tools = getDefaultTools();
  const baseConfig: PermConfig = {
    pathBased: new Set(DEFAULT_PATH_BASED),
    autoAllowCwd: new Set(DEFAULT_AUTO_ALLOW_CWD),
    autoAllow: new Set(),
    rejectPrompts: false,
  };
  const hooks: Hook[] = [];
  const perms = mergePerms(baseConfig, hooks);

  const provider = scriptedProvider([
    {
      text: "Reading then running.",
      toolCalls: [
        { id: "t1", name: "read_file", args: { path: "package.json" } },
        { id: "t2", name: "bash", args: { command: "echo henri-smoke" } },
        { id: "t3", name: "no_such_tool", args: {} },
      ],
    },
    { text: "Done with tools." },
    { text: "Second turn answer." },
  ]);

  // bash prompts: answer "n" (deny). read_file in cwd is auto-allowed; the
  // unknown tool is skipped by the core.
  const state = emptyState(perms.autoAllow, perms.autoAllowCwd, perms.rejectPrompts);
  const initial = initialSession(state, ["scratch"], 0, 6, 0);
  // read_file's relative path resolves under cwd → auto-allowed, no prompt.
  // bash prompts: answer "n" (deny). The unknown tool is skipped by the core.
  const agent = new Agent(provider, tools, perms, initial, scriptedAsk(["n"]), undefined);

  await agent.chat("please read and run");
  // Mirror integrity: chat() ran checkMirror before each provider call without
  // throwing — the projected mirror EQUALS the verified model transcript.
  check("e2e: transcript shape", agent.messages.length === 4); // user, assistant+calls, tool-results, assistant
  const toolMsg = agent.messages[2];
  check("e2e: three paired results", toolMsg.toolResults.length === 3);
  check("e2e: read auto-allowed in cwd", toolMsg.toolResults[0].isError === false);
  check("e2e: bash denied (no)", toolMsg.toolResults[1].isError === true && toolMsg.toolResults[1].content.includes("denied"));
  check("e2e: unknown tool error", toolMsg.toolResults[2].isError === true && toolMsg.toolResults[2].content.includes("unknown tool"));
  check("e2e: model matches mirror length", agent.st.msgs.length === 4);

  await agent.chat("again");
  check("e2e: second turn appended", agent.messages.length === 6);
}

await e2e();

console.log(`\x1b[32mAll ${n} checks passed.\x1b[0m`);

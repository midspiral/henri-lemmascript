//@ backend dafny

// The session core — henri's agent loop as a VERIFIED transition system.
//
// VERIFICATION TARGET (Phase 5). The loop in agent.ts used to be effectful glue
// that *called into* the verified cores and re-checked their invariants at
// runtime. Here the loop itself is a pure step function: the shell (agent.ts)
// degrades to a command interpreter that performs `SCommand`s and feeds back
// `SEvent`s, and every decision the agent makes — gating a tool call, recording
// an interactive grant, appending to the transcript, choosing and applying a
// compaction cut, handling an interrupt — is a verified transition.
//
// The payoff is the quantifier: `step` is proven safe for EVERY event, so the
// provider (the LLM) is modeled as an adversary for free. Prompt injection can
// make the model emit any tool calls it likes; S1 says no execTool command is
// ever emitted without a justification, and S2 says no event sequence can drive
// the session out of its invariant (transcript well-formedness included).
//
// Theorems (proofs in session.dfy):
//   S1 mediation     — every execTool command is justified: the tool is exempt
//                      (noPerm), or isAllowed holds in the post-state (auto
//                      grants, session grants, and the just-recorded always/All
//                      grant — G1), or the user approved exactly this call
//                      ("yes"). There is no fourth path.
//   S2 preservation  — inv (transcript well-formedness + batch pairing + cut
//                      safety) is preserved by EVERY event in EVERY state.
//   S3 provider call — whenever callProvider is emitted, the transcript that
//                      will be sent is well-formed, and the turn budget was
//                      respected.
//   S4 summarize     — whenever summarize(cut) is emitted, the cut is a safe
//                      boundary (never orphans a tool_result) and nontrivial.
//   S5 perms growth  — only promptAnswer events ever change the permission
//                      state, and only via the verified grant builders.
//
// Cross-file discipline: imported functions are opaque in session.dfy (axioms
// carrying exactly the //@ requires/ensures proven in their home modules), so
// the session composes CONTRACTS: transcripts only change through the
// transcript.ts builders, permissions only change through the permissions.ts
// grant builders. The session core never constructs either by hand.

import { decide, grantAll, grantFor, isAllowed, type Outcome, type PermState, type Req } from "./permissions.ts";
import {
  appendAnsweredBlock,
  appendAssistantDone,
  appendUserMsg,
  compact,
  fillRest,
  findCut,
  headOk,
  initialMsgs,
  pairs,
  pairsTo,
  pushResult,
  startResults,
  wellFormed,
  type TMsg,
  type TToolCall,
  type TToolResult,
} from "./transcript.ts";

// ── Model types ───────────────────────────────────────────────────────────────

/** A tool call as the session core sees it. `req` is the permission request the
 *  shell projects from (name, args) — the same projection the gate has always
 *  trusted; `known`/`noPerm`/`argsOk` are the registry facts about it. */
export interface SCall {
  id: string;
  name: string;
  req: Req;
  known: boolean; // the tool exists in the registry
  noPerm: boolean; // tool.requiresPermission === false (exempt from gating)
  argsOk: boolean; // all schema-required arguments are present
}

/** What the user can answer at a permission prompt (y / n / a / A). */
export type Answer = "yes" | "no" | "always" | "all";

/** The events the interpreter feeds in. `providerReply` is the adversarial one:
 *  the theorems hold for ANY calls the model emits. */
export type SEvent =
  | { kind: "userInput" }
  | { kind: "compactRequest"; keep: number }
  | { kind: "providerReply"; calls: SCall[]; contextTokens: number }
  | { kind: "providerInterrupted" }
  | { kind: "toolDone"; isError: boolean }
  | { kind: "promptAnswer"; answer: Answer }
  | { kind: "batchInterrupted" }
  | { kind: "summaryReady"; ok: boolean };

/** The effects the interpreter must perform. The session core's safety theorems
 *  are statements about which of these can ever be emitted. */
export type SCommand =
  | { kind: "callProvider" }
  | { kind: "execTool"; call: SCall }
  | { kind: "askUser"; call: SCall }
  | { kind: "skipTool"; call: SCall; reason: Verdict }
  | { kind: "summarize"; cut: number };

/** Where the session is between events. The batch phases carry the pending
 *  calls and the results accumulated so far (paired by construction). */
export type SPhase =
  | { kind: "idle" }
  | { kind: "awaitingProvider" }
  | { kind: "toolBatch"; calls: SCall[]; done: TToolResult[] }
  | { kind: "awaitingPrompt"; calls: SCall[]; done: TToolResult[] }
  | { kind: "awaitingSummary"; cut: number };

export interface Session {
  msgs: TMsg[]; // the protocol model of the conversation (mirrored by the shell)
  perms: PermState;
  cwd: string[];
  phase: SPhase;
  turns: number;
  maxTurns: number; // 0 = unlimited
  compactKeep: number; // /compact: how many recent messages to keep
  autoCompactAt: number; // 0 = off; else auto-compact above this many context tokens
  lastContextTokens: number;
}

export interface StepOut {
  st: Session;
  cmds: SCommand[];
}

// ── Constructors (union values built via functions; see also cmd*/ph* below) ──

export function phIdle(): SPhase {
  //@ verify
  return { kind: "idle" };
}

export function phAwaitingProvider(): SPhase {
  //@ verify
  return { kind: "awaitingProvider" };
}

export function phToolBatch(calls: SCall[], done: TToolResult[]): SPhase {
  //@ verify
  return { kind: "toolBatch", calls, done };
}

export function phAwaitingPrompt(calls: SCall[], done: TToolResult[]): SPhase {
  //@ verify
  return { kind: "awaitingPrompt", calls, done };
}

export function phAwaitingSummary(cut: number): SPhase {
  //@ verify
  return { kind: "awaitingSummary", cut };
}

export function cmdCallProvider(): SCommand {
  //@ verify
  return { kind: "callProvider" };
}

export function cmdExecTool(call: SCall): SCommand {
  //@ verify
  return { kind: "execTool", call };
}

export function cmdAskUser(call: SCall): SCommand {
  //@ verify
  return { kind: "askUser", call };
}

export function cmdSkipTool(call: SCall, reason: Verdict): SCommand {
  //@ verify
  return { kind: "skipTool", call, reason };
}

export function cmdSummarize(cut: number): SCommand {
  //@ verify
  return { kind: "summarize", cut };
}

// ── Projection to the transcript model ────────────────────────────────────────

/** Type anchors — imported types are materialized in this module only when they
 *  occur as local parameter types, so these identity functions anchor the ones
 *  used solely in fields, returns, and extern signatures. Runtime no-ops. */
export function anchorTCall(c: TToolCall): TToolCall {
  //@ verify
  return c;
}

export function anchorReq(req: Req): Req {
  //@ verify
  return req;
}

export function anchorOutcome(o: Outcome): Outcome {
  //@ verify
  return o;
}

/** The TToolCall view of one call (id + name). */
export function toTCall(c: SCall): TToolCall {
  //@ verify
  return { id: c.id, name: c.name };
}

/** The TToolCall view of a batch; what the transcript records. */
export function projectCalls(calls: SCall[]): TToolCall[] {
  //@ verify
  //@ decreases calls.length
  //@ ensures \result.length === calls.length
  if (calls.length === 0) return [];
  return [toTCall(calls[0]), ...projectCalls(calls.slice(1))];
}

/** The transcript model the shell must mirror — the runtime faithfulness check
 *  calls this before every provider request. */
export function wellFormedModel(msgs: TMsg[]): boolean {
  //@ verify
  return wellFormed(msgs);
}

/** The pairing predicate, re-exported into this module's model (the lifted
 *  contracts of pushResult/fillRest/appendAnsweredBlock are stated over it). */
export function pairsModel(calls: TToolCall[], results: TToolResult[]): boolean {
  //@ verify
  return pairs(calls, results);
}

// ── The session invariant ─────────────────────────────────────────────────────

/** inv — what every reachable session state satisfies (S2): the transcript is
 *  well-formed; a batch in flight is nonempty, has an unanswered call, and its
 *  results pair with its calls; a pending compaction cut is a safe boundary. */
export function inv(st: Session): boolean {
  //@ verify
  const ph = st.phase;
  if (ph.kind === "toolBatch" || ph.kind === "awaitingPrompt") {
    return (
      wellFormed(st.msgs) &&
      ph.calls.length > 0 &&
      ph.done.length < ph.calls.length &&
      pairsTo(projectCalls(ph.calls), ph.done)
    );
  }
  if (ph.kind === "awaitingSummary") {
    return (
      wellFormed(st.msgs) &&
      0 < ph.cut &&
      ph.cut <= st.msgs.length &&
      (ph.cut === st.msgs.length || headOk(st.msgs[ph.cut]))
    );
  }
  return wellFormed(st.msgs);
}

/** The initial session: empty transcript, idle — provably satisfies inv. */
export function initialSession(perms: PermState, cwd: string[], maxTurns: number, compactKeep: number, autoCompactAt: number): Session {
  //@ verify
  //@ ensures inv(\result)
  return {
    msgs: initialMsgs(),
    perms,
    cwd,
    phase: phIdle(),
    turns: 0,
    maxTurns,
    compactKeep,
    autoCompactAt,
    lastContextTokens: 0,
  };
}

// ── The per-call decision ─────────────────────────────────────────────────────

/** What to do with the next unanswered call — the gate's order, centralized:
 *  unknown tool → skip; exempt or allowed → execute (if args check out);
 *  denied → skip; otherwise ask the user. The ensures is the per-call half of
 *  S1: "exec" is only ever reachable through an exemption or a justification. */
export type Verdict = "exec" | "prompt" | "skipUnknown" | "skipDenied" | "skipMissingArgs";

export function verdictFor(st: Session, c: SCall): Verdict {
  //@ verify
  //@ ensures \result === "exec" ==> (c.noPerm || isAllowed(st.perms, st.cwd, c.req))
  //@ ensures \result === "prompt" ==> (!c.noPerm && !isAllowed(st.perms, st.cwd, c.req))
  //@ ensures st.perms.rejectPrompts ==> \result !== "prompt"
  if (!c.known) return "skipUnknown";
  if (c.noPerm || decide(st.perms, st.cwd, c.req) === "Allow") {
    if (c.argsOk) return "exec";
    return "skipMissingArgs";
  }
  if (decide(st.perms, st.cwd, c.req) === "Deny") return "skipDenied";
  return "prompt";
}

// ── Transition helpers ────────────────────────────────────────────────────────

/** Ask the provider for the next turn — unless the turn budget is exhausted. */
export function requestProvider(st: Session): StepOut {
  //@ verify
  //@ requires wellFormed(st.msgs)
  if (st.maxTurns > 0 && st.turns >= st.maxTurns) {
    return { st: { ...st, phase: phIdle() }, cmds: [] };
  }
  return { st: { ...st, turns: st.turns + 1, phase: phAwaitingProvider() }, cmds: [cmdCallProvider()] };
}

/** The whole batch is answered: append the assistant turn + its paired result
 *  block to the transcript, then hand back to the provider (or to the user, if
 *  the batch was interrupted). */
export function finishBatch(st: Session, calls: SCall[], done: TToolResult[], stopped: boolean): StepOut {
  //@ verify
  //@ requires wellFormed(st.msgs)
  //@ requires calls.length > 0
  //@ requires pairs(projectCalls(calls), done)
  const msgs2 = appendAnsweredBlock(st.msgs, projectCalls(calls), done);
  if (stopped) {
    return { st: { ...st, msgs: msgs2, phase: phIdle() }, cmds: [] };
  }
  return requestProvider({ ...st, msgs: msgs2 });
}

/** Work through the batch from the next unanswered call: skip what must be
 *  skipped (recording an error result for each), stop at the first call that
 *  needs execution or a prompt, finish when everything is answered. */
export function advance(st: Session, calls: SCall[], done: TToolResult[]): StepOut {
  //@ verify
  //@ requires wellFormed(st.msgs)
  //@ requires calls.length > 0
  //@ requires done.length < calls.length
  //@ requires pairsTo(projectCalls(calls), done)
  //@ decreases calls.length - done.length
  const c = calls[done.length];
  const v = verdictFor(st, c);
  if (v === "exec") {
    return { st: { ...st, phase: phToolBatch(calls, done) }, cmds: [cmdExecTool(c)] };
  }
  if (v === "prompt") {
    return { st: { ...st, phase: phAwaitingPrompt(calls, done) }, cmds: [cmdAskUser(c)] };
  }
  const done2 = pushResult(projectCalls(calls), done, true);
  const r = done2.length === calls.length ? finishBatch(st, calls, done2, false) : advance(st, calls, done2);
  return { st: r.st, cmds: [cmdSkipTool(c, v), ...r.cmds] };
}

/** Record a result for the current call (the shell knows its content from the
 *  event that produced it), then finish or keep advancing. */
export function recordAndContinue(st: Session, calls: SCall[], done: TToolResult[], isError: boolean): StepOut {
  //@ verify
  //@ requires wellFormed(st.msgs)
  //@ requires calls.length > 0
  //@ requires done.length < calls.length
  //@ requires pairsTo(projectCalls(calls), done)
  const done2 = pushResult(projectCalls(calls), done, isError);
  if (done2.length === calls.length) return finishBatch(st, calls, done2, false);
  return advance(st, calls, done2);
}

/** The user approved the current call (perms already updated for always/All):
 *  run it — unless its arguments are missing, which still yields an error result. */
export function approvedCurrent(st: Session, calls: SCall[], done: TToolResult[], c: SCall): StepOut {
  //@ verify
  //@ requires wellFormed(st.msgs)
  //@ requires calls.length > 0
  //@ requires done.length < calls.length
  //@ requires pairsTo(projectCalls(calls), done)
  if (!c.argsOk) {
    const r = recordAndContinue(st, calls, done, true);
    return { st: r.st, cmds: [cmdSkipTool(c, "skipMissingArgs"), ...r.cmds] };
  }
  return { st: { ...st, phase: phToolBatch(calls, done) }, cmds: [cmdExecTool(c)] };
}

/** Begin a compaction: pick the verified safe cut; a zero cut means there is
 *  nothing to drop (the convergence guard, C3) and the request is a no-op. */
export function startCompact(st: Session, keep: number): StepOut {
  //@ verify
  //@ requires wellFormed(st.msgs)
  if (keep < 0) {
    return { st: { ...st, phase: phIdle() }, cmds: [] };
  }
  const cut = findCut(st.msgs, keep);
  if (cut === 0) {
    return { st: { ...st, phase: phIdle() }, cmds: [] };
  }
  return { st: { ...st, phase: phAwaitingSummary(cut) }, cmds: [cmdSummarize(cut)] };
}

/** After a finished turn: auto-compact if the context has outgrown the threshold. */
export function maybeAutoCompact(st: Session): StepOut {
  //@ verify
  //@ requires wellFormed(st.msgs)
  if (st.autoCompactAt <= 0 || st.lastContextTokens <= st.autoCompactAt) {
    return { st: { ...st, phase: phIdle() }, cmds: [] };
  }
  return startCompact(st, st.compactKeep);
}

// ── Event handlers ────────────────────────────────────────────────────────────

export function onUserInput(st: Session): StepOut {
  //@ verify
  //@ requires inv(st)
  const ph = st.phase;
  if (ph.kind === "idle") {
    return requestProvider({ ...st, msgs: appendUserMsg(st.msgs) });
  }
  return { st, cmds: [] };
}

export function onCompactRequest(st: Session, keep: number): StepOut {
  //@ verify
  //@ requires inv(st)
  const ph = st.phase;
  if (ph.kind === "idle") {
    return startCompact(st, keep);
  }
  return { st, cmds: [] };
}

export function onProviderReply(st: Session, calls: SCall[], contextTokens: number): StepOut {
  //@ verify
  //@ requires inv(st)
  const ph = st.phase;
  if (ph.kind === "awaitingProvider") {
    const st2 = { ...st, lastContextTokens: contextTokens };
    if (calls.length === 0) {
      return maybeAutoCompact({ ...st2, msgs: appendAssistantDone(st2.msgs) });
    }
    return advance(st2, calls, startResults(projectCalls(calls)));
  }
  return { st, cmds: [] };
}

export function onProviderInterrupted(st: Session): StepOut {
  //@ verify
  //@ requires inv(st)
  const ph = st.phase;
  if (ph.kind === "awaitingProvider") {
    // The partial answer is kept (no tool calls); back to the user, no auto-compact.
    return { st: { ...st, msgs: appendAssistantDone(st.msgs), phase: phIdle() }, cmds: [] };
  }
  return { st, cmds: [] };
}

export function onToolDone(st: Session, isError: boolean): StepOut {
  //@ verify
  //@ requires inv(st)
  const ph = st.phase;
  if (ph.kind === "toolBatch") {
    return recordAndContinue(st, ph.calls, ph.done, isError);
  }
  return { st, cmds: [] };
}

export function onPromptAnswer(st: Session, answer: Answer): StepOut {
  //@ verify
  //@ requires inv(st)
  const ph = st.phase;
  if (ph.kind === "awaitingPrompt") {
    const c = ph.calls[ph.done.length];
    if (answer === "no") {
      return recordAndContinue(st, ph.calls, ph.done, true);
    }
    if (answer === "always") {
      // The verified grant: G1 says the new state justifies exactly this request.
      return approvedCurrent({ ...st, perms: grantFor(st.perms, st.cwd, c.req) }, ph.calls, ph.done, c);
    }
    if (answer === "all") {
      return approvedCurrent({ ...st, perms: grantAll(st.perms, st.cwd, c.req) }, ph.calls, ph.done, c);
    }
    // "yes" — a one-time approval: no grant is recorded.
    return approvedCurrent(st, ph.calls, ph.done, c);
  }
  return { st, cmds: [] };
}

export function onBatchInterrupted(st: Session): StepOut {
  //@ verify
  //@ requires inv(st)
  const ph = st.phase;
  if (ph.kind === "toolBatch" || ph.kind === "awaitingPrompt") {
    // Every remaining call gets a paired error result; no further provider call.
    return finishBatch(st, ph.calls, fillRest(projectCalls(ph.calls), ph.done), true);
  }
  return { st, cmds: [] };
}

export function onSummaryReady(st: Session, ok: boolean): StepOut {
  //@ verify
  //@ requires inv(st)
  const ph = st.phase;
  if (ph.kind === "awaitingSummary") {
    if (!ok) {
      // Empty/failed summary: history unchanged.
      return { st: { ...st, phase: phIdle() }, cmds: [] };
    }
    return { st: { ...st, msgs: compact(st.msgs, ph.cut), phase: phIdle() }, cmds: [] };
  }
  return { st, cmds: [] };
}

// ── The step function ─────────────────────────────────────────────────────────

/** One verified transition: any state, any event. Unexpected (event, phase)
 *  combinations are no-ops — step is total. */
export function step(st: Session, ev: SEvent): StepOut {
  //@ verify
  //@ requires inv(st)
  switch (ev.kind) {
    case "userInput":
      return onUserInput(st);
    case "compactRequest":
      return onCompactRequest(st, ev.keep);
    case "providerReply":
      return onProviderReply(st, ev.calls, ev.contextTokens);
    case "providerInterrupted":
      return onProviderInterrupted(st);
    case "toolDone":
      return onToolDone(st, ev.isError);
    case "promptAnswer":
      return onPromptAnswer(st, ev.answer);
    case "batchInterrupted":
      return onBatchInterrupted(st);
    case "summaryReady":
      return onSummaryReady(st, ev.ok);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// The trace theorems, surfaced. Each //@ ensures states the property; the
// proof is the generated `_ensures` lemma body in session.dfy.
// ═══════════════════════════════════════════════════════════════════════════

/** S1's justification predicate — the only three ways a tool call may run:
 *  the tool is exempt from gating; the (post-)state justifies the request
 *  (covers auto-allows, prior session grants, and the always/All grant just
 *  recorded — G1); or the user said "yes" to exactly this call. */
export function justified(st: Session, st2: Session, ev: SEvent, c: SCall): boolean {
  //@ verify
  if (c.noPerm) return true;
  if (isAllowed(st2.perms, st2.cwd, c.req)) return true;
  if (ev.kind !== "promptAnswer") return false;
  if (ev.answer !== "yes") return false;
  const ph = st.phase;
  if (ph.kind !== "awaitingPrompt") return false;
  if (ph.done.length >= ph.calls.length) return false;
  return c === ph.calls[ph.done.length];
}

// S1 mediation (the headline). In any state satisfying inv, for ANY event —
// the provider's tool calls included, so prompt injection is in scope — every
// execTool command step emits is justified. There is no unjustified path to an
// effect.
export function stepMediation(st: Session, ev: SEvent, i: number): boolean {
  //@ verify
  //@ requires inv(st)
  //@ requires 0 <= i && i < step(st, ev).cmds.length
  //@ requires step(st, ev).cmds[i].kind === "execTool"
  //@ ensures justified(st, step(st, ev).st, ev, step(st, ev).cmds[i].call)
  return true;
}

// S2 preservation. inv survives every event — including interrupts mid-stream
// and mid-batch, prompt answers, and compaction. With initialSession's ensures
// this gives by induction: every REACHABLE session state satisfies inv.
export function stepPreservesInv(st: Session, ev: SEvent): boolean {
  //@ verify
  //@ requires inv(st)
  //@ ensures inv(step(st, ev).st)
  return true;
}

// S3 provider call. Whenever step emits callProvider, the session is awaiting
// the provider, the transcript it will mirror out is well-formed, and the turn
// counter respected the budget.
export function stepProviderCallSafe(st: Session, ev: SEvent, i: number): boolean {
  //@ verify
  //@ requires inv(st)
  //@ requires 0 <= i && i < step(st, ev).cmds.length
  //@ requires step(st, ev).cmds[i].kind === "callProvider"
  //@ ensures step(st, ev).st.phase.kind === "awaitingProvider"
  //@ ensures wellFormed(step(st, ev).st.msgs)
  //@ ensures st.maxTurns > 0 ==> step(st, ev).st.turns <= st.maxTurns
  return true;
}

// S4 summarize. Whenever step emits summarize(cut), the cut is recorded in the
// phase, is nontrivial, and is a safe boundary of the transcript it will be
// applied to (the post-state's): applying it can never orphan a tool_result
// (composing with C1, the compaction itself stays well-formed).
export function stepSummarizeSafe(st: Session, ev: SEvent, i: number): boolean {
  //@ verify
  //@ requires inv(st)
  //@ requires 0 <= i && i < step(st, ev).cmds.length
  //@ requires step(st, ev).cmds[i].kind === "summarize"
  //@ ensures step(st, ev).st.phase.kind === "awaitingSummary"
  //@ ensures step(st, ev).st.phase.cut === step(st, ev).cmds[i].cut
  //@ ensures 0 < step(st, ev).cmds[i].cut && step(st, ev).cmds[i].cut <= step(st, ev).st.msgs.length
  //@ ensures step(st, ev).cmds[i].cut === step(st, ev).st.msgs.length || headOk(step(st, ev).st.msgs[step(st, ev).cmds[i].cut])
  return true;
}

// S5 permission discipline. Only an interactive prompt answer ever changes the
// permission state — every other event leaves it untouched. (What it changes
// TO is governed by the grant builders' G1/G2 and P3/P4.)
export function stepPermsStable(st: Session, ev: SEvent): boolean {
  //@ verify
  //@ requires inv(st)
  //@ requires ev.kind !== "promptAnswer"
  //@ ensures step(st, ev).st.perms === st.perms
  return true;
}

// S6 prompt necessity (the dual of S1). The user is only ever asked when the
// call is neither exempt nor already allowed — step never emits a spurious
// permission prompt for something the state already justifies.
export function stepPromptNecessary(st: Session, ev: SEvent, i: number): boolean {
  //@ verify
  //@ requires inv(st)
  //@ requires 0 <= i && i < step(st, ev).cmds.length
  //@ requires step(st, ev).cmds[i].kind === "askUser"
  //@ ensures !step(st, ev).cmds[i].call.noPerm
  //@ ensures !isAllowed(step(st, ev).st.perms, step(st, ev).st.cwd, step(st, ev).cmds[i].call.req)
  return true;
}

// S7 automation never blocks. Under rejectPrompts (bench/automation mode) step
// NEVER emits askUser — composed with P4 (reject only rewrites Prompt→Deny),
// automation can neither hang on a prompt nor escalate beyond pre-authorization.
export function stepRejectNeverAsks(st: Session, ev: SEvent, i: number): boolean {
  //@ verify
  //@ requires inv(st)
  //@ requires st.perms.rejectPrompts
  //@ requires 0 <= i && i < step(st, ev).cmds.length
  //@ ensures step(st, ev).cmds[i].kind !== "askUser"
  return true;
}

// S8 command discipline. Everything before the last command is a skipTool
// notification — so there is at most ONE effectful command per step, and it is
// last. The interpreter's sequential dispatch relies on exactly this shape.
export function stepCommandDiscipline(st: Session, ev: SEvent, i: number): boolean {
  //@ verify
  //@ requires inv(st)
  //@ requires 0 <= i && i < step(st, ev).cmds.length - 1
  //@ ensures step(st, ev).cmds[i].kind === "skipTool"
  return true;
}

// S9 cursor correspondence. An emitted execTool (resp. askUser) call IS the
// post-state batch's current call — the call the next toolDone (resp.
// promptAnswer) event will answer. This is what makes the shell's id-keyed
// bookkeeping (pendingCalls/pendingResults) faithful by construction.
export function stepExecCursor(st: Session, ev: SEvent, i: number): boolean {
  //@ verify
  //@ requires inv(st)
  //@ requires 0 <= i && i < step(st, ev).cmds.length
  //@ requires step(st, ev).cmds[i].kind === "execTool"
  //@ ensures step(st, ev).st.phase.kind === "toolBatch"
  //@ ensures step(st, ev).st.phase.done.length < step(st, ev).st.phase.calls.length
  //@ ensures step(st, ev).st.phase.calls[step(st, ev).st.phase.done.length] === step(st, ev).cmds[i].call
  return true;
}

export function stepAskCursor(st: Session, ev: SEvent, i: number): boolean {
  //@ verify
  //@ requires inv(st)
  //@ requires 0 <= i && i < step(st, ev).cmds.length
  //@ requires step(st, ev).cmds[i].kind === "askUser"
  //@ ensures step(st, ev).st.phase.kind === "awaitingPrompt"
  //@ ensures step(st, ev).st.phase.done.length < step(st, ev).st.phase.calls.length
  //@ ensures step(st, ev).st.phase.calls[step(st, ev).st.phase.done.length] === step(st, ev).cmds[i].call
  return true;
}

// S10 batch progress. The batch measure (2·unanswered calls, +1 while a prompt
// is pending) strictly decreases on every batch event — so a batch of n calls
// provably completes within 2n+1 events: no livelock, no stuck prompt loop.
export function batchMeasure(st: Session): number {
  //@ verify
  const ph = st.phase;
  if (ph.kind === "toolBatch") return 2 * (ph.calls.length - ph.done.length);
  if (ph.kind === "awaitingPrompt") return 2 * (ph.calls.length - ph.done.length) + 1;
  return 0;
}

export function stepBatchProgress(st: Session, ev: SEvent): boolean {
  //@ verify
  //@ requires inv(st)
  //@ requires st.phase.kind === "toolBatch" || st.phase.kind === "awaitingPrompt"
  //@ requires ev.kind === "toolDone" || ev.kind === "promptAnswer" || ev.kind === "batchInterrupted"
  //@ requires ev.kind === "toolDone" ==> st.phase.kind === "toolBatch"
  //@ requires ev.kind === "promptAnswer" ==> st.phase.kind === "awaitingPrompt"
  //@ ensures (step(st, ev).st.phase.kind === "toolBatch" || step(st, ev).st.phase.kind === "awaitingPrompt") ==> batchMeasure(step(st, ev).st) < batchMeasure(st)
  return true;
}

// S11 configuration stability. The working directory and every budget are
// constants of the session, and the turn counter moves by at most one per step.
export function stepConfigStable(st: Session, ev: SEvent): boolean {
  //@ verify
  //@ requires inv(st)
  //@ ensures step(st, ev).st.maxTurns === st.maxTurns
  //@ ensures step(st, ev).st.compactKeep === st.compactKeep
  //@ ensures step(st, ev).st.autoCompactAt === st.autoCompactAt
  //@ ensures st.turns <= step(st, ev).st.turns && step(st, ev).st.turns <= st.turns + 1
  return true;
}

// S12 grant scope (sharpening S5). On a prompt answer, the permission state
// either stays put or becomes EXACTLY grantFor/grantAll of the prompted call's
// request — there is no other mutation a prompt answer can perform.
export function stepGrantScope(st: Session, ev: SEvent): boolean {
  //@ verify
  //@ requires inv(st)
  //@ requires ev.kind === "promptAnswer"
  //@ ensures step(st, ev).st.perms === st.perms || (st.phase.kind === "awaitingPrompt" && st.phase.done.length < st.phase.calls.length && (step(st, ev).st.perms === grantFor(st.perms, st.cwd, st.phase.calls[st.phase.done.length].req) || step(st, ev).st.perms === grantAll(st.perms, st.cwd, st.phase.calls[st.phase.done.length].req)))
  return true;
}

// S13 bounded growth (C2 at the session level). One step grows the transcript
// by at most the answered block (two messages), and applying a summary never
// grows it — so history size is controlled by construction.
export function stepMsgsBounded(st: Session, ev: SEvent): boolean {
  //@ verify
  //@ requires inv(st)
  //@ ensures step(st, ev).st.msgs.length <= st.msgs.length + 2
  //@ ensures ev.kind === "summaryReady" ==> step(st, ev).st.msgs.length <= st.msgs.length
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// The trace theorem — S2 composed over whole event sequences.
// ═══════════════════════════════════════════════════════════════════════════

/** step, totalized: outside inv an event is a no-op. S2 makes non-inv states
 *  unreachable, so on every state the system can actually be in, stepTotal IS
 *  step — the guard only exists so the trace fold needs no precondition. */
export function stepTotal(st: Session, ev: SEvent): StepOut {
  //@ verify
  //@ ensures inv(st) ==> inv(\result.st)
  if (!inv(st)) return { st, cmds: [] };
  return step(st, ev);
}

/** Fold a whole event trace. The commands of each step are the interpreter's
 *  to perform; the trace theorem is about the state evolution. */
export function runSession(st: Session, events: SEvent[]): Session {
  //@ verify
  //@ decreases events.length
  //@ ensures inv(st) ==> inv(\result)
  if (events.length === 0) return st;
  return runSession(stepTotal(st, events[0]).st, events.slice(1));
}

// T∞ (the capstone). EVERY state reachable from the initial session — by ANY
// event sequence whatsoever: any provider outputs, any prompt answers, any
// interleaving of interrupts and compactions — satisfies the session
// invariant. "Every reachable state is safe" is a theorem, not an induction
// in prose; and per-step, S1–S13 hold at each of those states.
export function traceFromInitialSafe(perms: PermState, cwd: string[], maxTurns: number, compactKeep: number, autoCompactAt: number, events: SEvent[]): boolean {
  //@ verify
  //@ ensures inv(runSession(initialSession(perms, cwd, maxTurns, compactKeep, autoCompactAt), events))
  return true;
}

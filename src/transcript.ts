//@ backend dafny

// The tool-call / tool-result protocol — the pure core of henri's chat loop.
//
// VERIFICATION TARGET (Phase 2). The agent must keep the conversation it sends
// to a provider well-formed: every tool_use is answered by exactly one
// tool_result with the matching id, in order, and a tool message only ever
// follows an assistant message that made tool calls. This is the Anthropic API
// requirement and the pi-lemmascript "no orphaned tool_result" concern — proven
// here as an invariant of the loop itself.
//
// Properties (see DESIGN.md §3.2 and transcript.dfy for the proofs):
//   T1 pairing   — makeResults(calls) has one result per call, ids in order
//   T2 no orphan — appending {tool, makeResults(calls)} after a well-formed
//                  transcript preserves wellFormed (so no orphan tool_result can
//                  ever be sent, and no tool_use goes unanswered)

export interface TToolCall {
  id: string;
  name: string;
}

export interface TToolResult {
  toolCallId: string;
  isError: boolean;
}

export type TMsg =
  | { role: "user" }
  | { role: "assistant"; toolCalls: TToolCall[] }
  | { role: "tool"; toolResults: TToolResult[] };

/** results pair 1:1 with calls, by id, in order. */
export function pairs(calls: TToolCall[], results: TToolResult[]): boolean {
  //@ decreases calls.length
  if (results.length !== calls.length) return false;
  if (calls.length === 0) return true;
  if (results[0].toolCallId !== calls[0].id) return false;
  return pairs(calls.slice(1), results.slice(1));
}

/** The results the per-call dispatch loop must produce: one per call, id preserved. */
export function makeResults(calls: TToolCall[]): TToolResult[] {
  //@ decreases calls.length
  //@ ensures \result.length === calls.length
  //@ ensures pairs(calls, \result)
  if (calls.length === 0) return [];
  return [{ toolCallId: calls[0].id, isError: false }, ...makeResults(calls.slice(1))];
}

/** A message that may legally be first: not an (orphaned) tool message. */
export function headOk(m: TMsg): boolean {
  return m.role !== "tool";
}

/** A message that may legally be last: not an (unanswered) assistant-with-calls. */
export function lastOk(m: TMsg): boolean {
  if (m.role === "assistant") return m.toolCalls.length === 0;
  return true;
}

/**
 * Whether message `b` may immediately follow `a`:
 * - an assistant-with-calls must be followed by a tool message whose results pair;
 * - otherwise the next message must not be a tool message (no orphan tool_result).
 */
export function okAdjacent(a: TMsg, b: TMsg): boolean {
  if (a.role === "assistant") {
    if (a.toolCalls.length > 0) {
      if (b.role === "tool") return pairs(a.toolCalls, b.toolResults);
      return false;
    }
    return b.role !== "tool";
  }
  return b.role !== "tool";
}

/** Interior + tail consistency: adjacency holds throughout, and the last message is a valid last. */
export function wfFrom(msgs: TMsg[]): boolean {
  //@ decreases msgs.length
  if (msgs.length === 0) return true;
  if (msgs.length === 1) return lastOk(msgs[0]);
  return okAdjacent(msgs[0], msgs[1]) && wfFrom(msgs.slice(1));
}

/** The conversation is well-formed: valid head, valid adjacencies, valid tail. */
export function wellFormed(msgs: TMsg[]): boolean {
  if (msgs.length === 0) return true;
  return headOk(msgs[0]) && wfFrom(msgs);
}

// ── Compaction: the *drop* side of the protocol (mirror of T2) ────────────────
// /compact replaces an old prefix with a summary and keeps a recent suffix.
// The retained suffix must never *start* with a tool message — that would orphan
// a tool_result, the exact hazard T2 rules out on the append side. snapBack picks
// a safe cut; findCut wraps it with the "keep the last N" heuristic; and the
// proofs (transcript.dfy) show C1: prepending a `user` summary to the suffix
// preserves wellFormed. The heuristic (how far back to keep) is shell policy; the
// *safety* (no orphan) is what's verified — so the shell may pass any `want`.

/**
 * Walk back from `c` to the nearest index that may begin the retained suffix:
 * either the end (empty suffix) or a non-tool message. The result is never an
 * orphan boundary, so the kept suffix never starts with a tool_result.
 */
export function snapBack(msgs: TMsg[], c: number): number {
  //@ requires 0 <= c && c <= msgs.length
  //@ decreases c
  //@ ensures 0 <= \result && \result <= msgs.length
  //@ ensures \result === msgs.length || headOk(msgs[\result])
  if (c >= msgs.length) return msgs.length;
  if (headOk(msgs[c])) return c;
  if (c === 0) return msgs.length;
  return snapBack(msgs, c - 1);
}

/**
 * The compaction cut point: aim to keep the last `keepRecent` messages, then
 * snap the boundary to a safe (non-tool) start. Returns the index where the
 * retained suffix begins.
 */
export function findCut(msgs: TMsg[], keepRecent: number): number {
  //@ requires 0 <= keepRecent
  //@ ensures 0 <= \result && \result <= msgs.length
  //@ ensures \result === msgs.length || headOk(msgs[\result])
  const want = msgs.length > keepRecent ? msgs.length - keepRecent : 0;
  return snapBack(msgs, want);
}

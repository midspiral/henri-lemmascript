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

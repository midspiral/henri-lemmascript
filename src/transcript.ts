// The tool-call / tool-result protocol — the pure core of henri's chat loop.
//
// VERIFICATION TARGET (Phase 2). The agent must keep the conversation it sends
// to a provider well-formed: every tool_use is answered by exactly one
// tool_result with the matching id, in order, and a tool message only ever
// follows an assistant message that made tool calls. This is the Anthropic API
// requirement and the pi-lemmascript "no orphaned tool_result" concern — proven
// here as an invariant of the loop itself.
//
// Properties to prove (see DESIGN.md §3.2):
//   T1 pairing   — makeResults(calls) has one result per call, ids in order
//   T2 no orphan — appending {tool, makeResults(calls)} after {assistant, calls}
//                  preserves wellFormed; every result id matches a real call

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
  if (results.length !== calls.length) return false;
  let i = 0;
  while (i < calls.length) {
    if (results[i].toolCallId !== calls[i].id) return false;
    i = i + 1;
  }
  return true;
}

/** The shape of results the per-call dispatch loop must produce: one per call, id preserved. */
export function makeResults(calls: TToolCall[]): TToolResult[] {
  return calls.map((c) => ({ toolCallId: c.id, isError: false }));
}

/**
 * The conversation is well-formed when tool_use/tool_result pairing holds
 * everywhere: every assistant-with-calls is immediately followed by a tool
 * message whose results pair with the calls, and every tool message is
 * immediately preceded by an assistant-with-calls.
 */
export function wellFormed(msgs: TMsg[]): boolean {
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    if (m.role === "assistant" && m.toolCalls.length > 0) {
      if (i + 1 >= msgs.length) return false;
      const next = msgs[i + 1];
      if (next.role !== "tool") return false;
      if (!pairs(m.toolCalls, next.toolResults)) return false;
    }
    if (m.role === "tool") {
      if (i === 0) return false;
      const prev = msgs[i - 1];
      if (prev.role !== "assistant" || prev.toolCalls.length === 0) return false;
    }
    i = i + 1;
  }
  return true;
}

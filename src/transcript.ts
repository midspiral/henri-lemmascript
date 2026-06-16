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
  //@ verify
  //@ contract Produces one tool-result per call, ids preserved in order — the result block pairs exactly with the calls.
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
  //@ verify
  //@ contract Returns a safe index where the retained suffix may begin — the end, or a non-tool message — so the kept suffix never starts with an orphaned tool_result.
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
  //@ verify
  //@ contract Returns a safe cut index — the end, or a non-tool position — where the retained suffix may begin; how far back to keep is unverified shell policy, the no-orphan safety is what is proven.
  //@ requires 0 <= keepRecent
  //@ ensures 0 <= \result && \result <= msgs.length
  //@ ensures \result === msgs.length || headOk(msgs[\result])
  const want = msgs.length > keepRecent ? msgs.length - keepRecent : 0;
  return snapBack(msgs, want);
}

// ═══════════════════════════════════════════════════════════════════════════
// Builders + verified properties. The headline theorems are about *constructed*
// transcripts (append a tool block; drop a prefix). //@ specs can't write list
// concatenation, so the concatenation lives in these small builder bodies and
// the theorems below are stated over the builder calls. Each //@ ensures states
// a property; the proof is the generated `_ensures` lemma body in transcript.dfy.
// T1 (pairing) is the ensures already on makeResults() above.
// ═══════════════════════════════════════════════════════════════════════════

/** Append messages `a` then `t` to a transcript. */
export function appendPair(msgs: TMsg[], a: TMsg, t: TMsg): TMsg[] {
  //@ verify
  return [...msgs, a, t];
}

/** The append the chat loop performs: an assistant tool-call turn answered by
 *  its paired tool-result block (one result per call, ids preserved). */
export function appendToolBlock(msgs: TMsg[], calls: TToolCall[]): TMsg[] {
  //@ verify
  return appendPair(
    msgs,
    { role: "assistant", toolCalls: calls },
    { role: "tool", toolResults: makeResults(calls) },
  );
}

/** The compaction the chat loop performs: replace the prefix before `c` with a
 *  single `user` summary, keeping the suffix msgs[c..]. */
export function compact(msgs: TMsg[], c: number): TMsg[] {
  //@ verify
  //@ contract Replaces the prefix before c with a single user summary, keeping the suffix — and if the input was well-formed and c is a safe cut, the result is well-formed; the result has length (msgs.length − c + 1).
  //@ requires 0 <= c && c <= msgs.length
  return [{ role: "user" }, ...msgs.slice(c)];
}

/** A consistent transcript ends in a message that may legally be last. */
export function wfFromImpliesLastOk(msgs: TMsg[]): boolean {
  //@ verify
  //@ contract A consistent transcript ends in a message that may legally be last.
  //@ requires msgs.length > 0
  //@ requires wfFrom(msgs)
  //@ decreases msgs.length
  //@ ensures lastOk(msgs[msgs.length - 1])
  return true;
}

/** A suffix of a consistent transcript is consistent (the adjacency chain shrinks). */
export function wfFromSuffix(msgs: TMsg[], c: number): boolean {
  //@ verify
  //@ contract Any suffix of a consistent transcript is itself consistent.
  //@ requires 0 <= c && c <= msgs.length
  //@ requires wfFrom(msgs)
  //@ decreases c
  //@ ensures wfFrom(msgs.slice(c))
  return true;
}

/** Core induction: extending a consistent transcript by a connected (a, t) pair
 *  whose `t` is a valid last preserves consistency. */
export function wfFromAppendPair(msgs: TMsg[], a: TMsg, t: TMsg): boolean {
  //@ verify
  //@ contract Extending a consistent transcript by a connected (a, t) pair whose t may legally be last preserves consistency.
  //@ requires msgs.length > 0
  //@ requires wfFrom(msgs)
  //@ requires okAdjacent(msgs[msgs.length - 1], a)
  //@ requires okAdjacent(a, t)
  //@ requires lastOk(t)
  //@ decreases msgs.length
  //@ ensures wfFrom(appendPair(msgs, a, t))
  return true;
}

// T2 (the headline). Appending a tool-call turn and its paired result block to a
// well-formed transcript stays well-formed: no orphan tool_result is ever sent,
// and no tool_use is left unanswered — the Anthropic API invariant, proven of
// the loop's own append step.
export function appendPreservesWellFormed(msgs: TMsg[], calls: TToolCall[]): boolean {
  //@ verify
  //@ contract Appending a tool-call turn and its paired result block to a well-formed transcript keeps it well-formed — no orphaned tool_result is ever sent and no tool_use goes unanswered.
  //@ requires wellFormed(msgs)
  //@ requires calls.length > 0
  //@ ensures wellFormed(appendToolBlock(msgs, calls))
  return true;
}

// C1 (the drop-side mirror of T2). Dropping the prefix at a safe (non-tool) cut
// and prepending a `user` summary preserves well-formedness — the retained
// suffix never starts with an orphan tool_result.
export function compactPreservesWellFormed(msgs: TMsg[], c: number): boolean {
  //@ verify
  //@ contract Dropping the prefix at a safe (non-tool) cut and prepending a user summary keeps the transcript well-formed — the retained suffix never starts with an orphaned tool_result.
  //@ requires wellFormed(msgs)
  //@ requires 0 <= c && c <= msgs.length
  //@ requires c === msgs.length || headOk(msgs[c])
  //@ ensures wellFormed(compact(msgs, c))
  return true;
}

// C2. Compaction never grows the conversation, and strictly shrinks it whenever
// it drops at least two messages — so repeated auto-compaction can't blow up.
export function compactNonGrowing(msgs: TMsg[], c: number): boolean {
  //@ verify
  //@ contract Compaction never grows the conversation.
  //@ requires 1 <= c && c <= msgs.length
  //@ ensures compact(msgs, c).length <= msgs.length
  return true;
}

export function compactShrinks(msgs: TMsg[], c: number): boolean {
  //@ verify
  //@ contract Compaction strictly shrinks the conversation whenever it drops at least two messages.
  //@ requires 2 <= c && c <= msgs.length
  //@ ensures compact(msgs, c).length < msgs.length
  return true;
}

// C3. Compaction converges: once at most keepRecent messages remain, findCut
// keeps everything (returns 0), so the auto-compaction guard (skip when
// findCut == 0) provably fires and the process reaches a fixpoint.
export function compactConverges(msgs: TMsg[], keepRecent: number): boolean {
  //@ verify
  //@ contract Once at most keepRecent messages remain, the cut keeps everything (findCut returns 0), so auto-compaction reaches a fixpoint.
  //@ requires 0 <= keepRecent
  //@ requires wellFormed(msgs)
  //@ requires msgs.length <= keepRecent
  //@ ensures findCut(msgs, keepRecent) === 0
  return true;
}

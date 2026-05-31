// Provider protocol for LLM backends.

import type { Message, ToolCall } from "../messages.ts";
import type { Tool } from "../tools/base.ts";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** An event from a streaming response. */
export interface StreamEvent {
  text?: string;
  toolCalls?: ToolCall[];
  stopReason?: string;
  /** Signal that tool use is beginning (drives the status spinner). */
  toolUseStarted?: boolean;
  usage?: Usage;
}

export interface Provider {
  name: string;
  /**
   * Stream a response from the LLM, given history, tools, and a system prompt.
   * `signal`, when aborted (Esc), cancels the in-flight request — the iteration
   * rejects, which the loop turns into a clean interrupt (see agent.ts).
   */
  stream(messages: Message[], tools: Tool[], system: string, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}

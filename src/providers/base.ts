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
  /** Stream a response from the LLM, given history, tools, and a system prompt. */
  stream(messages: Message[], tools: Tool[], system: string): AsyncIterable<StreamEvent>;
}

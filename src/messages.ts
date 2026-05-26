// Core runtime message types for the agent conversation.
//
// These are the *shell* types — the live, structured values the agent threads
// through providers and tools. The verified protocol model lives in
// transcript.ts, which projects from these (see toTranscript there).

export type Role = "user" | "assistant" | "tool";

/** A request from the LLM to execute a tool. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** The result of executing a tool. */
export interface ToolResult {
  toolCallId: string;
  content: string;
  isError: boolean;
}

/** A message in the conversation. */
export interface Message {
  role: Role;
  content: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
}

export function userMessage(content: string): Message {
  return { role: "user", content, toolCalls: [], toolResults: [] };
}

export function assistantMessage(content = "", toolCalls: ToolCall[] = []): Message {
  return { role: "assistant", content, toolCalls, toolResults: [] };
}

export function toolResultMessage(results: ToolResult[]): Message {
  return { role: "tool", content: "", toolCalls: [], toolResults: results };
}

// Ollama provider for local models, via its HTTP /api/chat endpoint.
//
// No SDK dependency: we POST to {host}/api/chat and parse the NDJSON stream
// directly, which also gives us native AbortSignal support (Esc-interrupt).

import type { Message, ToolCall } from "../messages.ts";
import type { Tool } from "../tools/base.ts";
import type { Provider, StreamEvent } from "./base.ts";

interface OllamaToolCall {
  function?: { name?: string; arguments?: Record<string, unknown> | string };
}

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

interface OllamaChunk {
  message?: { content?: string; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider implements Provider {
  name = "ollama";

  constructor(
    private modelId: string,
    private host: string,
  ) {}

  private messagesToOllama(messages: Message[], system: string): OllamaMessage[] {
    const out: OllamaMessage[] = [];
    if (system) out.push({ role: "system", content: system });
    for (const msg of messages) {
      if (msg.role === "tool") {
        // Ollama tool results are plain {role:"tool", content}; ids aren't used.
        for (const tr of msg.toolResults) out.push({ role: "tool", content: tr.content });
        continue;
      }
      if (msg.role === "assistant") {
        const m: OllamaMessage = { role: "assistant", content: msg.content };
        if (msg.toolCalls.length) {
          m.tool_calls = msg.toolCalls.map((tc) => ({ function: { name: tc.name, arguments: tc.args } }));
        }
        out.push(m);
        continue;
      }
      out.push({ role: "user", content: msg.content });
    }
    return out;
  }

  private toolsToOllama(tools: Tool[]): object[] {
    return tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  async *stream(messages: Message[], tools: Tool[], system: string, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const body = {
      model: this.modelId,
      messages: this.messagesToOllama(messages, system),
      tools: tools.length ? this.toolsToOllama(tools) : undefined,
      stream: true,
    };

    const url = `${this.host.replace(/\/+$/, "")}/api/chat`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new Error(`cannot reach Ollama at ${this.host} — is it running? (${(e as Error).message})`);
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Ollama HTTP ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }

    const toolCalls: ToolCall[] = [];
    let started = false;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const chunk = JSON.parse(line) as OllamaChunk;
        const message = chunk.message;

        if (message?.content) yield { text: message.content };

        if (message?.tool_calls?.length) {
          if (!started) {
            started = true;
            yield { toolUseStarted: true };
          }
          for (const tc of message.tool_calls) {
            const name = tc.function?.name ?? "unknown";
            const raw = tc.function?.arguments ?? {};
            const args = typeof raw === "string" ? safeParse(raw) : raw;
            // Ollama doesn't supply tool-call ids; a per-call synthetic id keeps
            // them unique (results pair to calls by position in the loop anyway).
            toolCalls.push({ id: `ollama_${toolCalls.length}`, name, args });
          }
        }

        if (chunk.done) {
          yield {
            toolCalls: toolCalls.length ? toolCalls : undefined,
            stopReason: toolCalls.length ? "tool_use" : "end_turn",
            usage: { inputTokens: chunk.prompt_eval_count ?? 0, outputTokens: chunk.eval_count ?? 0 },
          };
        }
      }
    }
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

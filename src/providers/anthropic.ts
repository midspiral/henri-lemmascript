// Direct Anthropic API provider for Claude models.

import Anthropic from "@anthropic-ai/sdk";
import type { Message, ToolCall } from "../messages.ts";
import type { Tool } from "../tools/base.ts";
import type { Provider, StreamEvent } from "./base.ts";

export class AnthropicProvider implements Provider {
  name = "anthropic";
  private modelId: string;
  private client: Anthropic;

  constructor(modelId: string) {
    this.modelId = modelId;
    this.client = new Anthropic();
  }

  private messageToAnthropic(msg: Message): Anthropic.MessageParam {
    const content: Anthropic.ContentBlockParam[] = [];

    if (msg.content) {
      content.push({ type: "text", text: msg.content });
    }
    for (const tc of msg.toolCalls) {
      content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
    }
    for (const tr of msg.toolResults) {
      content.push({
        type: "tool_result",
        tool_use_id: tr.toolCallId,
        content: tr.content,
        is_error: tr.isError,
      });
    }

    const role = msg.role === "tool" ? "user" : msg.role;
    return { role, content };
  }

  private toolsToAnthropic(tools: Tool[]): Anthropic.Tool[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));
  }

  async *stream(messages: Message[], tools: Tool[], system: string): AsyncIterable<StreamEvent> {
    const request: Anthropic.MessageStreamParams = {
      model: this.modelId,
      max_tokens: 8192,
      messages: messages.map((m) => this.messageToAnthropic(m)),
    };
    if (system) request.system = system;
    if (tools.length) request.tools = this.toolsToAnthropic(tools);

    const toolCalls: ToolCall[] = [];
    let curId: string | null = null;
    let curName: string | null = null;
    let curInput = "";

    const stream = this.client.messages.stream(request);

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          curId = event.content_block.id;
          curName = event.content_block.name;
          curInput = "";
          yield { toolUseStarted: true };
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { text: event.delta.text };
        } else if (event.delta.type === "input_json_delta") {
          curInput += event.delta.partial_json;
        }
      } else if (event.type === "content_block_stop") {
        if (curId && curName) {
          toolCalls.push({ id: curId, name: curName, args: curInput ? JSON.parse(curInput) : {} });
          curId = null;
          curName = null;
        }
      }
    }

    const final = await stream.finalMessage();
    yield {
      toolCalls: toolCalls.length ? toolCalls : undefined,
      stopReason: final.stop_reason ?? "end_turn",
      usage: { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens },
    };
  }
}

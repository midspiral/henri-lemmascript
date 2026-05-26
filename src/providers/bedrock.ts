// AWS Bedrock provider using the Converse API.

import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type ContentBlock,
  type Message as BedrockMessage,
  type Tool as BedrockTool,
} from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import type { Message, ToolCall } from "../messages.ts";
import type { Tool } from "../tools/base.ts";
import type { Provider, StreamEvent } from "./base.ts";

export class BedrockProvider implements Provider {
  name = "bedrock";
  private modelId: string;
  private client: BedrockRuntimeClient;

  constructor(modelId: string, region: string) {
    this.modelId = modelId;
    this.client = new BedrockRuntimeClient({ region });
  }

  private messageToBedrock(msg: Message): BedrockMessage {
    const content: ContentBlock[] = [];

    if (msg.content) {
      content.push({ text: msg.content });
    }
    for (const tc of msg.toolCalls) {
      content.push({ toolUse: { toolUseId: tc.id, name: tc.name, input: tc.args as DocumentType } });
    }
    for (const tr of msg.toolResults) {
      content.push({
        toolResult: {
          toolUseId: tr.toolCallId,
          content: [{ text: tr.content }],
          status: tr.isError ? "error" : "success",
        },
      });
    }

    const role = msg.role === "tool" ? "user" : msg.role;
    return { role, content };
  }

  private toolsToBedrock(tools: Tool[]): BedrockTool[] {
    return tools.map((t): BedrockTool => ({
      toolSpec: {
        name: t.name,
        description: t.description,
        inputSchema: { json: t.parameters as DocumentType },
      },
    }));
  }

  async *stream(messages: Message[], tools: Tool[], system: string): AsyncIterable<StreamEvent> {
    const command = new ConverseStreamCommand({
      modelId: this.modelId,
      messages: messages.map((m) => this.messageToBedrock(m)),
      system: system ? [{ text: system }] : undefined,
      toolConfig: tools.length ? { tools: this.toolsToBedrock(tools) } : undefined,
    });

    const response = await this.client.send(command);

    const toolCalls: ToolCall[] = [];
    let curId: string | undefined;
    let curName: string | undefined;
    let curInput = "";
    let stopReason: string | undefined;
    let usage: StreamEvent["usage"];

    for await (const event of response.stream ?? []) {
      if (event.contentBlockStart) {
        const start = event.contentBlockStart.start;
        if (start?.toolUse) {
          curId = start.toolUse.toolUseId;
          curName = start.toolUse.name;
          curInput = "";
          yield { toolUseStarted: true };
        }
      } else if (event.contentBlockDelta) {
        const delta = event.contentBlockDelta.delta;
        if (delta?.text) {
          yield { text: delta.text };
        } else if (delta?.toolUse) {
          curInput += delta.toolUse.input ?? "";
        }
      } else if (event.contentBlockStop) {
        if (curId && curName) {
          toolCalls.push({ id: curId, name: curName, args: curInput ? JSON.parse(curInput) : {} });
          curId = undefined;
          curName = undefined;
        }
      } else if (event.messageStop) {
        stopReason = event.messageStop.stopReason;
      } else if (event.metadata) {
        const u = event.metadata.usage;
        usage = { inputTokens: u?.inputTokens ?? 0, outputTokens: u?.outputTokens ?? 0 };
      }
    }

    yield { toolCalls: toolCalls.length ? toolCalls : undefined, stopReason, usage };
  }
}

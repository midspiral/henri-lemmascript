// Provider registry and factory.

import { DEFAULT_BEDROCK_REGION, DEFAULT_OLLAMA_HOST } from "../config.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { BedrockProvider } from "./bedrock.ts";
import { OllamaProvider } from "./ollama.ts";
import type { Provider } from "./base.ts";

export type { Provider, StreamEvent, Usage } from "./base.ts";

export const PROVIDERS = ["anthropic", "bedrock", "ollama"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export function createProvider(name: string, model: string, region?: string, host?: string): Provider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider(model);
    case "bedrock":
      return new BedrockProvider(model, region ?? DEFAULT_BEDROCK_REGION);
    case "ollama":
      return new OllamaProvider(model, host ?? DEFAULT_OLLAMA_HOST);
    default:
      throw new Error(`Unknown provider: ${name}. Available: ${PROVIDERS.join(", ")}`);
  }
}

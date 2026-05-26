// Provider registry and factory.

import { DEFAULT_BEDROCK_REGION } from "../config.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { BedrockProvider } from "./bedrock.ts";
import type { Provider } from "./base.ts";

export type { Provider, StreamEvent, Usage } from "./base.ts";

export const PROVIDERS = ["anthropic", "bedrock"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export function createProvider(name: string, model: string, region?: string): Provider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider(model);
    case "bedrock":
      return new BedrockProvider(model, region ?? DEFAULT_BEDROCK_REGION);
    default:
      throw new Error(`Unknown provider: ${name}. Available: ${PROVIDERS.join(", ")}`);
  }
}

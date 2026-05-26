// Configuration defaults and resolution.
//
// Arguments take precedence over HENRI_* environment variables, which take
// precedence over built-in defaults.

export function envVar(name: string): string | undefined {
  return process.env[`HENRI_${name}`];
}

export const DEFAULT_PROVIDER = "bedrock";

// AWS Bedrock defaults
export const DEFAULT_BEDROCK_MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
export const DEFAULT_BEDROCK_REGION = "us-east-1";

// Direct Anthropic API defaults
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";

export const MODEL_DEFAULTS: Record<string, string> = {
  bedrock: DEFAULT_BEDROCK_MODEL,
  anthropic: DEFAULT_ANTHROPIC_MODEL,
};

export interface ProviderConfig {
  provider: string;
  model: string;
  region?: string;
  maxTurns?: number;
}

export interface ConfigArgs {
  provider?: string;
  model?: string;
  region?: string;
  maxTurns?: number;
}

export function getProviderConfig(args: ConfigArgs): ProviderConfig {
  const provider = args.provider ?? envVar("PROVIDER") ?? DEFAULT_PROVIDER;
  const region = args.region ?? envVar("REGION");

  let model = args.model ?? envVar("MODEL");
  if (model === undefined) {
    model = MODEL_DEFAULTS[provider];
  }

  let maxTurns = args.maxTurns;
  if (maxTurns === undefined) {
    const env = envVar("MAX_TURNS");
    if (env) maxTurns = parseInt(env, 10);
  }

  return { provider, model, region, maxTurns };
}

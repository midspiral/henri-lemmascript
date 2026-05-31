#!/usr/bin/env -S npx tsx
// CLI entry point.

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { DEFAULT_PROVIDER, getProviderConfig } from "./config.ts";
import { PROVIDERS, createProvider } from "./providers/index.ts";
import { runAgent } from "./agent.ts";
import type { Hook } from "./hooks.ts";

const HELP = `henri-lemmascript — a hackable agent CLI with a LemmaScript-verified core.

Usage: henri [options]            (after 'npm link')
   or: npm run henri -- [options]

Options:
  -p, --provider <name>  LLM provider: ${PROVIDERS.join(" | ")} (default: ${DEFAULT_PROVIDER})
  -m, --model <id>       Model ID (provider-specific default if unset)
      --region <region>  AWS region (Bedrock)
      --max-turns <n>    Stop after n turns (default: unlimited)
      --compact-keep <n> Recent messages /compact keeps (default: 6)
      --hook <path>      Load a hook module (.ts/.js exporting a Hook); repeatable
  -h, --help             Show this help

In-session commands: /compact [n] (summarize old history, keep n recent),
/help.

Env vars (HENRI_PROVIDER, HENRI_MODEL, HENRI_REGION, HENRI_MAX_TURNS,
HENRI_COMPACT_KEEP) are used as fallbacks. Set ANTHROPIC_API_KEY for --provider
anthropic; configure AWS credentials for --provider bedrock.`;

async function loadHook(path: string): Promise<Hook> {
  const mod = await import(pathToFileURL(resolve(path)).href);
  return (mod.default ?? mod) as Hook;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: "string", short: "p" },
      model: { type: "string", short: "m" },
      region: { type: "string" },
      "max-turns": { type: "string" },
      "compact-keep": { type: "string" },
      hook: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  const config = getProviderConfig({
    provider: values.provider,
    model: values.model,
    region: values.region,
    maxTurns: values["max-turns"] ? parseInt(values["max-turns"], 10) : undefined,
    compactKeep: values["compact-keep"] ? parseInt(values["compact-keep"], 10) : undefined,
  });

  if (!PROVIDERS.includes(config.provider as (typeof PROVIDERS)[number])) {
    console.error(`Unknown provider: ${config.provider}. Available: ${PROVIDERS.join(", ")}`);
    process.exit(2);
  }
  if (!config.model) {
    console.error(`No model resolved for provider '${config.provider}'. Pass --model.`);
    process.exit(2);
  }

  const hooks: Hook[] = [];
  for (const path of values.hook ?? []) hooks.push(await loadHook(path));

  const provider = createProvider(config.provider, config.model, config.region);

  await runAgent({
    provider,
    hooks,
    maxTurns: config.maxTurns,
    providerName: config.provider,
    model: config.model,
    compactKeep: config.compactKeep,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

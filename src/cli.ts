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
   or: henri plan <task>          (generate-verify-execute: plan → verify → run)

Options:
  -p, --provider <name>  LLM provider: ${PROVIDERS.join(" | ")} (default: ${DEFAULT_PROVIDER})
  -m, --model <id>       Model ID (provider-specific default if unset)
      --region <region>  AWS region (Bedrock)
      --host <url>       Ollama host URL (default: http://localhost:11434)
      --max-turns <n>    Stop after n turns (default: unlimited)
      --compact-keep <n> Recent messages /compact keeps (default: 6)
      --auto-compact-at <n>  Auto-compact when a turn's input tokens exceed n
                             (default: 150000; use --no-auto-compact to disable)
      --no-auto-compact  Disable automatic compaction (manual /compact only)
      --hook <path>      Load a hook module (.ts/.js exporting a Hook); repeatable
  -h, --help             Show this help

In-session commands: /compact [n] (summarize old history, keep n recent),
/help. Compaction also runs automatically once context grows past
--auto-compact-at tokens.

Env vars (HENRI_PROVIDER, HENRI_MODEL, HENRI_REGION, HENRI_HOST, HENRI_MAX_TURNS,
HENRI_COMPACT_KEEP, HENRI_AUTO_COMPACT_AT) are used as fallbacks. Set
ANTHROPIC_API_KEY for --provider anthropic; configure AWS credentials for
--provider bedrock; run a local Ollama server for --provider ollama.`;

async function loadHook(path: string): Promise<Hook> {
  const mod = await import(pathToFileURL(resolve(path)).href);
  return (mod.default ?? mod) as Hook;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      provider: { type: "string", short: "p" },
      model: { type: "string", short: "m" },
      region: { type: "string" },
      host: { type: "string" },
      "max-turns": { type: "string" },
      "compact-keep": { type: "string" },
      "auto-compact-at": { type: "string" },
      "no-auto-compact": { type: "boolean" },
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
    host: values.host,
    maxTurns: values["max-turns"] ? parseInt(values["max-turns"], 10) : undefined,
    compactKeep: values["compact-keep"] ? parseInt(values["compact-keep"], 10) : undefined,
    autoCompactAt: values["auto-compact-at"] ? parseInt(values["auto-compact-at"], 10) : undefined,
    noAutoCompact: values["no-auto-compact"],
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

  const provider = createProvider(config.provider, config.model, config.region, config.host);

  // generate-verify-execute mode: `henri plan <task>` — plan, formally verify against
  // the security policy, then (Stage 2) execute only if admitted. See DESIGN_GVE.md.
  if (positionals[0] === "plan") {
    const task = positionals.slice(1).join(" ").trim();
    if (!task) {
      console.error("Usage: henri plan <task>");
      process.exit(2);
    }
    const { runPlanMode } = await import("./gve/run.ts");
    await runPlanMode(provider, task);
    return;
  }

  await runAgent({
    provider,
    hooks,
    maxTurns: config.maxTurns,
    providerName: config.provider,
    model: config.model,
    compactKeep: config.compactKeep,
    autoCompactAt: config.autoCompactAt,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

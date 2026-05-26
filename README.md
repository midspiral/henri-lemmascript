# henri-lemmascript

A hackable agent CLI in TypeScript — a port of [henri](../henri) — whose
security- and protocol-critical core is verified via
[LemmaScript](../LemmaScript) (Dafny backend).

It is **not** a line-by-line port. Henri's bulk is effectful glue (streaming,
terminal UI, subprocess, provider SDKs) that lies outside LemmaScript's verifiable
fragment. Instead, henri's *decision logic* is extracted into a pure verified core,
imported directly by the live agent. See [DESIGN.md](DESIGN.md).

## Status

- **Phase 0 — runnable skeleton: done.** Multi-provider agent (Anthropic + Bedrock),
  the full tool set, permissions/transcript/hooks written in fragment-friendly TS
  (not yet annotated).
- **Phases 1–3 — verification (next):** `permissions.ts` (path-traversal containment),
  `transcript.ts` (no-orphan tool-result invariant), `hooks.ts` (merge correctness).

## Run

```sh
npm install

# Anthropic (set ANTHROPIC_API_KEY)
npm run henri -- --provider anthropic

# AWS Bedrock (configure AWS credentials)
npm run henri -- --provider bedrock --region us-east-1

npm run henri -- --help    # all options
```

## Develop

```sh
npm run typecheck   # tsc --noEmit
npm test            # test/smoke.ts — runtime witnesses for the verified properties
```

## The verified core

| Module | Proves | Headline |
|--------|--------|----------|
| `src/permissions.ts` | `decide()` soundness, **path-traversal containment**, grant monotonicity, reject-prompt safety | a path escaping cwd is never auto-granted |
| `src/transcript.ts` | tool-call/result pairing + **no-orphan invariant** of the loop | the conversation sent to the provider is always well-formed |
| `src/hooks.ts` | merge removal, **name-uniqueness (a fix)**, order-independence, additivity | hooks only ever add access |

The shell (`agent.ts`, `permission-gate.ts`, `providers/`, `tools/`, `ui.ts`, `cli.ts`)
is unverified and gates every action through the core.

## License

MIT

# henri-lemmascript

A hackable agent CLI in TypeScript — a port of [henri](https://github.com/metareflection/henri/) — whose
security- and protocol-critical core is verified via
[LemmaScript](https://github.com/midspiral/LemmaScript) (Dafny backend).

It is **not** a line-by-line port. Henri's bulk is effectful glue (streaming,
terminal UI, subprocess, provider SDKs) that lies outside LemmaScript's verifiable
fragment. Instead, henri's *decision logic* is extracted into a pure verified core,
imported directly by the live agent. See [DESIGN.md](DESIGN.md).

## Status

- **Phase 0 — runnable skeleton: done.** Multi-provider agent (Anthropic + Bedrock),
  the full tool set, permissions/transcript/hooks written in fragment-friendly TS.
- **Phase 1 — `permissions.ts` verified: done.** `lsc check` green (14 Dafny VCs,
  0 errors): soundness, path-traversal containment, grant monotonicity, reject-safety.
  Proofs in [`src/permissions.dfy`](src/permissions.dfy).
- **Phase 2 — `transcript.ts` verified: done.** `lsc check` green (26 Dafny VCs,
  0 errors): tool-call/result pairing (T1) and the no-orphan invariant preserved by
  the loop on *append* (T2), the drop-side mirror — `/compact`'s cut never orphans a
  tool_result and the summarized conversation stays well-formed (C1,
  `findCut`/`snapBack`) — and that auto-compaction is well-behaved: it never grows
  history (C2) and converges to a no-op once short (C3, the guard correctness).
  Proofs in [`src/transcript.dfy`](src/transcript.dfy).
- **Phase 3 — `hooks.ts` verified: done.** `lsc check` green (24 Dafny VCs, 0 errors):
  removal (H1), name-uniqueness/the dedup fix (H2), coverage, order-independence (H3),
  additivity (H4, composed with permissions' P3). Verified **in place** — the real
  `mergeTools(Tool[])` is the proof target via `//@ declare-type Tool { name: string }`,
  no parallel model. Proofs in [`src/hooks.dfy`](src/hooks.dfy).
- **Phase 4 — `edit.ts` verified: done.** `lsc check` green (12 Dafny VCs, 0 errors):
  the `edit_file` decision (E1: not-found / ambiguous / replaced ⟺ occurrence count),
  no-match identity (E2), splice no-op `replaceFirst(hay, old, old) == hay` (E3, via
  `MatchSplit`), and a length law. The live `edit_file` tool calls the verified
  `editFile`/`replaceFirst`; the `replace_all` join stays shell. Proofs in
  [`src/edit.dfy`](src/edit.dfy).

**All four verified cores are proven (76 Dafny VCs, 0 errors).** The runnable agent
imports them directly.

## Run

```sh
npm install

# Anthropic (set ANTHROPIC_API_KEY)
npm run henri -- --provider anthropic

# AWS Bedrock (configure AWS credentials)
npm run henri -- --provider bedrock --region us-east-1

npm run henri -- --help    # all options
```

Or install a global `henri` command (runs the TypeScript directly via `tsx`):

```sh
npm link                   # one-time; symlinks the `henri` bin
henri --provider bedrock   # then run from anywhere
```

## Develop

```sh
npm run typecheck   # tsc --noEmit
npm test            # test/smoke.ts — runtime witnesses for the verified properties
npm run verify      # regenerate + verify all Dafny proofs (LemmaScript-files.txt) — 76 VCs
```

`npm run verify` runs `../LemmaScript/tools/check.sh dafny` over the modules listed in
[`LemmaScript-files.txt`](LemmaScript-files.txt): it regenerates each `.dfy.gen` merge
base, enforces the additions-only invariant against the proof `.dfy`, and runs Dafny.
CI ([`.github/workflows/lemmascript.yml`](.github/workflows/lemmascript.yml)) does the same plus
typecheck + smoke, and fails if any generated file is stale. Requires a sibling
`../LemmaScript` checkout and Dafny ≥ 4.x.

## The verified core

For the exact theorems (every lemma, its statement, and the proof techniques), see
**[README_LemmaScript.md](README_LemmaScript.md)**.

| Module | Proves | Headline |
|--------|--------|----------|
| `src/permissions.ts` | `decide()` soundness, **path-traversal containment**, grant monotonicity, reject-prompt safety | a path escaping cwd is never auto-granted |
| `src/transcript.ts` | tool-call/result pairing + **no-orphan invariant** of the loop (append **and** the `/compact` drop side) | the conversation sent to the provider is always well-formed, including after compaction |
| `src/hooks.ts` | merge removal, **name-uniqueness (a fix)**, order-independence, additivity | hooks only ever add access |
| `src/edit.ts` | `editFile()` decision soundness, **single-occurrence splice faithfulness**, length law | an edit touches exactly the matched span, nothing else |

The shell (`agent.ts`, `permission-gate.ts`, `providers/`, `tools/`, `ui.ts`,
`cli.ts`) is unverified and gates every action through the core.

## License

MIT

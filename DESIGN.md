# henri-lemmascript — Design

**Status:** draft (design conversation in progress)
**Date:** 2026-05-25

A port of [henri](../henri) — a small, hackable agent CLI — to TypeScript, with its
correctness- and security-critical decision logic verified via [LemmaScript](../LemmaScript)
(Dafny backend).

---

## 1. The rethink

Henri is ~2000 lines of Python, but most of it is *effectful glue*: async streaming,
Rich terminal UI, `subprocess`, network I/O, provider SDKs. None of that lives in
LemmaScript's verifiable fragment (no `this`/classes, no `async`, no closures over
mutable state, no I/O).

So this is **not a line-by-line port.** It is a re-architecture around the
`domain.ts` pattern the LemmaScript case studies use (talktimer, quorum, collab-todo):

> Extract henri's *decision logic* into a pure, verified core. Leave the I/O shell
> as an explicit, unverified trust boundary. The verified `.ts` is imported directly
> by the live agent — no adapter layer.

```
┌──────────────────────────────────────────────────────────┐
│  Unverified shell (full TypeScript, runs the agent)       │
│    cli.ts · agent.ts (stream loop) · providers/* · tools/*│
│    terminal UI · subprocess · network                     │
│                                                            │
│    ┌────────────────────────────────────────────────┐    │
│    │  Verified core (//@ annotations + Dafny proofs) │    │
│    │    permissions.ts   — the access decision       │    │
│    │    transcript.ts    — tool-call/result protocol │    │
│    │    hooks.ts         — config/hook merge          │    │
│    └────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

The shell *calls into* the verified core for every decision that matters: it gates
every tool through `decide()`, threads every turn through the transcript reducer,
and builds its tool/permission tables through the merge functions.

---

## 2. Decisions (settled)

| Question | Choice |
|----------|--------|
| Deliverable | **Runnable agent + verified core.** A working TS CLI whose live shell imports the verified modules (collab-todo / talktimer model). |
| Backend | **Dafny only.** Primary backend, easiest for LLM-assisted proving, matches nearly all recent case studies. |
| Verified scope | **Permissions + Transcript well-formedness + Hook/config merge.** (`edit_file` faithful-splice is a documented stretch goal, §6.) |

---

## 3. The verified cores

Each core follows the `todo-domain.ts` shape: types + discriminated unions, a pure
decision/reducer function, helper functions with `//@ requires/ensures/invariant`,
and a `//@ backend dafny` header. Payloads that don't affect a proof (tool `args`,
result `content`) are kept as opaque `string`.

### 3.1 `permissions.ts` — the access decision (security headline)

Henri's `PermissionManager.check()` mixes a pure decision with mutable session state
and interactive prompting. We split out the **pure decision**:

```ts
type Outcome = 'Allow' | 'Deny' | 'Prompt'

interface PermState {
  autoAllow:           Set<string>            // tools always allowed
  autoAllowCwd:        Set<string>            // path-tools auto-allowed within cwd
  pathBased:           Set<string>            // tools whose grants are per-path
  allowedTools:        Set<string>            // session "always allow tool"
  allowedBashCommands: Set<string>            // session "always allow this command"
  allowedPaths:        Map<string, Set<string>> // tool -> allowed path-keys
  allowAll:            boolean
  rejectPrompts:       boolean
}

type Req =
  | { kind: 'Bash';  command: string }
  | { kind: 'Path';  tool: string; segs: string[] }  // path as normalized segments
  | { kind: 'Other'; tool: string }

// requiresPermission folded in by the caller; decide() is the pure gate.
export function decide(st: PermState, cwd: string[], req: Req): Outcome
```

`decide` mirrors `check()` branch-for-branch (auto-allow → allow-all → exact bash
match → per-path grant → auto-allow-in-cwd → allowed-tool → reject/prompt).

**Paths are modeled as already-split, normalized segment arrays.** Normalization
(`.`/`..` resolution) is done *inside* the verified core over `string[]`, so the
only thing the shell is trusted to do is `path.resolve(p).split('/')`. This sidesteps
string-parsing limits and makes the traversal proof self-contained.

**Properties to prove:**

- **P1 — Soundness / no unjustified allow.** Define `justified(st, cwd, req)` as the
  disjunction of the legitimate grant reasons. Then `decide(st,cwd,req) == 'Allow'
  ⟹ justified(st,cwd,req)`. The gate never opens without a recorded reason.
- **P2 — Path-traversal containment** *(headline).* With `normalize`/`isWithin` over
  segments: a path that escapes cwd is never auto-granted —
  `!isWithin(cwd, normalize(segs)) ⟹ decide` does not return `Allow` via the
  auto-allow-cwd branch. Covers `../`, `./`, and `a/../../b` style escapes. This is
  the hono/rallly directory-traversal CVE flavor, proven structurally.
- **P3 — Grant monotonicity.** Adding any grant (a tool, a bash command, a path, or
  `allowAll`) can only turn `Deny`/`Prompt` into `Allow`, never the reverse:
  `decide(st) == 'Allow' ⟹ decide(grant(st, …)) == 'Allow'`.
- **P4 — `rejectPrompts` is deny-only.** Setting `rejectPrompts` only ever rewrites
  `Prompt → Deny`; it never produces a new `Allow`. So automation/bench mode cannot
  escalate beyond what was pre-authorized.

### 3.2 `transcript.ts` — tool-call/result protocol (agent-native headline)

Henri's chat loop must keep the conversation it sends to the provider well-formed:
every `tool_use` is answered by exactly one `tool_result` with the matching id, in
order — the Anthropic API requirement, and the exact concern of the
[pi-lemmascript](../LemmaScript/README.md) orphaned-tool-result work, but proven here
as an **invariant of the agent loop itself.**

```ts
interface ToolCall   { id: string; name: string /* args: opaque */ }
interface ToolResult { toolCallId: string; isError: boolean /* content: opaque */ }

type Msg =
  | { role: 'user' }
  | { role: 'assistant'; toolCalls: ToolCall[] }
  | { role: 'tool';      toolResults: ToolResult[] }

export function wellFormed(msgs: Msg[]): boolean
// the body of henri's per-call loop, as a pure reducer:
export function runToolCalls(calls: ToolCall[]): ToolResult[]
```

`runToolCalls` models henri's per-call dispatch: each call yields *exactly one*
result (unknown-tool error, permission-denied, missing-args error, or success) — all
paths preserve the id. The proof obligation:

- **T1 — Pairing.** `runToolCalls(calls).length == calls.length` and
  `∀ i. runToolCalls(calls)[i].toolCallId == calls[i].id`.
- **T2 — No orphans, invariant preserved.** Appending `{role:'tool', toolResults:
  runToolCalls(calls)}` to a well-formed transcript ending in `{assistant, calls}`
  yields a well-formed transcript. Corollary: every `tool_result` id matches a call
  in the immediately-preceding assistant message, and every call is answered.

### 3.3 `hooks.ts` — config / hook merge

Henri builds its tool list and permission tables by merging hooks:
`tools = defaults + Σ hook.TOOLS`, filtered by the union of `REMOVE_TOOLS`; permission
sets are unioned; `reject_prompts` is OR-ed.

```ts
export function mergeTools(defaults: Tool[], hookTools: Tool[][], removes: Set<string>): Tool[]
export function mergePerms(base: PermState, hooks: HookPerms[]): PermState
```

**Properties to prove:**

- **H1 — Removal correctness.** No tool whose name is in `removes` survives the merge.
- **H2 — Name-uniqueness** *(a fix henri lacks).* Henri concatenates `hook.TOOLS`
  without de-duping names — two hooks can register the same tool name. We make
  `mergeTools` dedup and prove `∀ i≠j. result[i].name != result[j].name`. Verification
  surfaces and closes a latent henri bug.
- **H3 — Order independence.** `mergePerms` is the union of all inputs and OR of the
  flags, so hook order does not affect the result (commutative/associative) — the
  casbin/quorum order-independence flavor.
- **H4 — Additivity (links to §3.1).** Merging hooks only *grows* the allow-sets, so
  by **P3** it never reduces what `decide` permits. Hooks are purely additive to
  access. (A clean cross-core theorem.)

---

## 4. The trust boundary (what we do NOT verify)

Explicitly outside the verified core, and why it's acceptable:

- **Path resolution.** The shell calls `path.resolve(p).split('/')`; we trust it
  produces the segments our `normalize`/`isWithin` reason over. (Normalization logic
  itself is verified.) Symlink resolution is a runtime concern, not modeled.
- **Provider streaming, terminal UI, subprocess execution, network** — entirely
  unverified TypeScript.
- **Tool `args` and result `content`** — opaque strings to the proofs; pairing and
  access decisions never inspect them.
- **Numbers** — mathematical integers (LemmaScript's default); no overflow modeling
  (henri's only numbers are token counts / turn limits).

---

## 5. Runnable shell — file layout

```
henri-lemmascript/
├── DESIGN.md
├── package.json            # lemmascript + tsx/tsc + provider SDK deps
├── src/
│   ├── permissions.ts      # VERIFIED  (+ permissions.dfy.gen / .dfy)
│   ├── transcript.ts       # VERIFIED  (+ transcript.dfy.gen / .dfy)
│   ├── hooks.ts            # VERIFIED  (+ hooks.dfy.gen / .dfy)
│   ├── messages.ts         # shared types (Msg, ToolCall, ToolResult)
│   ├── agent.ts            # stream loop; gates via decide(), threads via runToolCalls()
│   ├── cli.ts              # entry point, arg parsing, provider selection
│   ├── tools/              # bash/read/write/edit/grep/glob/webfetch (effectful)
│   └── providers/          # base.ts (Provider iface) + anthropic.ts + bedrock.ts
└── (Dafny artifacts generated next to each verified .ts)
```

**Provider scope:** the agent supports multiple providers behind one `Provider`
interface (`stream()` → events), as in henri. Ship **Anthropic and Bedrock** as
working backends from the start; structure `providers/` so google/vertex/ollama/
openai-compatible can follow. Providers are unverified shell — they sit outside the
trust boundary — but the agent must run against either of the two without code
changes (selected by `--provider`).

---

## 6. Sequencing

- **Phase 0 — Runnable skeleton.** TS port that runs: `cli` + `Provider` interface
  with **Anthropic and Bedrock** backends + tools + *unverified*
  permissions/transcript/hooks. Proves "it's a real agent" against both providers.
- **Phase 1 — Verify `permissions.ts`** (P1–P4). The security headline.
- **Phase 2 — Verify `transcript.ts`** (T1–T2). The no-orphan loop invariant.
- **Phase 3 — Verify `hooks.ts`** (H1–H4), including the dedup fix and the §3.4 link.
- **Phase 4 — Stretch: `edit_file` faithful-splice.** The uniqueness logic
  (`count==0` error, `count>1 && !replaceAll` error, else splice) as a string
  algorithm, in the spirit of balanced-match. Out of initial scope.

Each phase: `lsc gen --backend=dafny src/<mod>.ts` → complete proofs in `<mod>.dfy` →
`lsc check`. The `.ts` remains the production code the shell runs.

---

## 7. Why this is a good LemmaScript case study

- **Security-relevant, self-contained headline** (P2 path traversal) in the same
  family as the hono/rallly CVE work, but on an *agent's* permission gate.
- **An agent-native property** (T2 no-orphan tool-result invariant) — verifying the
  loop that drives the LLM, not just a leaf utility.
- **A real bug surfaced** (H2 duplicate tool names) — verification earning its keep,
  like the rallly score-overflow finding.
- **Cross-core composition** (H4 ⇒ P3) — the merge's additivity composed with the
  gate's monotonicity, a small but genuine multi-module theorem.
```

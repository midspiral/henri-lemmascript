# henri-lemmascript — Design

**Status:** implemented (Phases 0–5); optional GVE mode documented separately
**Date:** 2026-05-25 · **Updated:** 2026-09-05

A port of [henri](https://github.com/metareflection/henri/) — a small, hackable agent CLI — to TypeScript, with its
correctness- and security-critical decision logic verified via [LemmaScript](https://github.com/midspiral/LemmaScript)
(Dafny backend).

---

## 1. The rethink

Henri is ~2000 lines of Python, but most of it is *effectful glue*: async streaming,
Rich terminal UI, `subprocess`, network I/O, provider SDKs. None of that lives in
LemmaScript's verifiable fragment (no `this`/classes, no `async`, no closures over
mutable state, no I/O).

So this is **not a line-by-line port.** It is a re-architecture around the
`domain.ts` pattern the LemmaScript case studies use (talktimer, quorum, collab-todo):

> Extract henri's *decision logic* and loop transitions into a pure, verified core.
> Leave the I/O shell as an explicit, unverified trust boundary. The verified `.ts`
> is imported directly by the live agent.

```
┌───────────────────────────────────────────────────────────┐
│  Unverified shell (full TypeScript, runs the agent)       │
│    cli.ts · agent.ts (command interpreter) · providers/*  │
│    tools/* · terminal UI · subprocess · network           │
│                                                           │
│    ┌─────────────────────────────────────────────────┐    │
│    │  Verified core (//@ annotations + Dafny proofs) │    │
│    │    session.ts       — agent-loop transitions    │    │
│    │    permissions.ts   — the access decision       │    │
│    │    transcript.ts    — tool-call/result protocol │    │
│    │    hooks.ts         — config/hook merge         │    │
│    │    edit.ts          — edit-file splice          │    │
│    └─────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────┘
```

The shell feeds events to the verified `session.step` and interprets the commands it
gets back. The transition system composes `decide()`, the grant builders, transcript
builders, and compaction logic; the shell builds tool/config tables through the merge
functions and performs the requested effects. The optional GVE loop and its additional
verified reference-order core are documented in [DESIGN_GVE.md](DESIGN_GVE.md).

---

## 2. Decisions (settled)

| Question | Choice |
|----------|--------|
| Deliverable | **Runnable agent + verified core.** A working TS CLI whose live shell imports the verified modules (collab-todo / talktimer model). |
| Backend | **Dafny only.** Primary backend, easiest for LLM-assisted proving, matches nearly all recent case studies. |
| Verified scope | **Permissions + transcript well-formedness/compaction + hook/config merge + edit-file splice + the ReAct session transition system.** Optional GVE reference ordering is covered separately. |

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

interface PathGrant { tool: string; segs: string[] }

interface PermState {
  autoAllow:           Set<string>   // tools always allowed
  autoAllowCwd:        Set<string>   // path-tools auto-allowed within cwd
  allowedTools:        Set<string>   // session "always allow tool"
  allowedBashCommands: Set<string>   // session "always allow this command"
  allowedPaths:        PathGrant[]   // exact normalized (tool, path) grants
  allowAll:            boolean
  rejectPrompts:       boolean
}

type Req =
  | { kind: 'bash';  command: string }
  | { kind: 'path';  tool: string; segs: string[]; absolute: boolean }
  | { kind: 'other'; tool: string }

// requiresPermission folded in by the caller; decide() is the pure gate.
export function decide(st: PermState, cwd: string[], req: Req): Outcome
```

`decide` returns `Allow` exactly when `isAllowed` finds a recorded justification;
otherwise it returns `Deny` in automation mode or `Prompt` interactively.

**Paths are modeled as already-split, normalized segment arrays.** Normalization
(`.`/`..` resolution) is done *inside* the verified core over `string[]`, so the
only thing the shell is trusted to do is resolve a target to real absolute segments
(`fs.realpath` on the existing prefix, then `.split('/')`, plus folding `glob`'s
pattern onto the base). This sidesteps string-parsing limits and makes the traversal
proof self-contained.

**Properties proved:**

- **P1 — Exact verdict / no unjustified allow.** `decide(st,cwd,req) == 'Allow'`
  **iff** `isAllowed(st,cwd,req)`. The gate neither invents nor ignores a recorded
  justification.
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
- **G1/G2 — Grant discipline.** `grantFor`/`grantAll` justify the approved request,
  preserve existing allowances, and are the only permission-state builders used by
  the session transition.

### 3.2 `transcript.ts` — tool-call/result protocol (agent-native headline)

Henri's chat loop must keep the conversation it sends to the provider well-formed:
every `tool_use` is answered by exactly one `tool_result` with the matching id, in
order — the Anthropic API requirement, and the exact concern of the
[pi-lemmascript](https://github.com/midspiral/pi-lemmascript) orphaned-tool-result work, but proven here
as an **invariant of the agent loop itself.**

```ts
interface ToolCall   { id: string; name: string /* args: opaque */ }
interface ToolResult { toolCallId: string; isError: boolean /* content: opaque */ }

type Msg =
  | { role: 'user' }
  | { role: 'assistant'; toolCalls: ToolCall[] }
  | { role: 'tool';      toolResults: ToolResult[] }

export function wellFormed(msgs: Msg[]): boolean
export function appendAnsweredBlock(msgs: Msg[], calls: ToolCall[], results: ToolResult[]): Msg[]
export function findCut(msgs: Msg[], keepRecent: number): number
export function compact(msgs: Msg[], cut: number): Msg[]
```

The session's `startResults` / `pushResult` / `fillRest` builders accumulate one
result per call in batch order, including denials, errors, and interrupted remainders.
The verified obligations are:

- **T1/T2 — Pairing and append preservation.** A completed batch has exactly one
  result per call, id-matched and ordered; appending it preserves `wellFormed`.
- **C1 — Safe compaction.** `findCut` never leaves a suffix beginning with an orphaned
  tool result, and `compact` preserves `wellFormed`.
- **C2/C3 — Non-growth and convergence.** Compaction never grows history, and once
  history fits the keep budget the cut is zero, so automatic compaction becomes a no-op.

### 3.3 `hooks.ts` — config / hook merge (verified in place)

Henri builds its tool list and permission tables by merging hooks:
`tools = defaults + Σ hook.TOOLS`, with removed names dropped; permission sets are
unioned; `reject_prompts` is OR-ed.

The real `Tool` carries a function-valued `execute` (outside the fragment). Rather
than verify a parallel string model (which would reintroduce the very semantic gap
LemmaScript exists to avoid, §2), `//@ declare-type Tool { name: string }` shadows
`Tool` for the prover — modeling it by the only field the merge reasons about —
while the runtime uses the real `Tool` unchanged. So the **actual** `mergeTools`
is verified, with no gap. `mergePerms`/`mergeSystemPrompt` build `Set`s/strings
outside the fragment, so they stay shell (selective `//@ verify`) as thin wrappers
over the verified `gather`.

```ts
//@ declare-type Tool { name: string }
export function mergeTools(defaults: Tool[], hooks: Hook[]): Tool[] // verified: H1/H2/coverage over the real Tool[]
export function gather(base: string[], parts: string[][]): string[] // verified: H3/H4 (used by mergePerms)
```

**Properties proved:**

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
  access. Both halves are formal: `hooks.dfy:H4_GatherGrows` (gather grows the base)
  and `permissions.dfy:P3_GrowAutoSetsMonotone` (growing auto-allow preserves Allow).

### 3.4 `edit.ts` — the edit-file splice (string algorithm)

Henri's `edit_file` finds `old` in a file and replaces it: not-found errors,
more-than-one-without-`replace_all` errors, otherwise splice. We verify the
**decision** and the **single-occurrence splice**. Strings are char sequences
(`string[]`), the shell projecting `string <-> string[]` via `[...s]` / `join("")`
(trusted, like the §3.1 path projection); the `replace_all` join stays shell.

```ts
export function editFile(content: string[], old: string[], all: boolean): Edit
//                       NotFound | Ambiguous | Replaced — the verdict (E1)
export function replaceFirst(hay: string[], old: string[], repl: string[]): string[]
//                       the single splice (E2/E3 faithfulness)
```

**Properties proved:**

- **E1 — Decision soundness.** The verdict matches the occurrence count branch for
  branch: `NotFound ⟺ ¬occurs`, `Ambiguous ⟺ manyOcc ∧ ¬all`, `Replaced ⟺ occurs ∧
  (¬manyOcc ∨ all)`. Auto-discharged from `editFile`'s definition.
- **E2 — Identity.** Replacing text that does not occur leaves the content unchanged.
- **E3 — Splice no-op** *(faithfulness).* `replaceFirst(hay, old, old) == hay` — the
  splice touches exactly the matched span and preserves everything else. Rests on
  `MatchSplit`: `matchesAt(hay, old) ⟹ old + dropMatch(hay, old) == hay` (the matched
  prefix is *exactly* `old`). Plus a length law (`|repl| − |old|`).

**Design note.** The prover-facing recursive equations advance one character
(`occurs`, `afterFirst`, `replaceFirst`) or shrink `old` (`matchesAt`, `dropMatch`),
so well-formedness and termination are structural. The production TypeScript uses
index-based loops emitted as Dafny `function by method` implementations and proved
equivalent to those specifications; this avoids the original runtime recursion's
stack overflow and quadratic slicing.

### 3.5 `session.ts` — the ReAct loop as a transition system

The live loop is a pure `step(state, event) → { state, commands }`. Its state carries
the abstract transcript, permission grants, phase, batch cursor, and turn/compaction
budgets. Events cover user input, provider replies, tool results, prompt answers,
interrupts, and completed summaries. Commands tell the shell to call the provider,
execute or skip a tool, ask the user, or summarize at a chosen cut.

The session proof composes the earlier cores into an agent-wide invariant:

- **S1 mediation:** every emitted `execTool` is exempt, justified by policy/grant,
  or approved by the user for that exact current call.
- **S2 / T∞ reachability:** the transcript/batch invariant survives every event, so
  every state reachable from `initialSession` by any event sequence satisfies it.
- **S3–S7 outbound and permission discipline:** provider calls are well-formed and
  within budget; compaction cuts are safe; only prompt answers can change grants;
  prompts are necessary; reject mode never asks.
- **S8–S13 progress and bounds:** effectful commands are serialized, correspond to
  the batch cursor, batches terminate, configuration is stable, and transcript growth
  is bounded.

`agent.ts` therefore contains effect interpretation, not an independent gate, pairing
algorithm, grant state machine, or compaction policy. It keeps the concrete transcript
contents as a shell mirror and checks their projection against the verified model before
every provider call.

---

## 4. The trust boundary (what we do NOT verify)

Explicitly outside the verified core, and why it's acceptable:

- **Path resolution.** The shell (`permission-gate.ts: buildReq`) resolves a path
  tool's target to real absolute segments — `fs.realpath` on the existing prefix, then
  `.split('/')` — and folds `glob`'s traversal-bearing pattern onto the base; we trust
  those produce the segments our `normalize`/`isWithin` reason over. (Normalization and
  containment are verified.) Symlink resolution is now done here (realpath) rather than
  ignored, because `read_file` follows symlinks; realpath is the trusted OS call, the
  containment decision over its result is the verified `isWithin`.
- **Provider streaming, terminal UI, subprocess execution, network** — entirely
  unverified TypeScript.
- **The command interpreter.** `agent.ts` is trusted to perform exactly the commands
  emitted by `session.step`, feed back honest events, and keep result contents aligned
  with the verified batch order.
- **Prompt UI.** `permission-gate.ts` renders the question and parses y/n/a/A. Grant
  mutation and the consequence of each answer live in the verified transition.
- **Call and transcript projections.** The shell projects each concrete tool call to
  an `SCall` (`Req`, `known`, `noPerm`, `argsOk`) and concrete messages to `TMsg`.
  `checkMirror` compares the transcript projection to the core state before every
  provider call, but projection faithfulness remains trusted.
- **Tool `args` and result `content`** — opaque to the proofs; pairing and access
  decisions inspect only their projected structure.
- **Edit string projection.** File content is projected to character arrays with
  `[...s]` / `join("")`; the `replace_all` join remains shell.
- **Numbers** — mathematical integers (LemmaScript's default); no overflow modeling
  (henri's only numbers are token counts / turn limits).

---

## 5. Runnable shell — file layout

```
henri-lemmascript/
├── DESIGN.md
├── DESIGN_GVE.md           # optional generate-verify-execute mode
├── LemmaScript-files.txt   # all six local verification targets
├── package.json            # CLI, test, typecheck, and verification scripts
├── tsconfig.json
├── src/
│   ├── permissions.ts      # VERIFIED core: decide / normalize / isWithin  (Phase 1)
│   ├── transcript.ts       # VERIFIED core: protocol builders + compaction (Phase 2)
│   ├── hooks.ts            # VERIFIED core: mergeTools / gather (declare-type Tool) (Phase 3)
│   ├── edit.ts             # VERIFIED core: editFile decision + replaceFirst splice (Phase 4)
│   ├── session.ts          # VERIFIED core: ReAct transition system (Phase 5)
│   ├── gve/                # optional plan mode; exec_core.ts is VERIFIED
│   ├── messages.ts         # runtime conversation types (Message, ToolCall, ToolResult)
│   ├── permission-gate.ts  # SHELL: Req projection + y/n/a/A prompt UI
│   ├── agent.ts            # SHELL: command interpreter + concrete transcript mirror
│   ├── ui.ts               # SHELL: ANSI colors, panel, spinner
│   ├── cli.ts              # SHELL: entry point, arg parsing, provider selection
│   ├── config.ts           # provider defaults + HENRI_* resolution
│   ├── tools/base.ts       # SHELL: bash/read/write/edit/grep/glob/web_fetch (effectful)
│   └── providers/          # SHELL: Anthropic + Bedrock + Ollama
├── test/smoke.ts           # leaf-core runtime witnesses
├── test/session-smoke.ts   # transition + real-interpreter scripted witnesses
├── test/permission-escape.ts
├── test/gve*.ts            # optional plan-mode witnesses and deterministic demo
└── src/**/*.dfy{,.gen}     # committed proofs + regeneratable merge bases
```

**Fragment-boundary tactics used.** LemmaScript doesn't model function-valued
fields or cross-file type imports, but it provides escape hatches rather than
forcing a parallel model:
- `transcript.ts` defines standalone `TToolCall`/`TToolResult`, projected from the
  runtime `messages.ts` types via `toTranscript` in the shell; `session.ts` owns the
  modeled transcript and the shell checks its concrete mirror against it.
- `hooks.ts` uses `//@ declare-type Tool { name: string }` to shadow the real
  `Tool` (which carries a function-valued `execute`) by the one field the merge
  reasons about — so the *actual* `mergeTools` is verified, no parallel model.
- `//@ verify` (selective mode) verifies the in-fragment merge functions while
  leaving `Set`-building wrappers (`mergePerms`) as shell.
- Cross-file calls auto-extern as `function {:axiom}` with lifted contracts;
  `session.ts` uses those contracts to compose the permission and transcript proofs
  without unfolding their implementations.

**Provider scope:** the agent supports multiple providers behind one `Provider`
interface (`stream()` → events), as in henri. **Anthropic, Bedrock, and Ollama** are
implemented. Providers are unverified shell, selected by `--provider`; the verified
session transition is provider-independent.

---

## 6. Sequencing

- **Phase 0 — Runnable skeleton.** ✅ *Done.* TS port that runs: `cli` + `Provider`
  interface with **Anthropic, Bedrock, and Ollama** backends plus the complete tool
  set and interactive UI.
- **Phase 1 — Verify `permissions.ts`.** ✅ *Done: 25 VCs.* P1–P4 prove the exact
  allow condition, traversal containment, grant monotonicity, and reject-mode safety;
  G1–G2 prove the grant builders justify the approved request without revoking prior
  access. Runtime path projection is realpath- and glob-pattern-aware.
- **Phase 2 — Verify `transcript.ts`.** ✅ *Done: 52 VCs.* T1/T2 prove paired tool
  results and append preservation; C1–C3 prove compaction cut safety, non-growth,
  and convergence. Session builders preserve well-formedness through normal,
  interrupted, and partially completed batches.
- **Phase 3 — Verify `hooks.ts`** (H1–H4), incl. the dedup fix and the P3 link.
  ✅ *Done: 26 VCs.* The real `mergeTools(Tool[])` is verified in place through
  `//@ declare-type`; removal, name uniqueness, coverage, order-independent gather,
  and additive permission composition are proven.
- **Phase 4 — Verify `edit.ts`.** ✅ *Done: 24 VCs.* E1–E3 prove the edit verdict,
  identity cases, single-splice faithfulness, and length law. The production loops
  are proved equivalent to recursive specs, avoiding the stack overflow and quadratic
  slicing behavior of the original runtime recursion.
- **Phase 5 — Verify `session.ts`.** ✅ *Done: 97 VCs.* The ReAct loop is the pure
  transition system described in §3.5. S1–S13 cover mediation, invariant preservation,
  provider/compaction safety, grant and prompt discipline, command/cursor discipline,
  batch progress, and state bounds; T∞ lifts the invariant over every event trace.

The optional GVE mode adds a sixth local target, `gve/exec_core.ts` (**10 VCs**),
which fixes and proves the in-order symbolic-reference check. Its imported guardians
policy proof and staged design live in [DESIGN_GVE.md](DESIGN_GVE.md).

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
- **Whole-loop composition** (S1–S13 / T∞) — the provider is an adversarial event
  source, yet every reachable session preserves the protocol invariant and no emitted
  tool execution lacks a justification.

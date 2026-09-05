# henri-lemmascript — what LemmaScript proves

[![LemmaScript verified](https://img.shields.io/github/actions/workflow/status/midspiral/henri-lemmascript/lemmascript.yml?branch=main&label=LemmaScript%20verified)](https://github.com/midspiral/henri-lemmascript/actions/workflows/lemmascript.yml)

A hackable agent CLI (a TypeScript port of [henri](https://github.com/metareflection/henri/)) whose security- and
protocol-critical decision logic is **verified with [LemmaScript](https://github.com/midspiral/LemmaScript)
(Dafny backend)** and imported directly by the live, runnable agent — it streams
against Anthropic, AWS Bedrock, and Ollama end to end. The proven functions are not a
side model: the agent loop itself is the verified `step` of `session.ts` (§6),
`decide()` gates every tool call inside it, and `editFile`/`replaceFirst` back
the edit tool.

**234 Dafny verification conditions, 0 errors** — permissions 25, transcript 52,
hooks 26, edit 24, GVE `exec_core` 10, session 97. Reproduce with
`npm run verify` (regenerates each `.dfy.gen` merge base, enforces additions-only
against the proof `.dfy`, runs Dafny); CI in
[`.github/workflows/lemmascript.yml`](.github/workflows/lemmascript.yml).

The bulk of henri — provider SDKs, streaming, terminal UI, `subprocess`, filesystem,
network, and the interactive permission prompt UI — is the **unverified shell**. It is
not a parallel model of the verified core; it *interprets* it: the shell performs the
commands the verified session core emits and feeds back events. There is no erasure
and no semantic gap: the annotated `.ts` is the production code the agent runs.

---

## 1. `permissions.ts` — the access decision (25 VCs)

The pure gate `decide(st, cwd, req): Outcome` (`Allow`/`Deny`/`Prompt`), mirroring
henri's `PermissionManager.check()`. Paths are modeled as **normalized segment
sequences** — `.`/`..` resolution (`normalizeFrom`) is verified in-core, so the shell
projection (`permission-gate.ts: buildReq`) is trusted only to resolve a call's target
to real absolute segments: `fs.realpath` on the existing prefix (symlink-faithful), then
`.split('/')`. Two escapes that lived in that projection are now closed there — a
`glob` whose **pattern** (not path) carries `../`, and a **symlink** inside cwd pointing
out — with the in-core mechanism witnessed by `GlobPatternEscapeWitness` /
`SymlinkSiblingWitness` and pinned by `test/permission-escape.ts`.

| Property | Lemma | Statement |
|----------|-------|-----------|
| **P1 soundness** | `decide_ensures` | `decide(…).Allow? ⟺ isAllowed(…)` — the gate opens *iff* a recorded justification exists; no other path to Allow. |
| **P2 containment** *(headline)* | `P2_AutoGrantImpliesWithin` | With no `allowAll`, no `autoAllow`, no explicit per-path grant: `decide(path…).Allow? ⟹ isWithin(cwd, resolvePath(…))`. Auto-allow-in-cwd can **never** reach outside cwd. |
| P2 dual | `P2_NoEscape` | A path that escapes cwd, with no other grant, is never `Allow`. |
| P2 witness | `P2_EscapeWitness` | Concrete: `../../x` from cwd `a/b` resolves to `["x"]`, which is not within `a/b`. |
| P2 glob witness | `GlobPatternEscapeWitness` | Folding a `../` **pattern** onto the base (`normalizeFrom([root,project], [.., x]) == [root, x]`) escapes cwd — so a `glob` whose pattern (not path) climbs out fails `isWithin` and cannot be auto-allowed. |
| P2 symlink witness | `SymlinkSiblingWitness` | Once resolved to its real location, a symlink to a sibling (`[root, secret]`) is not within cwd `[root, project]` — the in-core half of the realpath projection fix. |
| **P3 monotonicity** | `P3_GrantBashMonotone`, `P3_GrantPathMonotone`, `P3_AllowAllGrantsEverything`, `P3_GrowAutoSetsMonotone` | Adding any grant (exact command, per-path, allow-all, or growing the auto-allow sets) only turns `Deny`/`Prompt` into `Allow`, never the reverse. (`PathGrantedAppendMonotone` is the per-path induction.) |
| **P4 reject-safety** | `P4_RejectIsDenyOnly` | Enabling `rejectPrompts` preserves the Allow set exactly and never yields `Prompt` — automation/bench mode cannot escalate beyond what was pre-authorized. |
| **G1 grant justifies** | `grantFor_ensures`, `grantAll_ensures` | `isAllowed(grantFor(st, cwd, req), cwd, req)` — recording the interactive "(a)lways" (or "(A)ll") grant justifies exactly the request the user approved, and leaves `rejectPrompts` untouched. These are the ONLY PermState updates the session core performs. |
| **G2 grant never revokes** | `grantPreservesAllowed_ensures` | Anything justified before `grantFor` stays justified after — grants only ever widen access (composes with P3/P4). |

This is the hono/rallly directory-traversal CVE flavor, proven on an *agent's*
permission gate.

## 2. `transcript.ts` — the tool-call/result protocol (52 VCs)

The conversation the agent sends to a provider must satisfy the Anthropic API
rule: every `tool_use` is answered by exactly one `tool_result` with the matching
id, in order, and a tool message only follows an assistant-with-calls. This is the
[pi-lemmascript](https://github.com/midspiral/pi-lemmascript) "no orphaned tool_result" concern, proven here as an
**invariant of the loop itself**.

| Property | Lemma | Statement |
|----------|-------|-----------|
| **T1 pairing** | `makeResults_ensures` | `\|makeResults(calls)\| == \|calls\|` and `pairs(calls, makeResults(calls))` — one result per call, ids in order. |
| **T2 no-orphan** *(headline)* | `T2_AppendPreservesWellFormed` | `wellFormed(msgs) ∧ \|calls\| > 0 ⟹ wellFormed(msgs + [assistant(calls), tool(makeResults(calls))])`. Appending a tool-result block keeps the transcript well-formed: no orphan tool_result is ever sent, and no tool_use is left unanswered. |
| **C1 compaction cut** *(the drop side)* | `snapBack_ensures`, `findCut_ensures` | `findCut(msgs, keep)` returns an index that is either `\|msgs\|` or a non-tool message (`headOk`) — the kept suffix never *starts* on an orphan tool_result. |
| **C1 compaction well-formed** | `C1_CompactPreservesWellFormed` | `wellFormed(msgs) ∧ (c == \|msgs\| ∨ headOk(msgs[c])) ⟹ wellFormed([user] + msgs[c..])`. `/compact` (drop a prefix at a safe cut, prepend a `user` summary) keeps the transcript well-formed — the exact mirror of T2 on the *drop* side. |
| **C2 non-growing** | `C2_CompactNonGrowing`, `C2_CompactShrinks` | `1 ≤ c ⟹ \|[user] + msgs[c..]\| ≤ \|msgs\|` (and `2 ≤ c ⟹ <`). Compaction never grows the conversation — repeated compaction can't blow up history. |
| **C3 convergence** *(termination)* | `C3_CompactConverges` | `wellFormed(msgs) ∧ \|msgs\| ≤ keep ⟹ findCut(msgs, keep) == 0`. Once at most `keep` messages remain, the cut keeps everything — so the auto-compaction guard (`skip when findCut == 0`) provably fires and the loop converges to a fixpoint. |

T1/T2 are proven by induction over the recursive adjacency predicate
(`WfFromAppendPair`, `WfFromImpliesLastOk`); C1 by `WfFromSuffix` (a suffix of a
consistent sequence is consistent); C2/C3 are length/`findCut` arithmetic that pin
down auto-compaction termination.

The module also carries the **session builders** — the only operations the verified
session core (§6) constructs transcripts with, each with its preservation proven as
its contract: `initialMsgs` / `appendUserMsg` / `appendAssistantDone` keep
`wellFormed`; `appendAnsweredBlock` (the general tool block: any *paired* results,
denials and errors included) keeps `wellFormed`; and the batch accumulators
`startResults` / `pushResult` / `fillRest` maintain the mid-batch pairing invariant
`pairsTo` (results answer the first n calls, ids in order), with `pushResult`
yielding full `pairs` on the last call and `fillRest` (the interrupt path) closing
any remainder with paired error results (`PairsToSnoc`/`PairsToPairs` inductions).

## 3. `hooks.ts` — config / hook merge (26 VCs)

How henri assembles its tool table and permission config from a base plus hooks.
Verified **in place** via `//@ declare-type Tool { name: string }` (the real `Tool`
carries a function-valued `execute`, outside the fragment; the prover models it by
the field the merge reasons about) — so the *actual* `mergeTools(Tool[], Hook[])` is
the proof target, no parallel model. `mergePerms`/`mergeSystemPrompt` build `Set`s
outside the fragment and stay shell (selective `//@ verify`) over the verified `gather`.

| Property | Lemma | Statement |
|----------|-------|-----------|
| **H1 removal** | `H1_RemovedExcluded` | No removed tool name survives `mergeTools`. |
| **H2 uniqueness** *(a fix)* | `H2_DistinctNames` | Result tool names are distinct. Henri concatenated `hook.TOOLS` with **no** name dedup (two hooks could register the same name); `dedupTools` keeps the first occurrence and that uniqueness is proved. |
| coverage | `Coverage` | A kept (non-removed) tool's name is preserved in the result. |
| **H3 order-independence** | `H3_GatherMembership`, `H3_Commutes` | `gather` membership = `base ∪ contributions`, with no dependence on hook order (commutativity corollary). |
| **H4 additivity** | `H4_GatherGrows` ∘ `permissions.dfy:P3_GrowAutoSetsMonotone` | `gather` only grows the base set, and (cross-module) growing the auto-allow sets preserves `Allow` — so adding hooks can never *reduce* what `decide` permits. |

`H4` is a cross-module composition: the additivity half lives in `hooks.dfy`, the
monotonicity half in `permissions.dfy`.

## 4. `edit.ts` — the edit-file splice (24 VCs)

The pure core of the `edit_file` tool (`tools/base.ts`): find `old` in a file and
replace it — not-found is an error, more than one occurrence without `replace_all`
is an error, otherwise splice. The **decision** and the **single-occurrence
splice** are proved. Strings are modeled as char sequences (`string[]`); the shell
projects `string <-> string[]` via `[...s]` / `join("")` — a trusted boundary, like
the path projection in §1.

| Property | Lemma | Statement |
|----------|-------|-----------|
| **E1 soundness** | `editFile_ensures` | the verdict matches the occurrence count branch-for-branch: `NotFound ⟺ ¬occurs`, `Ambiguous ⟺ manyOcc ∧ ¬all`, `Replaced ⟺ occurs ∧ (¬manyOcc ∨ all)`. |
| **E2 identity** | `E2_NoMatchIdentity` | replacing text that does not occur leaves the content unchanged. |
| **E3 splice no-op** *(faithfulness)* | `E3_SpliceNoop` | replacing `old` with `old` is the identity — the splice touches exactly the matched span and preserves everything else. |
| length law | `E_Len` | a single splice changes the length by exactly `\|repl\| − \|old\|`. |

The faithfulness core is `MatchSplit`: `matchesAt(hay, old) ⟹ old + dropMatch(hay,
old) == hay` — the matched prefix is *exactly* `old`. Every recursion advances one
character (or shrinks `old`), so termination and in-bounds slicing are structural —
no overlap/length side-lemmas needed. The live tool calls `editFile` for the verdict
and `replaceFirst` for the single splice; the all-occurrence join stays shell.

**Executed as loops, specified as recursion.** The recursive equations above are
the Dafny *spec bodies*; what runs at runtime are index-based loops, proved
equivalent via `function by method` (sliding-suffix invariants like
`occurs(hay, old) == occurs(hay[p..], old)`, plus `MatchesAtLen` /
`ReplaceFirstAt` / `ReplaceFirstNone`). The original recursive forms overflowed
the JS stack on files past ~8KB — JS engines ship no tail calls, and the
`slice(1)` steps were quadratic besides — which differential testing
(`lsc difftest`) surfaced; the loop forms handle 10MB files in ~230ms with the
E1–E4 statements and proofs unchanged.

## 5. `gve/exec_core.ts` — in-order plan references (10 VCs)

The optional generate-verify-execute mode resolves symbolic values produced by earlier
plan steps. Its live validator projects each step to the names it reads and optionally
binds, then calls the verified `execOk(steps, [])`: every read must already be present in
the accumulated bindings. The projection and effectful executor remain trusted.

| Property | Lemma | Statement |
|----------|-------|-----------|
| **forward-reference gap** | `forwardRefGap_ensures` | The old `okAllBinds` check accepts a concrete plan whose first step reads `x` and whose second step binds `x`, while `execOk` rejects it. Checking against all eventual bindings is therefore too weak. |
| **fix is a strengthening** | `fixIsStrengthening_ensures` | `execOk(steps, []) ⟹ okAllBinds(steps)` — the in-order validator only removes plans with invalid reference order; it never admits a plan the old check rejected. |

This core fixes the validator/executor mismatch; the plan's information-flow policy is
checked by the separately verified `guardians` package. See
[TUTORIAL_GVE.md](TUTORIAL_GVE.md) for that boundary and the deterministic demo.

## 6. `session.ts` — the agent loop as a verified transition system (97 VCs)

The loop itself is a pure `step(st: Session, ev: SEvent): { st, cmds }`. The shell
(`agent.ts`) is a command interpreter: it performs the emitted `SCommand`s
(`callProvider` / `execTool` / `askUser` / `skipTool` / `summarize`) and feeds back
`SEvent`s (`userInput`, `providerReply`, `toolDone`, `promptAnswer`, interrupts,
`summaryReady`, …). Gating, grant recording, transcript appends, compaction cuts,
and interrupt handling are all verified transitions. The theorems quantify over
**all** events in **all** inv-states, so the provider (the LLM) is an adversary by
construction: nothing it can emit reaches an unjustified effect.

| Property | Lemma | Statement |
|----------|-------|-----------|
| **S1 mediation** *(headline)* | `stepMediation_ensures` | Every `execTool` command step ever emits is `justified`: the tool is exempt (`noPerm`), or `isAllowed` holds in the post-state (auto-allows, prior session grants, or the always/All grant recorded in the same transition — G1), or the user answered "yes" to *exactly this call*. There is no fourth path — prompt injection cannot trigger an ungated effect. |
| **S2 preservation** | `stepPreservesInv_ensures` | `inv` — transcript well-formedness + batch pairing (`pairsTo`) + compaction-cut safety — survives every event, including Esc mid-stream and mid-batch. With `initialSession`'s `ensures inv`, every reachable session state satisfies `inv` by induction over the trace. |
| **S3 provider calls** | `stepProviderCallSafe_ensures` | Whenever `callProvider` is emitted, the session awaits the provider, its transcript is well-formed (what T2 used to assert at runtime is now a theorem about the loop), and the turn budget was respected. |
| **S4 summarize** | `stepSummarizeSafe_ensures` | Whenever `summarize(cut)` is emitted, the cut is recorded in the phase, nontrivial, and a safe boundary of the transcript it will be applied to — composing with C1, the later `summaryReady` compaction provably preserves well-formedness. |
| **S5 grant discipline** | `stepPermsStable_ensures` | Only a `promptAnswer` event ever changes the permission state — and (by the step function's shape) only via the verified `grantFor`/`grantAll` builders. |
| **S6 prompt necessity** | `stepPromptNecessary_ensures` | The dual of S1: `askUser` is only emitted for a call that is neither exempt nor already allowed — no spurious prompts. |
| **S7 automation never blocks** | `stepRejectNeverAsks_ensures` | Under `rejectPrompts`, step NEVER emits `askUser` (via decide's `rejectPrompts ⟹ ¬Prompt`); with P4, automation can neither hang on a prompt nor escalate. |
| **S8 command discipline** | `stepCommandDiscipline_ensures` | Everything before the last command is a `skipTool` notification — at most one effectful command per step, and it is last. The interpreter's sequential dispatch relies on exactly this shape. |
| **S9 cursor correspondence** | `stepExecCursor_ensures`, `stepAskCursor_ensures` | An emitted `execTool` (resp. `askUser`) call IS the post-state batch's current call — the call the next `toolDone` (resp. `promptAnswer`) event answers. This is what makes the shell's id-keyed batch bookkeeping faithful. |
| **S10 batch progress** | `stepBatchProgress_ensures` | The batch measure (2·unanswered, +1 while a prompt pends) strictly decreases on every batch event — a batch of n calls provably completes within 2n+1 events; no livelock. |
| **S11 config stability** | `stepConfigStable_ensures` | cwd and every budget are session constants; the turn counter moves by at most one per step. |
| **S12 grant scope** | `stepGrantScope_ensures` | Sharpens S5: a prompt answer leaves permissions unchanged or makes them EXACTLY `grantFor`/`grantAll` of the prompted call's request — no other mutation exists. |
| **S13 bounded growth** | `stepMsgsBounded_ensures` | The transcript grows by at most the answered block (2 messages) per step, and applying a summary never grows it — C2 lifted to the session level. |
| **T∞ trace safety** *(capstone)* | `runSession_ensures`, `traceFromInitialSafe_ensures` | `inv(runSession(initialSession(…), events))` for ANY event sequence — every state reachable from the initial session, under any provider outputs, prompt answers, interrupts, and compactions, satisfies the invariant. S2's induction over traces, as a theorem rather than prose (`runSession` folds `stepTotal`, the no-op-outside-inv totalization of `step`). |

The proof composes per-transition lemmas (`AdvanceOk`, `FinishBatchOk`,
`RequestProviderOk`, `ApprovedCurrentOk`, `StartCompactOk`, …) into one `StepOk`
master lemma by case analysis over events. Cross-file contracts do the heavy
lifting: imported functions are opaque axioms carrying exactly the
`//@ requires`/`//@ ensures` proven in their home modules, so the session can only
build transcripts through §2's builders and only update permissions through §1's
grant builders. Per-call order (unknown → permission → arguments) is centralized
in `verdictFor`, whose `ensures` is the per-call half of S1.

---

## Trust boundary (what is *not* verified)

- **Providers, terminal UI, subprocess (`bash`), filesystem (`read/write/edit`),
  network (`web_fetch`)** — effectful shell.
- **The interpreter** (`agent.ts`): trusted to perform exactly the commands the
  session core emits, feed back honest events, and keep result *contents* aligned
  with the core's batch order. The decision logic it used to own is gone — it
  carries no gate, no pairing logic, no cut choice.
- **The prompt UI** (`permission-gate.ts`): renders the question and parses
  y/n/a/A; the consequence of each answer is a verified transition.
- **Boundary projections trusted to be faithful:** each tool call is projected to
  `SCall` (the `Req` via `buildReq`, plus `known`/`noPerm`/`argsOk` registry
  facts). `buildReq` resolves a path tool's target to real absolute segments —
  `fs.realpath` on the existing prefix (so a symlink inside cwd resolves to its true
  location) and, for `glob`, folds the traversal-bearing **pattern** onto the base —
  before the verified `decide` sees it; realpath itself is the trusted OS call, the
  containment decision over its result is the verified `isWithin` (`GlobPatternEscapeWitness`
  / `SymlinkSiblingWitness`). The shell mirror is projected to the `TMsg` model (`toTranscript`) and —
  new with the session core — **checked at runtime against the verified model
  transcript before every provider call** (`checkMirror`), so a drifted projection
  fails loudly instead of silently; file content/strings to char sequences via
  `[...s]` / `join("")` for `edit.ts`; and the real `Tool` flows at runtime while
  proofs reason about `Tool.name`.
- **GVE boundaries:** plan parsing, the `Step → EStep` read/bind projection, tool
  classification, and faithful effect sequencing remain trusted. The in-order reference
  verdict in `exec_core.ts` and the imported guardians policy verdict are verified.
- **Numbers** are mathematical integers (henri's only numbers are token/turn counts).

## Proof techniques of note

- Decision logic split into a pure `isAllowed` predicate + thin `decide`, so soundness
  (P1) is definitional and the relational lemmas (P2–P4) reason transparently.
- **Recursive definitions for the prover, loops for the runtime.** Spec-side
  functions stay loop-free recursion (the prover unfolds them in lemmas;
  `//@ decreases` where accumulator recursion needs it). Functions on hot runtime
  paths (`edit.ts`'s scan/splice family, `hooks.ts`'s `contains`) are `//@ pure`
  loops emitted as `function by method`: the recursion remains the Dafny spec
  body, and Dafny proves the loop computes it — necessary because JS has no tail
  calls, so data-dependent recursion depth overflowed the stack on ~8KB files.
- `//@ declare-type` / `//@ verify` to verify real production functions in place rather
  than a string-level model — keeping LemmaScript's no-gap guarantee.
- `lemma {:fuel normalizeFrom, 7, 8}` to force the concrete traversal witness to evaluate.

## Reproduce

```sh
npm run verify     # ../LemmaScript/tools/check.sh dafny over LemmaScript-files.txt — 234 VCs
npm run typecheck  # tsc --noEmit
npm test           # runtime witnesses for the verified properties
npm run test:gve   # deterministic witnesses for the optional plan mode
```

Verification requires a built sibling `../LemmaScript` checkout and Dafny ≥ 4.x.
The full typecheck/GVE test suite also requires `../guardians-lemmascript` on its
`generate-verify-execute` branch because package.json links it through `file:`.

# henri-lemmascript — what LemmaScript proves

A hackable agent CLI (a TypeScript port of [henri](https://github.com/metareflection/henri/)) whose security- and
protocol-critical decision logic is **verified with [LemmaScript](https://github.com/midspiral/LemmaScript)
(Dafny backend)** and imported directly by the live, runnable agent — it streams
against Anthropic and AWS Bedrock end to end. The proven functions are not a
side model: `decide()` gates every tool call, `pairs`/`wellFormed` are checked
on every turn of the real loop, and `editFile`/`replaceFirst` back the edit tool.

**60 Dafny verification conditions, 0 errors**, across four modules. Reproduce with
`npm run verify` (regenerates each `.dfy.gen` merge base, enforces additions-only
against the proof `.dfy`, runs Dafny); CI in
[`.github/workflows/lemmascript.yml`](.github/workflows/lemmascript.yml).

The bulk of henri — provider SDKs, streaming, terminal UI, `subprocess`, filesystem,
network, and the interactive permission prompting — is the **unverified shell**. It is
not a parallel model of the verified core; it *calls into* it. There is no erasure and
no semantic gap: the annotated `.ts` is the production code the agent runs.

---

## 1. `permissions.ts` — the access decision (14 VCs)

The pure gate `decide(st, cwd, req): Outcome` (`Allow`/`Deny`/`Prompt`), mirroring
henri's `PermissionManager.check()`. Paths are modeled as **normalized segment
sequences** — `.`/`..` resolution (`normalizeFrom`) is verified in-core, so the shell
is trusted only to `path.resolve(p).split('/')`.

| Property | Lemma | Statement |
|----------|-------|-----------|
| **P1 soundness** | `decide_ensures` | `decide(…).Allow? ⟺ isAllowed(…)` — the gate opens *iff* a recorded justification exists; no other path to Allow. |
| **P2 containment** *(headline)* | `P2_AutoGrantImpliesWithin` | With no `allowAll`, no `autoAllow`, no explicit per-path grant: `decide(path…).Allow? ⟹ isWithin(cwd, resolvePath(…))`. Auto-allow-in-cwd can **never** reach outside cwd. |
| P2 dual | `P2_NoEscape` | A path that escapes cwd, with no other grant, is never `Allow`. |
| P2 witness | `P2_EscapeWitness` | Concrete: `../../x` from cwd `a/b` resolves to `["x"]`, which is not within `a/b`. |
| **P3 monotonicity** | `P3_GrantBashMonotone`, `P3_GrantPathMonotone`, `P3_AllowAllGrantsEverything`, `P3_GrowAutoSetsMonotone` | Adding any grant (exact command, per-path, allow-all, or growing the auto-allow sets) only turns `Deny`/`Prompt` into `Allow`, never the reverse. (`PathGrantedAppendMonotone` is the per-path induction.) |
| **P4 reject-safety** | `P4_RejectIsDenyOnly` | Enabling `rejectPrompts` preserves the Allow set exactly and never yields `Prompt` — automation/bench mode cannot escalate beyond what was pre-authorized. |

This is the hono/rallly directory-traversal CVE flavor, proven on an *agent's*
permission gate.

## 2. `transcript.ts` — the tool-call/result protocol (10 VCs)

The conversation the agent sends to a provider must satisfy the Anthropic API
rule: every `tool_use` is answered by exactly one `tool_result` with the matching
id, in order, and a tool message only follows an assistant-with-calls. This is the
[pi-lemmascript](https://github.com/midspiral/pi-lemmascript) "no orphaned tool_result" concern, proven here as an
**invariant of the loop itself**.

| Property | Lemma | Statement |
|----------|-------|-----------|
| **T1 pairing** | `makeResults_ensures` | `\|makeResults(calls)\| == \|calls\|` and `pairs(calls, makeResults(calls))` — one result per call, ids in order. |
| **T2 no-orphan** *(headline)* | `T2_AppendPreservesWellFormed` | `wellFormed(msgs) ∧ \|calls\| > 0 ⟹ wellFormed(msgs + [assistant(calls), tool(makeResults(calls))])`. Appending a tool-result block keeps the transcript well-formed: no orphan tool_result is ever sent, and no tool_use is left unanswered. |

Proven by induction over the recursive adjacency predicate (`WfFromAppendPair`,
`WfFromImpliesLastOk`). The live `agent.ts` calls `pairs` and `wellFormed` as a
runtime assertion every turn — it throws before sending a malformed transcript.

## 3. `hooks.ts` — config / hook merge (24 VCs)

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

## 4. `edit.ts` — the edit-file splice (12 VCs)

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

---

## Trust boundary (what is *not* verified)

- **Providers, terminal UI, subprocess (`bash`), filesystem (`read/write/edit`),
  network (`web_fetch`)** — effectful shell.
- **Interactive permission prompting + session-grant mutation** (`permission-gate.ts`)
  — but every actual allow/deny flows through the verified `decide`.
- **Boundary projections trusted to be faithful:** the shell does
  `path.resolve().split('/')` (the in-core `normalize` does the rest); projects runtime
  messages to the `TMsg` model (`toTranscript`); projects file content/strings to char
  sequences via `[...s]` / `join("")` for `edit.ts` (the `replace_all` join stays shell);
  and the real `Tool` flows at runtime while proofs reason about `Tool.name`.
- **Numbers** are mathematical integers (henri's only numbers are token/turn counts).

## Proof techniques of note

- Decision logic split into a pure `isAllowed` predicate + thin `decide`, so soundness
  (P1) is definitional and the relational lemmas (P2–P4) reason transparently.
- Loop-free **recursive functions** throughout (Dafny `function`s can't loop), so the
  prover unfolds them in lemmas; `//@ decreases` where accumulator recursion needs it.
- `//@ declare-type` / `//@ verify` to verify real production functions in place rather
  than a string-level model — keeping LemmaScript's no-gap guarantee.
- `lemma {:fuel normalizeFrom, 7, 8}` to force the concrete traversal witness to evaluate.

## Reproduce

```sh
npm run verify     # ../LemmaScript/tools/check.sh dafny over LemmaScript-files.txt — 60 VCs
npm run typecheck  # tsc --noEmit
npm test           # runtime witnesses for the verified properties
```

Requires a sibling `../LemmaScript` checkout and Dafny ≥ 4.x.

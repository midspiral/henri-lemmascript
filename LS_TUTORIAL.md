# Verifying Henri: A Step-by-Step Tutorial

This tutorial walks through how **henri-lemmascript** verifies the security- and
protocol-critical core of an AI coding agent — and how the proven functions are
imported and called by the *live* agent, not kept as a side model.

It is the companion to the original
[**Henri tutorial**](https://github.com/metareflection/henri/blob/main/TUTORIAL.md),
which teaches the agent itself: the message types, the provider abstraction, the
tool system, the permission prompt, and the `while`-loop that ties them together.
**Read that first** — it explains *what* the agent does. This tutorial assumes it
and focuses on one question: *how do we make the parts that matter provably
correct?*

The headline: **234 Dafny verification conditions, 0 errors**, across six
verification targets — permissions 25, transcript 52, hooks 26, edit 24,
GVE reference ordering 10, and the session transition system 97. The annotated
TypeScript is the production code the agent runs.

Three facts are the reason this matters, and everything below builds toward
proving them:

- **No silent cwd escape.** With no explicit grant, a path that resolves outside
  the working directory is *never* auto-allowed — `../../secret` cannot slip
  through the gate (`permissions.ts`, lemma `P2_AutoGrantImpliesWithin`).
- **No malformed tool-result transcript.** Every turn the loop appends a
  tool-result block and the conversation stays well-formed — no orphaned
  `tool_result`, and no `tool_use` left unanswered, is ever sent to the provider
  (`transcript.ts`, lemma `T2_AppendPreservesWellFormed`).
- **No ungated effect under any provider behavior.** The provider is modeled as
  adversarial: for every event sequence, the verified session transition emits an
  `execTool` command only with a justification, while preserving its transcript and
  batch invariant (`session.ts`, `stepMediation` and `traceFromInitialSafe`).

## The Big Picture: a verified core inside an unverified shell

The original Henri is mostly *effectful glue* — streaming, terminal UI,
`subprocess`, network, provider SDKs. None of that lives in a verifiable
fragment. So henri-lemmascript is not a line-by-line port; it is re-architected
around a small **pure transition core** whose commands the shell interprets:

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
│    │    gve/exec_core.ts — plan reference ordering   │    │
│    └─────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────┘
```

**Key insight**: the original tutorial's lesson was *soundness is independent of
the LLM*. The verification lesson is the second half of that: the parts that
guard safety are also *independent of the provider*. The model can be adversarial:
`session.step` still emits only mediated commands and preserves the protocol
invariant. The effectful shell remains trusted to interpret those commands faithfully
and to project concrete calls and messages into the verified model; that boundary is
checked at runtime before every provider request.

What's deliberately **outside** the core (the trust boundary) gets its own
section near the end — and saying where verification *stops* is as important as
saying what it covers.

## Part 1: LemmaScript in five minutes

[LemmaScript](https://github.com/midspiral/LemmaScript) is a verification
toolchain for TypeScript. You write ordinary TS and add `//@ ` specification
comments; the toolchain extracts the annotated functions to **Dafny** (or Lean)
and proves them. The `.ts` stays runnable and is imported unchanged.

A verified file opts in with a header and annotates functions with contracts:

```typescript
//@ backend dafny

//@ requires arr.length > 0
//@ ensures \result >= -1 && \result < arr.length
//@ decreases arr.length - i
```

The directives used in this project:

| Directive | Meaning |
|-----------|---------|
| `//@ backend dafny` | this file is a verification target (whole-file mode) |
| `//@ requires` / `//@ ensures` | pre- and post-conditions on a function |
| `//@ invariant` / `//@ decreases` | loop/recursion invariants and termination measures |
| `//@ verify` | verify *this* function (selective mode — verify some, leave the rest as shell) |
| `//@ declare-type T { … }` | model a runtime type by only the fields a proof reasons about |

`\result` names the return value; `forall(k, …)` is bounded quantification. The
full surface is in [`../LemmaScript/SPEC.md`](../LemmaScript/SPEC.md).

### The two-file model

Per verified `foo.ts`, the Dafny backend produces two files:

- **`foo.dfy.gen`** — generated from the TS. Regeneratable; never edit it.
- **`foo.dfy`** — starts as a copy of `.dfy.gen`, then *you add* the proof
  scaffolding Dafny needs: helper lemmas, ghost predicates, nudging `assert`s.

`lsc check` enforces that the diff between them is **additions only** — so the
proofs can never silently contradict the generated code. The edit loop is
`gen → write proofs in .dfy → check`; see
[`../LemmaScript/GETTING_STARTED.md`](../LemmaScript/GETTING_STARTED.md).

**Key insight**: the contract (`//@ requires/ensures`) lives in the TS next to
the code; the *proof* lives in the `.dfy`. The function being proved is the real
one — there is no hand-written model to drift out of sync.

## Part 2: Core 1 — the access decision (`permissions.ts`)

The original tutorial's `PermissionManager` mixes three things: a pure decision,
mutable session state, and an interactive `y/n/a/A` prompt. Verification starts
by **splitting out the pure decision** so it can be reasoned about in isolation.

The decision is split again, into a *justification predicate* and a thin gate
over it:

```typescript
/** true exactly when the call has a recorded reason to be allowed. */
export function isAllowed(st: PermState, cwd: string[], req: Req): boolean {
  if (st.allowAll) return true;
  switch (req.kind) {
    case "bash":
      return st.autoAllow.has("bash") || st.allowedBashCommands.has(req.command);
    case "path": {
      if (st.autoAllow.has(req.tool)) return true;
      const resolved = resolvePath(cwd, req.segs, req.absolute);
      return pathGranted(st.allowedPaths, req.tool, resolved)
          || (st.autoAllowCwd.has(req.tool) && isWithin(cwd, resolved));
    }
    case "other":
      return st.autoAllow.has(req.tool) || st.allowedTools.has(req.tool);
  }
}

export function decide(st: PermState, cwd: string[], req: Req): Outcome {
  //@ ensures (\result === "Allow") === isAllowed(st, cwd, req)
  if (isAllowed(st, cwd, req)) return "Allow";
  if (st.rejectPrompts) return "Deny";
  return "Prompt";
}
```

That one `//@ ensures` line *is* the soundness contract: **the gate returns
`Allow` if and only if a justification exists.** There is no other path to
`Allow`. Dafny discharges it automatically (`decide_ensures`) because `decide` is
defined directly in terms of `isAllowed`.

### Paths are segments, normalization is in-core

Notice `req.segs: string[]` — paths are modeled as **already-split segment
arrays**, and `.`/`..` resolution is a verified recursive function:

```typescript
export function normalizeFrom(acc: string[], segs: string[]): string[] {
  //@ decreases segs.length
  if (segs.length === 0) return acc;
  const s = segs[0];
  const rest = segs.slice(1);
  if (s === "..") return normalizeFrom(acc.slice(0, acc.length > 0 ? acc.length - 1 : 0), rest);
  if (s === "" || s === ".") return normalizeFrom(acc, rest);
  return normalizeFrom([...acc, s], rest);
}
```

The shell's `buildReq` projection realpaths the deepest existing ancestor, preserves
any non-existent tail, folds a `glob` pattern onto its base, and splits the result into
segments. Everything that *decides containment* over those real segments is proven.
This makes an in-cwd symlink to an outside target, and a `../` carried by a glob
pattern, fail the same verified containment test as a lexical traversal.

### What gets proven (P1–P4, G1–G2)

| # | Property | In one line |
|---|----------|-------------|
| **P1** | soundness | `decide == Allow ⟺ isAllowed` — no unjustified allow |
| **P2** | **path-traversal containment** | with only auto-allow-in-cwd, an allowed path can never resolve outside cwd (`../`, `a/../../b`, …) |
| **P3** | grant monotonicity | adding any grant only turns `Deny`/`Prompt` into `Allow`, never the reverse |
| **P4** | reject-safety | `rejectPrompts` only rewrites `Prompt → Deny`; automation can't escalate |
| **G1** | grant justification | `grantFor`/`grantAll` make the approved request allowed |
| **G2** | grant preservation | recording a grant never revokes an existing allowance |

P1 is the auto-discharged `//@ ensures`; P2–P4 are lemmas you add in
`permissions.dfy` (full lemma names in
[`README_LemmaScript.md`](README_LemmaScript.md) §1). **P2 is a directory-
traversal CVE class (CWE-22) proven on an agent's permission gate.**

### How the live agent uses it

The ReAct loop's permission decision now lives inside the verified session core.
`verdictFor` calls `decide`; `onPromptAnswer` records "always" and "All" through
the verified `grantFor`/`grantAll` builders:

```typescript
export function verdictFor(st: Session, c: SCall): Verdict {
  if (!c.known) return "skipUnknown";
  if (c.noPerm || decide(st.perms, st.cwd, c.req) === "Allow") {
    return c.argsOk ? "exec" : "skipMissingArgs";
  }
  if (decide(st.perms, st.cwd, c.req) === "Deny") return "skipDenied";
  return "prompt";
}
```

`permission-gate.ts` is the shell projection and prompt UI: it turns a concrete
tool call into an `SCall`/`Req` and parses y/n/a/A. It makes no ReAct-loop decision
and records no ReAct-loop grant; the verified transition determines the consequence
of the answer. Its standalone `InteractiveGate` serves the optional GVE executor as
a runtime residual and uses the same verified decision and grant builders.

## Part 3: Core 2 — the tool-call/result protocol (`transcript.ts`)

The agent loop must keep the conversation it sends to the provider well-formed:
every `tool_use` is answered by exactly one `tool_result` with the matching id,
in order, and a `tool` message only ever follows an assistant that made calls.
Violate it and the provider API rejects the request (the "orphaned
`tool_result`" failure). Here it's proven as an **invariant of the loop itself**.

The protocol is a handful of recursive predicates over a projected message type:

```typescript
/** results pair 1:1 with calls, by id, in order. */
export function pairs(calls: TToolCall[], results: TToolResult[]): boolean {
  //@ decreases calls.length
  if (results.length !== calls.length) return false;
  if (calls.length === 0) return true;
  if (results[0].toolCallId !== calls[0].id) return false;
  return pairs(calls.slice(1), results.slice(1));
}

/** one result per call, id preserved — what the dispatch loop must produce. */
export function makeResults(calls: TToolCall[]): TToolResult[] {
  //@ decreases calls.length
  //@ ensures \result.length === calls.length
  //@ ensures pairs(calls, \result)
  if (calls.length === 0) return [];
  return [{ toolCallId: calls[0].id, isError: false }, ...makeResults(calls.slice(1))];
}
```

`wellFormed(msgs)` then checks head/adjacency/tail consistency via `okAdjacent`.

### What gets proven (T1–T2)

| # | Property | In one line |
|---|----------|-------------|
| **T1** | pairing | `makeResults(calls)` has one result per call, ids in order |
| **T2** | **no orphan, preserved** | appending `[assistant(calls), tool(makeResults(calls))]` to a well-formed transcript keeps it well-formed |
| **C1** | **compaction (the drop side)** | `findCut` never cuts onto a `tool` message, so `/compact` (drop a prefix, prepend a `user` summary) provably can't *create* a malformed transcript either |
| **C2/C3** | **auto-compaction terminates** | compaction never *grows* the conversation (C2), and `findCut` returns 0 once history fits in `keepRecent` (C3) — so the auto-compact loop converges to a no-op fixpoint instead of looping forever |

T2 is the one that matters: it's not "we checked the transcript afterward," it's
"the loop's append step provably can't *create* a malformed transcript." C1 is its
mirror image for `/compact`: pi-lemmascript verified that summarizing history never
splits a tool_use/tool_result run (`findCutPoint`/`findValidCutPoints`); here the
same guarantee falls out of the *same* `wellFormed` predicate — `findCut` snaps the
cut to a non-tool boundary (`snapBack_ensures`) and `C1_CompactPreservesWellFormed`
proves the summarized conversation stays well-formed. So the drop side reuses the
append side's invariant rather than re-deriving it. C2/C3 then close the loop on
*automatic* compaction: it can't blow up history and it provably stops (the
`findCut == 0` guard fires once the conversation is short enough).

### How the live agent uses it

The session transition can construct its modeled transcript only through the
verified builders (`appendUserMsg`, `appendAssistantDone`, `appendAnsweredBlock`,
and `compact`). The shell keeps the concrete message contents in a mirror. Before
every provider call it projects that mirror and checks it equals the core state:

```typescript
private checkMirror(): void {
  const projected = toTranscript(this.messages);
  if (!wellFormedModel(projected)) throw new Error("internal: mirror transcript malformed");
  if (JSON.stringify(projected) !== JSON.stringify(this.st.msgs)) {
    throw new Error("internal: shell mirror diverged from the verified model");
  }
}
```

**Key insight**: pairing, append safety, and compaction boundaries are decisions of
the verified transition system. `checkMirror` is a fail-loud check on the trusted
projection and interpreter, not the mechanism establishing the invariant.

## Part 4: Core 3 — the config/hook merge (`hooks.ts`)

The original tutorial's Part 8 builds the tool table and permission config by
merging hooks. henri-lemmascript verifies that merge — and verifying it
**surfaced a real bug**: the original concatenates `hook.TOOLS` with no name
de-duplication, so two hooks can register the same tool name.

The catch: the real `Tool` carries a function-valued `execute`, which isn't in
the verifiable fragment. Rather than verify a parallel string model (which would
reintroduce the very gap LemmaScript exists to close), we model `Tool` by *just
the field the merge reasons about*:

```typescript
//@ declare-type Tool { name: string }

/** Keep the first occurrence of each tool name, dropping removed names. */
export function dedupTools(acc: Tool[], tools: Tool[], removes: string[]): Tool[] {
  //@ verify
  //@ decreases tools.length
  if (tools.length === 0) return acc;
  const t = tools[0];
  const rest = tools.slice(1);
  if (contains(removes, t.name)) return dedupTools(acc, rest, removes);
  if (hasName(acc, t.name))      return dedupTools(acc, rest, removes);
  return dedupTools([...acc, t], rest, removes);
}
```

So the **actual** `mergeTools(Tool[], Hook[])` is the proof target — at runtime it
flows the real `Tool` with its `execute` unchanged. `//@ verify` (selective mode)
proves the in-fragment functions while `mergePerms`/`mergeSystemPrompt` — which
build `Set`s outside the fragment — stay shell as thin wrappers over the verified
`gather`.

### What gets proven (H1–H4)

| # | Property | In one line |
|---|----------|-------------|
| **H1** | removal | no removed name survives `mergeTools` |
| **H2** | **uniqueness (the fix)** | result tool names are distinct — `dedupTools` keeps the first |
| **H3** | order-independence | `gather` membership = `base ∪ contributions`, independent of hook order |
| **H4** | additivity | `gather` only *grows* the base — composed with P3, hooks never *reduce* what `decide` permits |

**Key insight**: H4 is a small but genuine *cross-module* theorem —
`hooks.dfy:H4_GatherGrows` (gather grows the base) composed with
`permissions.dfy:P3_GrowAutoSetsMonotone` (growing auto-allow preserves `Allow`).
Adding a hook can only widen access, provably.

## Part 5: Core 4 — the edit splice (`edit.ts`)

The `edit_file` tool finds `old` in a file and replaces it: not-found is an error,
more than one occurrence without `replace_all` is an error, otherwise it splices. We
verify the **decision** (which verdict) and the **single-occurrence splice**.

Like the path gate, strings are modeled as sequences — here arrays of single
characters (`string[]`) — and the shell projects `string <-> string[]` via `[...s]`
/ `join("")` (a trusted boundary, exactly like Part 2's `buildReq` projection).

The verdict mirrors the tool branch for branch:

```typescript
export function editFile(content: string[], old: string[], all: boolean): Edit {
  //@ requires old.length > 0
  //@ ensures (\result.kind === "NotFound")  === !occurs(content, old)
  //@ ensures (\result.kind === "Ambiguous") === (manyOcc(content, old) && !all)
  //@ ensures (\result.kind === "Replaced")  === (occurs(content, old) && (!manyOcc(content, old) || all))
  if (!occurs(content, old)) return { kind: "NotFound" };
  if (manyOcc(content, old) && !all) return { kind: "Ambiguous" };
  return { kind: "Replaced" };
}
```

### What gets proven (E1–E3 + length law)

| # | Property | In one line |
|---|----------|-------------|
| **E1** | decision soundness | `NotFound ⟺ ¬occurs`, `Ambiguous ⟺ manyOcc ∧ ¬all`, `Replaced ⟺ occurs ∧ (¬manyOcc ∨ all)` |
| **E2** | identity | replacing text that does not occur leaves the content unchanged |
| **E3** | **splice no-op** | `replaceFirst(hay, old, old) == hay` — the splice touches exactly the matched span and preserves everything else |
| — | length law | a single splice changes the length by exactly `\|repl\| − \|old\|` |

E1 is the auto-discharged `//@ ensures`; E2/E3 rest on `MatchSplit`
(`matchesAt(hay, old) ⟹ old + dropMatch(hay, old) == hay` — the matched prefix is
*exactly* `old`).

### The proof trick worth seeing

The prover-facing equations advance one character (`occurs`, `afterFirst`,
`replaceFirst`) or shrink `old` (`matchesAt`, `dropMatch`), which makes termination
and in-bounds slicing structural. The production TypeScript uses index-based loops:
LemmaScript emits them as Dafny `function by method` bodies and proves they compute
those recursive specifications. This preserves the clean proof shape without the
stack overflow and quadratic `slice(1)` behavior of the original runtime recursion.

**Key insight**: choosing the specification shape so well-formedness is structural is
most of the work in a string proof — the same lesson the balanced-match study scales
to 2233 VCs. The live `edit_file` tool calls `editFile` for the verdict and
`replaceFirst` for the single splice; the `replace_all` join stays shell.

## Part 6: Core 5 — the session transition system (`session.ts`)

The leaf cores become an agent-wide guarantee when the loop itself is expressed as
one pure transition:

```typescript
export function step(st: Session, ev: SEvent): StepOut {
  //@ requires inv(st)
  switch (ev.kind) {
    case "userInput":           return onUserInput(st);
    case "providerReply":       return onProviderReply(st, ev.calls, ev.contextTokens);
    case "toolDone":            return onToolDone(st, ev.isError);
    case "promptAnswer":        return onPromptAnswer(st, ev.answer);
    case "providerInterrupted": return onProviderInterrupted(st);
    case "batchInterrupted":    return onBatchInterrupted(st);
    case "compactRequest":      return onCompactRequest(st, ev.keep);
    case "summaryReady":        return onSummaryReady(st, ev.ok);
  }
}
```

`Session` carries the protocol model, permission state, batch cursor, phase, and
budgets. `step` returns a new state plus commands for the shell to interpret:
`callProvider`, `execTool`, `askUser`, `skipTool`, or `summarize`. Unexpected
event/phase combinations are no-ops, so the transition is total over hostile and
out-of-order inputs.

### What gets proven (S1–S13 and T∞)

The 97 session VCs compose the contracts of Parts 2 and 3 rather than re-proving
permissions and transcript structure:

| Family | Guarantee |
|--------|-----------|
| **S1 mediation** | every emitted `execTool` is exempt, already justified, justified by an always/All grant recorded in that transition, or approved once by the user |
| **S2 / T∞ preservation** | `inv` survives every step, and therefore every state reachable from `initialSession` by any event trace satisfies it |
| **S3–S4 outbound safety** | provider calls carry well-formed transcripts within the turn budget; summarization commands carry a nontrivial, protocol-safe cut |
| **S5–S7 permission discipline** | only prompt answers can change grants, prompts are necessary, and `rejectPrompts` mode never blocks waiting for one |
| **S8–S10 command discipline** | at most one effectful command is emitted per step, it corresponds to the batch cursor, and a batch of `n` calls terminates within `2n+1` events |
| **S11–S13 bounds** | configuration is stable, turns advance by at most one, transcript growth is bounded, and compaction never grows it |

The capstone is an induction over arbitrary traces in the code itself:

```typescript
export function traceFromInitialSafe(/* config, */ events: SEvent[]): boolean {
  //@ ensures inv(runSession(initialSession(/* config */), events))
  return true;
}
```

The provider is adversarial by construction because `providerReply` is just another
unconstrained event. What remains trusted is the shell's projection and faithful
interpretation of the commands—not the decision about which command may be emitted.

The sixth verification target, `gve/exec_core.ts` (10 VCs), belongs to Henri's
optional plan mode. It proves that symbolic references are bound by an earlier step
and supplies a counterexample to the old all-eventual-binds check. Its policy gate
and trust boundary are covered separately in [TUTORIAL_GVE.md](TUTORIAL_GVE.md).

## Part 7: No gap — the proven functions *are* the production code

This is the property that distinguishes henri-lemmascript from "we also wrote a
formal model." The annotated `.ts` files are imported along the live execution path:

- `agent.ts` feeds every event through the verified `session.step`, then interprets
  the commands it emits; it also uses `mergeTools`/`mergePerms` to build its tables.
- `session.ts` calls the verified permission decisions and grant builders, and can
  update its modeled transcript only through the verified transcript builders.
- `tools/base.ts` imports `{ editFile, replaceFirst }` and uses them in the
  `edit_file` tool — the verdict and the single splice run through the verified core.
- `gve/gate.ts` calls the verified `execOk` reference-order check in optional plan mode.

There is no code generation step that substitutes a different runtime implementation.
The boundaries between effectful values and proof models—`ToolCall → SCall`, concrete
messages → `TMsg`, strings → character arrays—are explicit trusted projections and are
checked where possible. When you read `step`, `decide`, or `editFile` above, you are
reading functions executed by `npm run henri`.

## Part 8: The trust boundary — where verification stops (and why that's fine)

Verifying the core makes the trust boundary smaller and **explicit**, not zero.
What is deliberately *not* verified:

- **Effects:** `subprocess` (`bash`), file I/O, network, provider streaming, and
  terminal UI remain shell.
- **The command interpreter:** `agent.ts` is trusted to perform exactly the commands
  `session.step` emits, feed back honest events, and keep result contents in batch order.
- **The prompt UI:** `permission-gate.ts` renders a question and parses y/n/a/A; the
  verified transition determines what each parsed answer does.
- **Boundary projections:** a concrete tool call becomes an `SCall` containing the
  projected `Req` plus `known`/`noPerm`/`argsOk` facts. `buildReq` realpaths the deepest
  existing ancestor and folds glob patterns before the verified containment decision.
  Concrete messages become `TMsg`; `checkMirror` compares that projection with the
  verified model before every provider call. These checks fail loudly, but faithfulness
  of the projections is still trusted.
- **Edit strings and opaque payloads:** the shell maps strings to character arrays for
  `edit.ts`; tool arguments, result content, and the `replace_all` join remain outside
  the proof.
- **GVE glue:** plan parsing, tool classification, the read/bind projection, and
  effectful execution of exactly the admitted plan remain trusted.
- **Numbers:** Dafny models mathematical integers; JavaScript overflow is not modeled.

**Key insight — worth stating out loud**: `decide == Allow ⟺ isAllowed` says *the
gate computes the intended policy correctly*. It does **not** say *executing an
allowed command is safe* — running arbitrary shell is exactly the part
verification can't bless, which is precisely why the permission gate earns its
keep. Verification moved the trust from "did we implement the policy right" (now
proven) to "is the policy itself right, and is the projection faithful" (still
trusted, but small and named).

## Part 9: Reproduce it

Prerequisites: a sibling [`../LemmaScript`](../LemmaScript) checkout (built), and
Dafny ≥ 4.x. The full typecheck/GVE suite also expects
`../guardians-lemmascript` on its `generate-verify-execute` branch. See
[`../LemmaScript/GETTING_STARTED.md`](../LemmaScript/GETTING_STARTED.md) for the
verification toolchain setup.

```sh
npm run verify     # ../LemmaScript/tools/check.sh dafny — regenerates, enforces
                   # additions-only, runs Dafny over all six: 234 VCs, 0 errors
npm run typecheck  # tsc --noEmit — the shell + core typecheck as one program
npm test           # runtime witnesses, including the verified session interpreter
npm run test:gve   # deterministic witnesses for optional plan mode
npm run henri      # run the actual agent (Anthropic, Bedrock, or Ollama)
```

Per-module, the edit loop is:

```sh
npm run gen   -- src/permissions.ts   # (re)generate permissions.dfy.gen
# ...add lemmas to permissions.dfy...
npm run check -- src/permissions.ts   # additions-only check + Dafny verify
```

## Part 10: Extend it — verify your own function

The original tutorial's Part 6 was "Adding a new tool." The verification analogue:

1. **Pick a small, pure function.** A predicate, a parser, a reducer with no I/O.
   `edit.ts` (Part 5) is a worked example — a string algorithm in the spirit of
   [balanced-match](https://github.com/midspiral/balanced-match-lemmascript); read it
   as a template before starting your own.
2. **Move it into a `//@ backend dafny` file** (or add `//@ verify` to it in an
   existing one) and write its contract with `//@ requires` / `//@ ensures`.
3. **`npm run gen -- src/yourfile.ts`**, then complete the proof in
   `yourfile.dfy` (helper lemmas, ghost predicates, `assert`s). The diff to
   `.dfy.gen` must be additions only.
4. **`npm run check -- src/yourfile.ts`** until Dafny is green. When it
   complains, the fix is usually either tightening a `//@ requires` / adding a
   `//@ invariant` in the `.ts`, or proving a helper lemma in the `.dfy`.
5. **Wire it into the shell** — import and call it from `agent.ts` /
   `tools/` so the proof is about code that runs, and add the file to
   `LemmaScript-files.txt` so `npm run verify` and CI see it.

A few exercises, in increasing difficulty:

- **A new permission property.** State and prove that a `bash` grant for one exact
  command never authorizes a *different* command.
- **`replace_all` faithfulness (stretch).** The all-occurrence join is still shell
  (Part 5). Verify a `replaceAll` over char sequences — the catch is termination: a
  skip-by-`|old|` recursion needs `matchesAt ⟹ |old| ≤ |hay|`, so you must either
  prove that lemma or restructure around `edit.ts`'s one-char-at-a-time shape.
- **Tighten the projection.** `toTranscript` is trusted today. Specify what
  "faithful projection" means and verify the part of it that lives in the
  fragment, shrinking the trust boundary.

## Where to go next

- [`README_LemmaScript.md`](README_LemmaScript.md) — the full property/lemma
  reference (what each of the 234 VCs proves).
- [`DESIGN.md`](DESIGN.md) — why the cores are shaped this way; the phased plan;
  the fragment-boundary tactics.
- [`TUTORIAL_GVE.md`](TUTORIAL_GVE.md) — the optional generate-verify-execute mode,
  its imported guardians policy proof, and its separate trust boundary.
- [`../LemmaScript/SPEC.md`](../LemmaScript/SPEC.md) — the annotation language.
- [`../LemmaScript/GETTING_STARTED.md`](../LemmaScript/GETTING_STARTED.md) — the
  Dafny edit loop in practice.
- The original [Henri tutorial](https://github.com/metareflection/henri/blob/main/TUTORIAL.md)
  — the agent this builds on.

**The whole point**: the agent loop is now the verified `session.step`, while
`agent.ts` is its effectful command interpreter. Who may touch what, how grants
change, whether tool results remain paired, where compaction may cut, and whether
every reachable session stays invariant are theorems about the code that actually
runs—not assertions layered around an otherwise-unverified loop.

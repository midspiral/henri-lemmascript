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

The headline: **48 Dafny verification conditions, 0 errors**, across three
modules — and the annotated TypeScript is the production code the agent runs.

## The Big Picture: a verified core inside an unverified shell

The original Henri is mostly *effectful glue* — streaming, terminal UI,
`subprocess`, network, provider SDKs. None of that lives in a verifiable
fragment. So henri-lemmascript is not a line-by-line port; it is re-architected
around a small **pure decision core** that the shell calls into:

```
┌───────────────────────────────────────────────────────────┐
│  Unverified shell (full TypeScript, runs the agent)       │
│    cli.ts · agent.ts (stream loop) · providers/* · tools/*│
│    terminal UI · subprocess · network                     │
│                                                           │
│    ┌─────────────────────────────────────────────────┐    │
│    │  Verified core (//@ annotations + Dafny proofs) │    │
│    │    permissions.ts   — the access decision       │    │
│    │    transcript.ts    — tool-call/result protocol │    │
│    │    hooks.ts         — config/hook merge         │    │
│    └─────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────┘
```

**Key insight**: the original tutorial's lesson was *soundness is independent of
the LLM*. The verification lesson is the second half of that: the parts that
guard safety are also *independent of the rest of the agent*. The shell can be
buggy, the model can be adversarial — `decide()` still computes exactly the
intended access policy, and the loop still refuses to send a malformed
transcript.

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

The shell is trusted only to call `path.resolve(p).split('/')`; everything that
*decides containment* is proven. That keeps the headline property self-contained.

### What gets proven (P1–P4)

| # | Property | In one line |
|---|----------|-------------|
| **P1** | soundness | `decide == Allow ⟺ isAllowed` — no unjustified allow |
| **P2** | **path-traversal containment** | with only auto-allow-in-cwd, an allowed path can never resolve outside cwd (`../`, `a/../../b`, …) |
| **P3** | grant monotonicity | adding any grant only turns `Deny`/`Prompt` into `Allow`, never the reverse |
| **P4** | reject-safety | `rejectPrompts` only rewrites `Prompt → Deny`; automation can't escalate |

P1 is the auto-discharged `//@ ensures`; P2–P4 are lemmas you add in
`permissions.dfy` (full lemma names in
[`README_LemmaScript.md`](README_LemmaScript.md) §1). **P2 is a directory-
traversal CVE class (CWE-22) proven on an agent's permission gate.**

### How the live agent uses it

The stateful prompt lives in `permission-gate.ts` (unverified shell). It builds a
`Req` from a concrete `(Tool, ToolCall)` and calls the verified decision:

```typescript
// permission-gate.ts
async check(tool: Tool, call: ToolCall): Promise<boolean> {
  if (!tool.requiresPermission) return true;
  const req = this.buildReq(tool, call);
  const outcome = decide(this.state, this.cwd, req);   // ← verified core
  if (outcome === "Allow") return true;
  if (outcome === "Deny")  return false;
  return this.promptUser(tool, call, req);             // ← shell: y/n/a/A
}
```

**Key insight**: prompting, recording grants, and mutating session state are all
shell. But *every* allow/deny flows through the proven `decide`. The thing you
trust is small and explicit.

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

T2 is the one that matters: it's not "we checked the transcript afterward," it's
"the loop's append step provably can't *create* a malformed transcript."

### How the live agent uses it

`agent.ts` calls the same functions as a runtime assertion **every turn**, before
sending:

```typescript
const results = await this.runToolCalls(toolCalls);

// Verified invariant T1: results pair 1:1 with calls, ids in order.
if (!pairs(toolCalls.map(c => ({ id: c.id, name: c.name })),
           results.map(r => ({ toolCallId: r.toolCallId, isError: r.isError })))) {
  throw new Error("internal: tool results do not pair with tool calls");
}
this.messages.push(toolResultMessage(results));

// Verified invariant T2: the conversation we will send next is well-formed.
if (!wellFormed(toTranscript(this.messages))) {
  throw new Error("internal: malformed conversation transcript");
}
```

**Key insight**: the proof guarantees these checks *can't fail* on the paths the
loop actually takes — so the `throw`s are a belt-and-suspenders boundary against
the unverified projection (`toTranscript`), not a substitute for the proof.

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

## Part 5: No gap — the proven functions *are* the production code

This is the property that distinguishes henri-lemmascript from "we also wrote a
formal model." The annotated `.ts` files are imported by the live shell:

- `permission-gate.ts` imports `{ decide, normalize, resolvePath }` and calls
  `decide(...)` on every gated tool call.
- `agent.ts` imports `{ pairs, wellFormed }` and asserts them every turn, and
  imports `{ mergeTools, mergePerms }` to build its tables.

There is no code generation step that produces a *different* runtime artifact and
no adapter translating a model into the real types. When you read `decide` in the
tutorial above, you are reading the function that gates the `bash` tool when you
run `npm run henri`. The proof is *about the running code*.

## Part 6: The trust boundary — where verification stops (and why that's fine)

Verifying the core makes the trust boundary smaller and **explicit**, not zero.
What is deliberately *not* verified:

- **`subprocess` (`bash`), file I/O (`read`/`write`/`edit`), network, provider
  streaming, terminal UI** — effectful shell.
- **Path projection.** The shell does `path.resolve(p).split('/')`; the in-core
  `normalize` reasons over the result. Symlink resolution is a runtime concern,
  not modeled.
- **Transcript projection** (`toTranscript`) from runtime messages to the `TMsg`
  model — trusted to be faithful.
- **Tool `args` and result `content`** — opaque strings to the proofs.
- **Numbers** — mathematical integers (henri's only numbers are token/turn
  counts); no overflow modeling.

**Key insight — worth stating out loud**: `decide == Allow ⟺ isAllowed` says *the
gate computes the intended policy correctly*. It does **not** say *executing an
allowed command is safe* — running arbitrary shell is exactly the part
verification can't bless, which is precisely why the permission gate earns its
keep. Verification moved the trust from "did we implement the policy right" (now
proven) to "is the policy itself right, and is the projection faithful" (still
trusted, but small and named).

## Part 7: Reproduce it

Prerequisites: a sibling [`../LemmaScript`](../LemmaScript) checkout (built), and
Dafny ≥ 4.x. See [`../LemmaScript/GETTING_STARTED.md`](../LemmaScript/GETTING_STARTED.md)
for setup.

```sh
npm run verify     # ../LemmaScript/tools/check.sh dafny — regenerates, enforces
                   # additions-only, runs Dafny over all three: 48 VCs, 0 errors
npm run typecheck  # tsc --noEmit — the shell + core typecheck as one program
npm test           # runtime witnesses for P1–P4 / T1–T2 / H1–H3
npm run henri      # run the actual agent (Anthropic or AWS Bedrock)
```

Per-module, the edit loop is:

```sh
npm run gen   -- src/permissions.ts   # (re)generate permissions.dfy.gen
# ...add lemmas to permissions.dfy...
npm run check -- src/permissions.ts   # additions-only check + Dafny verify
```

## Part 8: Extend it — verify your own function

The original tutorial's Part 6 was "Adding a new tool." The verification analogue:

1. **Pick a small, pure function.** A predicate, a parser, a reducer with no I/O.
   The `edit_file` faithful-splice (does a replacement preserve everything
   outside the match?) is the documented stretch goal — a string algorithm in the
   spirit of [balanced-match](https://github.com/midspiral/balanced-match-lemmascript).
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
- **`edit_file` splice (stretch).** Prove the uniqueness contract: `count == 0`
  errors, `count > 1 && !replaceAll` errors, else the splice replaces exactly the
  matched span and preserves the rest.
- **Tighten the projection.** `toTranscript` is trusted today. Specify what
  "faithful projection" means and verify the part of it that lives in the
  fragment, shrinking the trust boundary.

## Where to go next

- [`README_LemmaScript.md`](README_LemmaScript.md) — the full property/lemma
  reference (what each of the 48 VCs proves).
- [`DESIGN.md`](DESIGN.md) — why the cores are shaped this way; the phased plan;
  the fragment-boundary tactics.
- [`../LemmaScript/SPEC.md`](../LemmaScript/SPEC.md) — the annotation language.
- [`../LemmaScript/GETTING_STARTED.md`](../LemmaScript/GETTING_STARTED.md) — the
  Dafny edit loop in practice.
- The original [Henri tutorial](https://github.com/metareflection/henri/blob/main/TUTORIAL.md)
  — the agent this builds on.

**The whole point**: the agent's `while`-loop is unchanged from the original; what
changed is that the three decisions that guard safety and protocol — *who may
touch what*, *is the transcript well-formed*, *does merging hooks stay additive* —
are now theorems, checked on every run, about the code that actually runs.

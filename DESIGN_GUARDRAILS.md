# DESIGN_GUARDRAILS.md — Guarding the meaning of "verified"

**Status:** draft
**Date:** 2026-05-30
**Scope:** tooling that protects the *integrity* of henri-lemmascript's verified core
when the editor is an LLM agent (today: Claude + LemmaScript; tomorrow: henri editing
henri).

---

## 0. The principle

> **A green `npm run verify` is necessary but not sufficient.** Verification is only as
> strong as (a) the *spec* it proves and (b) the *projections* it trusts. An agent
> optimizing for "make it pass" can hollow out either one without the build ever going
> red.

The four modules in [`LemmaScript-files.txt`](LemmaScript-files.txt) carry **60 Dafny
VCs, 0 errors**. That number certifies *the implementation matches the spec*. It says
nothing about whether the spec still says what we want — and that gap is exactly where a
self-editing agent does damage. These tools close it by turning "did the meaning of
verified change?" into a **small, reviewable artifact** that is separated from the large,
noisy proof-body diffs.

The design goal is **detection and forced acknowledgement, not prevention.** Agents may
freely rewrite proofs and shell; what they may not do is *silently* alter what is
guaranteed.

---

## 1. Threat model — how a green check goes hollow

Each row is a real path by which `npm run verify` stays green (or fails to run) while the
guarantee silently weakens. The right column is the tool that closes it (§4).

| # | Erosion mode | Why the build stays green | Closed by |
|---|--------------|---------------------------|-----------|
| **W1** | **Weaken a `//@ ensures`** in the `.ts` (e.g. relax `=== isAllowed` to `==>`) | The contract lives in the `.ts`; the toolchain regenerates and proves the *weaker* theorem. | spec-guard (§4.1) |
| **W2** | **Loosen a `//@ requires`** until the obligation is trivial, or tighten it so the function is never exercised the way the shell calls it | Fewer/cheaper proof obligations; still 0 errors. | spec-guard (§4.1) |
| **W3** | **Delete a lemma** from a `.dfy` (drop `P2_AutoGrantImpliesWithin`) | Removing an *addition* is still "additions-only"; Dafny has *less* to prove. | spec-guard (§4.1) |
| **W4** | **`//@ assume` / `//@ havoc` / `//@ assume false`** to close a stubborn goal | `assume P;` tells Z3 to trust `P` unconditionally — "proves" nothing. | assume-allowlist (§4.2) |
| **W5** | **Projection drift** — change `buildReq`, `toTranscript`, the `[...s]`/`join`, or the `//@ declare-type Tool` so the model no longer mirrors reality | The proof is about the model; the model is now a lie. *No VC touches the shell.* | watched-projection (§4.4) |
| **W6** | **Coverage opt-out** — add a function but don't annotate `//@ verify`, or don't add the file to `LemmaScript-files.txt` | Un-annotated functions are silently skipped; un-listed files are never checked. | spec-guard coverage (§4.1) + VC count (§4.3) |
| **W7** | **Fail-to-run reads as success** — `../LemmaScript` unbuilt or Dafny missing | The script can exit 0 without Dafny ever proving anything. | verify hardening (§4.3) |

W1–W3 and W6 are *spec* erosions. W4 is a *proof* erosion. W5 is a *projection* erosion.
W7 is an *execution* erosion. The tools are organized along those four axes.

**Key insight:** none of W1–W7 is caught by the existing toolchain. The additions-only
check protects the proof from *contradicting* the generated code; it does not protect the
spec from being *watered down*. CI's `git diff --exit-code` on `*.dfy.gen`/`*.dfy` catches
*stale* generated files, not *dropped properties*. The only thing standing between W3 and a
shipped regression today is a human noticing a deleted lemma buried in a large proof diff.

---

## 2. The proof surface

Define the **proof surface** of a module as everything whose change alters the meaning of
"verified" — as opposed to proof-body churn, which is free. It spans both files of the
two-file model:

- **In the `.ts`** — every `//@` directive: `requires`, `ensures`, `invariant`,
  `decreases`, `verify`, `declare-type`, `extern`, `havoc`, `assume`, `backend`.
- **In the `.dfy`** — the *additions over `.dfy.gen`*: the hand-written `lemma` /
  `predicate` / `function`-with-`ensures` declarations (their **names and signatures**,
  not their bodies). The toolchain already isolates this set — it is exactly the
  additions-only delta the check enforces — so spec-guard reads it for free.

A lemma's **body** is not on the surface (an empty body means *proven*; a 200-line tactic
block and a one-liner that prove the same statement are equivalent). A lemma's
**statement** is. This separation is the whole trick: it lets proofs churn loudly while
the small set of *claims* stays quiet and reviewable.

### Property tiers

Not all properties are equal. spec-guard classifies each into a tier (declared in the
spec-lock, §5):

| Tier | Meaning | On change |
|------|---------|-----------|
| **frozen** | Boxing invariants that keep a self-editing agent contained. Today: `P2_AutoGrantImpliesWithin`, `P2_NoEscape` (no cwd escape) and `P4_RejectIsDenyOnly` (automation can't escalate). | **Never auto-acceptable.** Removal/weakening requires an explicit, logged out-of-band override — the human/adversarial-verifier gate. |
| **core** | The rest of the proven properties (P1, P3, T1–T2, H1–H4, E1–E3). | Acceptable **with sign-off** (a deliberate spec-lock regen, §5). |
| **proof-body** | Helper lemmas, ghost predicates, `assert`s, `decreases`. | **Free.** Churn freely; not tracked. |

---

## 3. Design overview

```
┌───────────────────────────────────────────────────────────────────┐
│  edit loop (agent or human)                                       │
│    gen → write proofs in .dfy → check  ───────────────┐           │
│                                                        ▼          │
│  GUARDRAILS                                                       │
│    spec-guard --check ──► proof surface vs spec-lock.json         │
│      ├─ W1/W2 weakened contract   ⚠ sign-off                      │
│      ├─ W3   dropped lemma         ⚠ sign-off (frozen ⇒ override) │
│      ├─ W4   new assume/havoc      ⚠ allowlist entry              │
│      └─ W6   coverage gap          ✗ fail                         │
│    verify (hardened) ──► parses Dafny output                      │
│      ├─ W7  Dafny didn't run       ✗ fail                         │
│      └─ count < expected / err>0   ✗ fail                         │
│    watched-projection ──► flags edits to trust-boundary fns       │
│      └─ W5  buildReq/toTranscript/projection touched  ⚠ review    │
└───────────────────────────────────────────────────────────────────┘
              │ all green + acknowledged
              ▼
        Stop hook / CI required checks
```

Everything keys off one committed artifact, **`spec-lock.json`** (§5): the recorded proof
surface plus expected VC counts and property tiers. Regenerating it with an explicit
`--accept` *is the act of sign-off*; the lockfile diff is the reviewable record of "what
the meaning of verified changed to."

---

## 4. The tools

All tools live in henri-lemmascript itself (this is henri-specific *policy*, not a
LemmaScript toolchain feature) under `scripts/`, run via `tsx` to match the repo
(`tsx src/cli.ts`, `tsx test/smoke.ts`), and surface as npm scripts.

### 4.1 `spec-guard` — the core tool

```sh
npm run spec-guard            # report: diff the proof surface vs spec-lock.json
npm run spec-guard -- --check # CI mode: exit nonzero on any unacknowledged ⚠/✗
npm run spec-guard -- --accept# regenerate spec-lock.json (the sign-off act)
```

**What it does.** For each module in `LemmaScript-files.txt`:

1. **Extract the proof surface** (§2): scan the `.ts` for `//@` directives; compute the
   `.dfy` − `.dfy.gen` additions and extract `lemma`/`predicate`/`function`-`ensures`
   *signatures* from the delta.
2. **Compare to the baseline** recorded in `spec-lock.json`, classifying each change:
   - **ADDED** property/lemma — informational (a strengthening; generally good).
   - **REMOVED** property/lemma (**W3**) — ⚠ sign-off; ✗ override if the property is
     `frozen`.
   - **CHANGED** contract text (**W1/W2**) — ⚠ sign-off. The tool *cannot* tell stronger
     from weaker (§7); it forces a human to look.
   - **COVERAGE gap** (**W6**) — a `//@ backend dafny` file with `//@ verify`-eligible
     functions left un-annotated, or a verified `.ts` not in `LemmaScript-files.txt` — ✗
     fail (this one is unambiguous).
3. **Emit** a human-readable report and a `--json` form for the hook/CI.

**Why a lockfile and not just `git diff HEAD`?** Two reasons. (a) It records *intent*: the
lockfile is small and semantic ("P2 exists, frozen"), so its diff reads as
"you removed P2," not as 40 lines of moved Dafny. (b) It survives rebases/branches and
gives CI a stable baseline independent of which commit it diffs against. `git diff` is a
fallback mode (`--base HEAD`) for quick local checks.

### 4.2 assume / havoc allowlist (sub-check of spec-guard)

**W4.** The proof-surface scan counts `//@ assume`, `//@ havoc`, `//@ assume false`, and
`//@ extern` occurrences per file. A *net increase* fails `--check` unless there is a
matching entry in an **allowlist** (`spec-lock.json → escapeHatches[]`) with a one-line
justification. Per the LemmaScript `AGENTS.md`: `havoc`/`extern` over a genuinely
out-of-fragment value is legitimate and gets an allowlist entry; `assume` to paper over a
goal you didn't discharge is not, and the failure is the prompt to restructure or prove
the lemma instead. The allowlist makes every escape hatch *documented inline and
deliberate* rather than slipped in.

### 4.3 `verify` hardening — assert VC counts

**W6 (counts) / W7 (fail-to-run).** Today `npm run verify` shells out to
`../LemmaScript/tools/check.sh dafny` and trusts its exit code. We wrap it:

```sh
npm run verify       # → scripts/verify.ts: runs check.sh, parses Dafny output, asserts
npm run verify:raw   # → the current ../LemmaScript/tools/check.sh dafny (unchanged)
```

`scripts/verify.ts`:
- runs `verify:raw`, capturing stdout;
- **asserts Dafny actually ran** — the toolchain/Dafny-present preflight; a missing
  `../LemmaScript` build or absent `dafny` is a ✗, never a silent pass;
- parses the per-module `verified`/`error` counts and checks **total verified ≥ expected
  and errors == 0**, where `expected` (per module: permissions 14, transcript 10, hooks
  24, edit 12 → 60) is recorded in `spec-lock.json`;
- a *drop* in count fails (catches W3/W6 from the execution side); a legitimate *rise*
  (new lemma) is acknowledged via `spec-guard --accept`, which updates the expected
  counts in the same artifact.

So "verify passed" comes to mean **"Dafny ran and proved at least the VCs we signed off
on,"** not "the script exited 0."

### 4.4 watched-projection check

**W5.** The proofs are only meaningful if the unverified shell projects reality into the
model faithfully. These functions are the trust boundary named in
[`DESIGN.md` §4](DESIGN.md) and [`LS_TUTORIAL.md` Part 7](LS_TUTORIAL.md):

- `permission-gate.ts → buildReq` (must feed `path.resolve(p).split('/')` segments)
- `agent.ts → toTranscript` (runtime messages → `TMsg`)
- `tools/base.ts` edit projection (`[...s]` / `join("")`, and the shell `replace_all` join)
- the `//@ declare-type Tool { name: string }` boundary

spec-guard keeps a **watched-files/functions list** (`spec-lock.json → watched[]`). Any
diff that touches one emits a ⚠ **"projection touched — re-confirm faithfulness"** — not a
hard fail (these are legitimately edited), but a flag that elevates the change to
verified-core review even though no VC moved. This is the one axis the tools can only
*flag*, not *check* (§7); naming it explicitly is the point.

### 4.5 harness hook + CI wiring

The loop should not be able to leave the tree red or the spec drifted-unacknowledged.

- **Local (advisory).** A `Stop` (or `PostToolUse` matched to edits under `src/` and
  `*.dfy`) hook in `.claude/settings.local.json` runs `npm run typecheck && npm test &&
  npm run verify && npm run spec-guard -- --check`. Hook output is feedback to the agent,
  not a hard gate — the user remains the gate (configured via the `update-config`
  skill / `settings.json`, since hooks are harness behavior).
- **CI (required).** Add the same `spec-guard --check` step and switch the existing
  verify step to the hardened `verify`, alongside the current additions-only +
  staleness + typecheck + smoke jobs in
  [`.github/workflows/lemmascript.yml`](.github/workflows/lemmascript.yml). The
  spec-lock is committed, so CI fails if a PR changed the proof surface without
  regenerating it.

---

## 5. The `spec-lock.json` artifact

One committed file at the repo root. Sketch:

```jsonc
{
  "modules": {
    "src/permissions.ts": {
      "expectedVCs": 14,
      "contracts": [ /* hash + text of each //@ requires/ensures/invariant */ ],
      "lemmas": [
        { "name": "P2_AutoGrantImpliesWithin", "tier": "frozen", "sig": "…" },
        { "name": "P4_RejectIsDenyOnly",        "tier": "frozen", "sig": "…" },
        { "name": "P3_GrantBashMonotone",       "tier": "core",   "sig": "…" }
        /* … */
      ],
      "escapeHatches": [],                 // assume/havoc/extern, with justifications
      "watched": ["buildReq"]              // projection fns in the shell that feed this core
    }
    /* transcript.ts, hooks.ts, edit.ts … */
  },
  "totalExpectedVCs": 60
}
```

- **Generated**, never hand-edited, by `spec-guard --accept`. Hand-editing it to dodge a
  ⚠ is itself a reviewable diff (and a frozen-tier removal still requires the override
  flag, §3) — so the artifact's value is that it makes the dishonest move *loud*, not
  cryptographically impossible (§7).
- Lives in version control; the lockfile diff in a PR is the human-readable summary of
  "what the meaning of verified changed to."

---

## 6. The edit loop, with guardrails

Extends the per-module loop in [`LS_TUTORIAL.md` Part 9](LS_TUTORIAL.md):

```sh
# 1. edit the .ts; regenerate + complete the proof (unchanged)
npm run gen   -- src/permissions.ts
#   …add lemmas to permissions.dfy…
npm run check -- src/permissions.ts        # Dafny green

# 2. guardrails
npm run verify                             # Dafny ran; counts ≥ signed-off; 0 errors
npm run spec-guard -- --check              # proof surface vs spec-lock

# 3a. surface unchanged → done.
# 3b. surface changed deliberately (added a property, raised a count):
npm run spec-guard -- --accept             # regen spec-lock = sign-off; review its diff
# 3c. a ⚠ you didn't intend → you weakened/dropped something. Fix the .ts/.dfy, not the lock.
```

The discipline: **fix red by proving more, not by claiming less; clear a ⚠ by
`--accept`ing a change you can defend, never by editing the lock to hide it.**

---

## 7. Non-goals and residual trust

Stated plainly, because saying where a guardrail *stops* is as important as what it
catches (the same ethic as `LS_TUTORIAL.md` Part 7):

- **spec-guard cannot tell whether a *new or rewritten* spec is *correct*** — only that it
  changed. Judging a fresh `//@ ensures` is still human/adversarial work. The tool routes
  attention; it does not replace judgement.
- **It is syntactic, not a semantic equivalence checker.** An equivalent rewording of a
  `requires` flags as CHANGED (a false positive). That is the safe direction — a false
  positive costs one sign-off; a false negative ships a regression.
- **It trusts git and its own lockfile.** An agent that edits the source *and* the lock in
  one move is not stopped by the tool — it is stopped by the *reviewer reading the lock
  diff* (and, for frozen properties, by the override gate). The defense is a small
  reviewable artifact, not tamper-proofing.
- **Projection faithfulness (W5) is flagged, never proven.** Whether `buildReq` truly
  yields `resolve().split('/')` segments remains trusted; the tool only insists the
  change be *looked at*.

The guardrails shrink the trust surface to: *is the spec itself right, and are the
projections faithful* — the same irreducible residue the verified core already names,
now with the *erosion* paths fenced off.

---

## 8. Toward self-improving henri

This is the rehearsal for the real goal. When henri edits its own `permissions.ts`,
"verified" will guarantee the implementation matches the spec — but the spec is the thing
that must not drift. So the architecture these tools prototype is:

- **The spec-lock is the trusted kernel made concrete.** The `frozen` tier (P2, P4) is the
  boxing invariant a self-editing agent is never allowed to relax on its own authority.
- **`--accept` is the gate.** In the agent loop, the act of acknowledging a spec change is
  precisely what gets delegated *out of the loop* — to a human, or to a separate
  adversarial-verifier agent — even when the editing agent may freely rewrite proofs and
  shell. The frozen tier escalates further, to an explicit logged override.
- **spec-guard can itself become a henri tool.** Exposed in `tools/`, a self-editing henri
  runs it on its own diff before committing — and is structurally unable to *grant itself*
  a frozen-tier change. The guardrail that constrains today's Claude becomes the guardrail
  henri runs against henri.

The stepping stone (Claude editing henri) and the destination (henri editing henri) want
the *same* invariant: **the agent may change anything except, silently, what it
guarantees.**

---

## 9. Sequencing

- **G0 — `spec-lock.json` + extractor.** Parse the proof surface (`//@` from `.ts`,
  lemma signatures from the `.dfy` − `.dfy.gen` delta) and snapshot the current 60-VC,
  four-module baseline. Tier P2/P4 as `frozen`.
- **G1 — `spec-guard --check`/`--accept`** (W1–W3, W6) + the assume/havoc allowlist (W4).
- **G2 — hardened `verify`** (W6 counts, W7 fail-to-run); repoint `npm run verify`,
  keep `verify:raw`.
- **G3 — watched-projection flag** (W5): seed `watched[]` with `buildReq`, `toTranscript`,
  the edit projection, the `declare-type Tool` boundary.
- **G4 — wiring:** the local `Stop`/`PostToolUse` hook and the CI step.
- **G5 — (toward §8)** expose `spec-guard` as a henri tool with the frozen-tier gate.

Each stage is independently useful; G1 alone closes the highest-leverage gap (W3, a
dropped property passing every existing check).

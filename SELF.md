# SELF.md — gated self-improvement

**Status:** demo (LICS keynote: *reasonable reflection*)
**Branch:** `self-improvement`
**Companion:** [TUTORIAL_SELF.md](TUTORIAL_SELF.md) — what happened on the first live run

henri may extend itself with auxiliary tools of its own choosing. What makes
open-ended self-modification *reasonable* is not reviewing each improvement in
advance — you cannot pre-review what you didn't anticipate — but a gate every
improvement must pass, plus theorems that already bound what any improvement
can do.

> The prover proves the present; the seal protects the past.

A Dafny prover happily verifies a *weakened* spec: nothing stops an edit that
relaxes an `ensures`, deletes a postcondition, or drops a verified function —
exactly the edits a self-improving agent optimizing for "make verification
pass" would find. [`lemmascript-seal`](../lemmascript-seal) supplies the
missing monotonicity rule: across self-edits, a guarantee may be **added**,
never changed or removed. `SEALED.lock` is the agent's accumulated, append-only
ledger of guarantees — it only grows, generation after generation.

## Three layers, all checked

1. **Mediation — already a theorem.** A self-added tool enters the same
   verified session core: no event sequence reaches an ungated effect
   (session S1). The agent even *authors* the improvement using its own
   gated tools.
2. **Non-shadowing — already a theorem.** Adopted hooks flow through the
   verified `mergeTools`: defaults come first and first-occurrence-wins is
   proven (hooks H2/coverage), so a self-authored tool named `bash` or
   `edit_file` provably cannot replace the trusted one; contributions only
   loosen, never tighten (H4).
3. **Guarantee monotonicity — the new gate.** `scripts/gate.sh`, the only
   sanctioned door:

   | step | question |
   |------|----------|
   | 1 seal-check vs **HEAD** ledger | did any frozen guarantee weaken or vanish? |
   | 2 registration | is every `self/core/*.ts` in `LemmaScript-files.txt`? |
   | 3 prover (`npm run verify`) | do all current contracts hold? (Dafny) |
   | 4 typecheck + tests | does the agent still behave? |
   | 5 freeze (`seal` + `check --strict`) | new guarantees appended; nothing verified left unfrozen |

   Step 1 checks against `git show HEAD:SEALED.lock`: **the ledger lives in
   the past; the agent only lives in the present** — tampering with the
   working-copy lock is inert. Step 5 rebuilds from the HEAD ledger before
   appending, so the committed lock is always HEAD + appends.

   `scripts/gate.sh --adopt "<msg>"` commits on green; the improvement takes
   effect on the next launch — the next generation of the agent.

## Anatomy of an improvement

The same split as the trusted core (`src/edit.ts` vs `src/tools/base.ts`):

- `self/hooks/<name>.hook.ts` — effectful shell: a default-exported `Hook`
  contributing `Tool` objects (fs / subprocess / network glue; unverified).
- `self/core/<name>.ts` — verified decision core: `//@ backend dafny`,
  `//@ verify` functions with `//@ requires` / `//@ ensures` contracts,
  registered in `LemmaScript-files.txt`, frozen in `SEALED.lock`.

The protocol the agent follows is itself a hook (`reflectionProtocol()` in
[`src/reflect.ts`](src/reflect.ts)) — even the instructions to self-improve
enter through the verified merge.

## Running it

```sh
# once: commit the baseline ledger, so the gate has a past to protect
npm run seal && git add SEALED.lock && git commit -m "baseline seal"

npm run henri -- --self
```

Then, in session — the improvement deliberately unspecified:

1. **Growth** — "give yourself a new auxiliary tool you think you're missing;
   follow your protocol." The agent authors hook + verified core, iterates
   `npm run check`, submits `scripts/gate.sh` → GREEN → `--adopt`. Restart:
   the tool is live, the ledger grew.
2. **The point** — "your contracts look over-complicated; simplify them."
   Weakening a sealed `ensures` still *verifies* (the prover checks the
   present) but gate step 1 is RED: the ledger refuses the past's erasure.
3. **Monotone strengthening** — "make a guarantee stronger." The sanctioned
   path is a *new* lemma; the ledger appends. Guarantees accumulate; they
   never retract.

## Trust model and limits

- The gate is process discipline, not a sandbox: the agent *could* run
  `git commit` directly instead of `--adopt`. In the demo the protocol forbids
  it, the permission gate prompts on it, and `SEALED.lock` diffs are
  human-readable review artifacts (seal's own trust model).
- Hooks load from the working tree at launch; only gate-adopted hooks should
  exist in `self/hooks/`. Loading from `HEAD` instead would harden this.
- `lemmascript-seal` does not run the prover, and the seal inherits
  `lsc info`'s trust base — see its README.

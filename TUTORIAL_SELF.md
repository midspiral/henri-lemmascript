# TUTORIAL_SELF.md — the first gated self-improvement, in one read

What just happened: henri, launched with `--self`, was asked to *"give yourself
one new auxiliary tool — your choice."* It chose, unprompted, a complexity
analyzer; wrote the tool as a hook plus a **verified core**; iterated the prover
until green; submitted through the gate; tested the tool on its own source; and
adopted it with a commit. The guarantee ledger grew from **117 to 124 frozen
contracts, with zero deletions**. [SELF.md](SELF.md) is the design (*why* this
is safe to allow); this file is the *what happened*, and an honest accounting of
what is proved versus trusted.

## 1. The run

The agent followed the protocol it is given as a system-prompt hook
([`src/reflect.ts`](src/reflect.ts) — the instructions to self-improve enter
through the same verified merge as everything else):

1. **Chose its improvement** — `analyze_complexity`, a code-metrics tool. The
   choice was not in the prompt; open-endedness is the point, and the gate is
   what makes it tolerable.
2. **Wrote the split** the codebase models everywhere: effectful shell in
   [`self/hooks/complexity.hook.ts`](self/hooks/complexity.hook.ts) (reads the
   file, formats output), pure decisions in
   [`self/core/complexity.ts`](self/core/complexity.ts) — recursive counters
   with contracts, in the house style of `src/edit.ts`. **17 Dafny VCs, 0
   errors**, discharged automatically.
3. **Classified its own tool's permissions** correctly: `requiresPermission:
   true`, registered as `pathBased` + `autoAllowCwd` — mirroring `read_file`.
   Those contributions flow through the verified `gather` (H4: loosening only,
   for its own tool only).
4. **Registered the core** in `LemmaScript-files.txt` and submitted through
   [`scripts/gate.sh`](scripts/gate.sh): ledger check, registration check,
   full prover run (all modules, its own included), typecheck + tests — then
   the append-only freeze.
5. **Tested the tool on real files before adopting** — nobody asked; the
   protocol doesn't require it. Culture is imitated from the codebase an agent
   lives in.
6. **Adopted**: `gate.sh --adopt` committed exactly the improvement — 571
   insertions, 0 deletions, including 83 appended ledger lines. On the next
   launch, `analyze_complexity` is simply one of henri's tools.

## 2. What the gate rejected

The mirror experiment, run against the same tree: delete one sealed `ensures`
(the H4 additivity clause of `gatherGrows` in [`src/hooks.ts`](src/hooks.ts))
and resubmit.

- The **prover accepts it**: `Dafny program verifier finished with 25 verified,
  0 errors`. A prover verifies whatever contract is in front of it — a weaker
  spec verifies *more* easily. This is not a prover bug; it is the prover's
  job description.
- The **gate rejects it in seconds**, before the expensive prover step even
  runs: `CHANGED: src/hooks.ts:gatherGrows — sealed contract was modified`,
  exit 1.

> The prover proves the present; the seal protects the past.

The check runs against `git show HEAD:SEALED.lock`, so editing the working-copy
ledger is inert: the ledger lives in the past, the agent only lives in the
present.

## 3. Proved versus trusted

**Proved before any improvement exists** (and quantified over all of them):

| layer | theorem | consequence for a self-added tool |
|---|---|---|
| mediation | session S1 | it is gated like every tool; no event sequence reaches an ungated effect |
| non-shadowing | hooks H2 + coverage | it can never replace `bash`, `edit_file`, or any trusted default |
| additivity | hooks H4 | its permission contributions only loosen, never tighten |

**Proved per improvement:** the core's contracts — here, honest bounds
(non-blank ≤ total lines, complexity ≥ 1, counts ≥ 0) — verified by Dafny and
frozen thereafter.

**Trusted:** the hook's shell code (same trust split as `src/tools/base.ts`);
`lsc info`'s contract extraction (the same trust base as the proofs); and the
gate itself as *process discipline* — the agent could `git commit` around it,
which the protocol forbids, the permission prompt surfaces, and the
human-readable `SEALED.lock` diff catches on review. Review is cheap by
construction: append-only means the diff is all `+`.

One instructive wrinkle from the live run: the core's *comment header*
advertises a "monotonicity" theorem, but the *contract* proves non-negativity.
The prose over-claims; the frozen contract does not. Only what was actually
proven entered the ledger — the seal keeps the promises honest, and prose
remains prose.

## 4. Reproduce it

```sh
git log --oneline -3        # the adoption commit: "Add complexity analysis tool…"
git show <adoption> --stat  # 571 insertions, 0 deletions
npm run seal:check          # seal-check OK — 124 guarantees intact

HENRI_BASH_TIMEOUT_MS=900000 npm run henri -- --self
```

Then ask for the next improvement — your choice, or better, the agent's. To
strengthen an existing guarantee, the sanctioned path is a **new** lemma
(guarantees accumulate; they never retract); to watch the gate say no, order
the agent to weaken one and read the RED line.

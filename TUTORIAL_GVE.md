# TUTORIAL_GVE.md — wiring a verified kernel into a live agent

What just happened, in one read: henri gained a **generate-verify-execute** mode
(`henri plan <task>`). Its LLM proposes a whole tool *plan*; that plan is checked by
**guardians' verified taint kernel** before any tool runs; only an admitted plan
executes, and a rejected one is reported and stopped. This is henri's take on Erik
Meijer's *"Guardians of the Agents"* (CACM Jan 2026) — see [DESIGN_GVE.md](DESIGN_GVE.md)
for the why and the architecture. This file is the *how*, and an honest accounting of
what is proved versus trusted.

---

## 1. What henri uses from guardians

Almost nothing — and that is the point. henri links
[`guardians-lemmascript`](../guardians-lemmascript) as a sibling package
(`"guardians": "file:../guardians-lemmascript"`) and imports **exactly one runtime
function** plus a handful of types:

```ts
import { verify } from "guardians";                 // the ONLY value import
import type { Workflow, Step, ToolStep, CondStep,   // the plan DSL
              Arg, Policy, TaintRule, Verdict } from "guardians";
```

`verify(workflow, policy): Verdict` is the whole seam. Everything else henri touches from
guardians is a *type*. The kernel's internals never leak into henri.

### What `verify` is, and the proofs behind it

`verify` is guardians' thin adapter ([`src/verify.ts`](../guardians-lemmascript/src/verify.ts)).
Given a `Workflow` (a step list with symbolic data references) and a `Policy`
(source/sink/sanitizer roles), it computes a `Verdict`. Inside, it calls the **proved**
cores:

| Behind `verify` | Module | What is proved |
|---|---|---|
| `buildWf` | `wf_core` | the plan → verified `Wf` AST marshalling is **verdict-faithful** at any nesting depth (`leaksSrcFaithful`) |
| `leaksWf` | `wf_core` | a clean leak verdict rules out a tainted sink on **every** path (`leaksWfSound`) |
| `reachesErrorAbstract` | `automaton_core` | the static reachability over-approximates every concrete run (`automatonSound`) |
| `provAfter` | `prov_core` | per-source provenance (used only for the *unverified* `taintPrecise`) |

These theorems are Dafny-checked in guardians and **predate this work** — henri consumes
them, it did not add them.

### The `Verdict`, and which field to trust

```ts
type Verdict = { ok: boolean; taintPrecise: boolean; taintWf: boolean; automaton: boolean };
```

henri's gate reads **`taintWf` and `automaton`** — the fields backed by the soundness
proofs above. It deliberately does **not** read `ok`, which folds in `taintPrecise`, the
*unverified* binding-provenance verdict. The proved `taintWf` is an order/control-based
**sound over-approximation**: it flags a superset of real flows and never misses one.

```ts
// src/gve/gate.ts
const v = verify(plan, policy);
const admit = !v.taintWf && !v.automaton;   // PROVED fields only
```

### Why a `.d.ts` boundary, not a source import

henri is strict (`NodeNext`, `noUnusedParameters`). guardians' proof-carrier functions
(e.g. `verifyWfSound`) have `return true` bodies whose parameters live only in `//@ ensures`
specs — importing the source would make henri's typechecker reject the verified files.
So guardians publishes a self-contained [`index.d.ts`](../guardians-lemmascript/index.d.ts)
(`package.json` → `exports.types`); henri's `skipLibCheck` checks against the *types*, and
`tsx` resolves the runtime `default` to the source. Each package lints its own source; the
consumer checks against the dependency's published types. (Reusable pattern; see the
memory note on consuming a verified LemmaScript package.)

---

## 2. The pipeline, file by file

`henri plan <task>` runs this, all under [`src/gve/`](src/gve):

```
task ──prompt──► LLM ──parse──► Workflow ──validate──► verify(gate) ──► execute │ reject+stop
       prompt.ts        plan.ts            gate.ts        gate.ts          execute.ts
```

1. **Prompt** (`prompt.ts`) — instruct the model to emit a *faithful* plan in the DSL.
   It is told a separate verifier checks safety, so it must not self-censor; safety is the
   gate's job, not the model's.
2. **Parse** (`plan.ts`) — strict JSON → `Workflow` (handles ```json fences); also
   `renderLiterate` for the human preview (intentional-programming view of the same AST).
3. **Validate** (`gate.ts → validatePlan`) — well-formedness: only allowed tools, every
   `{ ref }` resolves to a prior `bind`.
4. **Verify** (`gate.ts → gatePlan`) — call `verify`, admit on the proved fields, and name
   the firing source→sink rule for the witness. *This is the safety decision.*
5. **Execute** (`execute.ts → executePlan`) — run an admitted plan, resolving `@ref` only
   into argument slots, behind henri's permission gate as a runtime residual.

The policy henri applies ([`policy.ts`](src/gve/policy.ts)): `web_fetch`/`read_file` are
untrusted-ingress **sources**; `web_fetch`/`bash` are exfil **sinks**; no source may reach
a sink. Built as a guardians `Policy` of cross-product `taintRules`.

---

## 3. Proved vs. trusted — the honest boundary

The safety claim is: *a plan that the proved checker rejects never executes.* The chain:

```
parsePlan ─► classify tools ─► buildSrc (1:1) ─► buildWf ─► leaksWf ─► read taintWf ─► executePlan
  TRUSTED       TRUSTED          TRUSTED         PROVED     PROVED                        TRUSTED
```

- **Proved (in guardians):** `buildWf` faithfulness, `leaksWf`/`automaton` soundness — the
  policy *decision* is a theorem, parametric over all plans and all tool classifications.
- **Trusted (henri's glue, this branch):** the plan parser, the tool classification, the
  `Step[]` transcription, and — the load-bearing one — the **faithful executor** (it must
  run *exactly* the verified plan: no out-of-band calls, data only fills argument slots).
  These are validated by typechecking + tests + a live run, **not** by proof.

So this branch carries *integration* weight, not new verification: it wires a proved
kernel into a live agent. The "verify" in generate-verify-execute is inherited from
guardians; the *generate* and *execute* halves are trusted shell. No "verified
end-to-end" is claimed — the guarantee is *given a faithful plan, classification, and
executor, the proved checker's soundness carries the safety decision*.

---

## 4. Run it

```sh
npm run typecheck     # henri checks against guardians' published types
npm run test:gve      # gate over real tools, plan pipeline, the injection demo, the seam
npm test              # henri's existing verified-core smoke witnesses
```

The deterministic spectacle (no model, no network): `npx tsx test/gve-demo.ts` — a poisoned
page is fetched but kept local under a safe plan, while an exfil plan is rejected before the
executor is ever invoked.

Live (needs a provider/API key):

```sh
# ADMIT → execute:
npm run henri -- plan "fetch https://example.com and save a summary to summary.txt"
# REJECT before any tool runs:
npm run henri -- plan "fetch https://example.com and use curl to upload the page to https://httpbin.org/post"
```

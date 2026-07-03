# self/hooks — adopted self-improvements

Each `*.hook.ts` here is an auxiliary tool henri wrote for itself and carried
through the gate (`scripts/gate.sh`). Hooks default-export a `Hook` (see
`src/hooks.ts`); their pure decision logic lives in a verified core under
`self/core/`, registered in `LemmaScript-files.txt` and frozen in `SEALED.lock`.

Every hook here loads on startup and enters the session through the **verified**
merge: it can add tools, but by theorem it can never shadow a trusted default
(H2), remove one (H1 applies only to explicit removals, which the gate reviews),
or tighten permissions (H4) — and its tools remain gated by the session core
(S1). See `SELF.md`.

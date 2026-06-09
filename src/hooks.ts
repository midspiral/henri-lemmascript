//@ backend dafny

// Hook / config merge — VERIFIED in place.
//
// The real Tool carries a function-valued `execute` (outside the fragment), so
// //@ declare-type models Tool by just its `name` — the field the merge actually
// reasons about — while the runtime uses the real Tool unchanged. The merge
// functions are verified directly (no parallel model); mergePerms/mergeSystemPrompt
// build Sets/strings outside the fragment and stay unverified (selective //@ verify
// mode), as thin wrappers over the verified `gather`.
//
// NOTE: this diverges from henri intentionally (the H2 fix). Henri concatenated
// hook.TOOLS with no name dedup; here dedupTools keeps the first occurrence of
// each name and that uniqueness is proved.
//
// Properties (proofs in hooks.dfy):
//   H1 removal    — no removed name survives mergeTools
//   H2 uniqueness — result tool names are distinct (the dedup fix)
//   coverage      — a kept (non-removed) name is preserved
//   H3 order-indep— gather membership = base ∪ contributions (order-free)
//   H4 additivity — gather only grows the base (composes with permissions' P3)

import type { Tool } from "./tools/base.ts";

//@ declare-type Tool { name: string }

export interface Hook {
  tools?: Tool[];
  removeTools?: string[];
  pathBased?: string[];
  autoAllowCwd?: string[];
  autoAllow?: string[];
  rejectPrompts?: boolean;
  systemPrompt?: string;
}

/** Tool-classification + permission config the gate is seeded with. */
export interface PermConfig {
  pathBased: Set<string>;
  autoAllowCwd: Set<string>;
  autoAllow: Set<string>;
  rejectPrompts: boolean;
}

// ── tool merge (verified, over the real Tool[]) ───────────────────────────────

/** Recursive string-list membership. */
export function contains(xs: string[], x: string): boolean {
  //@ verify
  //@ decreases xs.length
  if (xs.length === 0) return false;
  if (xs[0] === x) return true;
  return contains(xs.slice(1), x);
}

/** Does any tool in `tools` carry this name? */
export function hasName(tools: Tool[], name: string): boolean {
  //@ verify
  //@ decreases tools.length
  if (tools.length === 0) return false;
  if (tools[0].name === name) return true;
  return hasName(tools.slice(1), name);
}

/** Keep the first occurrence of each tool name, dropping removed names. */
export function dedupTools(acc: Tool[], tools: Tool[], removes: string[]): Tool[] {
  //@ verify
  //@ decreases tools.length
  if (tools.length === 0) return acc;
  const t = tools[0];
  const rest = tools.slice(1);
  if (contains(removes, t.name)) return dedupTools(acc, rest, removes);
  if (hasName(acc, t.name)) return dedupTools(acc, rest, removes);
  return dedupTools([...acc, t], rest, removes);
}

/** All tools: defaults followed by every hook's contributed tools. */
export function allTools(defaults: Tool[], hooks: Hook[]): Tool[] {
  //@ verify
  //@ decreases hooks.length
  if (hooks.length === 0) return defaults;
  return allTools([...defaults, ...(hooks[0].tools ?? [])], hooks.slice(1));
}

/** All removed names, across every hook. */
export function allRemoves(hooks: Hook[]): string[] {
  //@ verify
  //@ decreases hooks.length
  if (hooks.length === 0) return [];
  return [...(hooks[0].removeTools ?? []), ...allRemoves(hooks.slice(1))];
}

/** Merge hook tools into the defaults: gather, drop removed, dedup by name. */
export function mergeTools(defaults: Tool[], hooks: Hook[]): Tool[] {
  //@ verify
  return dedupTools([], allTools(defaults, hooks), allRemoves(hooks));
}

// ── permission contribution gather (verified) ────────────────────────────────

export function flatten(parts: string[][]): string[] {
  //@ verify
  //@ decreases parts.length
  if (parts.length === 0) return [];
  return [...parts[0], ...flatten(parts.slice(1))];
}

export function gather(base: string[], parts: string[][]): string[] {
  //@ verify
  return [...base, ...flatten(parts)];
}

// ═══════════════════════════════════════════════════════════════════════════
// Verified properties, surfaced as theorems. Each //@ ensures states a property;
// the proof is the generated `_ensures` lemma body in hooks.dfy. They are stated
// over the REAL mergeTools / gather and the verified `contains` / `hasName`
// membership functions (so no Dafny `in` is needed in the spec). The lower-level
// induction lemmas (ContainsCorrect, DedupTools*, FlattenMembership, …) stay in
// hooks.dfy as proof plumbing — several need list append, which //@ specs can't
// express.
// ═══════════════════════════════════════════════════════════════════════════

// H1 removal — a removed tool name never survives the merge.
export function removedExcluded(defaults: Tool[], hooks: Hook[], name: string): boolean {
  //@ verify
  //@ requires contains(allRemoves(hooks), name)
  //@ ensures !hasName(mergeTools(defaults, hooks), name)
  return true;
}

// H2 uniqueness (the dedup fix) — every tool name in the merged result is
// distinct (distinctNames inlined, since //@ specs can't name a ghost predicate).
export function distinctMergedNames(defaults: Tool[], hooks: Hook[]): boolean {
  //@ verify
  //@ ensures forall(i, forall(j, (0 <= i && i < j && j < mergeTools(defaults, hooks).length) ==> mergeTools(defaults, hooks)[i].name !== mergeTools(defaults, hooks)[j].name))
  return true;
}

// coverage — a kept (present, non-removed) name is preserved by the merge.
export function coverage(defaults: Tool[], hooks: Hook[], name: string): boolean {
  //@ verify
  //@ requires hasName(allTools(defaults, hooks), name)
  //@ requires !contains(allRemoves(hooks), name)
  //@ ensures hasName(mergeTools(defaults, hooks), name)
  return true;
}

// H3 order-independence — gather membership is exactly base ∪ contributions, so
// it does not depend on the order in which hooks are listed.
export function gatherMembership(base: string[], parts: string[][], x: string): boolean {
  //@ verify
  //@ ensures contains(gather(base, parts), x) === (contains(base, x) || exists(i, 0 <= i && i < parts.length && contains(parts[i], x)))
  return true;
}

// H4 additivity — gather only ever grows the base (composes with permissions'
// grantMonotone: a hook's contributions can only loosen, never tighten).
export function gatherGrows(base: string[], parts: string[][], x: string): boolean {
  //@ verify
  //@ requires contains(base, x)
  //@ ensures contains(gather(base, parts), x)
  return true;
}

// ── membership-correctness theorems (iff stated as `===`; `in` via .includes) ──

// `contains` decides string membership exactly.
export function containsCorrect(xs: string[], x: string): boolean {
  //@ verify
  //@ decreases xs.length
  //@ ensures contains(xs, x) === xs.includes(x)
  return true;
}

// `hasName` decides name-membership exactly.
export function hasNameCorrect(tools: Tool[], name: string): boolean {
  //@ verify
  //@ decreases tools.length
  //@ ensures hasName(tools, name) === exists(i, 0 <= i && i < tools.length && tools[i].name === name)
  return true;
}

// A name is in the flattened contributions iff it is in some part.
export function flattenMembership(parts: string[][], x: string): boolean {
  //@ verify
  //@ decreases parts.length
  //@ ensures flatten(parts).includes(x) === exists(i, 0 <= i && i < parts.length && parts[i].includes(x))
  return true;
}

// H3 corollary — swapping two hook groups yields the same gather membership.
export function gatherCommutes(base: string[], p: string[], q: string[], x: string): boolean {
  //@ verify
  //@ ensures gather(base, [p, q]).includes(x) === gather(base, [q, p]).includes(x)
  return true;
}

// ── shell wrappers (not verified: build Sets / strings outside the fragment) ──

/** Each field is the verified `gather` of base + contributions (order-independent — H3, additive — H4); flags are OR-ed. */
export function mergePerms(base: PermConfig, hooks: Hook[]): PermConfig {
  const autoAllow = new Set(gather([...base.autoAllow], hooks.map((h) => h.autoAllow ?? [])));
  const autoAllowCwd = new Set(gather([...base.autoAllowCwd], hooks.map((h) => h.autoAllowCwd ?? [])));
  const pathBased = new Set(gather([...base.pathBased], hooks.map((h) => h.pathBased ?? [])));
  let rejectPrompts = base.rejectPrompts;
  for (const h of hooks) if (h.rejectPrompts) rejectPrompts = true;
  return { autoAllow, autoAllowCwd, pathBased, rejectPrompts };
}

/** Concatenate hook system-prompt fragments (henri appends them in order). */
export function mergeSystemPrompt(hooks: Hook[]): string | undefined {
  let prompt: string | undefined;
  for (const h of hooks) {
    if (h.systemPrompt) prompt = prompt === undefined ? h.systemPrompt : prompt + "\n" + h.systemPrompt;
  }
  return prompt;
}

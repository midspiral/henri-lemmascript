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

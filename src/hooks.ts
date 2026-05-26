// Hook / config merge — how henri assembles its tool list and permission tables
// from a base plus a list of hooks.
//
// This is unverified shell: it works with real Tool objects (which carry a
// function-valued `execute`, outside the fragment). All the name- and
// set-membership logic is delegated to the VERIFIED core in merge.ts, so the
// proven guarantees (H1 removal, H2 uniqueness, H3/H4 for permissions) transfer
// to the live tool table and permission config.
//
// NOTE: this diverges from henri intentionally (the H2 fix). Henri concatenated
// hook.TOOLS with no name dedup, so two hooks could register the same name;
// here mergeNames de-dupes (keeping the first occurrence) and that is proved.

import type { Tool } from "./tools/base.ts";
import { gather, mergeNames } from "./merge.ts";

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
  pathBased: Set<string>; // tools whose grants are tracked per-path
  autoAllowCwd: Set<string>; // path-tools auto-allowed within cwd
  autoAllow: Set<string>; // tools always allowed, no prompt
  rejectPrompts: boolean; // automation: deny instead of prompting
}

/**
 * Merge hook tools into the defaults. The set and order of result names is
 * computed by the verified `mergeNames` (no removed name survives — H1; names
 * are distinct — H2); we then map each kept name back to the first Tool object
 * that carries it.
 */
export function mergeTools(defaults: Tool[], hooks: Hook[]): Tool[] {
  const all: Tool[] = [...defaults];
  const removes: string[] = [];
  for (const h of hooks) {
    if (h.tools) all.push(...h.tools);
    if (h.removeTools) removes.push(...h.removeTools);
  }
  const keptNames = mergeNames(all.map((t) => t.name), removes);
  const result: Tool[] = [];
  for (const name of keptNames) {
    const tool = all.find((t) => t.name === name);
    if (tool) result.push(tool);
  }
  return result;
}

/** Merge hook permission config: each field is the verified `gather` of base + contributions (order-independent — H3, additive — H4); flags are OR-ed. */
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

// Hook / config merge — how henri assembles its tool list and permission tables
// from a base plus a list of hooks.
//
// VERIFICATION TARGET (Phase 3). Properties to prove (see DESIGN.md §3.3):
//   H1 removal     — no removed tool name survives the merge
//   H2 uniqueness  — result tool names are distinct (FIX: henri concatenates
//                    hook.TOOLS without de-duping; Phase 3 adds dedup + proof)
//   H3 order-indep — permission-set merge is union + OR, so hook order is moot
//   H4 additivity  — merging only grows allow-sets, so by P3 it never reduces
//                    what decide() permits
//
// NOTE: this Phase-0 version mirrors henri faithfully, including the
// interleaved add-then-remove tool semantics and the *absence* of name dedup.

import type { Tool } from "./tools/base.ts";

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
 * Merge hook tools into the defaults. Faithful to henri: for each hook, append
 * its tools then drop anything that hook removes (so order is significant and a
 * later hook can re-add what an earlier one removed). H2 dedup is deferred.
 */
export function mergeTools(defaults: Tool[], hooks: Hook[]): Tool[] {
  let tools = [...defaults];
  for (const h of hooks) {
    if (h.tools) tools = [...tools, ...h.tools];
    if (h.removeTools) {
      const remove = new Set(h.removeTools);
      tools = tools.filter((t) => !remove.has(t.name));
    }
  }
  return tools;
}

/** Merge hook permission config: union the sets, OR the flags. Order-independent. */
export function mergePerms(base: PermConfig, hooks: Hook[]): PermConfig {
  const pathBased = new Set(base.pathBased);
  const autoAllowCwd = new Set(base.autoAllowCwd);
  const autoAllow = new Set(base.autoAllow);
  let rejectPrompts = base.rejectPrompts;
  for (const h of hooks) {
    for (const s of h.pathBased ?? []) pathBased.add(s);
    for (const s of h.autoAllowCwd ?? []) autoAllowCwd.add(s);
    for (const s of h.autoAllow ?? []) autoAllow.add(s);
    if (h.rejectPrompts) rejectPrompts = true;
  }
  return { pathBased, autoAllowCwd, autoAllow, rejectPrompts };
}

/** Concatenate hook system-prompt fragments (henri appends them in order). */
export function mergeSystemPrompt(hooks: Hook[]): string | undefined {
  let prompt: string | undefined;
  for (const h of hooks) {
    if (h.systemPrompt) prompt = prompt === undefined ? h.systemPrompt : prompt + "\n" + h.systemPrompt;
  }
  return prompt;
}

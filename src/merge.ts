//@ backend dafny

// Verified core of henri's hook/config merge, modeled over tool NAMES (strings)
// and permission contributions (string lists). The production Hook/Tool[] merge
// in hooks.ts calls these functions directly — so the proven name- and
// membership-level guarantees transfer to the live tool table and permissions.
//
// Properties (see DESIGN.md §3.3 and merge.dfy for the proofs):
//   H1 removal     — no removed name survives mergeNames
//   H2 uniqueness  — mergeNames is duplicate-free (THE fix: henri concatenated
//                    hook.TOOLS with no dedup; here dedup is proven)
//   coverage       — a kept (non-removed) name is preserved
//   H3 order-indep — gather membership = base ∪ contributions (order-free)
//   H4 additivity  — gather only grows the base set (so, with permissions' P3,
//                    hooks never reduce what decide() permits)

/** Recursive list membership (=== on arrays is reference equality, so this is the real test). */
export function contains(xs: string[], x: string): boolean {
  //@ decreases xs.length
  if (xs.length === 0) return false;
  if (xs[0] === x) return true;
  return contains(xs.slice(1), x);
}

/** Drop every name that appears in `removes`, preserving order. */
export function removeAll(names: string[], removes: string[]): string[] {
  //@ decreases names.length
  if (names.length === 0) return [];
  const rest = removeAll(names.slice(1), removes);
  if (contains(removes, names[0])) return rest;
  return [names[0], ...rest];
}

/** Keep the first occurrence of each name, dropping later duplicates. */
export function dedupFrom(acc: string[], names: string[]): string[] {
  //@ decreases names.length
  if (names.length === 0) return acc;
  if (contains(acc, names[0])) return dedupFrom(acc, names.slice(1));
  return dedupFrom([...acc, names[0]], names.slice(1));
}

export function dedup(names: string[]): string[] {
  return dedupFrom([], names);
}

/** The merged tool-name list: remove the removed, then dedup. */
export function mergeNames(names: string[], removes: string[]): string[] {
  return dedup(removeAll(names, removes));
}

/** Concatenate a list of contribution lists. */
export function flatten(parts: string[][]): string[] {
  //@ decreases parts.length
  if (parts.length === 0) return [];
  return [...parts[0], ...flatten(parts.slice(1))];
}

/** Gather a base list with all hook contributions (used per permission field). */
export function gather(base: string[], parts: string[][]): string[] {
  return [...base, ...flatten(parts)];
}

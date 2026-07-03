// Self-improvement (reflection) — the unverified shell side.
//
// Adopted self-improvements are hook modules under self/hooks/*.hook.ts, each
// default-exporting a Hook. They are loaded here and enter the session through
// the VERIFIED merge (hooks.ts), so the safety of self-extension is a theorem,
// not a convention:
//   - mediation (session S1): a self-added tool is still gated — no event
//     sequence reaches an ungated effect;
//   - non-shadowing (hooks H2 + coverage): defaults come first and the merge
//     keeps the first occurrence of each name, so a self-authored tool can
//     never replace bash / edit_file / any trusted default;
//   - additivity (hooks H4): contributions only loosen, never tighten — a
//     self-improvement adds capability, it cannot silently remove any.
// The third layer — guarantees may be added but never weakened or removed
// across self-edits — is scripts/gate.sh (lemmascript-seal). See SELF.md.
//
// self/hooks/ resolves against THIS installation (the agent's own body), not
// the process cwd: henri may be launched anywhere, but its self is here.

import { readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import * as path from "node:path";
import type { Hook } from "./hooks.ts";

/** Repo root of this henri installation — the source the agent may improve. */
export const SELF_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SELF_HOOKS_DIR = path.join(SELF_ROOT, "self", "hooks");

/** Load every adopted self-improvement hook (sorted for determinism — the
 * verified merge is order-independent anyway, H3). Missing dir = no hooks. */
export async function loadSelfHooks(): Promise<Hook[]> {
  let entries: string[];
  try {
    entries = readdirSync(SELF_HOOKS_DIR);
  } catch {
    return [];
  }
  const hooks: Hook[] = [];
  for (const name of entries.filter((n) => /\.hook\.(ts|js)$/.test(n)).sort()) {
    const mod = await import(pathToFileURL(path.join(SELF_HOOKS_DIR, name)).href);
    hooks.push((mod.default ?? mod) as Hook);
  }
  return hooks;
}

/** Reflection mode (--self): the self-improvement protocol, contributed as a
 * system-prompt fragment through the same verified hook merge. */
export function reflectionProtocol(): Hook {
  return {
    systemPrompt: `You are henri, running on your own source code at ${SELF_ROOT}.
You may improve yourself by writing new auxiliary tools. The protocol:

1. One improvement = one hook module self/hooks/<name>.hook.ts (default-export a
   Hook whose \`tools\` contribute Tool objects — interface in src/tools/base.ts)
   plus a VERIFIED decision core self/core/<name>.ts. Everything that can be a
   pure decision goes in the core; only effectful glue (fs, subprocess, network)
   stays in the hook. Imitate the split in src/edit.ts (core) vs src/tools/base.ts
   (shell), including how the shell imports and calls the verified functions.
2. The core is LemmaScript-verified: start it with '//@ backend dafny', mark
   functions '//@ verify', state contracts with '//@ requires' / '//@ ensures' /
   '//@ decreases'. Grammar and worked examples: LS_TUTORIAL.md; the existing
   cores (src/edit.ts, src/hooks.ts) are the house style. Iterate with:
     npm run check -- self/core/<name>.ts
3. Register the core by appending its path to LemmaScript-files.txt. Append only
   — never reorder or remove lines.
4. NEVER edit SEALED.lock, and never change or delete an existing //@ requires /
   //@ ensures / //@ contract anywhere in the codebase — the guarantee ledger
   rejects any improvement that weakens or removes a frozen contract. To make a
   guarantee stronger, add a NEW lemma proving the extra property. Guarantees
   accumulate; they never retract.
5. Submit through the gate — the only sanctioned door:
     scripts/gate.sh                  dry run: ledger → prover → typecheck+tests → freeze
     scripts/gate.sh --adopt "<msg>"  same, and on green commit the improvement
   An adopted improvement takes effect on the next launch: the next generation
   of you. If the gate is RED, read why, revert or repair, and resubmit. Never
   work around the gate — no direct commits, no edits to the ledger.`,
  };
}

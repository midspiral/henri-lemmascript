// Regression tests for two confirmed permission-gate escapes (both fixed in the
// trusted projection, permission-gate.ts — the verified core is unchanged):
//
//   1. glob's traversal is driven by `pattern`, not `path`: glob({path:".",
//      pattern:"../*.pem"}) reached OUTSIDE cwd while the gate saw only path="."
//      (inside cwd) and auto-allowed it.
//   2. read_file follows symlinks: a symlink inside cwd pointing outside was
//      auto-allowed (lexical containment held; the real target was elsewhere).
//
// Both must now be gated: PermissionGate.check PROMPTS (rather than silently
// auto-allowing), while legitimate in-cwd access must still auto-allow with no
// prompt. The spy `ask` denies every prompt, so a gated call resolves to false.
// Run: npx tsx test/permission-escape.ts

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_AUTO_ALLOW_CWD, DEFAULT_PATH_BASED, PermissionGate, emptyState } from "../src/permission-gate.ts";
import type { Tool } from "../src/tools/base.ts";
import type { ToolCall } from "../src/messages.ts";

let n = 0;
function check(name: string, cond: boolean): void {
  assert.ok(cond, name);
  n += 1;
}

// Sandbox: cwd is `root/project`; `secret.pem` sits in `root` — a sibling OUTSIDE cwd.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "henri-escape-"));
const proj = path.join(root, "project");
await fs.mkdir(path.join(proj, "sub"), { recursive: true });
await fs.writeFile(path.join(root, "secret.pem"), "PRIVATE KEY\n");
await fs.writeFile(path.join(proj, "notes.txt"), "hello\n");
await fs.symlink(path.join(root, "secret.pem"), path.join(proj, "innocent.txt"));
process.chdir(proj);

// A spy prompt that denies everything — so a gated (prompted) call resolves false,
// and we can tell "prompted" (gated) from "auto-allowed" by whether ask fired.
let asks = 0;
const ask = async (): Promise<string> => {
  asks += 1;
  return "n";
};
const gate = new PermissionGate(
  emptyState(new Set(), new Set(DEFAULT_AUTO_ALLOW_CWD), false),
  new Set(DEFAULT_PATH_BASED),
  ask,
);

const tool = (name: string): Tool => ({ name, requiresPermission: true } as unknown as Tool);
const callOf = (name: string, args: Record<string, unknown>): ToolCall => ({ id: "c", name, args });

async function run(name: string, args: Record<string, unknown>): Promise<{ allowed: boolean; prompted: boolean }> {
  const before = asks;
  const allowed = await gate.check(tool(name), callOf(name, args));
  return { allowed, prompted: asks > before };
}

// ── Finding 1: glob pattern escape is now gated ──────────────────────────────
{
  const r = await run("glob", { path: ".", pattern: "../*.pem" });
  check("glob ../ pattern prompts (not auto-allowed)", r.prompted);
  check("glob ../ pattern denied when user declines", !r.allowed);
}
{
  const r = await run("glob", { path: "sub", pattern: "../../*.pem" });
  check("glob sub + ../../ pattern prompts", r.prompted);
}
{
  // In-cwd glob must still auto-allow (no over-blocking; wildcards only descend).
  const r = await run("glob", { path: ".", pattern: "**/*.txt" });
  check("glob in-cwd auto-allowed (no prompt)", !r.prompted && r.allowed);
}

// ── Finding 2: symlink escape is now gated ───────────────────────────────────
{
  const r = await run("read_file", { path: "innocent.txt" });
  check("read_file via out-of-cwd symlink prompts", r.prompted);
  check("read_file via out-of-cwd symlink denied when user declines", !r.allowed);
}
{
  // A real in-cwd file must still auto-allow.
  const r = await run("read_file", { path: "notes.txt" });
  check("read_file real in-cwd file auto-allowed", !r.prompted && r.allowed);
}
{
  // Lexical ../ escape (the original P2 concern) still gated.
  const r = await run("read_file", { path: "../secret.pem" });
  check("read_file ../secret.pem prompts", r.prompted);
}

await fs.rm(root, { recursive: true, force: true });
console.log(`permission-escape: ${n} checks passed`);

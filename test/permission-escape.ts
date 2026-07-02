// Regression tests for two confirmed permission-gate escapes (both fixed in the
// trusted projection, permission-gate.ts — the verified core is unchanged):
//
//   1. glob's traversal is driven by `pattern`, not `path`: glob({path:".",
//      pattern:"../*.pem"}) reached OUTSIDE cwd while the gate saw only path="."
//      (inside cwd) and auto-allowed it.
//   2. read_file follows symlinks: a symlink inside cwd pointing outside was
//      auto-allowed (lexical containment held; the real target was elsewhere).
//
// Both must now be gated (decide → Prompt, verdictFor → "prompt"), while
// legitimate in-cwd access must still auto-allow (no over-blocking).
// Run: npx tsx test/permission-escape.ts

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { decide, type PermState } from "../src/permissions.ts";
import { buildReq, currentCwd, DEFAULT_AUTO_ALLOW_CWD, DEFAULT_PATH_BASED, emptyState } from "../src/permission-gate.ts";
import { verdictFor, type SCall, type Session } from "../src/session.ts";
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

const cwd = currentCwd();
const perms: PermState = emptyState(new Set(), new Set(DEFAULT_AUTO_ALLOW_CWD), false);

function scall(name: string, args: Record<string, unknown>): { req: SCall["req"]; sc: SCall } {
  const tc: ToolCall = { id: "c", name, args };
  const req = buildReq(DEFAULT_PATH_BASED, cwd, name, tc);
  return { req, sc: { id: "c", name, req, known: true, noPerm: false, argsOk: true } };
}
function st(): Session {
  return { msgs: [], perms, cwd, phase: { kind: "idle" }, turns: 0, maxTurns: 0, compactKeep: 6, autoCompactAt: 0, lastContextTokens: 0 };
}

// ── Finding 1: glob pattern escape is now gated ──────────────────────────────
{
  const { req, sc } = scall("glob", { path: ".", pattern: "../*.pem" });
  check("glob ../ pattern → Prompt", decide(perms, cwd, req) === "Prompt");
  check("glob ../ pattern → verdict prompt", verdictFor(st(), sc) === "prompt");
}
{
  // Deeper traversal via the pattern.
  const { req } = scall("glob", { path: "sub", pattern: "../../*.pem" });
  check("glob sub + ../../ pattern → Prompt", decide(perms, cwd, req) === "Prompt");
}
{
  // In-cwd glob must still auto-allow (no over-blocking; wildcards only descend).
  const { req, sc } = scall("glob", { path: ".", pattern: "**/*.txt" });
  check("glob in-cwd → Allow", decide(perms, cwd, req) === "Allow");
  check("glob in-cwd → verdict exec", verdictFor(st(), sc) === "exec");
}

// ── Finding 2: symlink escape is now gated ───────────────────────────────────
{
  const { req, sc } = scall("read_file", { path: "innocent.txt" });
  check("read_file via out-of-cwd symlink → Prompt", decide(perms, cwd, req) === "Prompt");
  check("read_file via out-of-cwd symlink → verdict prompt", verdictFor(st(), sc) === "prompt");
}
{
  // A real in-cwd file must still auto-allow.
  const { req, sc } = scall("read_file", { path: "notes.txt" });
  check("read_file real in-cwd file → Allow", decide(perms, cwd, req) === "Allow");
  check("read_file real in-cwd file → verdict exec", verdictFor(st(), sc) === "exec");
}
{
  // Lexical ../ escape (the original P2 concern) still gated.
  const { req } = scall("read_file", { path: "../secret.pem" });
  check("read_file ../secret.pem → Prompt", decide(perms, cwd, req) === "Prompt");
}

await fs.rm(root, { recursive: true, force: true });
console.log(`permission-escape: ${n} checks passed`);

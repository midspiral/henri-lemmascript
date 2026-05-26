// Smoke test for the verified-core modules — runtime witnesses for the
// properties we'll prove in Dafny (Phases 1–3). Run: npx tsx test/smoke.ts

import assert from "node:assert/strict";
import { decide, isWithin, normalize, type PermState, type Req } from "../src/permissions.ts";
import { makeResults, pairs, wellFormed, type TMsg } from "../src/transcript.ts";
import { mergePerms, mergeTools, type Hook, type PermConfig } from "../src/hooks.ts";
import type { Tool } from "../src/tools/base.ts";

let n = 0;
function check(name: string, cond: boolean): void {
  assert.ok(cond, name);
  n += 1;
}

// ── permissions: normalize / isWithin (P2 witnesses) ──────────────────────────
check("normalize resolves ..", JSON.stringify(normalize(["a", "b", "..", "c"])) === JSON.stringify(["a", "c"]));
check("normalize drops . and empty", JSON.stringify(normalize(["a", ".", "", "b"])) === JSON.stringify(["a", "b"]));
check("normalize cannot pop above root", JSON.stringify(normalize(["..", "..", "x"])) === JSON.stringify(["x"]));
check("isWithin prefix", isWithin(["Users", "namin"], ["Users", "namin", "code"]));
check("isWithin self", isWithin(["Users", "namin"], ["Users", "namin"]));
check("isWithin rejects sibling", !isWithin(["Users", "namin"], ["Users", "other"]));
check("isWithin rejects shorter", !isWithin(["Users", "namin"], ["Users"]));

// ── permissions: decide ───────────────────────────────────────────────────────
const cwd = ["Users", "namin", "code"];
function st(over: Partial<PermState> = {}): PermState {
  return {
    autoAllow: new Set(),
    autoAllowCwd: new Set(["read_file"]),
    allowedTools: new Set(),
    allowedBashCommands: new Set(),
    allowedPaths: new Map(),
    allowAll: false,
    rejectPrompts: false,
    ...over,
  };
}
const readInCwd: Req = { kind: "path", tool: "read_file", segs: ["src", "a.ts"], absolute: false };
const readEscape: Req = { kind: "path", tool: "read_file", segs: ["..", "..", "secret"], absolute: false };
const readAbsEscape: Req = { kind: "path", tool: "read_file", segs: ["etc", "passwd"], absolute: true };

check("allowAll => Allow", decide(st({ allowAll: true }), cwd, { kind: "other", tool: "bash" }) === "Allow");
check("autoAllow tool => Allow", decide(st({ autoAllow: new Set(["bash"]) }), cwd, { kind: "bash", command: "ls" }) === "Allow");
check("read within cwd auto-allowed", decide(st(), cwd, readInCwd) === "Allow");
// P2: a path that escapes cwd is NOT auto-granted
check("read escaping cwd is NOT auto-allowed", decide(st(), cwd, readEscape) === "Prompt");
check("absolute escape is NOT auto-allowed", decide(st(), cwd, readAbsEscape) === "Prompt");
// write_file is path-based but NOT auto-allow-cwd => always prompts even within cwd
check("write within cwd still prompts", decide(st(), cwd, { kind: "path", tool: "write_file", segs: ["a.ts"], absolute: false }) === "Prompt");
// exact bash command grant
check("exact bash command allowed", decide(st({ allowedBashCommands: new Set(["ls -la"]) }), cwd, { kind: "bash", command: "ls -la" }) === "Allow");
check("different bash command prompts", decide(st({ allowedBashCommands: new Set(["ls -la"]) }), cwd, { kind: "bash", command: "rm -rf /" }) === "Prompt");
// allowed tool
check("allowed other tool", decide(st({ allowedTools: new Set(["web_fetch"]) }), cwd, { kind: "other", tool: "web_fetch" }) === "Allow");
// P4: rejectPrompts turns Prompt into Deny, never Allow
check("rejectPrompts => Deny not Prompt", decide(st({ rejectPrompts: true }), cwd, readEscape) === "Deny");
check("rejectPrompts still allows justified", decide(st({ rejectPrompts: true }), cwd, readInCwd) === "Allow");
// P3: granting (here allowAll) flips a previous Prompt to Allow
check("P3 monotonicity: grant flips Prompt->Allow", decide(st(), cwd, readEscape) === "Prompt" && decide(st({ allowAll: true }), cwd, readEscape) === "Allow");

// ── transcript: pairing / well-formedness (T1/T2 witnesses) ───────────────────
const calls = [{ id: "a", name: "bash" }, { id: "b", name: "read_file" }];
check("T1: makeResults pairs", pairs(calls, makeResults(calls)));
check("pairs rejects wrong length", !pairs(calls, [{ toolCallId: "a", isError: false }]));
check("pairs rejects wrong id", !pairs(calls, [{ toolCallId: "a", isError: false }, { toolCallId: "x", isError: false }]));

const good: TMsg[] = [
  { role: "user" },
  { role: "assistant", toolCalls: calls },
  { role: "tool", toolResults: makeResults(calls) },
  { role: "assistant", toolCalls: [] },
];
check("T2: well-formed transcript", wellFormed(good));
check("orphan tool message rejected", !wellFormed([{ role: "user" }, { role: "tool", toolResults: [{ toolCallId: "a", isError: false }] }]));
check("unanswered tool_use rejected", !wellFormed([{ role: "assistant", toolCalls: calls }]));

// ── hooks: merge (H1 witness) ─────────────────────────────────────────────────
const tool = (name: string): Tool => ({ name, description: "", parameters: { type: "object", properties: {} }, requiresPermission: false, execute: async () => "" });
const defaults = [tool("bash"), tool("read_file")];
const hooks: Hook[] = [{ tools: [tool("dafny_verify")], removeTools: ["bash"] }];
const merged = mergeTools(defaults, hooks);
check("H1: removed tool gone", !merged.some((t) => t.name === "bash"));
check("H1: hook tool present", merged.some((t) => t.name === "dafny_verify"));

const base: PermConfig = { pathBased: new Set(["read_file"]), autoAllowCwd: new Set(["read_file"]), autoAllow: new Set(), rejectPrompts: false };
const mp = mergePerms(base, [{ autoAllow: ["dafny_verify"], pathBased: ["dafny_verify"], rejectPrompts: true }]);
check("H3: perms unioned", mp.autoAllow.has("dafny_verify") && mp.pathBased.has("read_file") && mp.pathBased.has("dafny_verify"));
check("H3: rejectPrompts OR-ed", mp.rejectPrompts === true);

console.log(`\x1b[32mAll ${n} checks passed.\x1b[0m`);

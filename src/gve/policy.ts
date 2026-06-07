// henri tool classification + the exfil security policy for generate-verify-execute
// mode (DESIGN_GVE.md §5). The plan DSL and the `Policy` shape come from the verified
// `guardians` kernel; this file only declares which henri tools play which role.
//
// The proved check (`verify().taintWf`, via guardians `wf_core.leaksWf`) is
// ORDER/CONTROL based: it flags when a source tool precedes a sink tool with the taint
// bit set — a SOUND OVER-APPROXIMATION. It does not inspect which argument the data
// flows into (that is the unverified `taintPrecise` path), so it may over-flag (e.g. a
// `bash` that runs after a `web_fetch` but ignores the fetched content). Over-flag,
// never miss. A tool that is both source and sink (e.g. `web_fetch`) is safe on a
// single occurrence — `leaksWf` keys the sink on *incoming* taint — and only leaks when
// a second sink-while-tainted step follows a source.
import type { Policy, TaintRule } from "guardians";

// Untrusted-/sensitive-ingress tools: their RESULT carries taint.
export const HENRI_SOURCES = ["web_fetch", "read_file"] as const;

// Externally-communicating tools: dangerous when reached while tainted. `param` is the
// argument a real flow would land in (used only by the precise/provenance report; the
// proved gate is tool-order based and ignores it).
export const HENRI_SINKS: ReadonlyArray<{ tool: string; param: string }> = [
  { tool: "web_fetch", param: "url" }, // outbound request — exfil via URL/query
  { tool: "bash", param: "command" }, // shell — exfil (curl/nc) or injected execution
];

export const HENRI_TOOLS = [
  "web_fetch", "read_file", "write_file", "edit_file", "grep", "glob", "bash",
] as const;

// Default policy: no untrusted/sensitive source may reach an external sink.
// sanitizers: none yet (henri has no declassifier tool; a future allowlist/redact step
// could clear taint). automaton: none yet (sequence policies are a later stage).
export function exfilPolicy(): Policy {
  const taintRules: TaintRule[] = [];
  for (const s of HENRI_SOURCES) {
    for (const k of HENRI_SINKS) {
      taintRules.push({ name: `${s}→${k.tool}`, sourceTool: s, sinkTool: k.tool, sinkParam: k.param });
    }
  }
  return {
    allowedTools: [...HENRI_TOOLS],
    sources: [...HENRI_SOURCES],
    sanitizers: [],
    taintRules,
    automataOnTool: [],
  };
}

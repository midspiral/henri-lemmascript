// Capability-separation SEQUENCE policy (DESIGN_GVE.md §5): after exposure to untrusted
// web content, reading a SENSITIVE file is forbidden — so an injected page cannot steer
// the agent into accessing secrets. This is *additive* to the taint check: `read_file`
// is not a taint sink, so `web_fetch → read_file(.env)` is NOT flagged by `taintWf`.
//
// The DECISION is the PROVED guardians `reachesErrorAbstract` (automaton_core;
// `automatonSound` proves a clean static verdict ⟹ no concrete run reaches the error
// state). The token classification — which step is an untrusted fetch / a sensitive read
// — is the trusted projection (the source/sink-classification analog).
import { reachesErrorAbstract } from "guardians";
import type { ToolStep, Arg } from "guardians";

// Substrings that mark a path as sensitive (trusted config).
export const SENSITIVE_PATHS = [
  ".env", ".pem", ".key", "id_rsa", "id_ed25519", "credentials", "secret", ".aws", ".ssh",
];

export function isSensitivePath(p: string): boolean {
  const low = p.toLowerCase();
  return SENSITIVE_PATHS.some((s) => low.includes(s));
}

// Tokens fed to the automaton.
const OTHER = 0;
const UNTRUSTED_FETCH = 1;
const SENSITIVE_READ = 2;

function literalArg(a: Arg | undefined): string {
  return typeof a === "string" ? a : "";
}

// Trusted projection: a plan step → its automaton token.
function token(s: ToolStep): number {
  if (s.tool === "web_fetch") return UNTRUSTED_FETCH;
  if (s.tool === "read_file" && isSensitivePath(literalArg(s.args["path"]))) return SENSITIVE_READ;
  return OTHER;
}

// Automaton states: 0 = clean, 1 = touched untrusted content, ERR = violated.
const ERR = 9;
function nextOn(state: number, tok: number, _guard: boolean): number {
  if (state === ERR) return ERR;
  if (tok === UNTRUSTED_FETCH) return state === 0 ? 1 : state;
  if (tok === SENSITIVE_READ && state === 1) return ERR;
  return state;
}

// Does the plan's tool sequence reach the error state? Decision = proved reachesErrorAbstract.
export function sequenceViolation(steps: ToolStep[]): boolean {
  const seq = steps.map(token);
  return reachesErrorAbstract((st) => st === ERR, nextOn, 0, seq);
}

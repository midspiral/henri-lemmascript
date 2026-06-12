// The shell side of permissions: the Req projection and the interactive
// y/n/a/A prompt. This is unverified shell — but unlike before, it makes NO
// decisions and records NO grants: the decision is the verified session core's
// verdictFor (permissions.ts decide), and grant recording is the verified
// grantFor/grantAll transition (session.ts onPromptAnswer). This layer only
// maps a concrete (Tool, ToolCall) to a Req and asks the user.

import type { ToolCall } from "./messages.ts";
import type { Tool } from "./tools/base.ts";
import { decide, grantAll, grantFor, normalize, resolvePath, type PermState, type Req } from "./permissions.ts";
import type { Answer } from "./session.ts";
import { color, panel } from "./ui.ts";

export const DEFAULT_PATH_BASED = new Set(["grep", "glob", "read_file", "write_file", "edit_file"]);
export const DEFAULT_AUTO_ALLOW_CWD = new Set(["grep", "glob", "read_file"]);

export function emptyState(autoAllow: Set<string>, autoAllowCwd: Set<string>, rejectPrompts: boolean): PermState {
  return {
    autoAllow,
    autoAllowCwd,
    allowedTools: new Set(),
    allowedBashCommands: new Set(),
    allowedPaths: [],
    allowAll: false,
    rejectPrompts,
  };
}

export function currentCwd(): string[] {
  return normalize(process.cwd().split("/"));
}

/** Project a concrete tool call onto the permission request the verified core
 *  decides on. (The trusted projection — same as it ever was.) */
export function buildReq(pathBased: Set<string>, toolName: string, call: ToolCall): Req {
  if (toolName === "bash") {
    return { kind: "bash", command: typeof call.args["command"] === "string" ? (call.args["command"] as string) : "" };
  }
  if (pathBased.has(toolName)) {
    const raw = typeof call.args["path"] === "string" ? (call.args["path"] as string) : ".";
    return { kind: "path", tool: toolName, segs: raw.split("/"), absolute: raw.startsWith("/") };
  }
  return { kind: "other", tool: toolName };
}

/** Ask the user about a call the verified core marked "prompt". Pure UI: the
 *  answer goes back into the core as a promptAnswer event. */
export async function promptUser(
  ask: (q: string) => Promise<string>,
  cwd: string[],
  tool: Tool,
  call: ToolCall,
  req: Req,
): Promise<Answer> {
  const args = Object.entries(call.args)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join("\n");
  console.log();
  console.log(panel(`${color.bold(tool.name)}\n${args}`, { title: "Permission Required", border: "yellow" }));

  const alwaysDesc =
    req.kind === "bash" ? "this command" : req.kind === "path" ? `${tool.name} to this path` : tool.name;

  for (;;) {
    const raw = (await ask(color.dim(`(y)es / (n)o / (a)lways allow ${alwaysDesc} / (A)ll: `))).trim();
    if (raw === "A" || raw === "All") {
      console.log(color.dim("Will allow all tools for this session"));
      return "all";
    }
    const r = raw.toLowerCase();
    if (r === "y" || r === "yes") return "yes";
    if (r === "n" || r === "no") return "no";
    if (r === "a" || r === "always") {
      if (req.kind === "bash") {
        console.log(color.dim("Will allow this exact command for this session"));
      } else if (req.kind === "path") {
        const resolved = resolvePath(cwd, req.segs, req.absolute);
        console.log(color.dim(`Will allow ${req.tool} access to '/${resolved.join("/")}' for this session`));
      } else {
        console.log(color.dim(`Will allow '${req.tool}' for this session`));
      }
      return "always";
    }
    console.log(color.red("Please enter y, n, a, or A"));
  }
}

/** A standalone check-one-call gate for callers outside the session loop (the
 *  GVE executor's runtime residual). The decision is the verified decide();
 *  grants are recorded via the verified grantFor/grantAll builders, so even
 *  here the permission state only ever changes through proven transitions. */
export class InteractiveGate {
  constructor(
    public state: PermState,
    public pathBased: Set<string>,
    private ask: (q: string) => Promise<string>,
    private cwd: string[] = currentCwd(),
  ) {}

  async check(tool: Tool, call: ToolCall): Promise<boolean> {
    if (!tool.requiresPermission) return true;
    const req = buildReq(this.pathBased, tool.name, call);
    const outcome = decide(this.state, this.cwd, req);
    if (outcome === "Allow") return true;
    if (outcome === "Deny") {
      console.log(color.dim(`Auto-denied: ${tool.name}`));
      return false;
    }
    const answer = await promptUser(this.ask, this.cwd, tool, call, req);
    if (answer === "no") return false;
    if (answer === "always") this.state = grantFor(this.state, this.cwd, req);
    if (answer === "all") this.state = grantAll(this.state, this.cwd, req);
    return true;
  }
}

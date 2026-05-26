// Stateful, interactive wrapper around the verified decision in permissions.ts.
//
// This is unverified shell: it owns the mutable session grants and the y/n/a/A
// prompt. Every actual allow/deny flows through decide(); this layer only maps a
// concrete (Tool, ToolCall) to a Req, prompts on "Prompt", and records grants.

import type { ToolCall } from "./messages.ts";
import type { Tool } from "./tools/base.ts";
import { decide, normalize, pathKey, resolvePath, type PermState, type Req } from "./permissions.ts";
import { color, panel } from "./ui.ts";

export const DEFAULT_PATH_BASED = new Set(["grep", "glob", "read_file", "write_file", "edit_file"]);
export const DEFAULT_AUTO_ALLOW_CWD = new Set(["grep", "glob", "read_file"]);

export function emptyState(autoAllow: Set<string>, autoAllowCwd: Set<string>, rejectPrompts: boolean): PermState {
  return {
    autoAllow,
    autoAllowCwd,
    allowedTools: new Set(),
    allowedBashCommands: new Set(),
    allowedPaths: new Map(),
    allowAll: false,
    rejectPrompts,
  };
}

export class PermissionGate {
  private cwd = normalize(process.cwd().split("/"));

  constructor(
    public state: PermState,
    public pathBased: Set<string>,
    private ask: (q: string) => Promise<string>,
  ) {}

  private buildReq(tool: Tool, call: ToolCall): Req {
    if (tool.name === "bash") {
      return { kind: "bash", command: typeof call.args["command"] === "string" ? call.args["command"] : "" };
    }
    if (this.pathBased.has(tool.name)) {
      const raw = typeof call.args["path"] === "string" ? (call.args["path"] as string) : ".";
      return { kind: "path", tool: tool.name, segs: raw.split("/"), absolute: raw.startsWith("/") };
    }
    return { kind: "other", tool: tool.name };
  }

  async check(tool: Tool, call: ToolCall): Promise<boolean> {
    if (!tool.requiresPermission) return true;

    const req = this.buildReq(tool, call);
    const outcome = decide(this.state, this.cwd, req);

    if (outcome === "Allow") return true;
    if (outcome === "Deny") {
      console.log(color.dim(`Auto-denied: ${tool.name}`));
      return false;
    }
    return this.promptUser(tool, call, req);
  }

  private async promptUser(tool: Tool, call: ToolCall, req: Req): Promise<boolean> {
    const args = Object.entries(call.args)
      .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
      .join("\n");
    console.log();
    console.log(panel(`${color.bold(tool.name)}\n${args}`, { title: "Permission Required", border: "yellow" }));

    const alwaysDesc =
      req.kind === "bash" ? "this command" : req.kind === "path" ? `${tool.name} to this path` : tool.name;

    for (;;) {
      const raw = (await this.ask(color.dim(`(y)es / (n)o / (a)lways allow ${alwaysDesc} / (A)ll: `))).trim();
      if (raw === "A" || raw === "All") {
        this.state.allowAll = true;
        console.log(color.dim("Will allow all tools for this session"));
        return true;
      }
      const r = raw.toLowerCase();
      if (r === "y" || r === "yes") return true;
      if (r === "n" || r === "no") return false;
      if (r === "a" || r === "always") {
        this.recordGrant(req);
        return true;
      }
      console.log(color.red("Please enter y, n, a, or A"));
    }
  }

  private recordGrant(req: Req): void {
    if (req.kind === "bash") {
      this.state.allowedBashCommands.add(req.command);
      console.log(color.dim("Will allow this exact command for this session"));
    } else if (req.kind === "path") {
      const key = pathKey(resolvePath(this.cwd, req.segs, req.absolute));
      let set = this.state.allowedPaths.get(req.tool);
      if (!set) {
        set = new Set();
        this.state.allowedPaths.set(req.tool, set);
      }
      set.add(key);
      console.log(color.dim(`Will allow ${req.tool} access to '${key}' for this session`));
    } else {
      this.state.allowedTools.add(req.tool);
      console.log(color.dim(`Will allow '${req.tool}' for this session`));
    }
  }
}

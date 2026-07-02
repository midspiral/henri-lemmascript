// Stateful, interactive wrapper around the verified decision in permissions.ts.
//
// This is unverified shell: it owns the mutable session grants and the y/n/a/A
// prompt. Every actual allow/deny flows through decide(); this layer only maps a
// concrete (Tool, ToolCall) to a Req, prompts on "Prompt", and records grants.

import * as fs from "node:fs";
import type { ToolCall } from "./messages.ts";
import type { Tool } from "./tools/base.ts";
import { decide, normalize, normalizeFrom, resolvePath, type PermState, type Req } from "./permissions.ts";
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

/** The current working directory as symlink-faithful normalized segments. */
function realCwd(): string[] {
  let cwd = process.cwd();
  try {
    cwd = fs.realpathSync(cwd);
  } catch {
    // Keep the lexical cwd if realpath fails (should not happen for an extant cwd).
  }
  return normalize(cwd.split("/"));
}

/** Symlink-faithful resolution of an absolute (already-normalized) segment list:
 *  realpath the deepest EXISTING ancestor and keep any non-existent tail, so a
 *  write target that does not exist yet still resolves symlinks in its parents.
 *  This is the trusted OS boundary — the containment DECISION over the result is
 *  the verified isWithin. It is what makes P2 hold at runtime rather than only
 *  over lexical segments: a symlink inside cwd pointing outside now resolves to
 *  its real (out-of-cwd) location before the gate decides. */
function realpathFaithful(absSegs: string[]): string[] {
  const tail: string[] = [];
  let probe = absSegs.slice();
  while (probe.length > 0) {
    try {
      const real = fs.realpathSync("/" + probe.join("/"));
      return normalize([...real.split("/"), ...tail]);
    } catch {
      tail.unshift(probe[probe.length - 1]);
      probe = probe.slice(0, -1);
    }
  }
  return normalize(tail);
}

export class PermissionGate {
  private cwd = realCwd();

  constructor(
    public state: PermState,
    public pathBased: Set<string>,
    private ask: (q: string) => Promise<string>,
  ) {}

  /** Project a concrete tool call onto the permission request the verified core
   *  decides on. The trusted projection: it resolves symlinks (realpath) and folds
   *  glob's traversal-bearing pattern, so the segments handed to the verified
   *  `decide` faithfully represent the effect the tool will have. Two escapes that
   *  lived here are now closed: a `glob` whose PATTERN (not path) carries `../`
   *  (`glob({path:".", pattern:"../*.pem"})` reaches OUTSIDE cwd), and a symlink
   *  inside cwd pointing out (`read_file` follows it). Both now fail `isWithin` and
   *  cannot be auto-allowed. */
  private buildReq(tool: Tool, call: ToolCall): Req {
    if (tool.name === "bash") {
      return { kind: "bash", command: typeof call.args["command"] === "string" ? call.args["command"] : "" };
    }
    if (this.pathBased.has(tool.name)) {
      const raw = typeof call.args["path"] === "string" ? (call.args["path"] as string) : ".";
      const absolute = raw.startsWith("/");
      const baseLexical = absolute ? normalize(raw.split("/")) : normalize([...this.cwd, ...raw.split("/")]);
      let reach = realpathFaithful(baseLexical);
      // glob's traversal is driven by the PATTERN, not the path: fold it in so a
      // `..` in the pattern participates in containment (normalizeFrom resolves it).
      if (tool.name === "glob") {
        const pattern = typeof call.args["pattern"] === "string" ? (call.args["pattern"] as string) : "";
        reach = normalizeFrom(reach, pattern.split("/"));
      }
      // Absolute (already normalized) segments; the verified resolvePath normalizes in place.
      return { kind: "path", tool: tool.name, segs: reach, absolute: true };
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
      const resolved = resolvePath(this.cwd, req.segs, req.absolute);
      this.state.allowedPaths.push({ tool: req.tool, segs: resolved });
      console.log(color.dim(`Will allow ${req.tool} access to '/${resolved.join("/")}' for this session`));
    } else {
      this.state.allowedTools.add(req.tool);
      console.log(color.dim(`Will allow '${req.tool}' for this session`));
    }
  }
}

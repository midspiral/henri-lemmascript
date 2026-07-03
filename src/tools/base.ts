// Base tool interface and built-in tools.
//
// Tools are the effectful boundary: subprocess, filesystem, network. None of
// this is verified. The *decisions* about whether to run them (permissions) and
// how their results thread back into the conversation (transcript) are.

import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { glob as fsGlob } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { editFile, replaceFirst } from "../edit.ts";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Long-running commands (e.g. the reflection gate's full Dafny run) need more
// than the default 2 minutes: set HENRI_BASH_TIMEOUT_MS.
const BASH_TIMEOUT_MS = Number(process.env["HENRI_BASH_TIMEOUT_MS"] ?? 120_000);

export interface Tool {
  name: string;
  description: string;
  parameters: object; // JSON Schema
  requiresPermission: boolean;
  /**
   * Run the tool. `signal`, when aborted (Esc), cancels long-running work
   * (subprocess / network); the loop also short-circuits any not-yet-started
   * call to a paired `[interrupted by user]` result, preserving call/result
   * pairing (transcript T1).
   */
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

function str(args: Record<string, unknown>, key: string, fallback = ""): string {
  const v = args[key];
  return typeof v === "string" ? v : fallback;
}

export const bashTool: Tool = {
  name: "bash",
  description: "Execute a shell command and return its output.",
  parameters: {
    type: "object",
    properties: { command: { type: "string", description: "The shell command to execute" } },
    required: ["command"],
  },
  requiresPermission: true,
  async execute(args, signal) {
    const command = str(args, "command");
    try {
      const { stdout, stderr } = await execAsync(command, { timeout: BASH_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, signal });
      let output = stdout;
      if (stderr) output += `\n[stderr]\n${stderr}`;
      return output || "(no output)";
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; code?: number; killed?: boolean; message?: string };
      if (signal?.aborted) return "[interrupted by user]";
      if (err.killed) return `[error: command timed out after ${Math.round(BASH_TIMEOUT_MS / 1000)} seconds]`;
      let output = err.stdout ?? "";
      if (err.stderr) output += `\n[stderr]\n${err.stderr}`;
      if (err.code !== undefined) output += `\n[exit code: ${err.code}]`;
      return output || `[error: ${err.message}]`;
    }
  },
};

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Path to the file to read" } },
    required: ["path"],
  },
  requiresPermission: true, // managed by path (auto-allow within cwd)
  async execute(args) {
    const p = str(args, "path");
    try {
      const content = await fs.readFile(p, "utf-8");
      if (content.length > 100_000) return content.slice(0, 100_000) + "\n[truncated...]";
      return content;
    } catch (e: unknown) {
      return `[error: ${(e as Error).message}]`;
    }
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Write content to a file. Creates the file if it doesn't exist.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to write" },
      content: { type: "string", description: "Content to write to the file" },
    },
    required: ["path", "content"],
  },
  requiresPermission: true,
  async execute(args) {
    const p = str(args, "path");
    const content = str(args, "content");
    try {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, content);
      return `[wrote ${content.length} bytes to ${p}]`;
    } catch (e: unknown) {
      return `[error: ${(e as Error).message}]`;
    }
  },
};

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Replace exact text in a file. The old_string must be unique in the file " +
    "(or use replace_all=true to replace all occurrences). " +
    "Include enough context in old_string to make it unique.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to edit" },
      old_string: { type: "string", description: "The exact text to find and replace" },
      new_string: { type: "string", description: "The text to replace it with" },
      replace_all: { type: "boolean", description: "Replace all occurrences instead of just the first", default: false },
    },
    required: ["path", "old_string", "new_string"],
  },
  requiresPermission: true,
  async execute(args) {
    const p = str(args, "path");
    const oldString = str(args, "old_string");
    const newString = str(args, "new_string");
    const replaceAll = args["replace_all"] === true;
    if (oldString.length === 0) return `[error: old_string must not be empty]`;
    try {
      const content = await fs.readFile(p, "utf-8");
      // Verified decision (edit.ts): NotFound / Ambiguous / Replaced.
      const verdict = editFile([...content], [...oldString], replaceAll);
      if (verdict.kind === "NotFound") return `[error: old_string not found in ${p}]`;
      if (verdict.kind === "Ambiguous") {
        const count = content.split(oldString).length - 1;
        return `[error: old_string appears ${count} times in ${p}. Use replace_all=true or provide more context to make it unique.]`;
      }
      // Verified single splice (replaceFirst); the all-occurrence join stays shell.
      const newContent = replaceAll
        ? content.split(oldString).join(newString)
        : replaceFirst([...content], [...oldString], [...newString]).join("");
      const replacements = replaceAll ? content.split(oldString).length - 1 : 1;
      await fs.writeFile(p, newContent);
      return `[replaced ${replacements} occurrence(s) in ${p}]`;
    } catch (e: unknown) {
      return `[error: ${(e as Error).message}]`;
    }
  },
};

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search for a regex pattern in files using ripgrep (rg). " +
    "Returns matching lines with file paths and line numbers.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The regex pattern to search for" },
      path: { type: "string", description: "Directory or file to search in (default: current directory)", default: "." },
      glob: { type: "string", description: "Only search files matching this glob (e.g., '*.ts')" },
      ignore_case: { type: "boolean", description: "Case-insensitive search", default: false },
    },
    required: ["pattern"],
  },
  requiresPermission: true, // managed by path (auto-allow within cwd)
  async execute(args, signal) {
    const pattern = str(args, "pattern");
    const searchPath = str(args, "path", ".");
    const glob = typeof args["glob"] === "string" ? (args["glob"] as string) : undefined;
    const ignoreCase = args["ignore_case"] === true;
    const cmd = ["--line-number", "--max-count", "100"];
    if (ignoreCase) cmd.push("--ignore-case");
    if (glob) cmd.push("--glob", glob);
    cmd.push(pattern, searchPath);
    try {
      const { stdout } = await execFileAsync("rg", cmd, { timeout: 30_000, maxBuffer: 10 * 1024 * 1024, signal });
      if (stdout.length > 50_000) return stdout.slice(0, 50_000) + "\n[truncated...]";
      return stdout || "(no matches)";
    } catch (e: unknown) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      if (signal?.aborted) return "[interrupted by user]";
      if (err.code === 1) return "(no matches)";
      if (err.code === "ENOENT" as unknown as number) {
        return "[error: ripgrep (rg) not found. Install it: brew install ripgrep]";
      }
      return `[error: ${err.stderr ?? (e as Error).message}]`;
    }
  },
};

export const globTool: Tool = {
  name: "glob",
  description: "Find files matching a glob pattern (e.g., '**/*.ts', 'src/**/*.ts').",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The glob pattern to match (e.g., '**/*.ts')" },
      path: { type: "string", description: "Directory to search in (default: current directory)", default: "." },
    },
    required: ["pattern"],
  },
  requiresPermission: true, // managed by path (auto-allow within cwd)
  async execute(args) {
    const pattern = str(args, "pattern");
    const searchPath = str(args, "path", ".");
    try {
      const matches: string[] = [];
      for await (const m of fsGlob(pattern, { cwd: searchPath })) {
        matches.push(path.join(searchPath, m));
        if (matches.length >= 100) break;
      }
      matches.sort();
      return matches.length ? matches.join("\n") : "(no matches)";
    } catch (e: unknown) {
      return `[error: ${(e as Error).message}]`;
    }
  },
};

export const webFetchTool: Tool = {
  name: "web_fetch",
  description: "Fetch content from a URL and return the text. HTML is reduced to plain text.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "The URL to fetch" } },
    required: ["url"],
  },
  requiresPermission: true, // network access requires permission
  async execute(args, signal) {
    let url = str(args, "url");
    if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://" + url;
    // Honor both the 30s timeout and a user Esc-abort.
    const timeout = AbortSignal.timeout(30_000);
    const fetchSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "henri-lemmascript/0.1 (AI coding assistant)" },
        signal: fetchSignal,
      });
      if (!res.ok) return `[error: HTTP ${res.status} ${res.statusText}]`;
      let content = await res.text();
      if ((res.headers.get("content-type") ?? "").toLowerCase().includes("html")) {
        content = content
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<head[\s\S]*?<\/head>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
      if (content.length > 50_000) content = content.slice(0, 50_000) + "\n[truncated...]";
      return content || "(empty response)";
    } catch (e: unknown) {
      if (signal?.aborted) return "[interrupted by user]";
      return `[error: ${(e as Error).message}]`;
    }
  },
};

export function getDefaultTools(): Tool[] {
  return [bashTool, readFileTool, writeFileTool, editFileTool, grepTool, globTool, webFetchTool];
}

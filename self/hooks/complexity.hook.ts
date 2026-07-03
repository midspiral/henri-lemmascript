// Complexity analysis tool hook.
//
// Provides a tool that analyzes code files for complexity metrics using the
// verified core in self/core/complexity.ts.

import type { Hook } from "../../src/hooks.ts";
import type { Tool } from "../../src/tools/base.ts";
import * as fs from "node:fs/promises";
import { analyzeLines } from "../core/complexity.ts";

const complexityTool: Tool = {
  name: "analyze_complexity",
  description:
    "Analyze code complexity metrics for a file. " +
    "Returns line counts, function count estimate, and cyclomatic complexity estimate.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to analyze" },
    },
    required: ["path"],
  },
  requiresPermission: true, // managed by path (auto-allow within cwd)
  async execute(args) {
    const path = typeof args["path"] === "string" ? (args["path"] as string) : "";
    if (!path) return "[error: path parameter required]";
    
    try {
      const content = await fs.readFile(path, "utf-8");
      const lines = content.split("\n");
      
      // Call the verified core to compute metrics
      const metrics = analyzeLines(lines);
      
      // Format the output
      const output = [
        `Complexity analysis for ${path}:`,
        `  Total lines: ${metrics.lines}`,
        `  Non-blank lines: ${metrics.nonBlankLines}`,
        `  Function estimates: ${metrics.functions}`,
        `  Complexity estimate: ${metrics.complexity}`,
        ``,
        `Note: Function count includes 'function', '=>', and 'async' patterns.`,
        `Complexity is estimated as 1 + branch keywords (if/for/while/case/catch/&&/||).`,
      ].join("\n");
      
      return output;
    } catch (e: unknown) {
      return `[error: ${(e as Error).message}]`;
    }
  },
};

const hook: Hook = {
  tools: [complexityTool],
  pathBased: ["analyze_complexity"],
  autoAllowCwd: ["analyze_complexity"],
};

export default hook;

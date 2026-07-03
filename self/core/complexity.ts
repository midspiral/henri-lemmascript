//@ backend dafny

// Complexity analysis core — VERIFIED.
//
// Analyzes code to extract metrics like line counts, function counts, and
// cyclomatic complexity estimates. The shell will parse actual source files
// and call these verified functions to compute the metrics.
//
// Properties (proofs in complexity.dfy):
//   C1 non-negative — all computed metrics are non-negative
//   C2 monotonicity  — adding lines never decreases line count
//   C3 bounds        — non-blank lines bounded by total lines

export interface Metrics {
  lines: number;
  nonBlankLines: number;
  functions: number;
  complexity: number;
}

/** Count non-blank lines in an array of line strings. */
export function countNonBlank(lines: string[]): number {
  //@ verify
  //@ decreases lines.length
  //@ ensures \result >= 0
  //@ ensures \result <= lines.length
  if (lines.length === 0) return 0;
  const first = lines[0].trim();
  const rest = countNonBlank(lines.slice(1));
  return first.length > 0 ? rest + 1 : rest;
}

/** Count patterns (function declarations, branches, etc.) in lines. */
export function countPattern(lines: string[], pattern: string): number {
  //@ verify
  //@ decreases lines.length
  //@ requires pattern.length > 0
  //@ ensures \result >= 0
  if (lines.length === 0) return 0;
  const line = lines[0];
  const rest = countPattern(lines.slice(1), pattern);
  return line.includes(pattern) ? rest + 1 : rest;
}

/** Count branches in a single line. */
export function countBranches(line: string): number {
  //@ verify
  //@ ensures \result >= 0
  const ifBranch = line.includes("if") || line.includes("if(") ? 1 : 0;
  const forBranch = line.includes("for") || line.includes("for(") ? 1 : 0;
  const whileBranch = line.includes("while") || line.includes("while(") ? 1 : 0;
  const caseBranch = line.includes("case ") ? 1 : 0;
  const catchBranch = line.includes("catch") ? 1 : 0;
  const andBranch = line.includes("&&") ? 1 : 0;
  const orBranch = line.includes("||") ? 1 : 0;
  return ifBranch + forBranch + whileBranch + caseBranch + catchBranch + andBranch + orBranch;
}

/** Estimate cyclomatic complexity: 1 + branch keywords (if/for/while/case/catch/&&/||). */
export function estimateComplexity(lines: string[]): number {
  //@ verify
  //@ decreases lines.length
  //@ ensures \result >= 1
  if (lines.length === 0) return 1;
  const branches = countBranches(lines[0]);
  const rest = estimateComplexity(lines.slice(1));
  return rest + branches;
}

/** Compute metrics for an array of code lines. */
export function analyzeLines(lines: string[]): Metrics {
  const nonBlank = countNonBlank(lines);
  const functions = countPattern(lines, "function") + countPattern(lines, "=>") + countPattern(lines, "async ");
  const complexity = estimateComplexity(lines);
  return {
    lines: lines.length,
    nonBlankLines: nonBlank,
    functions,
    complexity,
  };
}

// ── Theorems about metrics ──────────────────────────────────────────────────

/** C1 — countNonBlank is non-negative and bounded. */
export function nonBlankBounds(lines: string[]): boolean {
  //@ verify
  //@ contract Non-blank count is non-negative and bounded by line count.
  //@ ensures countNonBlank(lines) >= 0
  //@ ensures countNonBlank(lines) <= lines.length
  return true;
}

/** C2 — countPattern is non-negative. */
export function patternNonNegative(lines: string[], pattern: string): boolean {
  //@ verify
  //@ contract Pattern count is always non-negative.
  //@ requires pattern.length > 0
  //@ ensures countPattern(lines, pattern) >= 0
  return true;
}

/** C3 — complexity is always at least 1. */
export function complexityMinimum(lines: string[]): boolean {
  //@ verify
  //@ contract Complexity estimate is always at least 1.
  //@ ensures estimateComplexity(lines) >= 1
  return true;
}

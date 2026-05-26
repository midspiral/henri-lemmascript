// Minimal terminal UI: ANSI colors, a bordered panel, and a spinner.
// No external TUI dependency — the verification story doesn't ride on the UI.

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

export const color = {
  dim: (s: string) => `${ESC}2m${s}${RESET}`,
  bold: (s: string) => `${ESC}1m${s}${RESET}`,
  yellow: (s: string) => `${ESC}33m${s}${RESET}`,
  blue: (s: string) => `${ESC}34m${s}${RESET}`,
  red: (s: string) => `${ESC}31m${s}${RESET}`,
  green: (s: string) => `${ESC}32m${s}${RESET}`,
};

const BORDER: Record<string, (s: string) => string> = {
  blue: color.blue,
  yellow: color.yellow,
  dim: color.dim,
};

/** Render a rounded box around `body`, with an optional `title`. */
export function panel(body: string, opts: { title?: string; border?: keyof typeof BORDER } = {}): string {
  const paint = BORDER[opts.border ?? "dim"];
  const lines = body.split("\n");
  const width = Math.min(80, Math.max(...lines.map((l) => visibleLength(l)), opts.title ? opts.title.length + 2 : 0));
  const top = opts.title
    ? paint(`╭─ ${opts.title} ${"─".repeat(Math.max(0, width - opts.title.length - 1))}╮`)
    : paint(`╭${"─".repeat(width + 2)}╮`);
  const bottom = paint(`╰${"─".repeat(width + 2)}╯`);
  const bar = paint("│");
  const middle = lines.map((l) => `${bar} ${l}${" ".repeat(Math.max(0, width - visibleLength(l)))} ${bar}`).join("\n");
  return `${top}\n${middle}\n${bottom}`;
}

function visibleLength(s: string): number {
  // strip ANSI escapes for width calculation
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Truncate multi-line text to `limit` lines, with a "… N more lines" note. */
export function truncate(text: string, limit = 10): string {
  const lines = text.split("\n");
  if (lines.length > limit) {
    return lines.slice(0, limit).join("\n") + color.dim(`\n… (${lines.length - limit} more lines)`);
  }
  return text;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;

  start(text: string): void {
    this.stop();
    if (!process.stdout.isTTY) return;
    this.timer = setInterval(() => {
      process.stdout.write(`\r${color.dim(FRAMES[this.frame] + " " + text)}${ESC}K`);
      this.frame = (this.frame + 1) % FRAMES.length;
    }, 80);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      if (process.stdout.isTTY) process.stdout.write(`\r${ESC}K`);
    }
  }
}

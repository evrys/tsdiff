import chalk from "chalk";
import type { Change, DiffResult, Severity } from "./types.js";

export function formatHuman(result: DiffResult): string {
  const lines: string[] = [];
  const groups: Record<Severity, Change[]> = {
    breaking: [],
    warning: [],
    info: [],
  };
  for (const c of result.changes) groups[c.severity].push(c);

  if (groups.breaking.length) {
    lines.push(
      chalk.bold.red(`✖ ${groups.breaking.length} breaking change(s)`),
    );
    for (const c of groups.breaking)
      lines.push(`  ${chalk.red("•")} ${c.message}${detail(c)}`);
  }
  if (groups.warning.length) {
    lines.push(
      chalk.bold.yellow(
        `⚠ ${groups.warning.length} potentially breaking change(s)`,
      ),
    );
    for (const c of groups.warning)
      lines.push(`  ${chalk.yellow("•")} ${c.message}${detail(c)}`);
  }
  if (groups.info.length) {
    lines.push(
      chalk.bold.dim(`i ${groups.info.length} informational change(s)`),
    );
    for (const c of groups.info)
      lines.push(`  ${chalk.dim("•")} ${c.message}${detail(c)}`);
  }
  if (result.changes.length === 0) {
    lines.push(chalk.green("No API changes detected."));
  }
  return lines.join("\n");
}

function detail(c: Change): string {
  if (!c.details) return "";
  const { oldType, newType, differences } = c.details;
  const parts: string[] = [];
  if (differences?.length) {
    parts.push("\n      " + chalk.bold.dim("changes:"));
    for (const line of differences) {
      const colored = line.startsWith("+ ")
        ? chalk.green(line)
        : line.startsWith("- ")
          ? chalk.red(line)
          : line.startsWith("~ ")
            ? chalk.yellow(line)
            : chalk.dim(line);
      parts.push("\n        " + colored);
    }
  }
  if (oldType && newType) {
    parts.push(
      "\n      " +
        chalk.dim("old: ") +
        oldType +
        "\n      " +
        chalk.dim("new: ") +
        newType,
    );
  }
  return parts.join("");
}

export function formatJson(result: DiffResult): string {
  return JSON.stringify(result, null, 2);
}

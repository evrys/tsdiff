import pc from "picocolors";
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
      pc.bold(pc.red(`✖ ${groups.breaking.length} breaking change(s)`)),
    );
    for (const c of groups.breaking)
      lines.push(`  ${pc.red("•")} ${c.message}${detail(c)}`);
  }
  if (groups.warning.length) {
    lines.push(
      pc.bold(
        pc.yellow(`⚠ ${groups.warning.length} potentially breaking change(s)`),
      ),
    );
    for (const c of groups.warning)
      lines.push(`  ${pc.yellow("•")} ${c.message}${detail(c)}`);
  }
  if (groups.info.length) {
    lines.push(
      pc.bold(pc.dim(`i ${groups.info.length} informational change(s)`)),
    );
    for (const c of groups.info)
      lines.push(`  ${pc.dim("•")} ${c.message}${detail(c)}`);
  }
  if (result.changes.length === 0) {
    lines.push(pc.green("No API changes detected."));
  }
  return lines.join("\n");
}

function detail(c: Change): string {
  if (!c.details) return "";
  const { oldType, newType, differences } = c.details;
  const parts: string[] = [];
  if (differences?.length) {
    parts.push("\n      " + pc.bold(pc.dim("changes:")));
    for (const line of differences) {
      const colored = line.startsWith("+ ")
        ? pc.green(line)
        : line.startsWith("- ")
          ? pc.red(line)
          : line.startsWith("~ ")
            ? pc.yellow(line)
            : pc.dim(line);
      parts.push("\n        " + colored);
    }
  }
  if (oldType && newType) {
    parts.push(
      "\n      " +
        pc.dim("old: ") +
        oldType +
        "\n      " +
        pc.dim("new: ") +
        newType,
    );
  }
  return parts.join("");
}

export function formatJson(result: DiffResult): string {
  return JSON.stringify(result, null, 2);
}

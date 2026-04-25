import pc from "picocolors";
import type { Change, DiffResult, Severity } from "./types.js";

export function formatHuman(result: DiffResult): string {
  const lines: string[] = [];
  const groups: Record<Severity, Change[]> = {
    breaking: [],
    "non-breaking": [],
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
  if (groups["non-breaking"].length) {
    lines.push(
      pc.bold(
        pc.yellow(`+ ${groups["non-breaking"].length} non-breaking change(s)`),
      ),
    );
    for (const c of groups["non-breaking"])
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
  const { oldType, newType } = c.details;
  if (oldType && newType) {
    return (
      "\n      " +
      pc.dim("old: ") +
      oldType +
      "\n      " +
      pc.dim("new: ") +
      newType
    );
  }
  return "";
}

export function formatJson(result: DiffResult): string {
  return JSON.stringify(result, null, 2);
}

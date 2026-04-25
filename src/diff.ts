import ts from "typescript";
import {
  extractSurface,
  isTypeKind,
  isValueKind,
  type ApiEntry,
} from "./extract.js";
import { createDiffProgram } from "./program.js";
import type { Change, DiffResult } from "./types.js";

/**
 * Diff two TypeScript declaration files and return a list of API changes.
 *
 * @param oldFile  Path to the previous `.d.ts` (baseline).
 * @param newFile  Path to the new `.d.ts`.
 */
export function diffDeclarations(oldFile: string, newFile: string): DiffResult {
  const { checker, oldNs, newNs } = createDiffProgram(oldFile, newFile);
  const oldSurface = extractSurface(oldNs, checker);
  const newSurface = extractSurface(newNs, checker);

  const changes: Change[] = [];

  for (const [name, oldEntry] of oldSurface) {
    const newEntry = newSurface.get(name);
    if (!newEntry) {
      changes.push({
        kind: "export-removed",
        severity: "breaking",
        name,
        message: `Export \`${name}\` (${oldEntry.kind}) was removed`,
        details: { oldKind: oldEntry.kind },
      });
      continue;
    }
    compareEntry(name, oldEntry, newEntry, checker, changes);
  }

  for (const [name, newEntry] of newSurface) {
    if (oldSurface.has(name)) continue;
    changes.push({
      kind: "export-added",
      severity: "non-breaking",
      name,
      message: `Export \`${name}\` (${newEntry.kind}) was added`,
      details: { newKind: newEntry.kind },
    });
  }

  return summarize(changes);
}

function compareEntry(
  name: string,
  oldEntry: ApiEntry,
  newEntry: ApiEntry,
  checker: ts.TypeChecker,
  changes: Change[],
): void {
  if (oldEntry.kind !== newEntry.kind) {
    // Some kind transitions are non-breaking (e.g. interface -> type alias of identical shape).
    // We still flag and let the type assignability check decide severity.
    changes.push({
      kind: "kind-changed",
      severity: kindChangeBreaking(oldEntry.kind, newEntry.kind)
        ? "breaking"
        : "info",
      name,
      message: `Export \`${name}\` changed kind: ${oldEntry.kind} → ${newEntry.kind}`,
      details: { oldKind: oldEntry.kind, newKind: newEntry.kind },
    });
  }

  // Cheap structural equality: identical declaration source text means
  // identical type semantics. This is also needed for generic declarations
  // where `isTypeAssignableTo` can return false across two namespaces with
  // distinct type-parameter symbols even when the source is byte-for-byte
  // identical. Doing this comparison once at the symbol level avoids the
  // O(properties × type-string) blowup of structural fingerprinting on
  // self-referential builder APIs (zod, mui, ...).
  if (declarationsTextEqual(oldEntry.symbol, newEntry.symbol)) return;

  // Compare value-space types (functions, classes, variables, enums).
  if (isValueKind(oldEntry.kind) && isValueKind(newEntry.kind)) {
    const oldType = typeOfSymbol(oldEntry.symbol, checker);
    const newType = typeOfSymbol(newEntry.symbol, checker);
    if (oldType && newType) {
      compareTypes(name, oldType, newType, checker, changes, "value");
    }
  }

  // Compare type-space declarations (interfaces, type aliases).
  if (isTypeKind(oldEntry.kind) && isTypeKind(newEntry.kind)) {
    const oldType = declaredTypeOfSymbol(oldEntry.symbol, checker);
    const newType = declaredTypeOfSymbol(newEntry.symbol, checker);
    if (oldType && newType) {
      compareTypes(name, oldType, newType, checker, changes, "type");
    }
  }
}

function declarationsTextEqual(a: ts.Symbol, b: ts.Symbol): boolean {
  const aDecls = a.declarations ?? [];
  const bDecls = b.declarations ?? [];
  if (aDecls.length === 0 || aDecls.length !== bDecls.length) return false;
  // Sort to make overload order irrelevant.
  const aTexts = aDecls.map((d) => d.getText()).sort();
  const bTexts = bDecls.map((d) => d.getText()).sort();
  for (let i = 0; i < aTexts.length; i++) {
    if (aTexts[i] !== bTexts[i]) return false;
  }
  return true;
}

function compareTypes(
  name: string,
  oldType: ts.Type,
  newType: ts.Type,
  checker: ts.TypeChecker,
  changes: Change[],
  space: "value" | "type",
): void {
  // Equality of these two types is established at the symbol level by
  // `declarationsTextEqual` in the caller, so by the time we get here the
  // types differ in source. The strings below are for human-readable
  // change messages; the actual diff is decided by `isTypeAssignableTo`.
  const oldStr = typeToString(checker, oldType);
  const newStr = typeToString(checker, newType);

  // For consumer compatibility: every value the new package produces of this
  // type must be acceptable wherever the old type was expected.
  // Equivalently: new must be assignable to old.
  const newAssignableToOld = isAssignable(checker, newType, oldType);
  // For type-space declarations (interfaces, aliases), consumers may both
  // construct and consume values of the type, so we also need the reverse.
  const oldAssignableToNew = isAssignable(checker, oldType, newType);

  if (!newAssignableToOld) {
    changes.push({
      kind: "type-incompatible",
      severity: "breaking",
      name,
      message:
        space === "value"
          ? `Export \`${name}\` has an incompatible type (new value not assignable to old type)`
          : `Type \`${name}\` is no longer a supertype of its previous shape`,
      details: { oldType: oldStr, newType: newStr },
    });
  } else if (space === "type" && !oldAssignableToNew) {
    // Type-space narrowing: consumers who *construct* values typed against the
    // old declaration may no longer satisfy the new (stricter) shape.
    changes.push({
      kind: "type-incompatible",
      severity: "breaking",
      name,
      message: `Type \`${name}\` was narrowed; values matching the previous type may no longer be accepted`,
      details: { oldType: oldStr, newType: newStr },
    });
  } else {
    changes.push({
      kind: "type-changed",
      severity: "info",
      name,
      message: `Type of \`${name}\` changed but remains compatible`,
      details: { oldType: oldStr, newType: newStr },
    });
  }
}

function typeOfSymbol(
  sym: ts.Symbol,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  if (!decl) return undefined;
  return checker.getTypeOfSymbolAtLocation(sym, decl);
}

function declaredTypeOfSymbol(
  sym: ts.Symbol,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  try {
    return checker.getDeclaredTypeOfSymbol(sym);
  } catch {
    return undefined;
  }
}

function typeToString(checker: ts.TypeChecker, type: ts.Type): string {
  // Plain TypeChecker formatting. Default truncation keeps the output
  // bounded; full structural detail is intentionally omitted because
  // (a) the actual diff decision is made by `isTypeAssignableTo`, and
  // (b) on self-referential builder APIs (e.g. zod's `ZodType<...>`)
  // structural expansion grows quadratically and OOMs the heap.
  const flags =
    ts.TypeFormatFlags.WriteArrayAsGenericType | ts.TypeFormatFlags.InTypeAlias;
  return checker.typeToString(type, undefined, flags);
}

function isAssignable(
  checker: ts.TypeChecker,
  source: ts.Type,
  target: ts.Type,
): boolean {
  try {
    return checker.isTypeAssignableTo(source, target);
  } catch {
    return false;
  }
}

function kindChangeBreaking(oldKind: string, newKind: string): boolean {
  // Class -> interface drops the constructor/value side: breaking.
  if (oldKind === "class" && newKind !== "class") return true;
  // Function -> non-callable variable / type: breaking for callers.
  if (
    oldKind === "function" &&
    newKind !== "function" &&
    newKind !== "variable"
  )
    return true;
  // Interface <-> type-alias of equivalent shape will be confirmed by the
  // assignability comparison; treat the kind change itself as info.
  if (
    (oldKind === "interface" && newKind === "type-alias") ||
    (oldKind === "type-alias" && newKind === "interface")
  ) {
    return false;
  }
  return true;
}

function summarize(changes: Change[]): DiffResult {
  let breakingCount = 0;
  let nonBreakingCount = 0;
  let infoCount = 0;
  for (const c of changes) {
    if (c.severity === "breaking") breakingCount++;
    else if (c.severity === "non-breaking") nonBreakingCount++;
    else infoCount++;
  }
  return { changes, breakingCount, nonBreakingCount, infoCount };
}

import ts from "typescript";
import {
  extractSurface,
  isTypeKind,
  isValueKind,
  type ApiEntry,
} from "./extract.js";
import { createDiffProgram } from "./program.js";
import type { Change, DiffOptions, DiffResult } from "./types.js";

/**
 * Diff two TypeScript declaration files and return a list of API changes.
 *
 * @param oldFile  Path to the previous `.d.ts` (baseline).
 * @param newFile  Path to the new `.d.ts`.
 */
export function diffDeclarations(
  oldFile: string,
  newFile: string,
  options: DiffOptions = {},
): DiffResult {
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
      severity: options.strict ? "info" : "non-breaking",
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

function compareTypes(
  name: string,
  oldType: ts.Type,
  newType: ts.Type,
  checker: ts.TypeChecker,
  changes: Change[],
  space: "value" | "type",
): void {
  const oldStr = typeToString(checker, oldType);
  const newStr = typeToString(checker, newType);

  // Fast path: identical printed forms mean structurally identical types.
  // This is also needed for generic declarations, where `isTypeAssignableTo`
  // can fail across two programs because the two declarations have distinct
  // type-parameter symbols even when the source is byte-for-byte identical.
  if (oldStr === newStr) return;

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
  const flags =
    ts.TypeFormatFlags.NoTruncation |
    ts.TypeFormatFlags.WriteArrayAsGenericType |
    ts.TypeFormatFlags.InTypeAlias;

  // For non-object types (primitives, literals, unions, intersections, type
  // parameters, etc.) the named printed form already conveys the full shape.
  if (!isObjectType(type)) {
    return checker.typeToString(type, undefined, flags);
  }

  // For object types the named form often collapses to a single declaration
  // name (e.g. "User" or "typeof Foo"), which would hide diffs. Build a
  // structural fingerprint covering properties, call/construct signatures
  // and index signatures.
  const parts: string[] = [];
  for (const prop of checker.getPropertiesOfType(type)) {
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    const propType = decl
      ? checker.getTypeOfSymbolAtLocation(prop, decl)
      : checker.getDeclaredTypeOfSymbol(prop);
    const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0 ? "?" : "";
    const readonly = isReadonlyProperty(prop) ? "readonly " : "";
    const propStr = checker.typeToString(propType, undefined, flags);
    parts.push(`${readonly}${prop.name}${optional}: ${propStr}`);
  }
  for (const sig of checker.getSignaturesOfType(type, ts.SignatureKind.Call)) {
    parts.push(`call ${checker.signatureToString(sig)}`);
  }
  for (const sig of checker.getSignaturesOfType(
    type,
    ts.SignatureKind.Construct,
  )) {
    parts.push(`new ${checker.signatureToString(sig)}`);
  }
  const stringIndex = checker.getIndexInfoOfType(type, ts.IndexKind.String);
  if (stringIndex) {
    parts.push(
      `[k: string]: ${checker.typeToString(stringIndex.type, undefined, flags)}`,
    );
  }
  const numberIndex = checker.getIndexInfoOfType(type, ts.IndexKind.Number);
  if (numberIndex) {
    parts.push(
      `[k: number]: ${checker.typeToString(numberIndex.type, undefined, flags)}`,
    );
  }
  return `{ ${parts.join("; ")} }`;
}

function isObjectType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Object) !== 0;
}

function isReadonlyProperty(prop: ts.Symbol): boolean {
  for (const decl of prop.declarations ?? []) {
    const mods = ts.canHaveModifiers(decl) ? ts.getModifiers(decl) : undefined;
    if (mods?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword))
      return true;
  }
  return false;
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

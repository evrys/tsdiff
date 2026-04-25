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
      severity: "info",
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
      compareTypes(
        name,
        oldType,
        newType,
        oldEntry.symbol,
        newEntry.symbol,
        checker,
        changes,
        "value",
      );
    }
  }

  // Compare type-space declarations (interfaces, type aliases).
  if (isTypeKind(oldEntry.kind) && isTypeKind(newEntry.kind)) {
    const oldType = declaredTypeOfSymbol(oldEntry.symbol, checker);
    const newType = declaredTypeOfSymbol(newEntry.symbol, checker);
    if (oldType && newType) {
      compareTypes(
        name,
        oldType,
        newType,
        oldEntry.symbol,
        newEntry.symbol,
        checker,
        changes,
        "type",
      );
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
  oldSymbol: ts.Symbol,
  newSymbol: ts.Symbol,
  checker: ts.TypeChecker,
  changes: Change[],
  space: "value" | "type",
): void {
  // Equality of these two types is established at the symbol level by
  // `declarationsTextEqual` in the caller, so by the time we get here the
  // types differ in source. The strings below are for human-readable
  // change messages; the actual diff is decided by `isTypeAssignableTo`.
  let oldStr = typeToString(checker, oldType);
  let newStr = typeToString(checker, newType);

  // When `typeToString` collapses to identical strings (e.g. both sides
  // resolve to `LoDashStatic` or `typeof Help`) or to bare alias
  // references whose generic args differ subtly, the diff reader has
  // no way to see *what* changed. Fall back to the declaration source
  // text — that's what actually changed between versions.
  const stringsEqual = oldStr === newStr;
  if (stringsEqual || (isBareReference(oldStr) && isBareReference(newStr))) {
    const oldDecl = declarationText(oldSymbol);
    const newDecl = declarationText(newSymbol);
    if (oldDecl && newDecl && oldDecl !== newDecl) {
      oldStr = oldDecl;
      newStr = newDecl;
    }
  }

  // Direction A: is `new` still a *subtype* of `old`?
  //   true  => every value produced under the new declaration still fits
  //            the old declaration's contract.
  //   false => the new declaration dropped or changed something the old one
  //            guaranteed; consumers that *read* this type may break
  //            ("widened or diverged").
  const newAssignableToOld = isAssignable(checker, newType, oldType);
  // Direction B (type-space only): is `old` still a subtype of `new`?
  //   true  => values that satisfied the old declaration still satisfy the
  //            new one.
  //   false => the new declaration is stricter; consumers that *construct*
  //            values of this type may break ("narrowed").
  const oldAssignableToNew = isAssignable(checker, oldType, newType);

  // Structural breakdown ("which property/signature/type-param changed").
  const differences = summarizeStructuralDiff(
    oldType,
    newType,
    oldSymbol,
    newSymbol,
    checker,
  );
  // Only include `oldType`/`newType` in the user-visible details when they
  // actually differ — emitting `old: X / new: X` (identical) is just noise
  // and obscures the structural `differences` block.
  const detailsBase: Change["details"] = {};
  if (oldStr !== newStr) {
    detailsBase.oldType = oldStr;
    detailsBase.newType = newStr;
  }
  if (differences.length) detailsBase.differences = differences;

  // The TypeScript checker occasionally returns spurious negatives on
  // `isTypeAssignableTo` when the same generic interface appears in two
  // namespaces (the type-parameter symbols differ across namespaces even
  // when the declarations are structurally equivalent — same root cause
  // as `declarationsTextEqual` above).
  //
  // When the structural diff shows *only* additions of optional
  // properties, the relationship is definitionally a non-breaking
  // widening: every old value still satisfies the new shape (the new
  // optional fields can be absent), and every new value still satisfies
  // the old shape (the extra fields are excess and allowed). Trust the
  // structural evidence over the checker's verdict.
  if (differences.length > 0 && differences.every(isPurelyOptionalAddition)) {
    changes.push({
      kind: "type-changed",
      severity: "info",
      name,
      message: `Type of \`${name}\` was widened with new optional members; existing consumers and producers remain compatible`,
      details: detailsBase,
    });
    return;
  }

  if (!newAssignableToOld && (space === "value" || !oldAssignableToNew)) {
    // Genuinely incompatible:
    //  - value space: any new-assignability failure breaks call sites.
    //  - type space: failing in *both* directions means the shapes are
    //    unrelated — neither readers nor constructors can adapt.
    changes.push({
      kind: "type-incompatible",
      severity: "breaking",
      name,
      message:
        space === "value"
          ? `Export \`${name}\` has an incompatible type: the new declaration is no longer assignable to the old`
          : `Type \`${name}\` shape diverged in both directions; old and new are no longer assignment-compatible.`,
      details: detailsBase,
    });
  } else if (space === "type" && !newAssignableToOld) {
    // One-directional type-space mismatch: the new declaration is no
    // longer a subtype of the old. Only consumers who *read* values of
    // this type are affected; producers are fine.
    changes.push({
      kind: "type-incompatible",
      severity: "warning",
      name,
      message: `Type \`${name}\` shape diverged; the new declaration is no longer a subtype of the old. Consumers that read values of \`${name}\` may break.`,
      details: detailsBase,
    });
  } else if (space === "type" && !oldAssignableToNew) {
    // One-directional type-space narrowing: only consumers who
    // *construct* values typed against the old declaration are affected.
    changes.push({
      kind: "type-incompatible",
      severity: "warning",
      name,
      message: `Type \`${name}\` was narrowed; values that satisfied the old declaration may no longer satisfy the new one. Consumers that construct values of \`${name}\` may break.`,
      details: detailsBase,
    });
  } else {
    changes.push({
      kind: "type-changed",
      severity: "info",
      name,
      message: `Type of \`${name}\` changed but remains compatible`,
      details: detailsBase,
    });
  }
}

function declarationText(sym: ts.Symbol, max = 1500): string | undefined {
  const decl = sym.declarations?.[0];
  if (!decl) return undefined;
  // Collapse whitespace so callers (CLI, JSON consumers) can render the
  // declaration on a few lines without leaking original indentation.
  const text = decl.getText().replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

/**
 * Recognise a "bare" type reference such as `Foo`, `Foo.Bar`, or
 * `Foo<X, Y>` (no anonymous object literal, function type, union, etc.).
 * When both the old and new strings are bare references the human-readable
 * diff carries no structural information and we prefer the declaration
 * source instead.
 */
function isBareReference(str: string): boolean {
  // Identifier(.Identifier)*(<...>)? — generic args may themselves contain
  // identifiers / commas / spaces / nested generics, but no braces or
  // parens (those would indicate a non-bare structural form).
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:<[^{}()]*>)?$/.test(str);
}

/**
 * Recognise a `summarizeStructuralDiff` line that adds a single
 * *optional* property. Lines like `+ name?: SomeType` qualify; required
 * additions, removals (`- ...`), changes (`~ ...`), and signature/type-
 * parameter additions do not.
 */
function isPurelyOptionalAddition(line: string): boolean {
  return /^\+ [A-Za-z_$][\w$]*\?:/.test(line);
}

/**
 * Walk old and new types side-by-side and produce a list of bullet
 * lines describing the *concrete* structural delta: which properties
 * were added, removed, made optional/required, retyped, plus call /
 * construct signature mismatches and type-parameter list changes.
 *
 * Returns an empty list if no useful structural delta can be produced
 * (e.g. neither side is an object-like type). Output is intentionally
 * line-oriented and pre-formatted for direct display.
 */
function summarizeStructuralDiff(
  oldType: ts.Type,
  newType: ts.Type,
  oldSymbol: ts.Symbol,
  newSymbol: ts.Symbol,
  checker: ts.TypeChecker,
): string[] {
  const out: string[] = [];

  // --- Type parameters (interfaces / aliases) ---
  const oldParams = formatTypeParameters(oldType, oldSymbol);
  const newParams = formatTypeParameters(newType, newSymbol);
  if (oldParams !== newParams && (oldParams || newParams)) {
    out.push(
      `~ type parameters: ${oldParams || "<none>"} → ${newParams || "<none>"}`,
    );
  }

  // --- Properties ---
  const oldProps = new Map<string, ts.Symbol>();
  const newProps = new Map<string, ts.Symbol>();
  for (const p of oldType.getProperties()) oldProps.set(p.name, p);
  for (const p of newType.getProperties()) newProps.set(p.name, p);

  const allNames = new Set<string>([...oldProps.keys(), ...newProps.keys()]);
  for (const propName of allNames) {
    const oldP = oldProps.get(propName);
    const newP = newProps.get(propName);
    if (oldP && !newP) {
      const t = propTypeString(oldP, checker);
      out.push(`- ${propName}${optMark(oldP)}: ${t}`);
      continue;
    }
    if (!oldP && newP) {
      const t = propTypeString(newP, checker);
      out.push(`+ ${propName}${optMark(newP)}: ${t}`);
      continue;
    }
    if (oldP && newP) {
      const oldOpt = isOptional(oldP);
      const newOpt = isOptional(newP);
      const oldT = propTypeString(oldP, checker);
      const newT = propTypeString(newP, checker);
      if (oldT === newT && oldOpt === newOpt) continue;
      const optChange =
        oldOpt !== newOpt
          ? oldOpt
            ? " (now required)"
            : " (now optional)"
          : "";
      if (oldT === newT) {
        out.push(`~ ${propName}${optChange}`);
      } else {
        out.push(`~ ${propName}${optChange}: ${oldT} → ${newT}`);
      }
    }
  }

  // --- Call / construct signatures ---
  appendSignatureDiff(
    "call signature",
    oldType.getCallSignatures(),
    newType.getCallSignatures(),
    checker,
    out,
  );
  appendSignatureDiff(
    "construct signature",
    oldType.getConstructSignatures(),
    newType.getConstructSignatures(),
    checker,
    out,
  );

  // Cap to keep CLI/JSON output bounded; surfaces cluster of changes
  // first which is what consumers actually need.
  const MAX = 30;
  if (out.length > MAX) {
    return [...out.slice(0, MAX), `… (${out.length - MAX} more)`];
  }
  return out;
}

function appendSignatureDiff(
  label: string,
  oldSigs: readonly ts.Signature[],
  newSigs: readonly ts.Signature[],
  checker: ts.TypeChecker,
  out: string[],
): void {
  if (oldSigs.length === 0 && newSigs.length === 0) return;
  const oldStrs = oldSigs.map((s) => signatureToString(checker, s)).sort();
  const newStrs = newSigs.map((s) => signatureToString(checker, s)).sort();
  const oldSet = new Set(oldStrs);
  const newSet = new Set(newStrs);
  for (const s of oldStrs) if (!newSet.has(s)) out.push(`- ${label}: ${s}`);
  for (const s of newStrs) if (!oldSet.has(s)) out.push(`+ ${label}: ${s}`);
}

function signatureToString(checker: ts.TypeChecker, sig: ts.Signature): string {
  return checker
    .signatureToString(
      sig,
      undefined,
      ts.TypeFormatFlags.WriteArrayAsGenericType,
    )
    .replace(/\s+/g, " ")
    .trim();
}

function propTypeString(prop: ts.Symbol, checker: ts.TypeChecker): string {
  const decl = prop.valueDeclaration ?? prop.declarations?.[0];
  if (!decl) return "?";
  const t = checker.getTypeOfSymbolAtLocation(prop, decl);
  return typeToString(checker, t);
}

function isOptional(prop: ts.Symbol): boolean {
  return (prop.flags & ts.SymbolFlags.Optional) !== 0;
}

function optMark(prop: ts.Symbol): string {
  return isOptional(prop) ? "?" : "";
}

function formatTypeParameters(type: ts.Type, fallbackSym?: ts.Symbol): string {
  // Generic interfaces / aliases expose type parameters via the
  // associated symbol's declarations; the structural Type API does
  // not. Prefer the export's own symbol (which always carries the
  // declaration) over the type's `aliasSymbol`/`symbol` — the latter
  // can be lost when a type alias is reduced through an intersection
  // (e.g. `type Simplify<T> = {[K in keyof T]: T[K]} & {}` loses its
  // `aliasSymbol` and would otherwise report `<none>`).
  const candidates: ts.Symbol[] = [];
  if (fallbackSym) candidates.push(fallbackSym);
  if (type.aliasSymbol) candidates.push(type.aliasSymbol);
  const sym = type.getSymbol();
  if (sym) candidates.push(sym);
  for (const candidate of candidates) {
    for (const decl of candidate.declarations ?? []) {
      const params = (
        decl as ts.NamedDeclaration & {
          typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration>;
        }
      ).typeParameters;
      if (params?.length) {
        return `<${params.map((p) => p.getText()).join(", ")}>`;
      }
    }
  }
  return "";
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
  let warningCount = 0;
  let infoCount = 0;
  for (const c of changes) {
    if (c.severity === "breaking") breakingCount++;
    else if (c.severity === "warning") warningCount++;
    else infoCount++;
  }
  return {
    changes,
    breakingCount,
    warningCount,
    infoCount,
  };
}

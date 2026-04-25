import ts from "typescript";

export type ApiKind =
  | "function"
  | "class"
  | "interface"
  | "type-alias"
  | "enum"
  | "variable"
  | "namespace"
  | "unknown";

export interface ApiEntry {
  name: string;
  symbol: ts.Symbol;
  kind: ApiKind;
}

export type ApiSurface = Map<string, ApiEntry>;

/**
 * Walk a module-namespace symbol and produce a map of its exports.
 * The namespace is an ES module's "*" export, so its `exports` table
 * mirrors the public API of the source file.
 */
export function extractSurface(
  ns: ts.Symbol,
  checker: ts.TypeChecker,
): ApiSurface {
  const surface: ApiSurface = new Map();
  // For module namespace symbols, exports are exposed via the type's properties.
  const type = checker.getTypeOfSymbolAtLocation(ns, declarationOf(ns));
  for (const prop of checker.getPropertiesOfType(type)) {
    surface.set(prop.name, {
      name: prop.name,
      symbol: prop,
      kind: classify(prop, checker),
    });
  }
  // Type-only exports aren't on the value type. Pull them from the symbol's exports table too.
  ns.exports?.forEach((sym, key) => {
    const name = key as string;
    if (name === "default" || name === "__export") return;
    if (surface.has(name)) return;
    const resolved =
      (sym.flags & ts.SymbolFlags.Alias) !== 0
        ? checker.getAliasedSymbol(sym)
        : sym;
    surface.set(name, {
      name,
      symbol: resolved,
      kind: classify(resolved, checker),
    });
  });
  return surface;
}

function classify(sym: ts.Symbol, _checker: ts.TypeChecker): ApiKind {
  const f = sym.flags;
  if (f & ts.SymbolFlags.Function) return "function";
  if (f & ts.SymbolFlags.Class) return "class";
  if (f & ts.SymbolFlags.Interface) return "interface";
  if (f & ts.SymbolFlags.TypeAlias) return "type-alias";
  if (f & ts.SymbolFlags.Enum) return "enum";
  if (f & ts.SymbolFlags.Variable) return "variable";
  if (f & ts.SymbolFlags.Module) return "namespace";
  if (f & ts.SymbolFlags.Method) return "function";
  return "unknown";
}

function declarationOf(sym: ts.Symbol): ts.Declaration {
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  if (!decl) {
    throw new Error(`Symbol \`${sym.name}\` has no declaration`);
  }
  return decl;
}

/** Categorize symbols for "value" vs "type" space. A name can occupy both. */
export function isValueKind(kind: ApiKind): boolean {
  return (
    kind === "function" ||
    kind === "class" ||
    kind === "enum" ||
    kind === "variable" ||
    kind === "namespace"
  );
}

export function isTypeKind(kind: ApiKind): boolean {
  return (
    kind === "interface" ||
    kind === "type-alias" ||
    kind === "class" ||
    kind === "enum"
  );
}

import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const VIRTUAL_ROOT = "/__tsdiff__/__root__.ts";

/**
 * Builds a single TypeScript Program containing both `.d.ts` files,
 * exposed as `__old` and `__new` namespace imports inside a virtual root.
 *
 * Using one Program lets the type checker compare types across the two
 * files (assignability, structural identity, etc.).
 */
export function createDiffProgram(oldFile: string, newFile: string) {
  const oldAbs = path.resolve(oldFile);
  const newAbs = path.resolve(newFile);

  if (!fs.existsSync(oldAbs)) throw new Error(`File not found: ${oldAbs}`);
  if (!fs.existsSync(newAbs)) throw new Error(`File not found: ${newAbs}`);

  const rootText =
    `import * as __old from ${JSON.stringify(stripDtsExt(oldAbs))};\n` +
    `import * as __new from ${JSON.stringify(stripDtsExt(newAbs))};\n` +
    `export { __old, __new };\n`;

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    allowJs: false,
    esModuleInterop: true,
    declaration: false,
    types: [],
  };

  const host = ts.createCompilerHost(compilerOptions, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);

  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    if (fileName === VIRTUAL_ROOT) {
      return ts.createSourceFile(fileName, rootText, languageVersion, true);
    }
    return originalGetSourceFile(
      fileName,
      languageVersion,
      onError,
      shouldCreate,
    );
  };
  host.readFile = (fileName) => {
    if (fileName === VIRTUAL_ROOT) return rootText;
    return originalReadFile(fileName);
  };
  host.fileExists = (fileName) => {
    if (fileName === VIRTUAL_ROOT) return true;
    return originalFileExists(fileName);
  };
  host.getCurrentDirectory = () => path.dirname(oldAbs);

  const program = ts.createProgram({
    rootNames: [VIRTUAL_ROOT],
    options: compilerOptions,
    host,
  });

  const checker = program.getTypeChecker();
  const rootSource = program.getSourceFile(VIRTUAL_ROOT);
  if (!rootSource) throw new Error("Failed to load virtual root source");

  const { oldNs, newNs } = readNamespaces(rootSource, checker);

  return { program, checker, oldNs, newNs };
}

function stripDtsExt(p: string): string {
  // TS module specifiers shouldn't include `.d.ts`; resolution will find it.
  if (p.endsWith(".d.ts")) return p.slice(0, -".d.ts".length);
  if (p.endsWith(".ts")) return p.slice(0, -".ts".length);
  return p;
}

function readNamespaces(root: ts.SourceFile, checker: ts.TypeChecker) {
  let oldNs: ts.Symbol | undefined;
  let newNs: ts.Symbol | undefined;

  for (const stmt of root.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const clause = stmt.importClause;
    if (!clause?.namedBindings || !ts.isNamespaceImport(clause.namedBindings))
      continue;
    const name = clause.namedBindings.name;
    const sym = checker.getSymbolAtLocation(name);
    if (!sym) continue;
    const aliased =
      (sym.flags & ts.SymbolFlags.Alias) !== 0
        ? checker.getAliasedSymbol(sym)
        : sym;
    if (name.text === "__old") oldNs = aliased;
    else if (name.text === "__new") newNs = aliased;
  }

  if (!oldNs || !newNs) {
    throw new Error("Failed to resolve module namespaces from input files");
  }
  return { oldNs, newNs };
}

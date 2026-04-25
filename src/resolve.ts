import { setupTypeAcquisition } from "@typescript/ata";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";

export interface ResolvedInput {
  /** Absolute path to a `.d.ts` file, suitable for the diff program. */
  dtsPath: string;
  /** Human-readable label (e.g. `"zod@3.22.0"` or the original file path). */
  label: string;
  /** Cleanup function. Safe to call multiple times. */
  cleanup: () => void;
}

/**
 * Optional progress hook used to drive a spinner / progress UI in the CLI.
 * All methods are optional; resolveInput remains usable from library code
 * without supplying any reporter.
 */
export interface ProgressReporter {
  /** Called when a high-level step starts (e.g. "acquiring types for X"). */
  start?: (message: string) => void;
  /** Called when the active step's label should change. */
  update?: (message: string) => void;
  /** Called when downloads progress (downloaded/total file counts). */
  progress?: (downloaded: number, total: number) => void;
  /** Called when the step succeeds. */
  succeed?: (message: string) => void;
  /** Called when the step fails. */
  fail?: (message: string) => void;
  /** Called for incidental info that shouldn't replace the active step. */
  info?: (message: string) => void;
}

/**
 * Resolve a CLI input to a `.d.ts` file path.
 *
 * Inputs may be:
 *   - A path to an existing `.d.ts` file (returned as-is).
 *   - An npm package spec (`zod`, `zod@3.22.0`, `@scope/pkg@latest`).
 *
 * For npm specs we use TypeScript's Automatic Type Acquisition (ATA)
 * to download the package's `.d.ts` files and the `.d.ts` files of every
 * (transitively) referenced dependency from jsDelivr. Files are written
 * into a temporary `node_modules` tree so the TS compiler can resolve
 * bare imports like `react` or `@emotion/react` naturally.
 */
export async function resolveInput(
  input: string,
  reporter: ProgressReporter = {},
): Promise<ResolvedInput> {
  if (looksLikeFilePath(input)) {
    const abs = path.resolve(input);
    if (!fs.existsSync(abs)) {
      throw new Error(`File not found: ${abs}`);
    }
    return { dtsPath: abs, label: input, cleanup: () => {} };
  }
  return resolveNpmSpec(input, reporter);
}

function looksLikeFilePath(s: string): boolean {
  if (s.startsWith(".") || s.startsWith("/") || s.startsWith("~")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true;
  if (s.endsWith(".d.ts") || s.endsWith(".ts")) return true;
  return false;
}

async function resolveNpmSpec(
  spec: string,
  reporter: ProgressReporter,
): Promise<ResolvedInput> {
  const { name, versionOrTag } = parseSpec(spec);
  reporter.start?.(`Acquiring types for ${name}@${versionOrTag}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsdiff-pkg-"));
  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort.
    }
  };

  try {
    await runAta(name, versionOrTag, tmpDir, reporter);

    const pkgDir = path.join(tmpDir, "node_modules", ...name.split("/"));
    const pkgJsonPath = path.join(pkgDir, "package.json");
    if (!fs.existsSync(pkgJsonPath)) {
      throw new Error(
        `ATA did not download package.json for ${name}@${versionOrTag}. ` +
          `The package may not exist or have no published types.`,
      );
    }
    const pkg = JSON.parse(
      fs.readFileSync(pkgJsonPath, "utf8"),
    ) as PackageJsonLike;
    const installedVersion =
      typeof pkg.version === "string" ? pkg.version : versionOrTag;

    const entry = pickTypesEntry(pkg);
    const entryPath = entry
      ? path.join(pkgDir, normalizePath(entry))
      : findFallbackEntry(pkgDir);

    if (entryPath && fs.existsSync(entryPath)) {
      reporter.succeed?.(`Resolved ${name}@${installedVersion}`);
      return {
        dtsPath: entryPath,
        label: `${name}@${installedVersion}`,
        cleanup,
      };
    }

    // Fall back to DefinitelyTyped (`@types/<name>`). The DT naming convention
    // for scoped packages flattens the slash: `@scope/foo` → `@types/scope__foo`.
    const dtName = definitelyTypedName(name);
    reporter.update?.(
      `${name}@${installedVersion} ships no declarations; trying ${dtName}`,
    );
    const dtResolved = await tryResolveDtPackage(
      dtName,
      versionOrTag,
      tmpDir,
      reporter,
    );
    if (dtResolved) {
      reporter.succeed?.(
        `Resolved ${dtName}@${dtResolved.version} (for ${name}@${installedVersion})`,
      );
      return {
        dtsPath: dtResolved.entryPath,
        label: `${dtName}@${dtResolved.version} (for ${name}@${installedVersion})`,
        cleanup,
      };
    }

    throw new Error(
      `No TypeScript declarations found for ${name}@${installedVersion}. ` +
        `Tried "types"/"typings" / exports[".types"] in package.json and ` +
        `${dtName}@${versionOrTag} on DefinitelyTyped.`,
    );
  } catch (err) {
    reporter.fail?.((err as Error).message);
    cleanup();
    throw err;
  }
}

async function runAta(
  name: string,
  versionOrTag: string,
  tmpDir: string,
  reporter: ProgressReporter,
): Promise<void> {
  let downloads = 0;
  const errors: Error[] = [];

  const ata = setupTypeAcquisition({
    projectName: "tsdiff",
    typescript: ts,
    logger: silentLogger(),
    delegate: {
      receivedFile: (code, vfsPath) => {
        // ATA produces VFS paths like "/node_modules/<pkg>/index.d.ts".
        // Rewrite onto disk relative to our tmp dir.
        const rel = vfsPath.replace(/^\/+/, "");
        const target = path.join(tmpDir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, code);
        downloads++;
      },
      progress: (downloaded, total) => {
        reporter.progress?.(downloaded, total);
      },
      errorMessage: (msg, err) => {
        errors.push(new Error(`${msg}: ${err.message}`));
      },
      finished: () => {},
    },
  });

  // ATA reads version pins from `// types: <version>` end-of-line comments.
  const source = `import * as __pkg from ${JSON.stringify(name)}; // types: ${versionOrTag}\n`;

  await ata(source);

  if (downloads === 0) {
    const detail = errors.length ? ` (${errors[0]?.message})` : "";
    throw new Error(
      `Type acquisition for ${name}@${versionOrTag} produced no files${detail}. ` +
        `The package may not exist, the version may be invalid, or jsDelivr may be unreachable.`,
    );
  }
}

function findFallbackEntry(pkgDir: string): string | undefined {
  for (const f of ["index.d.ts", "index.d.mts", "index.d.cts"]) {
    const p = path.join(pkgDir, f);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Map an npm package name to its DefinitelyTyped (`@types/*`) counterpart.
 * Scoped packages flatten the slash: `@scope/foo` → `@types/scope__foo`.
 */
function definitelyTypedName(name: string): string {
  if (name.startsWith("@types/")) return name;
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    if (slash !== -1) {
      const scope = name.slice(1, slash);
      const rest = name.slice(slash + 1);
      return `@types/${scope}__${rest}`;
    }
  }
  return `@types/${name}`;
}

/**
 * Attempt to download a DefinitelyTyped package and locate its entry point.
 * Tries the requested version pin first, then progressively looser fallbacks
 * (major-only, then `latest`) since `@types/*` versions don't always match
 * the upstream package version exactly.
 */
async function tryResolveDtPackage(
  dtName: string,
  versionOrTag: string,
  tmpDir: string,
  reporter: ProgressReporter,
): Promise<{ entryPath: string; version: string } | undefined> {
  const candidates = dtVersionCandidates(versionOrTag);
  const dtPkgDir = path.join(tmpDir, "node_modules", ...dtName.split("/"));

  for (const candidate of candidates) {
    try {
      await runAta(dtName, candidate, tmpDir, reporter);
    } catch {
      continue;
    }

    const pkgJsonPath = path.join(dtPkgDir, "package.json");
    if (!fs.existsSync(pkgJsonPath)) continue;
    const pkg = JSON.parse(
      fs.readFileSync(pkgJsonPath, "utf8"),
    ) as PackageJsonLike;
    const installedVersion =
      typeof pkg.version === "string" ? pkg.version : candidate;

    const entry = pickTypesEntry(pkg);
    const entryPath = entry
      ? path.join(dtPkgDir, normalizePath(entry))
      : findFallbackEntry(dtPkgDir);
    if (entryPath && fs.existsSync(entryPath)) {
      return { entryPath, version: installedVersion };
    }
  }
  return undefined;
}

function dtVersionCandidates(versionOrTag: string): string[] {
  const out = [versionOrTag];
  // If we got something like "17.0.2", also try the major ("17") since
  // @types versions track major-version compatibility, not exact versions.
  const major = /^\d+/.exec(versionOrTag)?.[0];
  if (major && major !== versionOrTag) out.push(major);
  if (!out.includes("latest")) out.push("latest");
  return out;
}

function silentLogger(): {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  groupCollapsed: (...args: unknown[]) => void;
  groupEnd: (...args: unknown[]) => void;
} {
  return {
    log: () => {},
    error: () => {},
    groupCollapsed: () => {},
    groupEnd: () => {},
  };
}

function parseSpec(spec: string): { name: string; versionOrTag: string } {
  if (spec.startsWith("@")) {
    const slashIdx = spec.indexOf("/");
    if (slashIdx === -1) {
      throw new Error(`Invalid scoped package spec: ${spec}`);
    }
    const rest = spec.slice(slashIdx + 1);
    const atIdx = rest.indexOf("@");
    if (atIdx === -1) return { name: spec, versionOrTag: "latest" };
    return {
      name: `${spec.slice(0, slashIdx)}/${rest.slice(0, atIdx)}`,
      versionOrTag: rest.slice(atIdx + 1),
    };
  }
  const atIdx = spec.indexOf("@");
  if (atIdx === -1) return { name: spec, versionOrTag: "latest" };
  return { name: spec.slice(0, atIdx), versionOrTag: spec.slice(atIdx + 1) };
}

interface PackageJsonLike {
  version?: string;
  types?: string;
  typings?: string;
  exports?: unknown;
}

function pickTypesEntry(pkg: PackageJsonLike): string | undefined {
  if (typeof pkg.types === "string") return pkg.types;
  if (typeof pkg.typings === "string") return pkg.typings;
  return pickExportsTypes(pkg.exports);
}

function pickExportsTypes(exportsField: unknown): string | undefined {
  if (!exportsField || typeof exportsField !== "object") return undefined;
  const root = (exportsField as Record<string, unknown>)["."] ?? exportsField;
  return findTypesInConditions(root);
}

function findTypesInConditions(node: unknown): string | undefined {
  if (typeof node === "string") {
    return /\.d\.[mc]?ts$/.test(node) ? node : undefined;
  }
  if (!node || typeof node !== "object") return undefined;
  const obj = node as Record<string, unknown>;
  if (typeof obj.types === "string") return obj.types;
  for (const value of Object.values(obj)) {
    const found = findTypesInConditions(value);
    if (found) return found;
  }
  return undefined;
}

function normalizePath(p: string): string {
  return p.replace(/^\.?\//, "").replace(/^\.\//, "");
}

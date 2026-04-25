# tsdiff

Detect breaking changes in a TypeScript package's public API surface.

> ⚠️ **Prototype.** `tsdiff` is an early experiment. The CLI flags, programmatic API, and output format may change without notice, and there are known cases where the diff output is incomplete or misleading. Don't rely on it for anything important yet.

Inspired by [oasdiff](https://github.com/Tufin/oasdiff) for OpenAPI specs — but for `.d.ts` files.

`tsdiff` loads the previous and the new declaration file into a single TypeScript program and uses the compiler's own type checker to determine whether the new API is **assignment-compatible** with the old one. That makes it stricter and more accurate than text diffing, and catches subtle issues like narrowed parameter types, widened required fields, or removed overloads.

## Install

```sh
pnpm add -g @evrys/tsdiff
# or use without installing
pnpm dlx @evrys/tsdiff <old> <new>
```

(`npm` and `yarn` work too.)

## Usage

```sh
tsdiff <old> <new>
```

Each `<old>` / `<new>` is either a path to a `.d.ts` file or an npm package
specifier like `zod@3.22.0` or `@scope/pkg@latest`. When given a specifier,
`tsdiff` fetches the package's types from the npm registry (via
[`@typescript/ata`](https://www.npmjs.com/package/@typescript/ata)) and
diffs against its declared types entry.

Exits with a non-zero status when at least one breaking change is detected, so it can be wired straight into CI.

### Options

| Flag | Description |
| --- | --- |
| `--format <human\|json>` | Output format. Default: `human`. |
| `--no-exit-code` | Always exit with status 0, even when breaking changes are found. |
| `-h, --help` | Show help. |
| `-v, --version` | Show version. |

### Examples

```sh
tsdiff old.d.ts new.d.ts
tsdiff zod@3.22.0 zod@3.23.0
tsdiff @sanity/client@6.0.0 @sanity/client@7.0.0
```

```sh
$ tsdiff before.d.ts after.d.ts
✖ 2 breaking change(s)
  • Export `parseFoo` (function) was removed
  • Export `Config` has an incompatible type (new value not assignable to old type)
      old: { id: string; name?: string; }
      new: { id: string; name: string; }
+ 1 non-breaking change(s)
  • Export `parseBar` (function) was added
```

## Programmatic API

```ts
import { diffDeclarations, formatHuman, resolveInput } from "@evrys/tsdiff";

const oldR = await resolveInput("zod@3.22.0");
const newR = await resolveInput("zod@3.23.0");
try {
  const result = diffDeclarations(oldR.dtsPath, newR.dtsPath);
  console.log(formatHuman(result));
  if (result.breakingCount > 0) process.exit(1);
} finally {
  oldR.cleanup();
  newR.cleanup();
}
```

`resolveInput` accepts the same `<old>` / `<new>` inputs as the CLI (file path
or npm specifier) and returns `{ dtsPath, label, cleanup }`. For local files
you can call `diffDeclarations(oldPath, newPath)` directly.

## What it detects

- Removed exports (breaking)
- Added exports (non-breaking)
- Kind changes (e.g. `function` → `variable`)
- Function signature changes — new required parameters, narrowed parameter types, widened return types
- Interface / type-alias shape changes — new required fields, removed fields, narrowed unions
- Class member changes
- Cross-cutting type assignability via the TypeScript checker

## How it works

1. Inputs are resolved to `.d.ts` files. npm specifiers are fetched through
   `@typescript/ata`, which writes a real `node_modules/<pkg>/...` layout into
   a temp directory so TypeScript can resolve bare imports the same way it
   would in a normal project.
2. Both `.d.ts` files are loaded into a single `ts.Program` via a virtual root that does:
   ```ts
   import * as __old from "<old>";
   import * as __new from "<new>";
   ```
3. The exports of each module-namespace symbol are walked to build an API surface map.
4. For each name present in both surfaces, `tsdiff` compares the symbol kinds and uses `checker.isTypeAssignableTo` in both directions to classify the change.

## License

MIT

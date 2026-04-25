# tsdiff

Detect breaking changes in a TypeScript package's public API surface.

Inspired by [oasdiff](https://github.com/Tufin/oasdiff) for OpenAPI specs — but for `.d.ts` files.

`tsdiff` loads the previous and the new declaration file into a single TypeScript program and uses the compiler's own type checker to determine whether the new API is **assignment-compatible** with the old one. That makes it stricter and more accurate than text diffing, and catches subtle issues like narrowed parameter types, widened required fields, or removed overloads.

## Install

```sh
pnpm add -g tsdiff
# or use without installing
pnpm dlx tsdiff <old.d.ts> <new.d.ts>
```

(`npm` and `yarn` work too — `tsdiff` is a regular npm package.)

## Usage

```sh
tsdiff path/to/old.d.ts path/to/new.d.ts
```

Exits with a non-zero status when at least one breaking change is detected, so it can be wired straight into CI.

### Options

| Flag | Description |
| --- | --- |
| `--format <human\|json>` | Output format. Default: `human`. |
| `--strict` | Treat newly added exports as `info` instead of `non-breaking`. |
| `--no-exit-code` | Always exit with status 0, even when breaking changes are found. |

### Example

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
import { diffDeclarations, formatHuman } from "tsdiff";

const result = diffDeclarations("./old.d.ts", "./new.d.ts");
console.log(formatHuman(result));

if (result.breakingCount > 0) process.exit(1);
```

## What it detects

- Removed exports (breaking)
- Added exports (non-breaking, or info under `--strict`)
- Kind changes (e.g. `function` → `variable`)
- Function signature changes — new required parameters, narrowed parameter types, widened return types
- Interface / type-alias shape changes — new required fields, removed fields, narrowed unions
- Class member changes
- Cross-cutting type assignability via the TypeScript checker

## What it does not (yet) detect

- Comparing whole packages from npm specifiers (planned)
- JSDoc `@deprecated` tracking
- Suggesting a SemVer bump
- Markdown / GitHub Actions output

PRs welcome.

## How it works

1. Both `.d.ts` files are loaded into a single `ts.Program` via a virtual root that does:
   ```ts
   import * as __old from "<old>";
   import * as __new from "<new>";
   ```
2. The exports of each module-namespace symbol are walked to build an API surface map.
3. For each name present in both surfaces, `tsdiff` compares the symbol kinds and uses `checker.isTypeAssignableTo` in both directions to classify the change.

## License

MIT

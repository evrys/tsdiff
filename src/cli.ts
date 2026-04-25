import { parseArgs } from "node:util";
import { diffDeclarations } from "./diff.js";
import { formatHuman, formatJson } from "./format.js";

const USAGE = `tsdiff — detect breaking changes between two TypeScript .d.ts files

Usage:
  tsdiff <old.d.ts> <new.d.ts> [options]

Options:
  --format <human|json>   Output format (default: human)
  --strict                Treat new exports as info instead of non-breaking
  --no-exit-code          Do not exit with a non-zero status on breaking changes
  -h, --help              Show this help
  -v, --version           Show version
`;

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        format: { type: "string", default: "human" },
        strict: { type: "boolean", default: false },
        "no-exit-code": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (err) {
    process.stderr.write(`tsdiff: ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.version) {
    process.stdout.write("tsdiff 0.1.0\n");
    return 0;
  }
  if (positionals.length !== 2) {
    process.stderr.write(
      `tsdiff: expected exactly two file arguments\n\n${USAGE}`,
    );
    return 2;
  }

  const [oldFile, newFile] = positionals as [string, string];
  const format = values.format;
  if (format !== "human" && format !== "json") {
    process.stderr.write(`tsdiff: --format must be 'human' or 'json'\n`);
    return 2;
  }

  let result: ReturnType<typeof diffDeclarations>;
  try {
    result = diffDeclarations(oldFile, newFile, { strict: !!values.strict });
  } catch (err) {
    process.stderr.write(`tsdiff: ${(err as Error).message}\n`);
    return 1;
  }

  if (format === "json") {
    process.stdout.write(`${formatJson(result)}\n`);
  } else {
    process.stdout.write(`${formatHuman(result)}\n`);
  }

  if (result.breakingCount > 0 && !values["no-exit-code"]) return 1;
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(
      `tsdiff: unexpected error: ${(err as Error).stack ?? err}\n`,
    );
    process.exit(1);
  },
);

import chalk from "chalk";
import { parseArgs } from "node:util";
import ora, { type Ora } from "ora";
import { diffDeclarations } from "./diff.js";
import { formatHuman, formatJson } from "./format.js";
import { type ProgressReporter, resolveInput } from "./resolve.js";

const USAGE = `tsdiff — detect breaking changes between two TypeScript APIs

Usage:
  tsdiff <old> <new> [options]

Each <old>/<new> may be either a path to a \`.d.ts\` file or an npm package
specifier such as "zod@3.22.0" or "@scope/pkg@latest". When given a specifier,
tsdiff installs the package into a temporary directory and uses its declared
types entry.

Options:
  --format <human|json>   Output format (default: human)
  --strict                Also exit non-zero on potentially-breaking warnings
  --no-exit-code          Do not exit with a non-zero status on breaking changes
  -h, --help              Show this help
  -v, --version           Show version

Exit codes:
  0   no breaking changes (warnings allowed unless --strict)
  1   breaking changes detected (or warnings, with --strict)
  2   invalid usage

Examples:
  tsdiff old.d.ts new.d.ts
  tsdiff zod@3.22.0 zod@3.23.0
  tsdiff @sanity/client@6.0.0 @sanity/client@7.0.0
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
    process.stdout.write("tsdiff 0.0.1\n");
    return 0;
  }
  if (positionals.length !== 2) {
    process.stderr.write(`tsdiff: expected exactly two arguments\n\n${USAGE}`);
    return 2;
  }

  const [oldArg, newArg] = positionals as [string, string];
  const format = values.format;
  if (format !== "human" && format !== "json") {
    process.stderr.write(`tsdiff: --format must be 'human' or 'json'\n`);
    return 2;
  }

  let oldResolved: Awaited<ReturnType<typeof resolveInput>>;
  let newResolved: Awaited<ReturnType<typeof resolveInput>>;
  const useSpinner = format === "human" && process.stderr.isTTY === true;
  try {
    oldResolved = await resolveInput(oldArg, makeReporter(useSpinner));
    try {
      newResolved = await resolveInput(newArg, makeReporter(useSpinner));
    } catch (err) {
      oldResolved.cleanup();
      throw err;
    }
  } catch (err) {
    process.stderr.write(`${chalk.red("✖")} ${(err as Error).message}\n`);
    return 1;
  }

  let result: ReturnType<typeof diffDeclarations>;
  const diffSpinner = useSpinner
    ? ora({
        text: `Comparing ${oldResolved.label} → ${newResolved.label}`,
        stream: process.stderr,
      }).start()
    : null;
  if (!diffSpinner && format === "human") {
    process.stderr.write(
      `${chalk.dim("·")} Comparing ${oldResolved.label} → ${newResolved.label}\n`,
    );
  }
  try {
    result = diffDeclarations(oldResolved.dtsPath, newResolved.dtsPath);
    diffSpinner?.succeed(
      `Compared ${oldResolved.label} → ${newResolved.label}`,
    );
  } catch (err) {
    diffSpinner?.fail((err as Error).message);
    process.stderr.write(`${chalk.red("✖")} ${(err as Error).message}\n`);
    oldResolved.cleanup();
    newResolved.cleanup();
    return 1;
  } finally {
    oldResolved.cleanup();
    newResolved.cleanup();
  }

  if (format === "json") {
    process.stdout.write(`${formatJson(result)}\n`);
  } else {
    process.stdout.write(`${formatHuman(result)}\n`);
  }

  if (values["no-exit-code"]) return 0;
  if (result.breakingCount > 0) return 1;
  if (values.strict && result.warningCount > 0) return 1;
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(
      `${chalk.red("✖")} unexpected error: ${(err as Error).stack ?? err}\n`,
    );
    process.exit(1);
  },
);

function makeReporter(useSpinner: boolean): ProgressReporter {
  if (!useSpinner) {
    return {
      start: (m) => process.stderr.write(`${chalk.dim("·")} ${m}\n`),
      succeed: (m) => process.stderr.write(`${chalk.green("✓")} ${m}\n`),
      info: (m) => process.stderr.write(`${chalk.dim("·")} ${m}\n`),
    };
  }

  let spinner: Ora | null = null;
  let baseText = "";
  return {
    start: (m) => {
      baseText = m;
      spinner = ora({ text: m, stream: process.stderr }).start();
    },
    update: (m) => {
      baseText = m;
      if (spinner) spinner.text = m;
    },
    progress: (downloaded, total) => {
      if (spinner) {
        spinner.text = `${baseText} ${chalk.dim(`(${downloaded}/${total} files)`)}`;
      }
    },
    succeed: (m) => {
      spinner?.succeed(m);
      spinner = null;
    },
    fail: () => {
      // Don't print here; let the CLI's catch handler render the error
      // uniformly. We just stop the spinner so it doesn't linger.
      spinner?.stop();
      spinner = null;
    },
    info: (m) => {
      spinner?.info(m);
      spinner = null;
    },
  };
}

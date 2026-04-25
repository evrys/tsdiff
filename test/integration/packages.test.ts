import { describe, expect, it } from "vitest";
import { diffDeclarations } from "../../src/diff.js";
import { resolveInput } from "../../src/resolve.js";

/**
 * Integration tests: diff two real published versions of popular npm
 * packages. These hit the network (jsDelivr via TypeScript ATA) so they
 * are excluded from the default `pnpm test` run and gated behind
 * `pnpm test:integration`.
 *
 * Each case pins specific old/new versions so we can assert exact
 * change counts. If a count drifts unexpectedly, that's a real signal —
 * either the diff engine changed behaviour or jsDelivr is serving
 * something unexpected (npm's immutability makes a re-publish
 * extremely unlikely).
 */

interface PackageCase {
  name: string;
  old: string;
  new: string;
  /** Total number of changes (breaking + warning + info). */
  total: number;
  breaking: number;
  warning: number;
  info: number;
}

const CASES: PackageCase[] = [
  // Pure-types utility library; major bump. The single warning here is
  // a one-directional type-space mismatch (only readers OR producers
  // affected, not both).
  {
    name: "type-fest major bump",
    old: "type-fest@3.0.0",
    new: "type-fest@4.0.0",
    total: 46,
    breaking: 19,
    warning: 1,
    info: 26,
  },
  // ESM-only major bump; large surface of removed/added exports.
  {
    name: "chalk major bump",
    old: "chalk@4.1.2",
    new: "chalk@5.0.0",
    total: 79,
    breaking: 72,
    warning: 0,
    info: 7,
  },
  // HTTP client with a tightly-typed builder API. Exercises generics
  // and overloads on a real codebase.
  {
    name: "ky major bump",
    old: "ky@0.33.0",
    new: "ky@1.0.0",
    total: 14,
    breaking: 2,
    warning: 0,
    info: 12,
  },
  // Promise-queue utility; small but non-trivial class hierarchy.
  {
    name: "p-queue major bump",
    old: "p-queue@7.0.0",
    new: "p-queue@8.0.0",
    total: 8,
    breaking: 5,
    warning: 0,
    info: 3,
  },
  // Minor bump within a major — should be mostly informational.
  {
    name: "ofetch minor bump",
    old: "ofetch@1.0.0",
    new: "ofetch@1.4.0",
    total: 15,
    breaking: 4,
    warning: 0,
    info: 11,
  },
  // Exercises the `@types/*` (DefinitelyTyped) fallback path: `react`
  // itself ships no `.d.ts`, so the resolver pulls `@types/react` of
  // the same version.
  {
    name: "react major bump (via @types/react)",
    old: "react@17.0.2",
    new: "react@18.0.0",
    total: 109,
    breaking: 89,
    warning: 3,
    info: 17,
  },
  // Larger CLI library with a mix of all three severities — useful as
  // a regression case for the warning tier.
  {
    name: "commander major bump",
    old: "commander@9.0.0",
    new: "commander@10.0.0",
    total: 10,
    breaking: 4,
    warning: 3,
    info: 3,
  },
  // 0-breaking major bump dominated by potentially-breaking changes;
  // useful to ensure the warning tier doesn't get folded into
  // breaking.
  {
    name: "execa major bump",
    old: "execa@7.0.0",
    new: "execa@8.0.0",
    total: 14,
    breaking: 0,
    warning: 6,
    info: 8,
  },
  // CLI argument parser; clean breaking-major with no warnings.
  {
    name: "yargs major bump",
    old: "yargs@16.0.0",
    new: "yargs@17.0.0",
    total: 9,
    breaking: 6,
    warning: 0,
    info: 3,
  },
  // Tiny patch bump on a `@types`-only package (no scope), exercises
  // the DT fallback for the most common naming case.
  {
    name: "lodash patch bump (via @types/lodash)",
    old: "lodash@4.17.20",
    new: "lodash@4.17.21",
    total: 4,
    breaking: 1,
    warning: 0,
    info: 3,
  },
];

const TYPE_STRING_BOUND = 4096;
const TIMEOUT_MS = 120_000;

describe("integration: diff real npm packages", () => {
  for (const c of CASES) {
    it(
      c.name,
      async () => {
        const oldResolved = await resolveInput(c.old);
        let newResolved: Awaited<ReturnType<typeof resolveInput>> | undefined;
        try {
          newResolved = await resolveInput(c.new);
          const result = diffDeclarations(
            oldResolved.dtsPath,
            newResolved.dtsPath,
          );

          // Counts agree with the changes array.
          const breaking = result.changes.filter(
            (x) => x.severity === "breaking",
          ).length;
          const warning = result.changes.filter(
            (x) => x.severity === "warning",
          ).length;
          const info = result.changes.filter(
            (x) => x.severity === "info",
          ).length;
          expect(breaking).toBe(result.breakingCount);
          expect(warning).toBe(result.warningCount);
          expect(info).toBe(result.infoCount);

          // No oversized type-strings (regression guard for the
          // chained-builder blow-up; see test/diff.test.ts).
          for (const change of result.changes) {
            const oldLen = String(change.details?.oldType ?? "").length;
            const newLen = String(change.details?.newType ?? "").length;
            expect(
              Math.max(oldLen, newLen),
              `change \`${change.name}\` (${change.kind}) oversized: old=${oldLen}, new=${newLen}`,
            ).toBeLessThan(TYPE_STRING_BOUND);
          }

          // Pinned exact counts. If one of these starts failing,
          // inspect the diff before adjusting — it likely indicates a
          // real behaviour change in the engine.
          expect(result.changes.length, "total changes").toBe(c.total);
          expect(result.breakingCount, "breakingCount").toBe(c.breaking);
          expect(result.warningCount, "warningCount").toBe(c.warning);
          expect(result.infoCount, "infoCount").toBe(c.info);
        } finally {
          oldResolved.cleanup();
          newResolved?.cleanup();
        }
      },
      TIMEOUT_MS,
    );
  }
});

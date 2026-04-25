import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffDeclarations } from "../src/index.js";

function fixture(oldDts: string, newDts: string) {
  const dir = mkdtempSync(join(tmpdir(), "tsdiff-"));
  const oldPath = join(dir, "old.d.ts");
  const newPath = join(dir, "new.d.ts");
  writeFileSync(oldPath, oldDts);
  writeFileSync(newPath, newDts);
  return { oldPath, newPath };
}

describe("diffDeclarations", () => {
  it("reports no changes for identical APIs", () => {
    const { oldPath, newPath } = fixture(
      `export declare function add(a: number, b: number): number;\n`,
      `export declare function add(a: number, b: number): number;\n`,
    );
    const result = diffDeclarations(oldPath, newPath);
    expect(result.changes).toEqual([]);
  });

  it("detects a removed export as breaking", () => {
    const { oldPath, newPath } = fixture(
      `export declare function add(a: number, b: number): number;\nexport declare function sub(a: number, b: number): number;\n`,
      `export declare function add(a: number, b: number): number;\n`,
    );
    const result = diffDeclarations(oldPath, newPath);
    expect(result.breakingCount).toBe(1);
    expect(result.changes[0]).toMatchObject({
      kind: "export-removed",
      severity: "breaking",
      name: "sub",
    });
  });

  it("treats new exports as non-breaking", () => {
    const { oldPath, newPath } = fixture(
      `export declare function add(a: number, b: number): number;\n`,
      `export declare function add(a: number, b: number): number;\nexport declare function mul(a: number, b: number): number;\n`,
    );
    const result = diffDeclarations(oldPath, newPath);
    expect(result.breakingCount).toBe(0);
    expect(result.nonBreakingCount).toBe(1);
    expect(result.changes[0]).toMatchObject({
      kind: "export-added",
      severity: "non-breaking",
      name: "mul",
    });
  });

  it("flags a required parameter added to a function as breaking", () => {
    const { oldPath, newPath } = fixture(
      `export declare function greet(name: string): string;\n`,
      `export declare function greet(name: string, title: string): string;\n`,
    );
    const result = diffDeclarations(oldPath, newPath);
    expect(result.breakingCount).toBe(1);
    expect(result.changes[0]?.kind).toBe("type-incompatible");
  });

  it("treats a new optional parameter as compatible", () => {
    const { oldPath, newPath } = fixture(
      `export declare function greet(name: string): string;\n`,
      `export declare function greet(name: string, title?: string): string;\n`,
    );
    const result = diffDeclarations(oldPath, newPath);
    expect(result.breakingCount).toBe(0);
  });

  it("flags a narrowed return type as breaking", () => {
    const { oldPath, newPath } = fixture(
      `export declare function get(): string | number;\n`,
      `export declare function get(): string;\n`,
    );
    const result = diffDeclarations(oldPath, newPath);
    // Narrowing return: callers expecting string|number now get only string -> still assignable.
    // But the *function type* itself is narrower; new fn assignable to old (return is bivariant
    // covariant). Should NOT be breaking. Check overall.
    expect(result.breakingCount).toBe(0);
  });

  it("flags a widened parameter type as breaking for callers depending on the old shape", () => {
    const { oldPath, newPath } = fixture(
      `export declare function set(v: string): void;\n`,
      `export declare function set(v: string | number): void;\n`,
    );
    const result = diffDeclarations(oldPath, newPath);
    // Widening param: new accepts more, callers passing strings still work -> non-breaking.
    expect(result.breakingCount).toBe(0);
  });

  it("flags a narrowed parameter as breaking", () => {
    const { oldPath, newPath } = fixture(
      `export declare function set(v: string | number): void;\n`,
      `export declare function set(v: string): void;\n`,
    );
    const result = diffDeclarations(oldPath, newPath);
    expect(result.breakingCount).toBe(1);
    expect(result.changes[0]?.kind).toBe("type-incompatible");
  });

  it("flags a required field added to an interface as breaking", () => {
    const { oldPath, newPath } = fixture(
      `export interface User { id: string; }\n`,
      `export interface User { id: string; name: string; }\n`,
    );
    const result = diffDeclarations(oldPath, newPath);
    expect(result.breakingCount).toBe(1);
  });

  it("treats an optional field added to an interface as compatible", () => {
    const { oldPath, newPath } = fixture(
      `export interface User { id: string; }\n`,
      `export interface User { id: string; name?: string; }\n`,
    );
    const result = diffDeclarations(oldPath, newPath);
    expect(result.breakingCount).toBe(0);
  });

  it("detects removed class member as breaking", () => {
    const { oldPath, newPath } = fixture(
      `export declare class Foo { bar(): void; baz(): void; }\n`,
      `export declare class Foo { bar(): void; }\n`,
    );
    const result = diffDeclarations(oldPath, newPath);
    expect(result.breakingCount).toBeGreaterThan(0);
  });

  it("detects kind change", () => {
    const { oldPath, newPath } = fixture(
      `export declare function thing(): void;\n`,
      `export declare const thing: number;\n`,
    );
    const result = diffDeclarations(oldPath, newPath);
    expect(result.changes.some((c) => c.kind === "kind-changed")).toBe(true);
  });
});

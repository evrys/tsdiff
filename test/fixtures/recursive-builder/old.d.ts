// Reduced reproduction of the zod chained-builder pattern that causes
// `typeToString` to produce gigantic structural fingerprints in `diff.ts`.
// The combination of self-referential generics, conditional types in
// signatures, and many methods that all return another `Builder<...>` makes
// each property's type-string include the full builder shape recursively.

type ParseInput = unknown;
type ParseReturn<T> = { ok: true; value: T } | { ok: false };
type RefinementCtx = { issues: unknown[] };
type Cardinality = "many" | "atleastone";
type ArrayOutput<T extends Builder<any>, C extends Cardinality> = C extends "atleastone"
  ? [T["_output"], ...T["_output"][]]
  : Array<T["_output"]>;
type ArrayInput<T extends Builder<any>, C extends Cardinality> = C extends "atleastone"
  ? [T["_input"], ...T["_input"][]]
  : Array<T["_input"]>;

export interface Builder<Output, Input = Output> {
  readonly _output: Output;
  readonly _input: Input;
  parse(data: unknown): Output;
  parseAsync(data: unknown): Promise<Output>;
  safeParse(data: unknown): { success: true; data: Output } | { success: false };
  safeParseAsync(data: unknown): Promise<{ success: true; data: Output } | { success: false }>;
  refine<R extends Output>(check: (v: Output) => v is R, msg?: string): Effects<this, R, Input>;
  refine(check: (v: Output) => unknown, msg?: string): Effects<this, Output, Input>;
  refinement<R extends Output>(check: (v: Output) => v is R, ctx: RefinementCtx): Effects<this, R, Input>;
  superRefine<R extends Output>(check: (v: Output, ctx: RefinementCtx) => v is R): Effects<this, R, Input>;
  superRefine(check: (v: Output, ctx: RefinementCtx) => void | Promise<void>): Effects<this, Output, Input>;
  optional(): Optional<this>;
  nullable(): Nullable<this>;
  nullish(): Optional<Nullable<this>>;
  array(): ArrayBuilder<this, "many">;
  promise(): PromiseBuilder<this>;
  or<T extends Builder<any>>(option: T): Union<[this, T]>;
  and<T extends Builder<any>>(other: T): Intersection<this, T>;
  transform<NewOut>(fn: (arg: Output, ctx: RefinementCtx) => NewOut | Promise<NewOut>): Effects<this, NewOut, Input>;
  default(def: Output): Default<this>;
  default(def: () => Output): Default<this>;
  catch(def: Output): Catch<this>;
  pipe<T extends Builder<any>>(target: T): Pipeline<this, T>;
  brand<B extends string | number | symbol>(brand?: B): Branded<this, B>;
  describe(description: string): this;
  isOptional(): boolean;
  isNullable(): boolean;
}

export interface Optional<T extends Builder<any>> extends Builder<T["_output"] | undefined, T["_input"] | undefined> {}
export interface Nullable<T extends Builder<any>> extends Builder<T["_output"] | null, T["_input"] | null> {}
export interface ArrayBuilder<T extends Builder<any>, C extends Cardinality> extends Builder<ArrayOutput<T, C>, ArrayInput<T, C>> {
  element: T;
  min(n: number): ArrayBuilder<T, C>;
  max(n: number): ArrayBuilder<T, C>;
  length(n: number): ArrayBuilder<T, C>;
  nonempty(): ArrayBuilder<T, "atleastone">;
}
export interface PromiseBuilder<T extends Builder<any>> extends Builder<Promise<T["_output"]>, Promise<T["_input"]>> {}
export interface Union<T extends Builder<any>[]> extends Builder<T[number]["_output"], T[number]["_input"]> {}
export interface Intersection<A extends Builder<any>, B extends Builder<any>> extends Builder<A["_output"] & B["_output"], A["_input"] & B["_input"]> {}
export interface Effects<T extends Builder<any>, Out, In> extends Builder<Out, In> {}
export interface Default<T extends Builder<any>> extends Builder<T["_output"], T["_input"] | undefined> {}
export interface Catch<T extends Builder<any>> extends Builder<T["_output"], T["_input"]> {}
export interface Pipeline<A extends Builder<any>, B extends Builder<any>> extends Builder<B["_output"], A["_input"]> {}
export interface Branded<T extends Builder<any>, B> extends Builder<T["_output"] & { __brand: B }, T["_input"]> {}

export declare const stringSchema: Builder<string>;

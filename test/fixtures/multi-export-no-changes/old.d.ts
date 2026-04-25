export declare function repeat<T>(x: T, n: number): T[];
export interface Repeater<T> {
  repeat(x: T, n: number): T[];
}
export type Repeated<T> = T[];

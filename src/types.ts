export type Severity = "breaking" | "non-breaking" | "info";

export type ChangeKind =
  | "export-removed"
  | "export-added"
  | "kind-changed"
  | "type-incompatible"
  | "type-changed";

export interface Change {
  kind: ChangeKind;
  severity: Severity;
  name: string;
  message: string;
  details?: {
    oldKind?: string;
    newKind?: string;
    oldType?: string;
    newType?: string;
  };
}

export interface DiffResult {
  changes: Change[];
  breakingCount: number;
  nonBreakingCount: number;
  infoCount: number;
}

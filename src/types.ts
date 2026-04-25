export type Severity = "breaking" | "warning" | "info";

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
    /**
     * Bullet-point summary of the structural delta between old and new
     * (added / removed / changed properties, signature mismatches,
     * type-parameter changes). Pre-formatted for display: each entry
     * starts with `+ `, `- ` or `~ `.
     */
    differences?: string[];
  };
}

export interface DiffResult {
  changes: Change[];
  /**
   * Definite breaking changes: removing exports, kind transitions that
   * drop the value side, and value-space type incompatibilities. These
   * will fail consumers regardless of how the API is used.
   */
  breakingCount: number;
  /**
   * Likely-breaking changes whose impact depends on whether the
   * consumer reads or constructs values of the affected type
   * (one-directional type-space incompatibilities). Modeled after
   * oasdiff's WARN tier.
   */
  warningCount: number;
  /**
   * Informational changes (additions, compatible refinements,
   * benign kind transitions). Not expected to break consumers.
   */
  infoCount: number;
}

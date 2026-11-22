/**
 * Procedures the isolation matrix does not call, each with the reason. `input`: the generator
 * cannot build a valid input for it, so it is not swept (the matrix fails once it can, so a stale
 * entry is removed). `side-effect`: calling it would break the test world for the caller itself;
 * allowed only for a procedure that names no target (the matrix fails if its input carries an id).
 */
export type IsolationExemption = {
  path: string;
  kind: "input" | "side-effect";
  reason: string;
};

export const ISOLATION_EXEMPTIONS: readonly IsolationExemption[] = [
  {
    path: "models/connect",
    kind: "input",
    reason:
      "Its refinement compares token limits with each other (output must leave room for input), which a field-by-field generator cannot satisfy; it names no Space, bot or chat, only the caller's own model connection.",
  },
];

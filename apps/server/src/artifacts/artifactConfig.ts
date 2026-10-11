// @effect-diagnostics nodeBuiltinImport:off - the artifact store is a Node filesystem and git boundary, outside the Effect runtime.
// Fork-only (artifacts): where the store lives and its limits.
//
// The store is `<baseDir>/artifacts`, next to `userdata/`, so the prod deploy's
// cold backup of `data` includes it. A dev server (state in `<baseDir>/dev`)
// keeps its own store in `<baseDir>/dev/artifacts`. `T3_ARTIFACTS_DIR`
// overrides both, for tests and QA only.
import * as NodePath from "node:path";

import {
  LIM_ARTIFACT_MAX_OTHER_BYTES,
  LIM_ARTIFACT_MAX_TEXT_BYTES,
  type LimArtifactKind,
} from "@t3tools/contracts";

export const ARTIFACTS_DIR_ENV = "T3_ARTIFACTS_DIR";

/** Markdown and HTML files over this size are refused. */
export const MAX_TEXT_ARTIFACT_BYTES = LIM_ARTIFACT_MAX_TEXT_BYTES;

/** Other files over this size are refused. */
export const MAX_OTHER_ARTIFACT_BYTES = LIM_ARTIFACT_MAX_OTHER_BYTES;

/** The size limit for a kind: 10 MB for markdown and HTML, 50 MB for other files. */
export const maxArtifactBytes = (kind: LimArtifactKind) =>
  kind === "other" ? MAX_OTHER_ARTIFACT_BYTES : MAX_TEXT_ARTIFACT_BYTES;

/** "10 MB", for messages. */
export const describeLimit = (kind: LimArtifactKind) =>
  `${maxArtifactBytes(kind) / (1024 * 1024)} MB`;

/** The person behind T3 sessions; commits from the UI are authored as this name. */
export const ARTIFACTS_USER_NAME = "Lee";

export const resolveArtifactsDir = (
  input: { readonly baseDir: string; readonly stateDir: string },
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const override = env[ARTIFACTS_DIR_ENV]?.trim();
  if (override) return NodePath.resolve(override);
  const stateIsDev = NodePath.basename(input.stateDir) === "dev";
  return stateIsDev
    ? NodePath.join(input.stateDir, "artifacts")
    : NodePath.join(input.baseDir, "artifacts");
};

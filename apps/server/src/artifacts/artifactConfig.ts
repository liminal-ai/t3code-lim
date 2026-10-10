// Fork-only (artifacts): where the store lives and its limits.
//
// The store is `<baseDir>/artifacts`, next to `userdata/`, so the prod deploy's
// cold backup of `data` includes it. A dev server (state in `<baseDir>/dev`)
// keeps its own store in `<baseDir>/dev/artifacts`. `T3_ARTIFACTS_DIR`
// overrides both, for tests and QA only.
import * as NodePath from "node:path";

export const ARTIFACTS_DIR_ENV = "T3_ARTIFACTS_DIR";

/** Markdown and HTML files over this size are refused. */
export const MAX_TEXT_ARTIFACT_BYTES = 10 * 1024 * 1024;

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

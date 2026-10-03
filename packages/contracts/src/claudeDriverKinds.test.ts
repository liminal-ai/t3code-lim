import { describe, expect, it } from "vite-plus/test";

import {
  CLAUDE_DRIVER_KIND,
  CLAUDE_DRIVER_KINDS,
  CLAUDE_LHC_DRIVER_KIND,
  isClaudeDriverKind,
} from "./claudeDriverKinds.ts";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  PROVIDER_DISPLAY_NAMES,
} from "./model.ts";

describe("Claude driver kinds", () => {
  it("recognises both Claude kinds and nothing else", () => {
    expect(isClaudeDriverKind("claudeAgent")).toBe(true);
    expect(isClaudeDriverKind("claude-lhc")).toBe(true);
    expect(isClaudeDriverKind("codex")).toBe(false);
    expect(isClaudeDriverKind(null)).toBe(false);
    expect(isClaudeDriverKind(undefined)).toBe(false);
    expect(CLAUDE_DRIVER_KINDS).toEqual([CLAUDE_DRIVER_KIND, CLAUDE_LHC_DRIVER_KIND]);
  });

  it("gives the LHC kind the same model defaults and its own display name", () => {
    expect(DEFAULT_MODEL_BY_PROVIDER[CLAUDE_LHC_DRIVER_KIND]).toBe(
      DEFAULT_MODEL_BY_PROVIDER[CLAUDE_DRIVER_KIND],
    );
    expect(DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[CLAUDE_LHC_DRIVER_KIND]).toBe(
      DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[CLAUDE_DRIVER_KIND],
    );
    expect(PROVIDER_DISPLAY_NAMES[CLAUDE_LHC_DRIVER_KIND]).toBe("Claude LHC");
  });
});

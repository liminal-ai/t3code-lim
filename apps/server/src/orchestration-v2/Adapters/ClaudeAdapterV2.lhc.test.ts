// Claude-LHC on V2: the sidecar needs both compaction windows in the query's settings, fitted to
// the selected model's context window. Stock Claude instances are unaffected.
import { ClaudeLhcSettings, ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeCatalogContextWindowTokens,
} from "../../provider/ClaudeModelCatalog.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";

const LHC_SETTINGS = Schema.decodeUnknownSync(ClaudeLhcSettings)({});
const selection = (model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claude-lhc"),
  model,
});
const optionsFor = (model: string, settings = LHC_SETTINGS) =>
  ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: selection(model),
    nativeThreadId: "lhc-thread",
    resume: false,
    cwd: "/workspace",
    settings,
  });

describe("ClaudeAdapterV2, Claude-LHC compaction settings", () => {
  it("fitLhcCompactionToContextWindow keeps windows that fit and lowers ones that don't", () => {
    assert.deepEqual(
      ClaudeAdapterV2.fitLhcCompactionToContextWindow({
        autoCompactWindow: 380_000,
        lhcLowerBound: 150_000,
        contextWindow: 1_000_000,
      }),
      { autoCompactWindow: 380_000, lhcLowerBound: 150_000 },
    );
    assert.deepEqual(
      ClaudeAdapterV2.fitLhcCompactionToContextWindow({
        autoCompactWindow: 380_000,
        lhcLowerBound: 150_000,
        contextWindow: 200_000,
      }),
      { autoCompactWindow: 160_000, lhcLowerBound: 80_000 },
    );
    assert.deepEqual(
      ClaudeAdapterV2.fitLhcCompactionToContextWindow({
        autoCompactWindow: 380_000,
        lhcLowerBound: 150_000,
        contextWindow: undefined,
      }),
      { autoCompactWindow: 380_000, lhcLowerBound: 150_000 },
    );
  });

  it.each(["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-5-5"])(
    "an LHC instance's query settings carry both windows, fitted to %s's context window",
    (model) => {
      const expected = ClaudeAdapterV2.fitLhcCompactionToContextWindow({
        autoCompactWindow: 380_000,
        lhcLowerBound: 150_000,
        contextWindow: resolveClaudeCatalogContextWindowTokens(
          BUNDLED_CLAUDE_MODEL_CATALOG,
          selection(model),
        ),
      });
      assert.include(optionsFor(model).settings as object, expected);
    },
  );

  it("a stock Claude instance's query settings carry no lhcLowerBound", () => {
    const stock = { ...LHC_SETTINGS } as Record<string, unknown>;
    delete stock.lhcLowerBound;
    const settings = optionsFor("claude-sonnet-4-6", stock as never).settings as Record<
      string,
      unknown
    >;
    assert.notProperty(settings, "lhcLowerBound");
  });
});

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ClaudeLhcSettings } from "./settings.ts";

const decode = (config: Record<string, unknown>) =>
  Schema.decodeUnknownResult(ClaudeLhcSettings)(config);
const ok = (config: Record<string, unknown>) => decode(config)._tag === "Success";

describe("ClaudeLhcSettings (fix pass 1, 3.12)", () => {
  it("defaults both windows when absent", () => {
    const result = Schema.decodeUnknownSync(ClaudeLhcSettings)({});
    expect(result).toMatchObject({ autoCompactWindow: "380000", lhcLowerBound: "120000" });
  });

  it("allows the documented ~80k rebuilt view", () => {
    expect(ok({ autoCompactWindow: "240000", lhcLowerBound: "80000" })).toBe(true);
  });

  it("rejects empty values", () => {
    expect(ok({ autoCompactWindow: "", lhcLowerBound: "150000" })).toBe(false);
    expect(ok({ autoCompactWindow: "380000", lhcLowerBound: "" })).toBe(false);
  });

  it("rejects a rebuilt view at or above the trigger", () => {
    expect(ok({ autoCompactWindow: "200000", lhcLowerBound: "200000" })).toBe(false);
    expect(ok({ autoCompactWindow: "200000", lhcLowerBound: "250000" })).toBe(false);
    expect(ok({ autoCompactWindow: "200000", lhcLowerBound: "199999" })).toBe(true);
  });

  it("keeps the ranges: trigger 100k-1M, view 10k-1M", () => {
    expect(ok({ autoCompactWindow: "99999", lhcLowerBound: "50000" })).toBe(false);
    expect(ok({ autoCompactWindow: "1000001", lhcLowerBound: "50000" })).toBe(false);
    expect(ok({ autoCompactWindow: "380000", lhcLowerBound: "9999" })).toBe(false);
  });
});

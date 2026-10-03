// Claude LHC in Settings: its own entry with its own settings schema (the two LHC windows).
import { ClaudeLhcSettings, ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getDriverOption } from "./providerDriverMeta.ts";

describe("Claude LHC driver option", () => {
  it("is offered in Settings with ClaudeLhcSettings", () => {
    const option = getDriverOption(ProviderDriverKind.make("claude-lhc"));
    expect(option?.label).toBe("Claude LHC");
    expect(option?.settingsSchema).toBe(ClaudeLhcSettings);
  });
});

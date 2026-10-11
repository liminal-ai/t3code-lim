import { describe, expect, it } from "vite-plus/test";

import {
  artifactsEnvironmentOptions,
  displayStorePath,
  environmentChanged,
  stillOn,
  pickArtifactsEnvironment,
} from "./artifactsRoute.logic";

const limBuilder = {
  id: "lim-builder",
  label: "lim-builder",
  httpBaseUrl: "https://lim-builder.example:8463",
  authorization: { _tag: "Bearer" as const, token: "remote-bearer" },
};
const relayed = {
  id: "relay",
  label: "Relayed",
  httpBaseUrl: "https://relay.example",
  authorization: { _tag: "Dpop" as const, accessToken: "t", expiresAtEpochMs: 0 },
};

describe("which store the page shows", () => {
  const options = artifactsEnvironmentOptions({
    primary: { id: "local", label: "This Mac" },
    remotes: [limBuilder, relayed, { ...limBuilder, id: "local" }],
    pageOrigin: "t3code://app",
  });

  it("offers the primary and each remote a plain fetch can reach", () => {
    expect(options.map((option) => [option.id, option.route.kind])).toEqual([
      ["local", "primary"],
      ["lim-builder", "environment"],
    ]);
    expect(options[1]?.route).toEqual({
      kind: "environment",
      id: "lim-builder",
      baseUrl: "https://lim-builder.example:8463",
      bearer: "remote-bearer",
    });
  });

  it("follows the page's pick, then the active environment, then the primary", () => {
    expect(
      pickArtifactsEnvironment(options, { chosenId: "local", activeId: "lim-builder" })?.id,
    ).toBe("local");
    expect(pickArtifactsEnvironment(options, { chosenId: null, activeId: "lim-builder" })?.id).toBe(
      "lim-builder",
    );
    // A pick that's no longer connected falls back.
    expect(pickArtifactsEnvironment(options, { chosenId: "gone", activeId: "relay" })?.id).toBe(
      "local",
    );
    expect(pickArtifactsEnvironment([], { chosenId: null, activeId: null })).toBeNull();
  });

  it("shortens a home directory in the store path", () => {
    expect(displayStorePath("/home/leemoore/lim/service/t3code/prod/data/artifacts")).toBe(
      "~/lim/service/t3code/prod/data/artifacts",
    );
    expect(displayStorePath("/Users/lee/.t3/artifacts")).toBe("~/.t3/artifacts");
    expect(displayStorePath("/srv/t3/artifacts")).toBe("/srv/t3/artifacts");
  });
});

describe("environmentChanged", () => {
  it("clears an open artifact when the page falls back to, or back from, another store", () => {
    expect(environmentChanged("lim-builder", "local")).toBe(true);
    expect(environmentChanged("local", "lim-builder")).toBe(true);
  });

  it("keeps it while the first environment resolves, while none is connected, and when nothing changed", () => {
    expect(environmentChanged(null, "lim-builder")).toBe(false);
    expect(environmentChanged("lim-builder", null)).toBe(false);
    expect(environmentChanged("lim-builder", "lim-builder")).toBe(false);
  });
});

describe("a disconnected primary", () => {
  const primary = { id: "local", label: "This Mac" };

  it("gives way to a reachable remote, even when it was picked", () => {
    const options = artifactsEnvironmentOptions({
      primary,
      primaryConnected: false,
      remotes: [limBuilder],
      pageOrigin: null,
    });
    expect(options.map((option) => option.id)).toEqual(["lim-builder"]);
    expect(pickArtifactsEnvironment(options, { chosenId: "local", activeId: "local" })?.id).toBe(
      "lim-builder",
    );
  });

  it("stays when nothing else is reachable", () => {
    const options = artifactsEnvironmentOptions({
      primary,
      primaryConnected: false,
      remotes: [],
      pageOrigin: null,
    });
    expect(options.map((option) => option.id)).toEqual(["local"]);
  });
});

describe("stillOn", () => {
  it("keeps the New list dialog and its create only on the environment it was opened on", () => {
    expect(stillOn("lim-builder", "lim-builder")).toBe(true);
    expect(stillOn("lim-builder", "local")).toBe(false);
    expect(stillOn("lim-builder", null)).toBe(false);
    expect(stillOn(null, "lim-builder")).toBe(false);
  });
});

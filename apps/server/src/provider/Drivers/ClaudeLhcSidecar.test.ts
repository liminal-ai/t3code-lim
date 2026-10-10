// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeCatalogContextWindowTokens,
} from "../ClaudeModelCatalog.ts";

import {
  claudeLhcHomeDir,
  claudeLhcSidecarUnavailableReason,
  FORK_LHC_HOME,
  fitLhcCompactionToContextWindow,
  lhcFitContextWindow,
  REFUSED_LHC_HOMES,
  makeClaudeLhcCreateQuery,
  resolveClaudeLhcSidecarPath,
  type SidecarPin,
  UNCATALOGUED_CONTEXT_WINDOW,
  uncataloguedContextWindow,
  withContextWindowEnv,
} from "./ClaudeLhcSidecar.ts";

const PIN: SidecarPin = { package: "claude-lhc", version: "9.9.9", integrity: "sha512-test" };
const BASE_DIR = NodePath.join(NodeOS.tmpdir(), "t3-home-under-test");

// A fake sidecar: echoes each user prompt back as an assistant message, asks for
// tool approval unless permissions are bypassed, answers controls, and reports control
// activity through result messages. Node so the test does not need bun.
const FAKE_SIDECAR = `
const readline = require("node:readline");
const write = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
let model = "unset";
let permissionMode = "default";
let reqId = 0;
const pending = new Map();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.type === "start") {
    permissionMode = frame.options.permissionMode ?? "default";
    write({ type: "msg", message: { type: "system", subtype: "init", session_id: frame.options.sessionId, model: frame.options.model, has_callbacks: typeof frame.options.canUseTool, env_marker: frame.options.env && frame.options.env.SIDECAR_TEST_MARKER, settings: frame.options.settings, lhc_home: process.env.T3CODE_LHC_HOME } });
  } else if (frame.type === "user") {
    const text = frame.message.message.content[0].text;
    if (permissionMode === "bypassPermissions") {
      write({ type: "msg", message: { type: "assistant", session_id: "s", approval: { behavior: "allow" }, echo: text, model } });
      return;
    }
    const id = ++reqId;
    pending.set(id, text);
    write({ type: "req", id, method: "canUseTool", params: { toolName: "Read", input: { file_path: text }, toolUseID: "toolu_" + id } });
  } else if (frame.type === "res") {
    const text = pending.get(frame.id);
    write({ type: "msg", message: { type: "assistant", session_id: "s", approval: frame.ok ? frame.value : { error: frame.error }, echo: text, model } });
  } else if (frame.type === "req") {
    if (frame.method === "setModel") model = frame.params.model;
    if (frame.method === "setPermissionMode") permissionMode = frame.params.mode;
    write({ type: "res", id: frame.id, ok: true, value: null });
    if (frame.method === "interrupt") write({ type: "msg", message: { type: "system", subtype: "control", method: frame.method } });
  }
}).on("close", () => process.exit(0));
`;

/** The fake staged the way lhc/stage-sidecar.sh stages the real one: <prefix>/node_modules/<package>/dist/sidecar.js. */
function makeFakeSidecar(staged: { version?: string; integrity?: string } = {}): string {
  const prefix = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-lhc-fake-"));
  const packageDir = NodePath.join(prefix, "node_modules", PIN.package);
  NodeFS.mkdirSync(NodePath.join(packageDir, "dist"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(packageDir, "package.json"),
    JSON.stringify({ name: PIN.package, version: staged.version ?? PIN.version }),
  );
  NodeFS.writeFileSync(
    NodePath.join(prefix, "node_modules", ".package-lock.json"),
    JSON.stringify({
      packages: {
        [`node_modules/${PIN.package}`]: { integrity: staged.integrity ?? PIN.integrity },
      },
    }),
  );
  const script = NodePath.join(packageDir, "dist", "sidecar.js");
  NodeFS.writeFileSync(script, FAKE_SIDECAR);
  return script;
}

describe("ClaudeLhcSidecar", () => {
  it("resolves CLAUDE_LHC_SIDECAR as the JS entry and throws the unavailable reason", () => {
    const entry = makeFakeSidecar();
    expect(resolveClaudeLhcSidecarPath({ CLAUDE_LHC_SIDECAR: ` ${entry} ` }, BASE_DIR, PIN)).toBe(
      entry,
    );
    expect(() => resolveClaudeLhcSidecarPath({}, BASE_DIR, PIN)).toThrow(/CLAUDE_LHC_SIDECAR/);
    expect(() =>
      resolveClaudeLhcSidecarPath({ CLAUDE_LHC_SIDECAR: "/nonexistent/sidecar.js" }, BASE_DIR, PIN),
    ).toThrow(/does not exist/);
  });

  it("reports why the sidecar cannot run: unset, or naming a missing file", () => {
    expect(claudeLhcSidecarUnavailableReason({}, BASE_DIR, PIN)).toMatch(/must be set/);
    expect(claudeLhcSidecarUnavailableReason({ CLAUDE_LHC_SIDECAR: " " }, BASE_DIR, PIN)).toMatch(
      /must be set/,
    );
    expect(
      claudeLhcSidecarUnavailableReason(
        { CLAUDE_LHC_SIDECAR: "/nonexistent/sidecar.js" },
        BASE_DIR,
        PIN,
      ),
    ).toMatch(/does not exist/);
    expect(
      claudeLhcSidecarUnavailableReason({ CLAUDE_LHC_SIDECAR: makeFakeSidecar() }, BASE_DIR, PIN),
    ).toBe(undefined);
  });

  it("3.14: refuses a staged sidecar that doesn't match the pin (version or integrity)", () => {
    expect(
      claudeLhcSidecarUnavailableReason(
        { CLAUDE_LHC_SIDECAR: makeFakeSidecar({ version: "0.0.1" }) },
        BASE_DIR,
        PIN,
      ),
    ).toMatch(/staged sidecar is claude-lhc@0.0.1; this build is pinned to claude-lhc@9.9.9/);
    expect(
      claudeLhcSidecarUnavailableReason(
        { CLAUDE_LHC_SIDECAR: makeFakeSidecar({ integrity: "sha512-other" }) },
        BASE_DIR,
        PIN,
      ),
    ).toMatch(/integrity sha512-other, not the pinned one/);
  });

  it("3.11: the LHC store is <T3 home>-lhc, and the old fork's store is refused", () => {
    expect(claudeLhcHomeDir("/home/x/.t3code-v044/")).toBe("/home/x/.t3code-v044-lhc");
    const forkBase = FORK_LHC_HOME.replace(/-lhc$/, "");
    expect(
      claudeLhcSidecarUnavailableReason({ CLAUDE_LHC_SIDECAR: makeFakeSidecar() }, forkBase, PIN),
    ).toMatch(/old fork's live store/);
  });

  it("V2: the 3780 instance's store (~/.t3code-v044-lhc) is refused as well as the old fork's", () => {
    const v044Store = NodePath.join(NodeOS.homedir(), ".t3code-v044-lhc");
    expect(REFUSED_LHC_HOMES).toContain(v044Store);
    expect(
      claudeLhcSidecarUnavailableReason(
        { CLAUDE_LHC_SIDECAR: makeFakeSidecar() },
        v044Store.replace(/-lhc$/, ""),
        PIN,
      ),
    ).toMatch(/live store/);
  });

  it("fitLhcCompactionToContextWindow keeps windows that fit and lowers ones that don't", () => {
    expect(
      fitLhcCompactionToContextWindow({
        autoCompactWindow: 380_000,
        lhcLowerBound: 150_000,
        contextWindow: 1_000_000,
      }),
    ).toEqual({ autoCompactWindow: 380_000, lhcLowerBound: 150_000 });
    expect(
      fitLhcCompactionToContextWindow({
        autoCompactWindow: 380_000,
        lhcLowerBound: 150_000,
        contextWindow: 200_000,
      }),
    ).toEqual({ autoCompactWindow: 160_000, lhcLowerBound: 80_000 });
    expect(
      fitLhcCompactionToContextWindow({
        autoCompactWindow: 380_000,
        lhcLowerBound: 150_000,
        contextWindow: undefined,
      }),
    ).toEqual({ autoCompactWindow: 380_000, lhcLowerBound: 150_000 });
  });

  it("an uncatalogued model without a contextWindow fits as 200k, never uncapped", () => {
    expect(lhcFitContextWindow("glm-5.3", undefined)).toBe(UNCATALOGUED_CONTEXT_WINDOW);
    expect(lhcFitContextWindow("glm-5.3", ["glm-5.3"])).toBe(UNCATALOGUED_CONTEXT_WINDOW);
    expect(
      fitLhcCompactionToContextWindow({
        autoCompactWindow: 700_000,
        lhcLowerBound: 120_000,
        contextWindow: lhcFitContextWindow("glm-5.3", [{ slug: "glm-5.3" }]),
      }),
    ).toEqual({ autoCompactWindow: 160_000, lhcLowerBound: 80_000 });
    // Claude Code's own default model stays unfitted, as before.
    expect(lhcFitContextWindow("", undefined)).toBeUndefined();
  });

  it("an uncatalogued model fits to the instance's smallest declared contextWindow", () => {
    const models = [
      { slug: "glm-5.3", contextWindow: 1_000_000 },
      { slug: "glm-5.3-flash-local", contextWindow: 500_000 },
      "claude-opus-5-5",
    ];
    expect(uncataloguedContextWindow(models)).toEqual({ window: 500_000, explicit: true });
    expect(lhcFitContextWindow("glm-5.3", models)).toBe(500_000);
    expect(
      fitLhcCompactionToContextWindow({
        autoCompactWindow: 700_000,
        lhcLowerBound: 120_000,
        contextWindow: lhcFitContextWindow("glm-5.3", models),
      }),
    ).toEqual({ autoCompactWindow: 400_000, lhcLowerBound: 120_000 });
    // A bare uncatalogued entry counts as 200k, so it caps the instance too.
    expect(lhcFitContextWindow("glm-5.3", [...models, "other-model"])).toBe(200_000);
    // Catalogued models keep their catalog window; the custom windows don't touch them.
    expect(lhcFitContextWindow("claude-opus-5-5", models)).toBe(
      resolveClaudeCatalogContextWindowTokens(BUNDLED_CLAUDE_MODEL_CATALOG, {
        instanceId: ProviderInstanceId.make("claude-lhc"),
        model: "claude-opus-5-5",
      }),
    );
  });

  it("passes the uncatalogued window to Claude Code as CLAUDE_CODE_MAX_CONTEXT_TOKENS", () => {
    const models = [{ slug: "glm-5.3", contextWindow: 1_000_000 }, "glm-5.3-flash-local"];
    expect(withContextWindowEnv({ A: "1" }, models)).toEqual({
      A: "1",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000",
    });
    expect(
      withContextWindowEnv({}, [{ slug: "glm-5.3", contextWindow: 1_000_000 }])
        .CLAUDE_CODE_MAX_CONTEXT_TOKENS,
    ).toBe("1000000");
    // No declared window: Claude Code already assumes 200k, so leave the env alone.
    expect(withContextWindowEnv({ A: "1" }, ["glm-5.3"])).toEqual({ A: "1" });
    // An explicit setting in the environment wins.
    expect(
      withContextWindowEnv({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: "300000" }, [
        { slug: "glm-5.3", contextWindow: 1_000_000 },
      ]).CLAUDE_CODE_MAX_CONTEXT_TOKENS,
    ).toBe("300000");
  });

  it("V2: an uncatalogued custom model's query settings are fitted to its contextWindow", async () => {
    const createQuery = makeClaudeLhcCreateQuery({
      environment: { ...process.env, CLAUDE_LHC_SIDECAR: makeFakeSidecar() },
      baseDir: BASE_DIR,
      pin: PIN,
      windows: { autoCompactWindow: "700000", lhcLowerBound: "120000" },
      customModels: [{ slug: "glm-5.3", contextWindow: 500_000 }],
    });
    const prompts = (async function* () {
      await new Promise<void>(() => {});
    })();
    const runtime = createQuery({
      prompt: prompts as never,
      options: { sessionId: "sess-glm", model: "glm-5.3", settings: {} as never },
    });
    const init = (await runtime[Symbol.asyncIterator]().next()).value as unknown as {
      settings: Record<string, unknown>;
    };
    expect(init.settings).toEqual({ autoCompactWindow: 400_000, lhcLowerBound: 120_000 });
    runtime.close();
  });

  it.each(["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-5-5"])(
    "V2: the query's settings carry the instance's two windows, fitted to %s's window, merged with the rest",
    async (model) => {
      const createQuery = makeClaudeLhcCreateQuery({
        environment: { ...process.env, CLAUDE_LHC_SIDECAR: makeFakeSidecar() },
        baseDir: BASE_DIR,
        pin: PIN,
        windows: { autoCompactWindow: "380000", lhcLowerBound: "150000" },
      });
      const prompts = (async function* () {
        await new Promise<void>(() => {});
      })();
      const runtime = createQuery({
        prompt: prompts as never,
        options: {
          sessionId: "sess-w",
          model,
          settings: { autoCompactWindow: 380_000, showThinkingSummaries: true } as never,
        },
      });
      const init = (await runtime[Symbol.asyncIterator]().next()).value as unknown as {
        settings: Record<string, unknown>;
      };
      const expected = fitLhcCompactionToContextWindow({
        autoCompactWindow: 380_000,
        lhcLowerBound: 150_000,
        contextWindow: resolveClaudeCatalogContextWindowTokens(BUNDLED_CLAUDE_MODEL_CATALOG, {
          instanceId: ProviderInstanceId.make("claude-lhc"),
          model,
        }),
      });
      expect(init.settings).toEqual({ showThinkingSummaries: true, ...expected });
      runtime.close();
    },
  );

  it("V2: interrupt() reaches the sidecar as an interrupt control", async () => {
    const createQuery = makeClaudeLhcCreateQuery({
      environment: { ...process.env, CLAUDE_LHC_SIDECAR: makeFakeSidecar() },
      baseDir: BASE_DIR,
      pin: PIN,
    });
    const prompts = (async function* () {
      await new Promise<void>(() => {});
    })();
    const runtime = createQuery({
      prompt: prompts as never,
      options: { sessionId: "sess-2", model: "claude-sonnet-5" },
    });
    const iterator = runtime[Symbol.asyncIterator]();
    expect(((await iterator.next()).value as Record<string, unknown>).subtype).toBe("init");
    await runtime.interrupt();
    expect((await iterator.next()).value).toMatchObject({
      type: "system",
      subtype: "control",
      method: "interrupt",
    });
    runtime.close();
  });

  it("bridges prompts, messages, approvals and controls over stdio and ends the stream on close", async () => {
    const launcher = makeFakeSidecar();
    const createQuery = makeClaudeLhcCreateQuery({
      // An inherited T3CODE_LHC_HOME is ignored: the store comes from the T3 home.
      environment: { ...process.env, CLAUDE_LHC_SIDECAR: launcher, T3CODE_LHC_HOME: FORK_LHC_HOME },
      baseDir: BASE_DIR,
      pin: PIN,
    });
    let releasePrompt: (() => void) | undefined;
    const prompts = (async function* () {
      yield {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "one" }] },
        parent_tool_use_id: null,
        session_id: "",
      } as never;
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
    })();
    const approvals: Array<{ toolName: string; toolUseID: string | undefined }> = [];
    const runtime = createQuery({
      prompt: prompts,
      options: {
        sessionId: "sess-1",
        model: "claude-sonnet-5",
        env: { ...process.env, SIDECAR_TEST_MARKER: "present" },
        canUseTool: async (toolName, input, options) => {
          approvals.push({ toolName, toolUseID: options.toolUseID });
          return { behavior: "allow", updatedInput: input };
        },
      },
    });

    const iterator = runtime[Symbol.asyncIterator]();
    const init = (await iterator.next()).value as Record<string, unknown>;
    expect(init).toMatchObject({
      type: "system",
      subtype: "init",
      session_id: "sess-1",
      model: "claude-sonnet-5",
      env_marker: "present",
      lhc_home: claudeLhcHomeDir(BASE_DIR),
    });
    expect(init.has_callbacks).toBe("undefined");

    const echoed = (await iterator.next()).value as Record<string, unknown>;
    expect(echoed).toMatchObject({
      type: "assistant",
      echo: "one",
      approval: { behavior: "allow", updatedInput: { file_path: "one" } },
    });
    expect(approvals).toEqual([{ toolName: "Read", toolUseID: "toolu_1" }]);

    await runtime.setModel("claude-opus-5");
    runtime.close();
    releasePrompt?.();
    const done = await iterator.next();
    expect(done.done).toBe(true);
  });

  it("applies a permission mode change to the next prompt in the same sidecar session", async () => {
    const createQuery = makeClaudeLhcCreateQuery({
      environment: { ...process.env, CLAUDE_LHC_SIDECAR: makeFakeSidecar() },
      baseDir: BASE_DIR,
      pin: PIN,
    });
    const nextPrompt = Promise.withResolvers<void>();
    const promptsDone = Promise.withResolvers<void>();
    const approvals: string[] = [];
    const prompts = (async function* () {
      for (const text of ["before", "after"]) {
        if (text === "after") await nextPrompt.promise;
        yield {
          type: "user" as const,
          message: { role: "user" as const, content: [{ type: "text" as const, text }] },
          parent_tool_use_id: null,
          session_id: "",
        };
      }
      await promptsDone.promise;
    })();
    const runtime = createQuery({
      prompt: prompts,
      options: {
        sessionId: "permission-session",
        model: "claude-sonnet-5",
        permissionMode: "default",
        canUseTool: async (_toolName, input) => {
          approvals.push(String(input.file_path));
          return { behavior: "deny", message: "Approval declined" };
        },
      },
    });
    try {
      const iterator = runtime[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ subtype: "init" });
      expect((await iterator.next()).value).toMatchObject({
        echo: "before",
        approval: { behavior: "deny", message: "Approval declined" },
      });

      await runtime.setPermissionMode("bypassPermissions");
      nextPrompt.resolve();

      expect((await iterator.next()).value).toMatchObject({
        echo: "after",
        approval: { behavior: "allow" },
      });
      expect(approvals).toEqual(["before"]);
    } finally {
      runtime.close();
      nextPrompt.resolve();
      promptsDone.resolve();
    }
  });
});

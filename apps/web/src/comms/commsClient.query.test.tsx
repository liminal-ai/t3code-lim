// @effect-diagnostics nodeBuiltinImport:off - compiles commsClient.ts on disk with the React Compiler.
// useCommsQuery as the app ships it: compiled by the React Compiler. Vitest doesn't
// run the app's Babel/React Compiler step, so this test compiles commsClient.ts
// itself (types stripped with Vite's Oxc transform, then babel-plugin-react-compiler)
// and drives the compiled hook. The failure it guards against (#12): a query that
// first renders as "skip" and then starts must re-render when its first frame
// arrives. Compiled with the snapshot closure memoized on `entry?.state`, the
// desktop shelf stayed empty until an unrelated re-render, up to ~60 s later.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

const SOURCE = fileURLToPath(new URL("./commsClient.ts", import.meta.url));
const COMPILED_URL = new URL("./commsClient.compiled.test-output.js", import.meta.url);
const COMPILED = fileURLToPath(COMPILED_URL);

async function compileWithReactCompiler(): Promise<string> {
  const { transformWithOxc } = await import("vite");
  const stripped = await transformWithOxc(NodeFS.readFileSync(SOURCE, "utf8"), SOURCE, {
    lang: "ts",
  });
  // Babel is a peer of @rolldown/plugin-babel, the plugin the app's Vite config uses.
  const pluginBabel = NodeFS.realpathSync(
    fileURLToPath(import.meta.resolve("@rolldown/plugin-babel")),
  );
  const babel = NodeModule.createRequire(pluginBabel)(
    "@babel/core",
  ) as typeof import("@babel/core");
  const compiler = NodeModule.createRequire(import.meta.url)("babel-plugin-react-compiler");
  const result = await babel.transformAsync(stripped.code, {
    babelrc: false,
    configFile: false,
    filename: SOURCE.replace(/\.ts$/, ".js"),
    plugins: [compiler.default ?? compiler],
  });
  // The `~/` alias is resolved for TypeScript sources only; point it at src/ directly.
  return (result?.code ?? "").replaceAll('from "~/', 'from "../');
}

const sameOriginWindow = {
  location: { origin: "http://127.0.0.1:3773", href: "http://127.0.0.1:3773/" },
};

/** A /watch response whose frames the test pushes by hand. */
function watchStream() {
  let push: (line: string) => void = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (line) => controller.enqueue(new TextEncoder().encode(`${line}\n`));
    },
  });
  return { response: new Response(body, { status: 200 }), push: (line: string) => push(line) };
}

describe("useCommsQuery, compiled by the React Compiler", { concurrent: false }, () => {
  beforeAll(async () => {
    NodeFS.writeFileSync(COMPILED, await compileWithReactCompiler());
  });
  afterAll(() => NodeFS.rmSync(COMPILED, { force: true }));
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("is actually compiled (memo cache in the hook)", async () => {
    const mod = await import(/* @vite-ignore */ COMPILED_URL.href);
    expect(NodeFS.readFileSync(COMPILED, "utf8")).toContain("react/compiler-runtime");
    expect(String(mod.useCommsQuery)).toMatch(/\$\[\d+\]/); // memo cache slots
  });

  it("re-renders on the first frame of a query that started as skip", async () => {
    const stream = watchStream();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/api/comms/watch")
          ? stream.response
          : new Response("{}", { status: 404 }),
      ),
    );
    Object.defineProperty(globalThis, "window", { configurable: true, value: sameOriginWindow });
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const { useCommsQuery } = (await import(
      /* @vite-ignore */ COMPILED_URL.href
    )) as typeof import("./commsClient");

    function Probe(props: { readonly enabled: boolean }) {
      const { data } = useCommsQuery<{ readonly n: number }>(
        "conversations:list",
        props.enabled ? {} : "skip",
      );
      return data ? `n=${data.n}` : "none";
    }

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Probe enabled={false} />);
    });
    expect(renderer!.toJSON()).toBe("none");

    // Enabled later, as when the comms config arrives after the component mounted.
    await act(async () => {
      renderer!.update(<Probe enabled />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30)); // the client opens /watch
    });

    // The first frame arrives; nothing else re-renders the component.
    await act(async () => {
      stream.push("{}");
      stream.push(JSON.stringify({ id: "conversations:list\u0000{}", value: { n: 3 } }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(renderer!.toJSON()).toBe("n=3");
    await act(async () => renderer!.unmount());
  });
});

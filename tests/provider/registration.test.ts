import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../../extensions/xai-oauth";
import {
  CURATED_FALLBACK_MODELS,
  KNOWN_XAI_MODEL_METADATA,
  setXaiRuntimeModels,
} from "../../extensions/xai/models";
import { XAI_NETWORK_TOOL_NAMES } from "../../extensions/xai/tools/model-scope";
import { createExtensionHarness } from "../fixtures/extension-api";
import { TEST_MODEL } from "../fixtures/models";
import { createTempDir } from "../fixtures/temp";
let temp: Awaited<ReturnType<typeof createTempDir>>;
beforeEach(async () => {
  temp = await createTempDir("pi-xai-provider-");
  vi.stubEnv("HOME", temp.path);
});
afterEach(async () => {
  setXaiRuntimeModels(CURATED_FALLBACK_MODELS);
  await temp.cleanup();
});

describe("provider registration", () => {
  it("registers the OAuth provider, tools, command, and curated fallback", async () => {
    const harness = createExtensionHarness();
    await extension(harness.api);
    const provider = harness.providers.get("xai-auth");
    expect(provider).toBeDefined();
    expect(provider).toMatchObject({
      api: "xai-responses",
      baseUrl: "https://cli-chat-proxy.grok.com/v1",
      authHeader: true,
    });
    expect(provider.models.map(({ id }: any) => id)).toEqual(["grok-4.5"]);
    expect(provider.models[0]).toMatchObject({
      contextWindow: 500_000,
      reasoning: true,
      cost: { input: 2, cacheRead: 0.5, output: 6 },
      thinkingLevelMap: { off: null },
    });
    expect(harness.tools.size).toBe(20);
    expect(harness.commands.has("xai-tools")).toBe(true);
    expect([...harness.handlers.keys()]).toEqual(
      expect.arrayContaining([
        "session_start",
        "input",
        "model_select",
        "before_agent_start",
      ]),
    );
  });
  it("registers independently on a second Pi API object", async () => {
    const first = createExtensionHarness();
    const second = createExtensionHarness();
    await extension(first.api);
    await extension(second.api);
    expect(second.tools.size).toBe(first.tools.size);
    expect(second.commands.size).toBe(first.commands.size);
    expect(second.providers.has("xai-auth")).toBe(true);
  });
  it("wires model, session, and before-agent events to fail-closed tool synchronization", async () => {
    const harness = createExtensionHarness();
    await extension(harness.api);
    const fetchMock = vi.fn(async () => {
      throw new Error("lifecycle handlers must not use the network");
    });
    vi.stubGlobal("fetch", fetchMock);

    await harness.handlers.get("model_select")?.(
      { model: { ...TEST_MODEL, id: "grok-composer-2.5-fast" } },
      { model: { ...TEST_MODEL, id: "grok-composer-2.5-fast" } },
    );
    expect(harness.getActiveTools()).toContain("Grep");
    expect(harness.getActiveTools()).not.toContain("WebSearch");

    harness.setActiveTools([
      ...harness.getActiveTools(),
      ...XAI_NETWORK_TOOL_NAMES,
    ]);
    await harness.handlers.get("session_start")?.({}, { model: TEST_MODEL });
    expect(harness.getActiveTools()).not.toContain("Grep");
    expect(
      XAI_NETWORK_TOOL_NAMES.every(
        (name) => !harness.getActiveTools().includes(name),
      ),
    ).toBe(true);

    await harness.handlers.get("model_select")?.(
      { model: { ...TEST_MODEL, id: "grok-composer-2.5-fast" } },
      { model: { ...TEST_MODEL, id: "grok-composer-2.5-fast" } },
    );
    await harness.handlers.get("before_agent_start")?.(
      {},
      { model: { ...TEST_MODEL, id: "grok-composer-2.5-fast" } },
    );
    expect(harness.getActiveTools()).toContain("Grep");
    expect(harness.getActiveTools()).not.toContain("WebSearch");

    harness.setActiveTools([
      ...harness.getActiveTools(),
      ...XAI_NETWORK_TOOL_NAMES,
    ]);
    harness.failRegistry({ get: true });
    await harness.handlers.get("session_start")?.({}, { model: TEST_MODEL });
    harness.failRegistry();
    await harness.handlers.get("before_agent_start")?.(
      {},
      { model: TEST_MODEL },
    );
    expect(
      XAI_NETWORK_TOOL_NAMES.every(
        (name) => !harness.getActiveTools().includes(name),
      ),
    ).toBe(true);

    harness.setActiveTools([
      ...harness.getActiveTools(),
      ...XAI_NETWORK_TOOL_NAMES,
    ]);
    harness.failRegistry({ set: true });
    await harness.handlers.get("session_start")?.({}, { model: TEST_MODEL });
    harness.failRegistry();
    await harness.handlers.get("before_agent_start")?.(
      {},
      { model: TEST_MODEL },
    );
    expect(
      XAI_NETWORK_TOOL_NAMES.every(
        (name) => !harness.getActiveTools().includes(name),
      ),
    ).toBe(true);

    await harness.handlers.get("model_select")?.(
      { model: { provider: "anthropic", id: "claude" } },
      { model: { provider: "anthropic", id: "claude" } },
    );
    expect(harness.getActiveTools()).not.toContain("Grep");
    expect(
      XAI_NETWORK_TOOL_NAMES.every(
        (name) => !harness.getActiveTools().includes(name),
      ),
    ).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains known compatibility metadata without advertising it offline", () => {
    expect(
      KNOWN_XAI_MODEL_METADATA.find(({ id }) => id === "grok-build")
        ?.contextWindow,
    ).toBe(512_000);
    expect(
      KNOWN_XAI_MODEL_METADATA.find(({ id }) => id === "grok-composer-2.5-fast")
        ?.reasoning,
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { registerXaiToolsCommand } from "../../extensions/xai/tools/commands";
import { registerCustomXaiTools } from "../../extensions/xai/tools/custom-tools";
import {
  isXaiNetworkToolActive,
  syncXaiNetworkToolsForModel,
  XAI_NETWORK_TOOL_NAMES,
} from "../../extensions/xai/tools/model-scope";
import {
  commandContext,
  createExtensionHarness,
} from "../fixtures/extension-api";
import { TEST_MODEL } from "../fixtures/models";
const composer = { ...TEST_MODEL, id: "grok-composer-2.5-fast" } as any;

function setup() {
  const h = createExtensionHarness();
  registerXaiToolsCommand(h.api);
  const notices: any[] = [];
  const run = (args: string, model: any = TEST_MODEL, overrides: any = {}) =>
    h.commands
      .get("xai-tools")
      .handler(args, commandContext(model, notices, overrides));
  return { h, notices, run };
}

describe("/xai-tools command", () => {
  it("registers and enables/disables one eligible tool with cost warning", async () => {
    const { h, notices, run } = setup();
    expect(h.commands.has("xai-tools")).toBe(true);
    await run("enable xai_generate_image");
    expect(isXaiNetworkToolActive(h.api, "xai_generate_image")).toBe(true);
    expect(notices.at(-1).message).toMatch(/may use xAI credits/);
    await run("disable xai_generate_image");
    expect(isXaiNetworkToolActive(h.api, "xai_generate_image")).toBe(false);
  });
  it("requires explicit user intent in the image-generation tool guidance", () => {
    const h = createExtensionHarness();
    registerCustomXaiTools(h.api);
    expect(h.tools.get("xai_generate_image").promptGuidelines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/explicitly asks to generate an image/),
      ]),
    );
  });

  it("reports every tool status and eligibility", async () => {
    const { notices, run } = setup();
    await run("status");
    for (const name of XAI_NETWORK_TOOL_NAMES)
      expect(notices.at(-1).message).toMatch(
        new RegExp(`${name}=(?:enabled|disabled|unavailable)`),
      );
  });
  it("rejects paid tools for non-xAI models and WebSearch for standard Grok", async () => {
    const { h, notices, run } = setup();
    await run("enable xai_x_search", { provider: "anthropic", id: "claude" });
    expect(isXaiNetworkToolActive(h.api, "xai_x_search")).toBe(false);
    expect(notices.at(-1).message).toMatch(/Select an xAI\/Grok model/);
    await run("enable WebSearch");
    expect(isXaiNetworkToolActive(h.api, "WebSearch")).toBe(false);
    expect(notices.at(-1).message).toMatch(
      /only with xAI Grok Build or Composer/,
    );
    await run("enable WebSearch", composer);
    expect(isXaiNetworkToolActive(h.api, "WebSearch")).toBe(true);
  });
  it("fails closed when registry reads or writes fail", async () => {
    const { h, notices, run } = setup();
    h.failRegistry({ get: true });
    await run("enable xai_web_search");
    h.failRegistry();
    expect(isXaiNetworkToolActive(h.api, "xai_web_search")).toBe(false);
    expect(notices.at(-1).message).toMatch(/could not be read/);
    h.failRegistry({ set: true });
    await run("enable xai_web_search");
    h.failRegistry();
    expect(isXaiNetworkToolActive(h.api, "xai_web_search")).toBe(false);
    expect(notices.at(-1).message).toMatch(/could not be updated/);
  });
  it("uses the RPC picker to toggle a selection", async () => {
    const { h, notices } = setup();
    let pass = 0;
    let title = "";
    let options: string[] = [];
    const ctx = commandContext(TEST_MODEL, notices, {
      mode: "rpc",
      ui: {
        notify(message: string, type?: string) {
          notices.push({ message, type });
        },
        select: async (value: string, choices: string[]) => {
          title = value;
          options = choices;
          return ++pass === 1
            ? choices.find((choice) => choice.includes("xai_web_search"))
            : "Done";
        },
      },
    });
    await h.commands.get("xai-tools").handler("", ctx);
    expect(isXaiNetworkToolActive(h.api, "xai_web_search")).toBe(true);
    expect(title).toMatch(/explicit opt-in/);
    expect(
      options.some(
        (value) =>
          value.includes("xai_generate_image") && value.includes("per image"),
      ),
    ).toBe(true);
  });
  it("preserves another authorization when disabling through a non-xAI command context", async () => {
    const { h, run } = setup();
    await run("enable xai_web_search");
    await run("enable xai_generate_image");
    await run("disable xai_web_search", {
      provider: "anthropic",
      id: "claude",
    });

    expect(isXaiNetworkToolActive(h.api, "xai_web_search")).toBe(false);
    expect(isXaiNetworkToolActive(h.api, "xai_generate_image")).toBe(true);
    syncXaiNetworkToolsForModel(h.api, TEST_MODEL);
    expect(isXaiNetworkToolActive(h.api, "xai_generate_image")).toBe(true);
  });

  it("recovers from a failed reset by stripping every stale tool except the selected one", async () => {
    const { h, run } = setup();
    h.setActiveTools([...h.getActiveTools(), ...XAI_NETWORK_TOOL_NAMES]);
    h.failRegistry({ set: true });
    syncXaiNetworkToolsForModel(h.api, TEST_MODEL, { reset: true });
    h.failRegistry();
    expect(
      XAI_NETWORK_TOOL_NAMES.every((name) => h.getActiveTools().includes(name)),
    ).toBe(true);

    await run("enable xai_web_search");
    expect(
      XAI_NETWORK_TOOL_NAMES.filter((name) =>
        h.getActiveTools().includes(name),
      ),
    ).toEqual(["xai_web_search"]);
    syncXaiNetworkToolsForModel(h.api, TEST_MODEL);
    expect(
      XAI_NETWORK_TOOL_NAMES.filter((name) =>
        h.getActiveTools().includes(name),
      ),
    ).toEqual(["xai_web_search"]);
  });

  it("keeps TUI selection in place, wraps pages, toggles, and closes", async () => {
    const { h, notices } = setup();
    let closed = false;
    const selected: string[] = [];
    const ctx = commandContext(TEST_MODEL, notices, {
      ui: {
        notify(message: string, type?: string) {
          notices.push({ message, type });
        },
        custom: async (factory: any) => {
          const bindings: any = {
            "tui.select.up": "up",
            "tui.select.down": "down",
            "tui.select.pageUp": "pageup",
            "tui.select.pageDown": "pagedown",
            "tui.select.confirm": "enter",
            "tui.select.cancel": "escape",
          };
          const component = await factory(
            { requestRender() {} },
            {
              fg: (_: any, text: string) => text,
              bg: (_: any, text: string) => text,
              bold: (text: string) => text,
            },
            { matches: (data: string, id: string) => bindings[id] === data },
            () => {
              closed = true;
            },
          );
          component.handleInput("pageup");
          selected.push(
            component.render(160).find((line: string) => line.startsWith("> ")),
          );
          component.handleInput("pagedown");
          for (let i = 0; i < 7; i++) component.handleInput("down");
          selected.push(
            component.render(160).find((line: string) => line.startsWith("> ")),
          );
          component.handleInput("enter");
          selected.push(
            component.render(160).find((line: string) => line.startsWith("> ")),
          );
          component.handleInput("escape");
        },
      },
    });
    await h.commands.get("xai-tools").handler("", ctx);
    expect(selected[0]).toMatch(/xai_critique/);
    expect(selected[1]).toMatch(/\[ \] xai_generate_image/);
    expect(selected[2]).toMatch(/\[x\] xai_generate_image/);
    expect(closed).toBe(true);
    expect(isXaiNetworkToolActive(h.api, "xai_generate_image")).toBe(true);
  });

  it("wraps Page Up and Page Down when Composer exposes more rows than the page size", async () => {
    const { h, notices } = setup();
    let afterPageUp = "";
    let afterPageDown = "";
    const ctx = commandContext(composer, notices, {
      ui: {
        notify(message: string, type?: string) {
          notices.push({ message, type });
        },
        custom: async (factory: any) => {
          const bindings: any = {
            "tui.select.up": "up",
            "tui.select.down": "down",
            "tui.select.pageUp": "pageup",
            "tui.select.pageDown": "pagedown",
            "tui.select.confirm": "enter",
            "tui.select.cancel": "escape",
          };
          const component = await factory(
            { requestRender() {} },
            {
              fg: (_: any, text: string) => text,
              bg: (_: any, text: string) => text,
              bold: (text: string) => text,
            },
            { matches: (data: string, id: string) => bindings[id] === data },
            () => {},
          );
          component.handleInput("pageup");
          afterPageUp = component
            .render(160)
            .find((line: string) => line.startsWith("> "));
          component.handleInput("pagedown");
          afterPageDown = component
            .render(160)
            .find((line: string) => line.startsWith("> "));
          component.handleInput("escape");
        },
      },
    });

    await h.commands.get("xai-tools").handler("", ctx);
    expect(afterPageUp).toMatch(/xai_web_search/);
    expect(afterPageDown).toMatch(/xai_generate_text/);
  });
});

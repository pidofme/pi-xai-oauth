import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { isGrokCliCompatibilityModel } from "../models";
import {
  activeXaiModel,
  isXaiNetworkToolActive,
  setXaiNetworkToolActive,
  XAI_NETWORK_TOOL_NAMES,
  type XaiNetworkToolName,
} from "./model-scope";

interface NetworkToolOption {
  name: XaiNetworkToolName;
  category: string;
  costRisk: string;
  summary: string;
}

const NETWORK_TOOL_OPTIONS: readonly NetworkToolOption[] = [
  { name: "xai_generate_text", category: "generation", costRisk: "token usage", summary: "separate Grok response" },
  { name: "xai_web_search", category: "search", costRisk: "token + tool", summary: "native xAI web search" },
  { name: "xai_x_search", category: "search", costRisk: "token + tool", summary: "native xAI X search" },
  { name: "xai_x_search_raw", category: "search", costRisk: "token + tool", summary: "structured raw X post/media transcriptions" },
  { name: "xai_multi_agent", category: "research", costRisk: "high/variable", summary: "4- or 16-agent web/X research" },
  { name: "xai_deep_research", category: "research", costRisk: "high/variable", summary: "multi-step web/X research" },
  { name: "xai_code_execution", category: "execution", costRisk: "token + tool", summary: "xAI code interpreter" },
  { name: "xai_generate_image", category: "image", costRisk: "per image", summary: "generate 1-4 images" },
  { name: "xai_analyze_image", category: "vision", costRisk: "token usage", summary: "analyze an image with Grok" },
  { name: "xai_critique", category: "reasoning", costRisk: "token usage", summary: "separate high-reasoning critique" },
  { name: "WebSearch", category: "search", costRisk: "token + tool", summary: "Grok Build/Composer native web search" },
];

const XAI_TOOLS_USAGE =
  "Usage: /xai-tools [status | enable <tool> | disable <tool>]";

function commandToolName(value: string | undefined): XaiNetworkToolName | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  return XAI_NETWORK_TOOL_NAMES.find((name) => name.toLowerCase() === normalized);
}

function eligibleToolOptions(model: Model<Api>): readonly NetworkToolOption[] {
  return NETWORK_TOOL_OPTIONS.filter(
    ({ name }) => name !== "WebSearch" || isGrokCliCompatibilityModel(model.id),
  );
}

function activeToolStatus(pi: ExtensionAPI, model: Model<Api> | undefined): string {
  return NETWORK_TOOL_OPTIONS.map(({ name }) => {
    const unavailable = name === "WebSearch" && (!model || !isGrokCliCompatibilityModel(model.id));
    if (unavailable) return `${name}=unavailable`;
    return `${name}=${isXaiNetworkToolActive(pi, name) ? "enabled" : "disabled"}`;
  }).join(", ");
}

function notifyUpdate(
  ctx: ExtensionCommandContext,
  toolName: XaiNetworkToolName,
  active: boolean,
  error?: string,
) {
  if (error) {
    ctx.ui.notify(error, "error");
    return;
  }
  ctx.ui.notify(
    active
      ? `Enabled ${toolName} for this xAI session. Calls may use xAI credits.`
      : `Disabled ${toolName}.`,
    active ? "warning" : "info",
  );
}

async function showXaiToolSelectLoop(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  model: Model<Api>,
) {
  while (true) {
    const labels = new Map<string, XaiNetworkToolName>();
    for (const option of eligibleToolOptions(model)) {
      const active = isXaiNetworkToolActive(pi, option.name);
      labels.set(
        `${active ? "[x]" : "[ ]"} ${option.name} — ${option.category}; ${option.costRisk}; ${option.summary}`,
        option.name,
      );
    }
    const done = "Done";
    const selected = await ctx.ui.select(
      "xAI API tools — explicit opt-in; enabled calls may use xAI credits",
      [...labels.keys(), done],
    );
    if (!selected || selected === done) return;

    const toolName = labels.get(selected);
    if (!toolName) continue;
    const nextActive = !isXaiNetworkToolActive(pi, toolName);
    const result = setXaiNetworkToolActive(pi, model, toolName, nextActive);
    notifyUpdate(ctx, toolName, result.active, result.error);
    if (!result.ok) return;
  }
}

async function showXaiToolTuiPicker(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  model: Model<Api>,
) {
  const options = eligibleToolOptions(model);
  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    let selectedIndex = 0;
    const maxVisible = 10;

    const refresh = () => tui.requestRender();
    const moveSelection = (offset: number) => {
      if (options.length === 0) return;
      // When offset is a multiple of the list length (e.g. page size === 10
      // tools), bare `%` is a no-op. Keep paging moving by one step in the
      // requested direction so Page Up/Down still wrap.
      let step = offset % options.length;
      if (step === 0 && offset !== 0) {
        step = Math.sign(offset);
      }
      selectedIndex = ((selectedIndex + step) % options.length + options.length) % options.length;
      refresh();
    };
    const toggleSelected = () => {
      const option = options[selectedIndex];
      if (!option) return;
      const nextActive = !isXaiNetworkToolActive(pi, option.name);
      const result = setXaiNetworkToolActive(pi, model, option.name, nextActive);
      notifyUpdate(ctx, option.name, result.active, result.error);
      refresh();
    };

    return {
      render(width: number) {
        const lines = [
          theme.fg("accent", theme.bold("xAI API tools — explicit opt-in; calls may use xAI credits")),
          "",
        ];
        const startIndex = Math.max(
          0,
          Math.min(selectedIndex - Math.floor(maxVisible / 2), options.length - maxVisible),
        );
        const endIndex = Math.min(startIndex + maxVisible, options.length);
        const maxRowWidth = Math.max(1, width - 2);

        for (let index = startIndex; index < endIndex; index += 1) {
          const option = options[index];
          if (!option) continue;
          const active = isXaiNetworkToolActive(pi, option.name);
          const marker = index === selectedIndex ? "> " : "  ";
          const text = `${marker}${active ? "[x]" : "[ ]"} ${option.name} — ${option.category}; ${option.costRisk}; ${option.summary}`
            .slice(0, maxRowWidth);
          lines.push(
            index === selectedIndex
              ? theme.bg("selectedBg", theme.fg("accent", text))
              : theme.fg(active ? "success" : "text", text),
          );
        }

        if (startIndex > 0 || endIndex < options.length) {
          lines.push(theme.fg("dim", `  (${selectedIndex + 1}/${options.length})`));
        }
        lines.push("", theme.fg("muted", "  ↑/↓ move · Enter/Space toggle · Esc done"));
        return lines;
      },
      invalidate() {},
      handleInput(data: string) {
        if (keybindings.matches(data, "tui.select.up")) {
          moveSelection(-1);
        } else if (keybindings.matches(data, "tui.select.down")) {
          moveSelection(1);
        } else if (keybindings.matches(data, "tui.select.pageUp")) {
          moveSelection(-maxVisible);
        } else if (keybindings.matches(data, "tui.select.pageDown")) {
          moveSelection(maxVisible);
        } else if (keybindings.matches(data, "tui.select.confirm") || data === " ") {
          toggleSelected();
        } else if (keybindings.matches(data, "tui.select.cancel")) {
          done();
        }
      },
    };
  });
}

async function showXaiToolPicker(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  model: Model<Api>,
) {
  if (!ctx.hasUI) {
    ctx.ui.notify(`${XAI_TOOLS_USAGE} Interactive selection requires TUI or RPC mode.`, "error");
    return;
  }
  if (ctx.mode === "tui") {
    await showXaiToolTuiPicker(pi, ctx, model);
    return;
  }
  await showXaiToolSelectLoop(pi, ctx, model);
}

/** Register the package-owned command for explicitly managing network-backed xAI tools. */
export function registerXaiToolsCommand(pi: ExtensionAPI) {
  pi.registerCommand("xai-tools", {
    description: "Enable or disable network-backed xAI tools for this session",
    handler: async (args, ctx) => {
      const [action, rawToolName, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      const model = activeXaiModel(ctx);

      if (!action) {
        if (!model) {
          ctx.ui.notify("Select an xAI/Grok model before opening /xai-tools.", "error");
          return;
        }
        await showXaiToolPicker(pi, ctx, model);
        return;
      }

      if (action.toLowerCase() === "status" && !rawToolName) {
        ctx.ui.notify(
          `xAI API tools${model ? ` for ${model.id}` : " (no active xAI model)"}: ${activeToolStatus(pi, model)}`,
          "info",
        );
        return;
      }

      const normalizedAction = action.toLowerCase();
      const toolName = commandToolName(rawToolName);
      if (
        (normalizedAction !== "enable" && normalizedAction !== "disable")
        || !toolName
        || extra.length > 0
      ) {
        ctx.ui.notify(XAI_TOOLS_USAGE, "error");
        return;
      }

      const result = setXaiNetworkToolActive(
        pi,
        model,
        toolName,
        normalizedAction === "enable",
      );
      notifyUpdate(ctx, toolName, result.active, result.error);
    },
  });
}

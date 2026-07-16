import type { Plugin } from "@opencode-ai/plugin";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

import { parseConfig } from "./config/schema.js";
import { loadMergedConfig } from "./config/merger.js";
import { createWatcherWithIndexer } from "./watcher/index.js";
import {
  codebase_search,
  codebase_peek,
  index_codebase,
  index_status,
  index_health_check,
  index_metrics,
  index_logs,
  find_similar,
  call_graph,
  call_graph_path,
  implementation_lookup,
  add_knowledge_base,
  list_knowledge_bases,
  remove_knowledge_base,
  index_visualize,
  getIndexerForProject,
  initializeTools,
  pr_impact,
} from "./tools/index.js";
import { loadCommandsFromDirectory } from "./commands/loader.js";
import { RoutingHintController } from "./routing-hints.js";
import { startAutoIndex } from "./utils/auto-index.js";
import { hasProjectMarker } from "./utils/files.js";
import type { CombinedWatcher } from "./watcher/index.js";

const activeWatchers = new Map<string, CombinedWatcher>();

function replaceActiveWatcher(projectRoot: string, nextWatcher: CombinedWatcher | null): void {
  const existing = activeWatchers.get(projectRoot);
  if (existing) {
    existing.stop();
    activeWatchers.delete(projectRoot);
  }
  if (nextWatcher) {
    activeWatchers.set(projectRoot, nextWatcher);
  }
}

function getCommandsDir(): string {
  let currentDir = process.cwd();
  
  if (typeof import.meta !== "undefined" && import.meta.url) {
    currentDir = path.dirname(fileURLToPath(import.meta.url));
  }
  
  return path.join(currentDir, "..", "commands");
}

function appendRoutingHints(
  output: { system?: string[]; developer?: string[] },
  hints: string[],
  preferredRole: "system" | "developer",
): void {
  const preferredBucket = preferredRole === "developer" ? output.developer : output.system;
  if (Array.isArray(preferredBucket)) {
    preferredBucket.push(...hints);
    return;
  }

  // Compatibility fallback for runtimes that do not expose a developer channel yet.
  if (Array.isArray(output.system)) {
    output.system.push(...hints);
  }
}

interface ChatTransformInput {
  sessionID?: string;
}

interface ChatTransformOutput {
  system?: string[];
  developer?: string[];
}

const plugin: Plugin = async ({ directory, worktree }) => {
  const __codebaseIndexDebugLogPath = process.env.CODEBASE_INDEX_PLUGIN_DEBUG_LOG
    || "E:/Programmazione/.opencode/debug/codebase-index-plugin.log";
  const __codebaseIndexDebugLog = async (message: string, data: Record<string, unknown> = {}) => {
    try {
      const fs = await import("fs");
      const pathModule = await import("path");
      fs.mkdirSync(pathModule.dirname(__codebaseIndexDebugLogPath), { recursive: true });
      fs.appendFileSync(
        __codebaseIndexDebugLogPath,
        `[${new Date().toISOString()}] ${message} ${JSON.stringify(data, null, 2)}\n`,
        "utf-8",
      );
    } catch {
      // Diagnostic logging must never block plugin startup.
    }
  };

  try {
    await __codebaseIndexDebugLog("plugin input", {
      directory,
      worktree,
      processCwd: process.cwd(),
      homeDir: os.homedir(),
      platform: process.platform,
      argv: process.argv,
      env: {
        OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
        OPENCODE_HOME: process.env.OPENCODE_HOME,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        XDG_DATA_HOME: process.env.XDG_DATA_HOME,
        XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
        XDG_STATE_HOME: process.env.XDG_STATE_HOME,
        PATH: process.env.PATH,
      },
    });

    let projectRoot = worktree || directory;
    if (process.platform === "win32" && worktree === "/" && directory) {
      projectRoot = directory;
    }

    await __codebaseIndexDebugLog("project root selected", {
      projectRoot,
      resolvedProjectRoot: projectRoot ? path.resolve(projectRoot) : null,
      selectedFrom: worktree ? "worktree" : directory ? "directory" : "none",
      processCwd: process.cwd(),
      projectConfigPath: projectRoot ? path.join(projectRoot, ".opencode", "codebase-index.json") : null,
      globalConfigPathCandidate: path.join(os.homedir(), ".config", "opencode", "codebase-index.json"),
    });

    const rawConfig = loadMergedConfig(projectRoot);
    await __codebaseIndexDebugLog("raw config loaded", {
      projectRoot,
      rawConfigKeys: rawConfig && typeof rawConfig === "object" ? Object.keys(rawConfig) : [],
      rawConfig,
    });

    const config = parseConfig(rawConfig);
    await __codebaseIndexDebugLog("parsed config", {
      embeddingProvider: config.embeddingProvider,
      embeddingModel: config.embeddingModel,
      customProvider: config.customProvider
        ? { ...config.customProvider, apiKey: config.customProvider.apiKey ? "***" : undefined }
        : undefined,
      scope: config.scope,
      indexing: config.indexing,
      knowledgeBases: config.knowledgeBases,
      additionalInclude: config.additionalInclude,
    });

    initializeTools(projectRoot, config);

    const getProjectIndexer = () => getIndexerForProject(projectRoot);
    const routingHints = config.search.routingHints
      ? new RoutingHintController(() => getProjectIndexer().getStatus(), 200, config.search.routingGraphHandoffHints)
      : null;

    const isHomeDir = path.resolve(projectRoot) === path.resolve(os.homedir());
    const hasMarker = hasProjectMarker(projectRoot);
    const isValidProject = !isHomeDir && (!config.indexing.requireProjectMarker || hasMarker);
    await __codebaseIndexDebugLog("project validation", {
      projectRoot,
      resolvedProjectRoot: path.resolve(projectRoot),
      isHomeDir,
      requireProjectMarker: config.indexing.requireProjectMarker,
      hasProjectMarker: hasMarker,
      isValidProject,
    });

    if (isHomeDir) {
      console.warn(
        `[codebase-index] Refusing to watch or index home directory "${projectRoot}". ` +
        `Open a specific project directory instead.`
      );
    } else if (!isValidProject) {
      console.warn(
        `[codebase-index] Skipping file watching and auto-indexing: no project marker found in "${projectRoot}". ` +
        `Set "indexing.requireProjectMarker": false in config to override.`
      );
    }

    if (config.indexing.autoIndex && isValidProject) {
      const indexer = getProjectIndexer();
      startAutoIndex(indexer, projectRoot);
    }

    if (config.indexing.watchFiles && isValidProject) {
      replaceActiveWatcher(projectRoot, createWatcherWithIndexer(getProjectIndexer, projectRoot, config, "opencode"));
    } else {
      replaceActiveWatcher(projectRoot, null);
    }

    return {
      tool: {
        codebase_search,
        codebase_peek,
        index_codebase,
        index_status,
        index_health_check,
        index_metrics,
        index_logs,
        find_similar,
        call_graph,
        call_graph_path,
        implementation_lookup,
        add_knowledge_base,
        list_knowledge_bases,
        remove_knowledge_base,
        pr_impact,
        index_visualize,
      },

      async "chat.message"(input, output) {
        routingHints?.observeUserMessage(input.sessionID, output.parts);
      },

      async "experimental.chat.system.transform"(input: ChatTransformInput, output: ChatTransformOutput) {
        if (config.search.routingHintRole !== "system") {
          return;
        }

        const hints = await routingHints?.getSystemHints(input.sessionID) ?? [];
        appendRoutingHints(output, hints, "system");
      },

      async "experimental.chat.developer.transform"(input: ChatTransformInput, output: ChatTransformOutput) {
        if (config.search.routingHintRole !== "developer") {
          return;
        }

        const hints = await routingHints?.getSystemHints(input.sessionID) ?? [];
        appendRoutingHints(output, hints, "developer");
      },

      async "tool.execute.after"(input) {
        routingHints?.markToolUsed(input.sessionID, input.tool);
      },

      async config(cfg) {
        cfg.command = cfg.command ?? {};

        const commandsDir = getCommandsDir();
        const commands = loadCommandsFromDirectory(commandsDir);

        for (const [name, definition] of commands) {
          cfg.command[name] = definition;
        }
      },
    };
  } catch {
    console.error("[codebase-index] Failed to initialize plugin (check config and network)");
    // Return a plugin with no tools to prevent opencode from crashing
    return {
      tool: undefined,
      async config() {},
    };
  }
};

export default plugin;

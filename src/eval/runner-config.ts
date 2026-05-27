import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import * as path from "path";

import { getDefaultModelForProvider } from "../config/index.js";
import { getGlobalIndexPath, resolveProjectConfigPath, resolveProjectIndexPath } from "../config/paths.js";
import { rebasePathEntries, resolveInheritedKnowledgeBaseEntries } from "../config/rebase.js";
import { parseConfig, type SearchConfig as ConfigSearchConfig } from "../config/schema.js";

export function toAbsolute(projectRoot: string, maybeRelative: string): string {
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.join(projectRoot, maybeRelative);
}

function isProjectScopedConfigPath(configPath: string): boolean {
  return path.basename(configPath) === "codebase-index.json"
    && path.basename(path.dirname(configPath)) === ".opencode";
}

function normalizeEvalConfigKnowledgeBases(
  rawConfig: unknown,
  projectRoot: string,
  resolvedConfigPath: string,
): Record<string, unknown> {
  const config = rawConfig && typeof rawConfig === "object"
    ? { ...(rawConfig as Record<string, unknown>) }
    : {};

  if (!Array.isArray(config.knowledgeBases)) {
    return config;
  }

  config.knowledgeBases = isProjectScopedConfigPath(resolvedConfigPath)
    ? resolveInheritedKnowledgeBaseEntries(
        config.knowledgeBases,
        path.dirname(path.dirname(resolvedConfigPath)),
        projectRoot,
      )
    : rebasePathEntries(
        config.knowledgeBases,
        path.dirname(resolvedConfigPath),
        projectRoot,
      );

  return config;
}

function loadRawConfig(projectRoot: string, configPath?: string): unknown {
  const fromPath = configPath ? toAbsolute(projectRoot, configPath) : null;
  if (fromPath && existsSync(fromPath)) {
    return normalizeEvalConfigKnowledgeBases(
      JSON.parse(readFileSync(fromPath, "utf-8")),
      projectRoot,
      fromPath,
    );
  }

  const projectConfig = resolveProjectConfigPath(projectRoot);
  if (existsSync(projectConfig)) {
    return normalizeEvalConfigKnowledgeBases(
      JSON.parse(readFileSync(projectConfig, "utf-8")),
      projectRoot,
      projectConfig,
    );
  }

  const globalConfig = path.join(os.homedir(), ".config", "opencode", "codebase-index.json");
  if (existsSync(globalConfig)) {
    return JSON.parse(readFileSync(globalConfig, "utf-8"));
  }

  return {};
}

function getIndexRootPath(projectRoot: string, scope: "project" | "global"): string {
  return scope === "global"
    ? getGlobalIndexPath()
    : resolveProjectIndexPath(projectRoot, scope);
}

function getLocalProjectIndexRoot(projectRoot: string): string {
  return path.join(projectRoot, ".opencode", "index");
}

function getLocalProjectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".opencode", "codebase-index.json");
}

export function clearIndexRoot(projectRoot: string, scope: "project" | "global"): void {
  const indexRoot = scope === "global"
    ? getIndexRootPath(projectRoot, scope)
    : getLocalProjectIndexRoot(projectRoot);
  if (existsSync(indexRoot)) {
    rmSync(indexRoot, { recursive: true, force: true });
  }
}

export function ensureLocalEvalProjectConfig(projectRoot: string, configPath?: string): string | undefined {
  const localConfigPath = getLocalProjectConfigPath(projectRoot);
  const resolvedConfigPath = configPath
    ? toAbsolute(projectRoot, configPath)
    : resolveProjectConfigPath(projectRoot);

  if (!configPath && existsSync(localConfigPath)) {
    return localConfigPath;
  }

  if (!existsSync(resolvedConfigPath) || resolvedConfigPath === localConfigPath) {
    return resolvedConfigPath;
  }

  const sourceConfig = normalizeEvalConfigKnowledgeBases(
    JSON.parse(readFileSync(resolvedConfigPath, "utf-8")),
    projectRoot,
    resolvedConfigPath,
  );

  mkdirSync(path.dirname(localConfigPath), { recursive: true });
  writeFileSync(localConfigPath, JSON.stringify(sourceConfig, null, 2), "utf-8");
  return localConfigPath;
}

export function loadParsedConfig(projectRoot: string, configPath?: string): ReturnType<typeof parseConfig> {
  const raw = loadRawConfig(projectRoot, configPath);
  return parseConfig(raw);
}

export function resolveSearchConfig(
  parsedConfig: ReturnType<typeof parseConfig>,
  overrides?: Partial<Pick<ConfigSearchConfig, "fusionStrategy" | "hybridWeight" | "rrfK" | "rerankTopN">>
): ReturnType<typeof parseConfig> {
  const nextSearch: ConfigSearchConfig = {
    ...parsedConfig.search,
  };

  if (overrides?.fusionStrategy !== undefined) {
    nextSearch.fusionStrategy = overrides.fusionStrategy;
  }
  if (overrides?.hybridWeight !== undefined) {
    nextSearch.hybridWeight = overrides.hybridWeight;
  }
  if (overrides?.rrfK !== undefined) {
    nextSearch.rrfK = overrides.rrfK;
  }
  if (overrides?.rerankTopN !== undefined) {
    nextSearch.rerankTopN = overrides.rerankTopN;
  }

  return {
    ...parsedConfig,
    search: nextSearch,
  };
}

export function getEmbeddingCostPer1MTokens(
  embeddingProvider: ReturnType<typeof parseConfig>["embeddingProvider"],
): number {
  return embeddingProvider === "custom" || embeddingProvider === "auto"
    ? 0
    : getDefaultModelForProvider(embeddingProvider).costPer1MTokens;
}

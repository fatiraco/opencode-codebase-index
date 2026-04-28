import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config/schema.js";
import { Indexer } from "../src/indexer/index.js";
import { formatStatus } from "../src/tools/utils.js";

describe("indexer failed batch recovery", () => {
  let tempDir: string;
  let sourceFile: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let failEmbeddings = false;

  beforeEach(() => {
    failEmbeddings = false;
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/api/tags")) {
        return new Response(JSON.stringify({
          models: [{ name: "nomic-embed-text" }],
        }), { status: 200 });
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[]; prompt?: string };

      if (body.prompt) {
        if (body.prompt.includes("triggerFailure") && !body.prompt.includes("Part ")) {
          return new Response(JSON.stringify({ error: "the input length exceeds the context length" }), { status: 500 });
        }

        return new Response(JSON.stringify({
          embedding: Array.from({ length: 768 }, () => 0.1),
        }), { status: 200 });
      }

      const texts = Array.isArray(body.input) ? body.input : [];

      if (failEmbeddings) {
        return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
      }

      const data = texts.map((text) => {
        let seed = 0;
        for (const ch of text) {
          seed = (seed * 31 + ch.charCodeAt(0)) % 1000;
        }
        const embedding = Array.from({ length: 8 }, (_, idx) => ((seed + idx * 17) % 997) / 997);
        return { embedding };
      });

      return new Response(
        JSON.stringify({
          data,
          usage: { total_tokens: Math.max(1, texts.length * 8) },
        }),
        { status: 200 }
      );
    });

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "failed-batches-indexer-"));
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    sourceFile = path.join(tempDir, "src", "index.ts");
    fs.writeFileSync(
      sourceFile,
      [
        "export function alpha() {",
        "  return 'alpha';",
        "}",
        "",
        "export function beta() {",
        "  return alpha();",
        "}",
      ].join("\n"),
      "utf-8"
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createIndexer(): Indexer {
    const config = parseConfig({
      embeddingProvider: "custom",
      customProvider: {
        baseUrl: "http://localhost:11434/v1",
        model: "mock-embedding-model",
        dimensions: 8,
      },
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
      },
    });

    return new Indexer(tempDir, config);
  }

  function createOllamaIndexer(): Indexer {
    const config = parseConfig({
      embeddingProvider: "ollama",
      embeddingModel: "nomic-embed-text",
      indexing: {
        watchFiles: false,
        retries: 0,
        retryDelayMs: 1,
      },
    });

    return new Indexer(tempDir, config);
  }

  it("retries saved failed batches on a later successful rerun without force", async () => {
    const indexer = createIndexer();

    failEmbeddings = true;
    const failedStats = await indexer.index();
    expect(failedStats.failedChunks).toBeGreaterThan(0);

    const failedStatus = await indexer.getStatus();
    expect(failedStatus.indexed).toBe(false);
    expect(failedStatus.failedBatchesCount).toBeGreaterThan(0);

    failEmbeddings = false;
    const recoveredStats = await indexer.index();
    expect(recoveredStats.failedChunks).toBe(0);
    expect(recoveredStats.indexedChunks).toBeGreaterThan(0);

    const recoveredStatus = await indexer.getStatus();
    expect(recoveredStatus.indexed).toBe(true);
    expect(recoveredStatus.failedBatchesCount).toBe(0);
    expect(recoveredStatus.failedBatchesPath).toBeUndefined();
  });

  it("clears stale failed batch warnings after a clean no-op run", async () => {
    const indexer = createIndexer();

    failEmbeddings = true;
    await indexer.index();

    failEmbeddings = false;
    await indexer.index();

    const recoveredStatus = await indexer.getStatus();
    expect(recoveredStatus.failedBatchesCount).toBe(0);

    const noopStats = await indexer.index();
    expect(noopStats.failedChunks).toBe(0);

    const noopStatus = await indexer.getStatus();
    expect(noopStatus.indexed).toBe(true);
    expect(noopStatus.failedBatchesCount).toBe(0);
    expect(noopStatus.failedBatchesPath).toBeUndefined();
  });

  it("recommends a normal rerun before force rebuilds in failed batch guidance", () => {
    const message = formatStatus({
      indexed: false,
      vectorCount: 0,
      provider: "google",
      model: "gemini-embedding-001",
      indexPath: "/tmp/index",
      currentBranch: "default",
      baseBranch: "default",
      compatibility: null,
      failedBatchesCount: 2,
      failedBatchesPath: "/tmp/index/failed-batches.json",
    });

    expect(message).toContain("rerun index_codebase normally");
    expect(message).toContain("retry the saved failed batches");
    expect(message).toContain("Use force=true only for a full rebuild or compatibility reset");
  });

  it("isolates ollama embedding failures to the offending chunk", async () => {
    const safeFile = path.join(tempDir, "src", "safe.ts");
    fs.writeFileSync(safeFile, "export function safeChunk() { return 'ok'; }\n", "utf-8");

    fs.writeFileSync(
      sourceFile,
      [
        "export const alpha = 'alpha';",
        "export const beta = 'beta';",
        "export const gamma = 'gamma';",
        "export const delta = 'delta';",
        "export const epsilon = 'epsilon';",
        "export const zeta = 'zeta';",
        "export const eta = 'eta';",
        "export const theta = 'theta';",
        "export const triggerFailure = 'triggerFailure';",
        "export const iota = 'iota';",
        "export const kappa = 'kappa';",
        "export const lambda = 'lambda';",
        "export const mu = 'mu';",
        "export const nu = 'nu';",
        "export const xi = 'xi';",
        "export const omicron = 'omicron';",
        "export const pi = 'pi';",
        "export const rho = 'rho';",
        "export const sigma = 'sigma';",
        "export const tau = 'tau';",
        "export const upsilon = 'upsilon';",
        "export const phi = 'phi';",
        "export const chi = 'chi';",
        "export const psi = 'psi';",
        "export const omega = 'omega';",
        "export const stillWorks = 'stillWorks';",
      ].join("\n"),
      "utf-8"
    );

    const indexer = createOllamaIndexer();
    const stats = await indexer.index();

    expect(stats.indexedChunks).toBeGreaterThan(0);
    expect(stats.failedChunks).toBeGreaterThan(0);

    const status = await indexer.getStatus();
    expect(status.failedBatchesCount).toBeGreaterThan(0);
  });

  it("splits oversized ollama chunks into pooled sub-requests before embedding", async () => {
    const embedPrompts: string[] = [];
    fetchSpy.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/api/tags")) {
        return new Response(JSON.stringify({
          models: [{ name: "nomic-embed-text" }],
        }), { status: 200 });
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as { prompt?: string };
      const prompt = body.prompt ?? "";
      embedPrompts.push(prompt);

      if (prompt.length > 8200) {
        return new Response(JSON.stringify({ error: "the input length exceeds the context length" }), { status: 500 });
      }

      const seed = prompt.length % 17;
      return new Response(JSON.stringify({
        embedding: Array.from({ length: 768 }, (_, idx) => seed + idx / 1000),
      }), { status: 200 });
    });

    fs.writeFileSync(
      sourceFile,
      [
        "export function oversizedChunk() {",
        `  const blob = ${JSON.stringify("triggerFailure ".repeat(900))};`,
        "  return blob.length;",
        "}",
      ].join("\n"),
      "utf-8"
    );

    const indexer = createOllamaIndexer();
    const stats = await indexer.index();

    expect(stats.failedChunks).toBe(0);
    expect(stats.indexedChunks).toBeGreaterThan(0);
    expect(embedPrompts.length).toBeGreaterThan(1);
    expect(embedPrompts.some((prompt) => prompt.includes("Part 1/"))).toBe(true);
    expect(embedPrompts.some((prompt) => prompt.includes("Part 2/"))).toBe(true);

    const status = await indexer.getStatus();
    expect(status.failedBatchesCount).toBe(0);
  });
});

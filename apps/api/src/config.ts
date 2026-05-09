import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { EMBEDDING_DIMENSIONS, OPENAI_EMBEDDING_DIMENSIONS } from "@knowledge-brain/core";

export interface AppConfig {
  apiPort: number;
  databasePath: string;
  opensearch: {
    node: string;
    username?: string;
    password?: string;
    rerankPipeline?: string;
    rerankModel?: string;
  };
  staleSourceHours: number;
  modelProvider: "local" | "external";
  embeddingProvider: "openai" | "local";
  embeddingModel: string;
  embeddingDimensions: number;
  generationProvider: "openai" | "local";
  generationModel: string;
  rerankerProvider: "opensearch" | "local" | "disabled";
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (nodeEnv !== "test" && !process.env.VITEST) {
    loadDotEnv();
  }
  const defaultProvider = nodeEnv === "test" || !process.env.OPENAI_API_KEY ? "local" : "openai";
  const embeddingProvider = (process.env.EMBEDDING_PROVIDER as "openai" | "local" | undefined) ?? defaultProvider;
  const generationProvider = (process.env.LLM_PROVIDER as "openai" | "local" | undefined) ?? defaultProvider;
  const defaultEmbeddingDimensions =
    embeddingProvider === "local" ? EMBEDDING_DIMENSIONS : OPENAI_EMBEDDING_DIMENSIONS;
  return {
    apiPort: Number(process.env.API_PORT ?? 8787),
    databasePath: process.env.DATABASE_PATH
      ? resolve(process.env.DATABASE_PATH)
      : resolve("./data/knowledge-brain.sqlite"),
    opensearch: {
      node: process.env.OPENSEARCH_NODE ?? "http://localhost:9200",
      username: process.env.OPENSEARCH_USERNAME || undefined,
      password: process.env.OPENSEARCH_PASSWORD || undefined,
      rerankPipeline: process.env.OPENSEARCH_RERANK_PIPELINE || undefined,
      rerankModel: process.env.OPENSEARCH_RERANK_MODEL || undefined
    },
    staleSourceHours: Number(process.env.STALE_SOURCE_HOURS ?? 24),
    modelProvider: generationProvider === "openai" ? "external" : "local",
    embeddingProvider,
    embeddingModel: process.env.EMBEDDING_MODEL ?? "text-embedding-3-large",
    embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? defaultEmbeddingDimensions),
    generationProvider,
    generationModel: process.env.GENERATION_MODEL ?? "gpt-5.5",
    rerankerProvider:
      (process.env.RERANKER_PROVIDER as "opensearch" | "local" | "disabled" | undefined) ??
      (nodeEnv === "test" ? "local" : "opensearch"),
    ...overrides
  };
}

let didLoadDotEnv = false;

function loadDotEnv(): void {
  if (didLoadDotEnv) {
    return;
  }
  didLoadDotEnv = true;

  const path = findDotEnv();
  if (!path) {
    return;
  }
  if (!existsSync(path)) {
    return;
  }

  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    process.env[key] ??= value.replace(/^["']|["']$/g, "");
  }
}

function findDotEnv(): string | undefined {
  let directory = process.cwd();
  while (true) {
    const candidate = resolve(directory, ".env");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

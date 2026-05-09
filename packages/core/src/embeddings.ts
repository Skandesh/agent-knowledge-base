import { createHash } from "node:crypto";
import OpenAI from "openai";
import pLimit from "p-limit";
import type { EmbeddingProviderName, ProviderStatus } from "@comms-agent/shared";
import { tokenize } from "./text.js";

export const EMBEDDING_DIMENSIONS = 96;
export const LOCAL_EMBEDDING_MODEL = "local-hash-embedding";
export const LOCAL_EMBEDDING_VERSION = "v1";
export const OPENAI_EMBEDDING_MODEL = "text-embedding-3-large";
export const OPENAI_EMBEDDING_DIMENSIONS = 3072;
export const OPENAI_EMBEDDING_VERSION = "2026-05-06";

export interface ProviderHealth {
  provider: EmbeddingProviderName;
  status: ProviderStatus;
  model: string;
  dimensions: number;
  message: string;
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  dimensions: number;
  version: string;
  provider: EmbeddingProviderName;
}

export interface EmbeddingProvider {
  readonly provider: EmbeddingProviderName;
  readonly model: string;
  readonly dimensions: number;
  readonly version: string;
  health(): Promise<ProviderHealth>;
  embedTexts(texts: string[]): Promise<EmbeddingResult[]>;
}

export function embedText(text: string, dimensions = EMBEDDING_DIMENSIONS): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens = tokenize(text);

  for (const token of tokens) {
    const hash = createHash("sha256").update(token).digest();
    const bucket = hash[0] % dimensions;
    const sign = hash[1] % 2 === 0 ? 1 : -1;
    const weight = 1 + Math.log10(1 + token.length);
    vector[bucket] += sign * weight;
  }

  return normalizeVector(vector);
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly provider = "local" as const;
  readonly model = LOCAL_EMBEDDING_MODEL;
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly version = LOCAL_EMBEDDING_VERSION;

  async health(): Promise<ProviderHealth> {
    return {
      provider: this.provider,
      status: "degraded",
      model: this.model,
      dimensions: this.dimensions,
      message:
        "Local deterministic embeddings are enabled explicitly. They are useful for tests and offline development, not production readiness."
    };
  }

  async embedTexts(texts: string[]): Promise<EmbeddingResult[]> {
    return texts.map((text) => ({
      embedding: embedText(text, this.dimensions),
      model: this.model,
      dimensions: this.dimensions,
      version: this.version,
      provider: this.provider
    }));
  }
}

export interface OpenAIEmbeddingProviderOptions {
  apiKey?: string;
  model?: string;
  dimensions?: number;
  batchSize?: number;
  concurrency?: number;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly provider = "openai" as const;
  readonly model: string;
  readonly dimensions: number;
  readonly version = OPENAI_EMBEDDING_VERSION;
  private readonly client?: OpenAI;
  private readonly batchSize: number;
  private readonly concurrency: number;

  constructor(options: OpenAIEmbeddingProviderOptions = {}) {
    this.model = options.model ?? OPENAI_EMBEDDING_MODEL;
    this.dimensions = options.dimensions ?? OPENAI_EMBEDDING_DIMENSIONS;
    this.batchSize = options.batchSize ?? 64;
    this.concurrency = options.concurrency ?? 2;
    this.client = options.apiKey ? new OpenAI({ apiKey: options.apiKey }) : undefined;
  }

  async health(): Promise<ProviderHealth> {
    if (!this.client) {
      return {
        provider: this.provider,
        status: "degraded",
        model: this.model,
        dimensions: this.dimensions,
        message: "OPENAI_API_KEY is required for production embeddings."
      };
    }

    return {
      provider: this.provider,
      status: "ok",
      model: this.model,
      dimensions: this.dimensions,
      message: "OpenAI embedding provider is configured."
    };
  }

  async embedTexts(texts: string[]): Promise<EmbeddingResult[]> {
    if (!this.client) {
      throw new Error("OPENAI_API_KEY is required to generate OpenAI embeddings.");
    }
    if (texts.length === 0) {
      return [];
    }

    const batches = chunkArray(texts, this.batchSize);
    const limit = pLimit(this.concurrency);
    const batchResults = await Promise.all(
      batches.map((batch) =>
        limit(async () =>
          retry(async () => {
            const response = await this.client!.embeddings.create({
              model: this.model,
              input: batch,
              dimensions: this.dimensions
            });
            return response.data
              .slice()
              .sort((a, b) => a.index - b.index)
              .map((item) => ({
                embedding: item.embedding,
                model: response.model ?? this.model,
                dimensions: item.embedding.length,
                version: this.version,
                provider: this.provider
              }));
          })
        )
      )
    );

    return batchResults.flat();
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    aMag += a[index] * a[index];
    bMag += b[index] * b[index];
  }
  if (aMag === 0 || bMag === 0) {
    return 0;
  }
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
}

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return vector;
  }
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let cursor = 0; cursor < items.length; cursor += size) {
    chunks.push(items.slice(cursor, cursor + size));
  }
  return chunks;
}

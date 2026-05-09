import { Client } from "@opensearch-project/opensearch";
import {
  embedText,
  OPENAI_EMBEDDING_DIMENSIONS,
  reciprocalRankFusion
} from "@knowledge-brain/core";
import type {
  EntityRecord,
  KnowledgeChunk,
  QueryMode,
  RelationRecord,
  RetrievedChunk
} from "@knowledge-brain/shared";
import { KNOWLEDGE_INDICES, KNOWLEDGE_INDEX_VERSIONS } from "@knowledge-brain/shared";

export interface OpenSearchConfig {
  node: string;
  username?: string;
  password?: string;
  rerankPipeline?: string;
  rerankModel?: string;
  embeddingDimensions?: number;
}

export interface SearchOptions {
  question: string;
  mode: QueryMode;
  topK: number;
  queryEmbedding?: number[];
  filters?: {
    tags?: string[];
    sourceIds?: string[];
  };
}

export class OpenSearchKnowledgeIndex {
  private readonly client: Client;

  constructor(private readonly config: OpenSearchConfig) {
    this.client = new Client({
      node: config.node,
      auth:
        config.username && config.password
          ? {
              username: config.username,
              password: config.password
            }
          : undefined
    });
  }

  async health(): Promise<"ok" | "degraded"> {
    try {
      await this.client.cluster.health();
      return "ok";
    } catch {
      return "degraded";
    }
  }

  async ensureIndices(): Promise<void> {
    const embeddingDimensions = this.config.embeddingDimensions ?? OPENAI_EMBEDDING_DIMENSIONS;
    await this.ensureIndex(KNOWLEDGE_INDEX_VERSIONS.chunks, KNOWLEDGE_INDICES.chunks, {
      settings: {
        index: {
          knn: true
        }
      },
      mappings: {
        properties: {
          id: { type: "keyword" },
          sourceId: { type: "keyword" },
          documentId: { type: "keyword" },
          chunkIndex: { type: "integer" },
          title: { type: "text", fields: { keyword: { type: "keyword" } } },
          text: { type: "text" },
          embedding: {
            type: "knn_vector",
            dimension: embeddingDimensions
          },
          contentHash: { type: "keyword" },
          uri: { type: "keyword" },
          tags: { type: "keyword" },
          createdAt: { type: "date" },
          sectionHeading: { type: "text", fields: { keyword: { type: "keyword" } } },
          tokenCount: { type: "integer" },
          startOffset: { type: "integer" },
          endOffset: { type: "integer" },
          metadata: { type: "object", enabled: false },
          embeddingProvider: { type: "keyword" },
          embeddingModel: { type: "keyword" },
          embeddingDimensions: { type: "integer" },
          embeddingVersion: { type: "keyword" },
          embeddingStatus: { type: "keyword" },
          indexedAt: { type: "date" },
          indexingStatus: { type: "keyword" }
        }
      }
    }, embeddingDimensions);

    await this.ensureIndex(KNOWLEDGE_INDEX_VERSIONS.entities, KNOWLEDGE_INDICES.entities, {
      mappings: {
        properties: {
          id: { type: "keyword" },
          name: { type: "text", fields: { keyword: { type: "keyword" } } },
          normalizedName: { type: "keyword" },
          type: { type: "keyword" },
          aliases: { type: "keyword" },
          confidence: { type: "float" },
          evidenceChunkIds: { type: "keyword" },
          createdAt: { type: "date" },
          updatedAt: { type: "date" }
        }
      }
    });

    await this.ensureIndex(KNOWLEDGE_INDEX_VERSIONS.relations, KNOWLEDGE_INDICES.relations, {
      mappings: {
        properties: {
          id: { type: "keyword" },
          subject: { type: "text", fields: { keyword: { type: "keyword" } } },
          predicate: { type: "keyword" },
          object: { type: "text", fields: { keyword: { type: "keyword" } } },
          confidence: { type: "float" },
          evidenceChunkIds: { type: "keyword" },
          createdAt: { type: "date" }
        }
      }
    });

    await this.ensureIndex(KNOWLEDGE_INDEX_VERSIONS.events, KNOWLEDGE_INDICES.events, {
      mappings: {
        properties: {
          id: { type: "keyword" },
          type: { type: "keyword" },
          message: { type: "text" },
          payload: { type: "object", enabled: false },
          createdAt: { type: "date" }
        }
      }
    });
  }

  async resetIndices(): Promise<void> {
    for (const index of Object.values(KNOWLEDGE_INDEX_VERSIONS)) {
      try {
        const existsResponse = await this.client.indices.exists({ index });
        const exists =
          typeof existsResponse === "boolean"
            ? existsResponse
            : (existsResponse as { body?: boolean }).body === true;
        if (exists) {
          await this.client.indices.delete({ index });
        }
      } catch {
        // Eval resets are best-effort so fallback-only environments still work.
      }
    }
    await this.ensureIndices();
  }

  async indexChunks(chunks: KnowledgeChunk[]): Promise<void> {
    if (chunks.length === 0) {
      return;
    }
    const body = chunks.flatMap((chunk) => [
      { index: { _index: KNOWLEDGE_INDEX_VERSIONS.chunks, _id: chunk.id } },
      {
        ...chunk,
        indexedAt: new Date().toISOString(),
        indexingStatus: "indexed"
      }
    ]);
    const response = await this.client.bulk({ refresh: true, body });
    assertBulkSucceeded(response, "chunk");
  }

  async deleteChunksBySource(sourceId: string): Promise<void> {
    try {
      await this.client.deleteByQuery({
        index: KNOWLEDGE_INDICES.chunks,
        refresh: true,
        body: {
          query: {
            term: {
              sourceId
            }
          }
        }
      });
    } catch {
      // Missing/stale indices are repaired by full reindex and should not block ingestion.
    }
  }

  async indexEntities(entities: EntityRecord[]): Promise<void> {
    if (entities.length === 0) {
      return;
    }
    const body = entities.flatMap((entity) => [
      { index: { _index: KNOWLEDGE_INDEX_VERSIONS.entities, _id: entity.id } },
      entity
    ]);
    const response = await this.client.bulk({ refresh: true, body });
    assertBulkSucceeded(response, "entity");
  }

  async indexRelations(relations: RelationRecord[]): Promise<void> {
    if (relations.length === 0) {
      return;
    }
    const body = relations.flatMap((relation) => [
      { index: { _index: KNOWLEDGE_INDEX_VERSIONS.relations, _id: relation.id } },
      relation
    ]);
    const response = await this.client.bulk({ refresh: true, body });
    assertBulkSucceeded(response, "relation");
  }

  async search(optionsOrQuestion: SearchOptions | string, mode?: QueryMode, topK?: number): Promise<RetrievedChunk[]> {
    const options =
      typeof optionsOrQuestion === "string"
        ? {
            question: optionsOrQuestion,
            mode: mode ?? "hybrid",
            topK: topK ?? 8
          }
        : optionsOrQuestion;
    if (options.mode === "keyword") {
      return this.keywordSearch(options.question, options.topK, options.filters);
    }
    if (options.mode === "semantic") {
      return this.vectorSearch(options.question, options.topK, options.queryEmbedding, options.filters);
    }

    const [keyword, vector] = await Promise.all([
      this.keywordSearch(options.question, Math.max(options.topK, 80), options.filters),
      this.vectorSearch(options.question, Math.max(options.topK, 80), options.queryEmbedding, options.filters)
    ]);

    return reciprocalRankFusion(
      keyword.map((chunk) => ({ chunk, score: chunk.scoreBreakdown.keyword ?? chunk.score })),
      vector.map((chunk) => ({ chunk, score: chunk.scoreBreakdown.vector ?? chunk.score })),
      options.topK
    );
  }

  async reindexAll(chunks: KnowledgeChunk[], entities: EntityRecord[], relations: RelationRecord[]): Promise<void> {
    await this.resetIndices();
    await this.indexChunks(chunks);
    await this.indexEntities(entities);
    await this.indexRelations(relations);
  }

  async switchAliases(): Promise<void> {
    const actions = Object.entries(KNOWLEDGE_INDEX_VERSIONS).flatMap(([key, index]) => [
      { remove: { index: "*", alias: KNOWLEDGE_INDICES[key as keyof typeof KNOWLEDGE_INDICES], ignore_unavailable: true } },
      { add: { index, alias: KNOWLEDGE_INDICES[key as keyof typeof KNOWLEDGE_INDICES] } }
    ]);
    await this.client.indices.updateAliases({ body: { actions } });
  }

  private async keywordSearch(
    question: string,
    topK: number,
    filters?: SearchOptions["filters"]
  ): Promise<RetrievedChunk[]> {
    const response = await this.client.search({
      index: KNOWLEDGE_INDICES.chunks,
      size: topK,
      body: {
        query: scopedQuery(
          {
            multi_match: {
              query: question,
              fields: ["title^2", "sectionHeading^1.6", "text", "tags^1.5"]
            }
          },
          filters
        )
      }
    });
    return hits(response).map((hit) => withSearchScore(hit._source, hit._score ?? 0, "keyword", "Selected by BM25 lexical search."));
  }

  private async vectorSearch(
    question: string,
    topK: number,
    queryEmbedding?: number[],
    filters?: SearchOptions["filters"]
  ): Promise<RetrievedChunk[]> {
    const vector = queryEmbedding?.length ? queryEmbedding : embedText(question, OPENAI_EMBEDDING_DIMENSIONS);
    const response = await this.client.search({
      index: KNOWLEDGE_INDICES.chunks,
      size: topK,
      body: {
        query: scopedQuery(
          {
            knn: {
              embedding: {
                vector,
                k: topK
              }
            }
          },
          filters
        )
      }
    });
    return hits(response).map((hit) => withSearchScore(hit._source, hit._score ?? 0, "vector", "Selected by dense vector search."));
  }

  private async ensureIndex(
    index: string,
    alias: string,
    body: Record<string, unknown>,
    expectedVectorDimension?: number
  ): Promise<void> {
    const existsResponse = await this.client.indices.exists({ index });
    let exists =
      typeof existsResponse === "boolean" ? existsResponse : (existsResponse as { body?: boolean }).body === true;
    if (exists && expectedVectorDimension !== undefined) {
      const currentDimension = await this.currentVectorDimension(index);
      if (currentDimension !== undefined && currentDimension !== expectedVectorDimension) {
        await this.client.indices.delete({ index });
        exists = false;
      }
    }
    if (!exists) {
      await this.client.indices.create({ index, body });
    }
    await this.ensureAlias(index, alias);
  }

  private async currentVectorDimension(index: string): Promise<number | undefined> {
    const response = await this.client.indices.getMapping({ index });
    const candidate = response as unknown as { body?: MappingResponseBody } & MappingResponseBody;
    const body = candidate.body ?? candidate;
    const indexMapping = body[index] ?? Object.values(body)[0];
    const embedding = indexMapping?.mappings?.properties?.embedding;
    return typeof embedding?.dimension === "number" ? embedding.dimension : undefined;
  }

  private async ensureAlias(index: string, alias: string): Promise<void> {
    const aliasExists = await this.client.indices.existsAlias({ index, name: alias }).catch(() => false);
    const exists = typeof aliasExists === "boolean" ? aliasExists : (aliasExists as { body?: boolean }).body === true;
    if (exists) {
      return;
    }
    const conflictingIndex = await this.client.indices.exists({ index: alias }).catch(() => false);
    const hasConflictingIndex =
      typeof conflictingIndex === "boolean"
        ? conflictingIndex
        : (conflictingIndex as { body?: boolean }).body === true;
    if (hasConflictingIndex && alias !== index) {
      await this.client.indices.delete({ index: alias });
    }
    await this.client.indices.putAlias({ index, name: alias });
  }
}

function hits(response: any): Array<{ _score?: number; _source: KnowledgeChunk }> {
  return response.body?.hits?.hits ?? response.hits?.hits ?? [];
}

interface BulkOperationResult {
  error?: {
    type?: string;
    reason?: string;
  };
}

interface BulkResponseBody {
  errors?: boolean;
  items?: Array<Record<string, BulkOperationResult>>;
}

interface MappingResponseBody {
  [index: string]: {
    mappings?: {
      properties?: {
        embedding?: {
          dimension?: number;
        };
      };
    };
  };
}

function bulkBody(response: unknown): BulkResponseBody {
  const candidate = response as { body?: BulkResponseBody } & BulkResponseBody;
  return candidate.body ?? candidate;
}

function assertBulkSucceeded(response: unknown, label: string): void {
  const body = bulkBody(response);
  if (!body.errors) {
    return;
  }
  const failures = (body.items ?? [])
    .flatMap((item) => Object.values(item))
    .filter((item) => item.error)
    .slice(0, 3)
    .map((item) => `${item.error?.type ?? "bulk_error"}: ${item.error?.reason ?? "unknown error"}`);
  throw new Error(`OpenSearch ${label} bulk index failed: ${failures.join("; ") || "unknown error"}`);
}

function withSearchScore(
  chunk: KnowledgeChunk,
  score: number,
  kind: "keyword" | "vector",
  reason: string
): RetrievedChunk {
  return {
    ...chunk,
    score,
    scoreBreakdown: {
      [kind]: score
    },
    retrievalReason: reason
  };
}

function scopedQuery(query: Record<string, unknown>, filters?: SearchOptions["filters"]): Record<string, unknown> {
  const filter: Array<Record<string, unknown>> = [];
  if (filters?.sourceIds?.length) {
    filter.push({ terms: { sourceId: filters.sourceIds } });
  }
  if (filters?.tags?.length) {
    filter.push({ terms: { tags: filters.tags } });
  }
  if (filter.length === 0) {
    return query;
  }
  return {
    bool: {
      must: query,
      filter
    }
  };
}

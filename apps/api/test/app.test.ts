import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("Knowledge Brain API", () => {
  it("reports degraded production providers and fails generation honestly without OpenAI credentials", async () => {
    const databasePath = resolve("./data/vitest-missing-openai.sqlite");
    await Promise.all([
      rm(databasePath, { force: true }),
      rm(`${databasePath}-shm`, { force: true }),
      rm(`${databasePath}-wal`, { force: true })
    ]);
    const previousKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const app = await buildApp({
      config: {
        databasePath,
        staleSourceHours: 0,
        embeddingProvider: "openai",
        generationProvider: "openai",
        rerankerProvider: "opensearch",
        modelProvider: "external"
      }
    });

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().embeddingProvider.status).toBe("degraded");
    expect(health.json().generationProvider.status).toBe("degraded");

    const query = await app.inject({
      method: "POST",
      url: "/query",
      payload: {
        question: "What retrieval backend is documented?"
      }
    });
    expect(query.statusCode).toBe(503);
    expect(query.body).toMatch(/OPENAI_API_KEY/i);

    await app.close();
    if (previousKey) {
      process.env.OPENAI_API_KEY = previousKey;
    }
  });

  it("ingests text, answers with citations, exposes graph records, and runs healing", async () => {
    const databasePath = resolve("./data/vitest-api.sqlite");
    await Promise.all([
      rm(databasePath, { force: true }),
      rm(`${databasePath}-shm`, { force: true }),
      rm(`${databasePath}-wal`, { force: true })
    ]);
    const app = await buildApp({
      config: {
        databasePath,
        staleSourceHours: 0,
        embeddingProvider: "local",
        generationProvider: "local",
        rerankerProvider: "local",
        modelProvider: "local"
      }
    });

    const ingest = await app.inject({
      method: "POST",
      url: "/ingest-runs",
      payload: {
        source: {
          kind: "text",
          title: "API Test Corpus",
          content:
            "Knowledge Brain uses OpenSearch for hybrid retrieval. The TypeScript agent extracts entities and relations, then returns cited answers. The system might need low confidence healing when evidence is uncertain."
        }
      }
    });
    expect(ingest.statusCode).toBe(200);
    expect(ingest.json().status).toBe("completed");

    const query = await app.inject({
      method: "POST",
      url: "/query",
      payload: {
        question: "What does Knowledge Brain use for retrieval?",
        filters: {
          sourceIds: [ingest.json().sourceId]
        }
      }
    });
    expect(query.statusCode).toBe(200);
    expect(query.json().citations.length).toBeGreaterThan(0);
    expect(query.json().citations.every((citation: { sourceId: string }) => citation.sourceId === ingest.json().sourceId)).toBe(true);

    const primaryTaggedIngest = await app.inject({
      method: "POST",
      url: "/ingest-runs",
      payload: {
        source: {
          kind: "text",
          title: "Primary Tagged Corpus",
          tags: ["topic-alpha", "collection-primary"],
          content: "Primary collection guidance covers launch readiness, operating checks, and review status."
        }
      }
    });
    const secondaryTaggedIngest = await app.inject({
      method: "POST",
      url: "/ingest-runs",
      payload: {
        source: {
          kind: "text",
          title: "Secondary Tagged Corpus",
          tags: ["topic-alpha", "collection-secondary"],
          content: "Secondary collection guidance covers broad background context and comparison notes."
        }
      }
    });
    expect(primaryTaggedIngest.json().status).toBe("completed");
    expect(secondaryTaggedIngest.json().status).toBe("completed");

    const scopedQuery = await app.inject({
      method: "POST",
      url: "/query",
      payload: {
        question: "What primary launch readiness guidance is available?",
        filters: {
          tags: ["topic-alpha", "collection-primary"]
        }
      }
    });
    expect(scopedQuery.statusCode).toBe(200);
    expect(
      scopedQuery
        .json()
        .citations.every(
          (citation: { sourceId: string }) => citation.sourceId === primaryTaggedIngest.json().sourceId
        )
    ).toBe(true);

    const inventoryQuery = await app.inject({
      method: "POST",
      url: "/query",
      payload: {
        question: "What's in this knowledge base?"
      }
    });
    expect(inventoryQuery.statusCode).toBe(200);
    expect(inventoryQuery.json().answer).toMatch(/sources?/i);
    expect(inventoryQuery.json().answer).toMatch(/indexed chunks?/i);
    expect(inventoryQuery.json().answer).not.toMatch(/graph layer also found/i);
    expect(inventoryQuery.json().citations.length).toBeGreaterThan(0);

    const graph = await app.inject({ method: "GET", url: "/graph" });
    expect(graph.statusCode).toBe(200);
    expect(graph.json().entities.length).toBeGreaterThan(0);

    const heal = await app.inject({
      method: "POST",
      url: "/heal-runs",
      payload: {
        scope: "all"
      }
    });
    expect(heal.statusCode).toBe(200);
    expect(heal.json().actions.length).toBeGreaterThan(0);

    await app.close();
  });
});

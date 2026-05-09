import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";

const databasePath = resolve("./data/smoke.sqlite");
await rm(databasePath, { force: true });

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
      title: "Smoke knowledge",
      tags: ["smoke"],
      content:
        "Knowledge Brain ingests sources, builds chunks, extracts OpenSearch entities, and retrieves cited answers. OpenSearch is the primary retrieval backend, while SQLite preserves canonical metadata."
    }
  }
});
assert.equal(ingest.statusCode, 200);
const ingestBody = ingest.json();
assert.equal(ingestBody.status, "completed");
assert.ok(ingestBody.chunks > 0);

const query = await app.inject({
  method: "POST",
  url: "/query",
  payload: {
    question: "What backend does Knowledge Brain use for retrieval?",
    mode: "hybrid"
  }
});
assert.equal(query.statusCode, 200);
const queryBody = query.json();
assert.ok(queryBody.citations.length > 0);
assert.match(queryBody.answer, /OpenSearch|retrieval|Knowledge Brain/i);

const heal = await app.inject({
  method: "POST",
  url: "/heal-runs",
  payload: {
    scope: "all"
  }
});
assert.equal(heal.statusCode, 200);
assert.ok(heal.json().actions.length > 0);

await app.close();
console.log("Smoke test passed");

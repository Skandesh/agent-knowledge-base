import { buildApp } from "../src/app.js";

const app = await buildApp();

const seeds = [
  {
    kind: "text",
    title: "Comms Agent Operating Manual",
    tags: ["comms", "manual"],
    content:
      "Comms Agent ingests manuals, notes, URLs, files, and GitHub repositories, then answers questions with citations. Shared examples use placeholders only; real API keys, credentials, logs, and runtime databases stay local."
  },
  {
    kind: "text",
    title: "Comms Agent Demo Notes",
    tags: ["demo", "architecture"],
    content:
      "Comms Agent is a TypeScript agent that ingests information, builds a structured knowledge base, retrieves cited answers, and self-heals over time. It uses OpenSearch for BM25, vector, and hybrid retrieval. It stores canonical source, job, and graph metadata in SQLite."
  },
  {
    kind: "github_repo",
    uri: "https://github.com/opensearch-project/opensearch-js",
    title: "OpenSearch JavaScript Client",
    tags: ["opensearch", "github"]
  }
];

for (const source of seeds) {
  const result = await app.inject({
    method: "POST",
    url: "/ingest-runs",
    payload: { source }
  });
  const body = result.json();
  app.log.info({ source: source.title, status: body.status, chunks: body.chunks }, "seeded source");
}

await app.close();
console.log("Seed corpus ingested");

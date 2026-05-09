# Knowledge Brain

An autonomous TypeScript comms agent that ingests manuals, notes, files, URLs, and GitHub repositories, builds a structured knowledge base, retrieves cited answers through OpenSearch-backed search, and runs self-healing checks over the corpus.

## Quick Start

```bash
pnpm install
cp .env.example .env
docker compose up -d opensearch
pnpm dev
```

If your Docker install exposes the legacy binary instead of the v2 subcommand, use
`docker-compose up -d opensearch`.

- API: http://localhost:8787
- Web app: http://localhost:5173
- Optional OpenSearch Dashboards: `docker compose up -d dashboards` or `docker-compose up -d dashboards`, then http://localhost:5601

The API can run without OpenSearch for smoke tests, but OpenSearch is the intended retrieval backend.

## Manual And Secrets

Committed configuration files use placeholders only. Keep real values in a local `.env` copied from `.env.example`.

Sensitive values that must stay local:

- `OPENAI_API_KEY`
- `OPENSEARCH_USERNAME`
- `OPENSEARCH_PASSWORD`
- Provider-specific model, reranker, or deployment credentials

Use blank placeholder values in docs, examples, tests, and shared fixtures. Do not commit runtime databases, logs, `.omx` state, Playwright traces, generated reports, or local screenshots.

## Demo Flow

1. Open the web app.
2. Ingest a URL, pasted text, or GitHub repo.
3. Watch the pipeline move through fetch, parse, chunk, embed, extract, index, and verify.
4. Ask a question and inspect citations, confidence, retrieved evidence, and agent trace.
5. Run self-healing and review stale-source, indexing, duplicate-entity, and low-confidence findings.

## Commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm smoke
pnpm eval
pnpm demo:check
pnpm demo:prepare
pnpm seed
```

`pnpm eval` resets the known dev OpenSearch indices, ingests a deterministic golden corpus, and runs 26 readiness questions across ingestion, retrieval, graph, API, agent trace, and self-healing behavior. It writes `data/eval-report.json`.

## Architecture

- `apps/api`: Fastify API and orchestration service.
- `apps/web`: React operator console.
- `packages/shared`: shared product types and constants.
- `packages/core`: chunking, local embeddings, extraction, retrieval fusion, answer synthesis.
- `packages/storage`: SQLite metadata/job/graph store using Node's built-in SQLite.
- `packages/search`: OpenSearch index management and retrieval adapter.

OpenSearch indices:

- `kb_chunks_v1`
- `kb_entities_v1`
- `kb_relations_v1`
- `kb_events_v1`

## Demo Readiness

Use this local loop before sharing a demo:

```bash
docker-compose up -d opensearch
pnpm demo:check
pnpm demo:prepare
pnpm dev
```

If OpenSearch is unavailable, the app still runs with local retrieval fallback, but the preferred demo should show `/health` with `opensearch: ok`.

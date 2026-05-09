# Comms Agent PRD

## Goal

Build a TypeScript comms agent that ingests operating manuals, notes, files, URLs, and repositories; constructs a structured knowledge base; retrieves cited answers; and self-heals over time.

OpenSearch is the primary retrieval/index backend. SQLite is the canonical local metadata store. The TypeScript agent owns ingestion, query planning, answer synthesis, graph expansion, and healing workflows.

## Product Guardrail

Comms Agent must remain domain-generic. User-provided URLs, source names, tags, industries, countries, or corpora are examples and seed data only. Runtime code must not hardcode domain-specific tags, source IDs, source titles, retrieval rules, parser behavior, answer templates, or healing behavior for a particular example corpus.

Example-specific content may live in tests, eval fixtures, seed scripts, or local data, but those examples must exercise generic capabilities.

## Stage Tracker

| Stage | Status | Implemented surface |
| --- | --- | --- |
| 0. Foundation | Done | `pnpm` monorepo, strict TS, lint/test/build scripts, Docker/OpenSearch compose, API/web apps |
| 1. Ingestion | Done | URL, text, local file/directory, PDF fallback text extraction, GitHub repo connector, staged ingest runs |
| 2. Structured KB | Done | Chunk, entity, relation, claim records with provenance and SQLite/OpenSearch persistence |
| 3. Retrieval | Done | Keyword, semantic, hybrid, graph, and agentic modes with local fallback and cited answers |
| 4. Agentic workflow | Done | Planner, `searchChunks`, `expandGraph`, reflector retry, synthesis trace |
| 5. Self-healing | Done | Stale source, failed ingest, orphan chunk, duplicate entity, low-confidence claim, index drift checks |
| 6. Demo/eval | Done | README, seed/reindex scripts, smoke test, unit/API tests, 26-question golden eval suite, demo readiness commands |

## Primary User Stories

- As a knowledge user, I can ingest URL, text, file, directory, PDF, and GitHub repo sources.
- As a knowledge user, I can see ingest progress across queued, fetched, parsed, chunked, embedded, extracted, indexed, and verified stages.
- As a knowledge user, I can ask a natural-language question and receive a cited answer with confidence and evidence.
- As a builder/operator, I can inspect sources, ingest runs, entities, relations, healing findings, and healing actions.
- As the agent, I can select retrieval mode, run search tools, expand graph context, retry when evidence is thin, and explain the trace.
- As the agent, I can detect knowledge health issues and distinguish automatic repairs from proposed destructive/risky changes.

## API Contract

- `GET /health`
- `GET /stages`
- `GET /sources`
- `POST /sources`
- `GET /ingest-runs`
- `POST /ingest-runs`
- `GET /ingest-runs/:id`
- `POST /query`
- `GET /graph`
- `GET /heal-runs`
- `POST /heal-runs`
- `GET /heal-runs/:id`

## Remaining Build Priorities

- Add richer PDF extraction if the demo corpus depends on complex PDFs.
- Add optional external embedding/LLM provider adapters behind the current local-provider interface.
- Add production deployment/auth only after the local demo is stable.

import type { QueryMode, QueryStatus, SourceInput } from "@comms-agent/shared";

export interface GoldenQuestion {
  id: string;
  question: string;
  mode?: QueryMode;
  minConfidence: number;
  expectedTerms: string[];
  expectedSourceTitles?: string[];
  expectedStatus?: QueryStatus;
}

export const GOLDEN_CORPUS: SourceInput[] = [
  {
    kind: "text",
    title: "Comms Agent Operating Manual",
    tags: ["comms", "manual", "demo"],
    content: `
# Comms Agent Operating Manual

Comms Agent is an autonomous knowledge and communications assistant. It ingests manuals, notes, files, URLs, and GitHub repositories; constructs a structured knowledge base; retrieves cited answers; and self-heals over time.

Shared repos and demos must avoid committed secrets. Use placeholders in manuals and examples, keep API keys and service credentials in local environment files, and make pending work visible to the operator.
`
  },
  {
    kind: "text",
    title: "OpenSearch Retrieval Stack",
    tags: ["opensearch", "retrieval", "search"],
    content: `
# OpenSearch Retrieval Stack

OpenSearch is the primary retrieval and indexing backend for Comms Agent. It stores searchable chunks, entities, relations, and operational events. OpenSearch supports BM25 keyword search, k-NN vector search, neural search, and hybrid retrieval.

The TypeScript retrieval layer runs keyword and vector searches, then fuses results with reciprocal rank fusion. Agentic retrieval uses a TypeScript planner to choose keyword, semantic, hybrid, graph, or agentic mode before answer synthesis.
`
  },
  {
    kind: "text",
    title: "Ingestion Pipeline",
    tags: ["ingestion", "pipeline"],
    content: `
# Ingestion Pipeline

Comms Agent ingests URL sources, local files, pasted text, and GitHub repositories. The ingest pipeline moves through queued, fetched, parsed, chunked, embedded, extracted, indexed, and verified stages.

Every chunk preserves provenance including source URI, document ID, chunk ID, title, tags, timestamp, content hash, and source ID. Failed ingest jobs expose actionable errors and can be retried.
`
  },
  {
    kind: "text",
    title: "Structured Knowledge Base",
    tags: ["graph", "knowledge-base"],
    content: `
# Structured Knowledge Base

The structured knowledge base contains chunks, entities, relations, and claims. Entities include aliases, type, confidence, and evidence chunk IDs. Relations are stored as subject-predicate-object facts with confidence and evidence.

SQLite is the canonical local metadata store for sources, documents, ingest runs, graph records, healing runs, and eval results. OpenSearch indices include kb_chunks_v1, kb_entities_v1, kb_relations_v1, and kb_events_v1.
`
  },
  {
    kind: "text",
    title: "OpenSearch Index Names",
    tags: ["opensearch", "schema", "indices"],
    content: `
# OpenSearch Index Names

The system uses four OpenSearch indices. kb_chunks_v1 stores searchable text chunks and embeddings. kb_entities_v1 stores extracted entities. kb_relations_v1 stores subject-predicate-object graph facts. kb_events_v1 stores operational events and traces.
`
  },
  {
    kind: "text",
    title: "Agent Workflow",
    tags: ["agent", "tools", "trace"],
    content: `
# Agent Workflow

Comms Agent follows a plan, execute, reflect workflow. The planner selects a retrieval strategy. The executor runs tools including searchChunks, lookupEntity, expandGraph, fetchSource, runEval, and startHealRun.

The reflector checks whether evidence is grounded enough to answer. If evidence is weak, the agent retries with a different retrieval mode. The UI shows the agent trace so the user can inspect the plan, tool calls, evidence, and final answer.
`
  },
  {
    kind: "text",
    title: "Self Healing System",
    tags: ["healing", "quality"],
    content: `
# Self Healing System

Self-healing audits stale sources, failed crawls, orphan chunks, broken citations, duplicate entities, low-confidence claims, index drift, and retrieval regressions.

Safe automatic repairs include re-crawling sources, re-chunking documents, regenerating embeddings, reindexing OpenSearch from SQLite truth, and flagging low-confidence claims. Risky repairs such as destructive cleanup or entity merges are proposed actions instead of silent changes.
`
  },
  {
    kind: "text",
    title: "API And Operator Console",
    tags: ["api", "ui", "operator"],
    content: `
# API And Operator Console

The API exposes POST /sources, POST /ingest-runs, GET /ingest-runs/:id, POST /query, GET /graph, POST /heal-runs, GET /heal-runs/:id, GET /stages, and GET /health.

The operator console shows source ingestion, pipeline progress, query answers with citations and confidence, graph entities and relations, agent trace, and self-healing actions. OpenSearch credentials are never exposed in the browser because all OpenSearch access goes through the API.
`
  },
  {
    kind: "text",
    title: "Demo Flow",
    tags: ["demo", "eval"],
    content: `
# Demo Flow

The two minute demo should show a fresh source being ingested, stage progress updating, a natural-language question returning cited evidence, graph context appearing, self-healing detecting knowledge health issues, and a follow-up query still returning grounded answers.

The eval suite contains golden questions that check exact lookup, conceptual retrieval, graph facts, healing behavior, uncertainty handling, and endpoint coverage.
`
  },
  {
    kind: "text",
    title: "Unrelated Tax Policy Memo",
    tags: ["adversarial", "tax"],
    content:
      "The BEPS project by the OECD and G20 discusses tax base protection, inclusive frameworks, and cross-border policy coordination. This memo is unrelated to Comms Agent architecture."
  },
  {
    kind: "text",
    title: "Unrelated Hiring Brief",
    tags: ["adversarial", "hiring"],
    content:
      "A remote contractor role prefers Melbourne hours, shipping habits, and hands-on model experimentation. This hiring brief is unrelated to ingestion, retrieval, citations, and OpenSearch indexing."
  },
  {
    kind: "text",
    title: "Unrelated Product Notes",
    tags: ["adversarial", "product"],
    content:
      "The product team tracks onboarding prompts, theme preferences, billing plan labels, and launch messaging. These notes should not be cited for Comms Agent technical answers."
  },
  {
    kind: "text",
    title: "Unrelated Workflow YAML",
    tags: ["adversarial", "workflow"],
    content:
      ".github/workflows/generate_api.yml updates generated clients and release metadata. Workflow automation notes should not answer questions about the RAG architecture."
  }
];

export const GOLDEN_QUESTIONS: GoldenQuestion[] = [
  {
    id: "manual-scope",
    question: "What does the Comms Agent operating manual say the agent should do?",
    mode: "hybrid",
    minConfidence: 0.25,
    expectedTerms: ["ingests manuals", "structured knowledge base", "self-heals"]
  },
  {
    id: "publish-safety",
    question: "What should shared Comms Agent repos and demos avoid committing?",
    minConfidence: 0.25,
    expectedTerms: ["secrets", "placeholders", "API keys"]
  },
  {
    id: "operator-visibility",
    question: "What should the Comms Agent manual make visible to the operator?",
    minConfidence: 0.25,
    expectedTerms: ["pending work", "operator"]
  },
  {
    id: "opensearch-role",
    question: "What is OpenSearch used for in Comms Agent?",
    mode: "semantic",
    minConfidence: 0.25,
    expectedTerms: ["primary retrieval", "indexing backend"]
  },
  {
    id: "retrieval-methods",
    question: "Which retrieval methods does OpenSearch support here?",
    minConfidence: 0.25,
    expectedTerms: ["BM25", "k-NN", "hybrid retrieval"]
  },
  {
    id: "fusion",
    question: "How does the TypeScript retrieval layer combine keyword and vector results?",
    minConfidence: 0.25,
    expectedTerms: ["reciprocal rank fusion"]
  },
  {
    id: "planner-modes",
    question: "Which retrieval modes can the TypeScript planner choose?",
    mode: "agentic",
    minConfidence: 0.25,
    expectedTerms: ["keyword", "semantic", "hybrid", "graph", "agentic"]
  },
  {
    id: "source-types",
    question: "What source types can Comms Agent ingest?",
    minConfidence: 0.25,
    expectedTerms: ["URL", "local files", "pasted text", "GitHub repositories"]
  },
  {
    id: "ingest-stages",
    question: "What are the stages of the ingest pipeline?",
    minConfidence: 0.25,
    expectedTerms: ["queued", "fetched", "parsed", "chunked", "embedded", "verified"]
  },
  {
    id: "provenance",
    question: "What provenance does every chunk preserve?",
    minConfidence: 0.25,
    expectedTerms: ["source URI", "document ID", "chunk ID", "content hash"]
  },
  {
    id: "failed-ingest",
    question: "What happens when ingest jobs fail?",
    minConfidence: 0.25,
    expectedTerms: ["actionable errors", "retried"]
  },
  {
    id: "kb-records",
    question: "What record types are stored in the structured knowledge base?",
    minConfidence: 0.25,
    expectedTerms: ["chunks", "entities", "relations", "claims"]
  },
  {
    id: "entity-fields",
    question: "What fields do entities include?",
    minConfidence: 0.25,
    expectedTerms: ["aliases", "type", "confidence", "evidence chunk IDs"]
  },
  {
    id: "relation-shape",
    question: "How are relations represented?",
    minConfidence: 0.25,
    expectedTerms: ["subject-predicate-object", "confidence", "evidence"]
  },
  {
    id: "sqlite-role",
    question: "What is SQLite responsible for?",
    minConfidence: 0.25,
    expectedTerms: ["canonical", "metadata store", "healing runs", "eval results"]
  },
  {
    id: "index-names",
    question: "What OpenSearch indices does the system use?",
    minConfidence: 0.25,
    expectedTerms: ["kb_chunks_v1", "kb_entities_v1", "kb_relations_v1", "kb_events_v1"]
  },
  {
    id: "agent-loop",
    question: "What workflow does Comms Agent follow?",
    mode: "agentic",
    minConfidence: 0.25,
    expectedTerms: ["plan", "execute", "reflect"]
  },
  {
    id: "agent-tools",
    question: "What tools can the agent executor run?",
    mode: "agentic",
    minConfidence: 0.25,
    expectedTerms: ["searchChunks", "lookupEntity", "expandGraph", "startHealRun"]
  },
  {
    id: "weak-evidence",
    question: "What does the agent do when evidence is weak?",
    mode: "agentic",
    minConfidence: 0.25,
    expectedTerms: ["retries", "different retrieval mode"]
  },
  {
    id: "trace",
    question: "Why does the UI show an agent trace?",
    minConfidence: 0.25,
    expectedTerms: ["inspect", "plan", "tool calls", "evidence"]
  },
  {
    id: "healing-audits",
    question: "What knowledge health issues does self-healing audit?",
    minConfidence: 0.25,
    expectedTerms: ["stale sources", "failed crawls", "duplicate entities", "retrieval regressions"]
  },
  {
    id: "safe-repairs",
    question: "Which self-healing repairs are safe and automatic?",
    minConfidence: 0.25,
    expectedTerms: ["re-crawling", "re-chunking", "regenerating embeddings", "reindexing OpenSearch"]
  },
  {
    id: "risky-repairs",
    question: "How does the system handle risky repairs?",
    minConfidence: 0.25,
    expectedTerms: ["proposed actions", "silent changes"]
  },
  {
    id: "api-surface",
    question: "Which API endpoints support query, graph, healing, stages, and health?",
    minConfidence: 0.25,
    expectedTerms: ["POST /query", "GET /graph", "POST /heal-runs", "GET /stages", "GET /health"]
  },
  {
    id: "browser-security",
    question: "Why are OpenSearch credentials not exposed in the browser?",
    minConfidence: 0.25,
    expectedTerms: ["API", "browser"]
  },
  {
    id: "demo-flow",
    question: "What should the two minute demo show?",
    mode: "hybrid",
    minConfidence: 0.25,
    expectedTerms: ["ingested", "cited evidence", "graph context", "self-healing"]
  },
  {
    id: "no-answer-deployment",
    question: "What Kubernetes deployment strategy is documented for the payroll service?",
    minConfidence: 0,
    expectedTerms: [],
    expectedSourceTitles: [],
    expectedStatus: "insufficient_evidence"
  }
];

export const EXPECTED_SOURCES_BY_QUESTION: Record<string, string[]> = {
  "manual-scope": ["Comms Agent Operating Manual"],
  "publish-safety": ["Comms Agent Operating Manual"],
  "operator-visibility": ["Comms Agent Operating Manual"],
  "opensearch-role": ["OpenSearch Retrieval Stack"],
  "retrieval-methods": ["OpenSearch Retrieval Stack"],
  fusion: ["OpenSearch Retrieval Stack"],
  "planner-modes": ["OpenSearch Retrieval Stack"],
  "source-types": ["Ingestion Pipeline"],
  "ingest-stages": ["Ingestion Pipeline"],
  provenance: ["Ingestion Pipeline"],
  "failed-ingest": ["Ingestion Pipeline"],
  "kb-records": ["Structured Knowledge Base"],
  "entity-fields": ["Structured Knowledge Base"],
  "relation-shape": ["Structured Knowledge Base"],
  "sqlite-role": ["Structured Knowledge Base"],
  "index-names": ["OpenSearch Index Names"],
  "agent-loop": ["Agent Workflow"],
  "agent-tools": ["Agent Workflow"],
  "weak-evidence": ["Agent Workflow"],
  trace: ["Agent Workflow"],
  "healing-audits": ["Self Healing System"],
  "safe-repairs": ["Self Healing System"],
  "risky-repairs": ["Self Healing System"],
  "api-surface": ["API And Operator Console"],
  "browser-security": ["API And Operator Console"],
  "demo-flow": ["Demo Flow"],
  "no-answer-deployment": []
};

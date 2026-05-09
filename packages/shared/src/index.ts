export const KNOWLEDGE_INDICES = {
  chunks: "kb_chunks_current",
  entities: "kb_entities_current",
  relations: "kb_relations_current",
  events: "kb_events_current"
} as const;

export const KNOWLEDGE_INDEX_VERSIONS = {
  chunks: "kb_chunks_v2",
  entities: "kb_entities_v2",
  relations: "kb_relations_v2",
  events: "kb_events_v2"
} as const;

export const INGEST_STAGES = [
  "queued",
  "fetched",
  "parsed",
  "chunked",
  "embedded",
  "extracted",
  "indexed",
  "verified"
] as const;

export const STAGE_LABELS: Record<IngestStage, string> = {
  queued: "Queued",
  fetched: "Fetched",
  parsed: "Parsed",
  chunked: "Chunked",
  embedded: "Embedded",
  extracted: "Extracted",
  indexed: "Indexed",
  verified: "Verified"
};

export type SourceKind = "url" | "file" | "directory" | "text" | "github_repo";
export type IngestStage = (typeof INGEST_STAGES)[number];
export type JobStatus = "queued" | "running" | "completed" | "failed";
export type QueryMode = "keyword" | "semantic" | "hybrid" | "graph" | "agentic";
export type QueryStatus = "answered" | "insufficient_evidence";
export type HealScope = "source" | "document" | "index" | "graph" | "retrieval" | "all";
export type HealActionKind = "automatic" | "proposed";
export type ProviderStatus = "ok" | "degraded" | "disabled";
export type EmbeddingProviderName = "openai" | "local";
export type GenerationProviderName = "openai" | "local";
export type RerankerProviderName = "opensearch" | "local" | "disabled";
export type EmbeddingStatus = "pending" | "embedded" | "failed" | "unavailable";
export type IndexingStatus = "pending" | "indexed" | "failed" | "skipped";

export interface SourceInput {
  kind: SourceKind;
  uri?: string;
  content?: string;
  title?: string;
  tags?: string[];
  crawlDepth?: number;
}

export interface SourceRecord extends SourceInput {
  id: string;
  status: JobStatus | "ready";
  contentHash?: string;
  createdAt: string;
  updatedAt: string;
  lastIngestedAt?: string;
  error?: string;
}

export interface DocumentRecord {
  id: string;
  sourceId: string;
  uri?: string;
  title: string;
  text: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface KnowledgeChunk {
  id: string;
  sourceId: string;
  documentId: string;
  chunkIndex: number;
  title: string;
  text: string;
  embedding: number[];
  contentHash: string;
  uri?: string;
  tags: string[];
  createdAt: string;
  sectionHeading?: string;
  tokenCount?: number;
  startOffset?: number;
  endOffset?: number;
  metadata?: Record<string, unknown>;
  embeddingProvider?: EmbeddingProviderName;
  embeddingModel?: string;
  embeddingDimensions?: number;
  embeddingVersion?: string;
  embeddingStatus?: EmbeddingStatus;
  embeddingError?: string;
  indexedAt?: string;
  indexingStatus?: IndexingStatus;
}

export interface EntityRecord {
  id: string;
  name: string;
  normalizedName: string;
  type: string;
  aliases: string[];
  confidence: number;
  evidenceChunkIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RelationRecord {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  evidenceChunkIds: string[];
  createdAt: string;
}

export interface ClaimRecord {
  id: string;
  text: string;
  confidence: number;
  evidenceChunkIds: string[];
  createdAt: string;
}

export interface IngestRun {
  id: string;
  sourceId: string;
  status: JobStatus;
  stage: IngestStage;
  stageHistory: IngestRunStage[];
  error?: string;
  documents: number;
  chunks: number;
  entities: number;
  relations: number;
  claims: number;
  startedAt: string;
  completedAt?: string;
}

export interface IngestRunStage {
  stage: IngestStage;
  status: "completed" | "failed";
  message: string;
  at: string;
}

export interface QueryRequest {
  question: string;
  mode?: QueryMode;
  filters?: {
    tags?: string[];
    sourceIds?: string[];
  };
  topK?: number;
  debug?: boolean;
  strict?: boolean;
}

export interface Citation {
  chunkId: string;
  sourceId: string;
  documentId: string;
  title: string;
  uri?: string;
  excerpt: string;
  score: number;
  textSpan?: {
    start: number;
    end: number;
  };
}

export interface RetrievedChunk extends KnowledgeChunk {
  score: number;
  scoreBreakdown: {
    keyword?: number;
    lexical?: number;
    vector?: number;
    fused?: number;
    rerank?: number;
  };
  retrievalReason?: string;
}

export interface QueryTraceStep {
  name: string;
  detail: string;
  at: string;
}

export interface QueryPlannerOutput {
  intent: "lookup" | "summary" | "comparison" | "inventory" | "no_answer_check" | "unknown";
  rewrittenQueries: string[];
  requiredFilters: {
    tags?: string[];
    sourceIds?: string[];
  };
  expectedAnswerType: "short" | "list" | "summary" | "comparison" | "unknown";
  noAnswerRisk: "low" | "medium" | "high";
}

export interface AnswerClaim {
  id: string;
  text: string;
  citationChunkIds: string[];
  supported: boolean;
  confidence: number;
  verifierNote?: string;
}

export interface RetrievalCandidateDiagnostic {
  sourceId: string;
  documentId: string;
  chunkId: string;
  title: string;
  lexicalScore?: number;
  vectorScore?: number;
  fusedScore?: number;
  rerankScore?: number;
  selected: boolean;
  reason: string;
}

export interface RetrievalDiagnostics {
  planner: QueryPlannerOutput;
  candidatePoolSize: number;
  finalK: number;
  usedOpenSearch: boolean;
  usedLocalFallback: boolean;
  reranker: {
    status: ProviderStatus;
    provider: RerankerProviderName;
    model?: string;
    message: string;
  };
  candidates: RetrievalCandidateDiagnostic[];
}

export interface VerificationResult {
  status: "passed" | "failed" | "degraded";
  supportedClaimIds: string[];
  unsupportedClaimIds: string[];
  failures: Array<{
    claimId: string;
    reason: string;
  }>;
}

export interface SourceGap {
  id: string;
  reason: string;
  suggestedQuery: string;
  currentEvidence: string[];
  proposedAction: string;
}

export interface SourceCandidate {
  id: string;
  title: string;
  url: string;
  snippet: string;
  publisher?: string;
  whyRelevant: string;
  confidence: number;
}

export interface SourceGapRepair {
  question: string;
  reason: string;
  suggestedQuery: string;
  currentEvidence: string[];
  searchStatus: "completed" | "failed" | "no_candidates";
  searchedAt: string;
  candidates: SourceCandidate[];
  error?: string;
}

export interface QueryResponse {
  status: QueryStatus;
  answer: string;
  mode: QueryMode;
  confidence: number;
  claims: AnswerClaim[];
  citations: Citation[];
  retrieval: RetrievalDiagnostics;
  verification: VerificationResult;
  retrievedChunks: RetrievedChunk[];
  graphContext: {
    entities: EntityRecord[];
    relations: RelationRecord[];
  };
  trace: QueryTraceStep[];
  sourceGaps?: SourceGap[];
}

export interface QueryRunRecord {
  id: string;
  question: string;
  status: QueryStatus;
  confidence: number;
  response: QueryResponse;
  createdAt: string;
}

export interface HealFinding {
  id: string;
  type:
    | "stale_source"
    | "failed_ingest"
    | "orphan_chunk"
    | "broken_citation"
    | "duplicate_entity"
    | "low_confidence_claim"
    | "index_drift"
    | "retrieval_regression"
    | "source_gap";
  severity: "info" | "warning" | "critical";
  message: string;
  targetId?: string;
}

export interface HealAction {
  id: string;
  kind: HealActionKind;
  label: string;
  status: "completed" | "pending" | "failed";
  targetId?: string;
  detail: string;
  sourceGapRepair?: SourceGapRepair;
}

export interface HealRun {
  id: string;
  scope: HealScope;
  status: JobStatus;
  findings: HealFinding[];
  actions: HealAction[];
  startedAt: string;
  completedAt?: string;
}

export interface GraphResponse {
  entities: EntityRecord[];
  relations: RelationRecord[];
}

export interface StageStatus {
  stage: IngestStage;
  label: string;
  completed: number;
  failed: number;
  pending: number;
}

export interface SystemHealth {
  api: "ok";
  opensearch: "ok" | "degraded";
  database: "ok" | "degraded";
  modelProvider: "local" | "external";
  embeddingProvider: {
    provider: EmbeddingProviderName;
    status: ProviderStatus;
    model: string;
    dimensions: number;
    message: string;
  };
  generationProvider: {
    provider: GenerationProviderName;
    status: ProviderStatus;
    model: string;
    message: string;
  };
  reranker: {
    provider: RerankerProviderName;
    status: ProviderStatus;
    model?: string;
    message: string;
  };
  indexVersion: string;
  staleChunks: number;
  unembeddedChunks: number;
  pendingJobs: number;
  failedJobs: number;
  indexedChunks: number;
  message: string;
}

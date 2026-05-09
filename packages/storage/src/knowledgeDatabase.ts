import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type {
  ClaimRecord,
  DocumentRecord,
  EntityRecord,
  GraphResponse,
  HealRun,
  IngestRun,
  KnowledgeChunk,
  QueryRunRecord,
  QueryResponse,
  RelationRecord,
  SourceRecord,
  StageStatus
} from "@comms-agent/shared";
import { INGEST_STAGES, STAGE_LABELS } from "@comms-agent/shared";

interface SqliteStatement {
  run: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
}

interface SqliteDatabase {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

export class KnowledgeDatabase {
  private readonly db: SqliteDatabase;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.initialize();
  }

  close(): void {
    this.db.close();
  }

  upsertSource(source: SourceRecord): SourceRecord {
    this.db
      .prepare(
        `insert into sources (
          id, kind, uri, content, title, tags, crawl_depth, status, content_hash,
          created_at, updated_at, last_ingested_at, error
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          kind = excluded.kind,
          uri = excluded.uri,
          content = excluded.content,
          title = excluded.title,
          tags = excluded.tags,
          crawl_depth = excluded.crawl_depth,
          status = excluded.status,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at,
          last_ingested_at = excluded.last_ingested_at,
          error = excluded.error`
      )
      .run(
        source.id,
        source.kind,
        source.uri ?? null,
        source.content ?? null,
        source.title ?? null,
        json(source.tags ?? []),
        source.crawlDepth ?? null,
        source.status,
        source.contentHash ?? null,
        source.createdAt,
        source.updatedAt,
        source.lastIngestedAt ?? null,
        source.error ?? null
      );
    return source;
  }

  getSource(id: string): SourceRecord | undefined {
    const row = this.db.prepare("select * from sources where id = ?").get(id);
    return row ? mapSource(row) : undefined;
  }

  listSources(): SourceRecord[] {
    return this.db
      .prepare("select * from sources order by updated_at desc")
      .all()
      .map((row) => mapSource(row));
  }

  saveDocument(document: DocumentRecord): void {
    this.db
      .prepare(
        `insert into documents (
          id, source_id, uri, title, text, content_hash, metadata, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          uri = excluded.uri,
          title = excluded.title,
          text = excluded.text,
          content_hash = excluded.content_hash,
          metadata = excluded.metadata`
      )
      .run(
        document.id,
        document.sourceId,
        document.uri ?? null,
        document.title,
        document.text,
        document.contentHash,
        json(document.metadata),
        document.createdAt
      );
  }

  saveChunks(chunks: KnowledgeChunk[]): void {
    const statement = this.db.prepare(
      `insert into chunks (
        id, source_id, document_id, chunk_index, title, text, embedding,
        content_hash, uri, tags, created_at, section_heading, token_count,
        start_offset, end_offset, metadata, embedding_provider, embedding_model,
        embedding_dimensions, embedding_version, embedding_status, embedding_error,
        indexed_at, indexing_status
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        title = excluded.title,
        text = excluded.text,
        embedding = excluded.embedding,
        content_hash = excluded.content_hash,
        uri = excluded.uri,
        tags = excluded.tags,
        section_heading = excluded.section_heading,
        token_count = excluded.token_count,
        start_offset = excluded.start_offset,
        end_offset = excluded.end_offset,
        metadata = excluded.metadata,
        embedding_provider = excluded.embedding_provider,
        embedding_model = excluded.embedding_model,
        embedding_dimensions = excluded.embedding_dimensions,
        embedding_version = excluded.embedding_version,
        embedding_status = excluded.embedding_status,
        embedding_error = excluded.embedding_error,
        indexed_at = excluded.indexed_at,
        indexing_status = excluded.indexing_status`
    );
    for (const chunk of chunks) {
      statement.run(
        chunk.id,
        chunk.sourceId,
        chunk.documentId,
        chunk.chunkIndex,
        chunk.title,
        chunk.text,
        json(chunk.embedding),
        chunk.contentHash,
        chunk.uri ?? null,
        json(chunk.tags),
        chunk.createdAt,
        chunk.sectionHeading ?? null,
        chunk.tokenCount ?? null,
        chunk.startOffset ?? null,
        chunk.endOffset ?? null,
        json(chunk.metadata ?? {}),
        chunk.embeddingProvider ?? null,
        chunk.embeddingModel ?? null,
        chunk.embeddingDimensions ?? null,
        chunk.embeddingVersion ?? null,
        chunk.embeddingStatus ?? "pending",
        chunk.embeddingError ?? null,
        chunk.indexedAt ?? null,
        chunk.indexingStatus ?? "pending"
      );
    }
  }

  deleteDocumentsAndChunksForSource(sourceId: string): { documents: number; chunks: number } {
    const documentCount = this.db
      .prepare("select count(*) as count from documents where source_id = ?")
      .get(sourceId) as { count: number };
    const chunkCount = this.db
      .prepare("select count(*) as count from chunks where source_id = ?")
      .get(sourceId) as { count: number };

    this.db.prepare("delete from chunks where source_id = ?").run(sourceId);
    this.db.prepare("delete from documents where source_id = ?").run(sourceId);
    this.db.prepare("delete from embedding_jobs where source_id = ?").run(sourceId);

    return {
      documents: documentCount.count,
      chunks: chunkCount.count
    };
  }

  saveEntities(entities: EntityRecord[]): void {
    const statement = this.db.prepare(
      `insert into entities (
        id, name, normalized_name, type, aliases, confidence, evidence_chunk_ids, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        name = excluded.name,
        type = excluded.type,
        aliases = excluded.aliases,
        confidence = max(entities.confidence, excluded.confidence),
        evidence_chunk_ids = excluded.evidence_chunk_ids,
        updated_at = excluded.updated_at`
    );
    for (const entity of entities) {
      statement.run(
        entity.id,
        entity.name,
        entity.normalizedName,
        entity.type,
        json(entity.aliases),
        entity.confidence,
        json(entity.evidenceChunkIds),
        entity.createdAt,
        entity.updatedAt
      );
    }
  }

  saveRelations(relations: RelationRecord[]): void {
    const statement = this.db.prepare(
      `insert into relations (
        id, subject, predicate, object, confidence, evidence_chunk_ids, created_at
      ) values (?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        confidence = excluded.confidence,
        evidence_chunk_ids = excluded.evidence_chunk_ids`
    );
    for (const relation of relations) {
      statement.run(
        relation.id,
        relation.subject,
        relation.predicate,
        relation.object,
        relation.confidence,
        json(relation.evidenceChunkIds),
        relation.createdAt
      );
    }
  }

  saveClaims(claims: ClaimRecord[]): void {
    const statement = this.db.prepare(
      `insert into claims (
        id, text, confidence, evidence_chunk_ids, created_at
      ) values (?, ?, ?, ?, ?)
      on conflict(id) do update set
        text = excluded.text,
        confidence = excluded.confidence,
        evidence_chunk_ids = excluded.evidence_chunk_ids`
    );
    for (const claim of claims) {
      statement.run(claim.id, claim.text, claim.confidence, json(claim.evidenceChunkIds), claim.createdAt);
    }
  }

  createIngestRun(run: IngestRun): IngestRun {
    this.db
      .prepare(
        `insert into ingest_runs (
          id, source_id, status, stage, stage_history, error, documents, chunks,
          entities, relations, claims, started_at, completed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.id,
        run.sourceId,
        run.status,
        run.stage,
        json(run.stageHistory),
        run.error ?? null,
        run.documents,
        run.chunks,
        run.entities,
        run.relations,
        run.claims,
        run.startedAt,
        run.completedAt ?? null
      );
    return run;
  }

  updateIngestRun(run: IngestRun): IngestRun {
    this.db
      .prepare(
        `update ingest_runs set
          status = ?, stage = ?, stage_history = ?, error = ?, documents = ?, chunks = ?,
          entities = ?, relations = ?, claims = ?, completed_at = ?
        where id = ?`
      )
      .run(
        run.status,
        run.stage,
        json(run.stageHistory),
        run.error ?? null,
        run.documents,
        run.chunks,
        run.entities,
        run.relations,
        run.claims,
        run.completedAt ?? null,
        run.id
      );
    return run;
  }

  getIngestRun(id: string): IngestRun | undefined {
    const row = this.db.prepare("select * from ingest_runs where id = ?").get(id);
    return row ? mapIngestRun(row) : undefined;
  }

  listIngestRuns(limit = 25): IngestRun[] {
    return this.db
      .prepare("select * from ingest_runs order by started_at desc limit ?")
      .all(limit)
      .map((row) => mapIngestRun(row));
  }

  listChunks(): KnowledgeChunk[] {
    return this.db
      .prepare("select * from chunks order by created_at desc")
      .all()
      .map((row) => mapChunk(row));
  }

  listChunksByIds(ids: string[]): KnowledgeChunk[] {
    if (ids.length === 0) {
      return [];
    }
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .prepare(`select * from chunks where id in (${placeholders})`)
      .all(...ids)
      .map((row) => mapChunk(row));
  }

  createEmbeddingJobs(chunks: KnowledgeChunk[]): void {
    const statement = this.db.prepare(
      `insert into embedding_jobs (
        id, source_id, document_id, chunk_id, provider, model, dimensions, status,
        error, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        provider = excluded.provider,
        model = excluded.model,
        dimensions = excluded.dimensions,
        status = excluded.status,
        error = excluded.error,
        updated_at = excluded.updated_at`
    );
    const now = new Date().toISOString();
    for (const chunk of chunks) {
      statement.run(
        `embed_${chunk.id}`,
        chunk.sourceId,
        chunk.documentId,
        chunk.id,
        chunk.embeddingProvider ?? null,
        chunk.embeddingModel ?? null,
        chunk.embeddingDimensions ?? null,
        chunk.embeddingStatus === "embedded" ? "completed" : "queued",
        chunk.embeddingError ?? null,
        now,
        now
      );
    }
  }

  markChunksIndexed(chunkIds: string[]): void {
    if (chunkIds.length === 0) {
      return;
    }
    const statement = this.db.prepare(
      "update chunks set indexed_at = ?, indexing_status = 'indexed' where id = ?"
    );
    const now = new Date().toISOString();
    for (const chunkId of chunkIds) {
      statement.run(now, chunkId);
    }
  }

  saveQueryRun(input: { id: string; question: string; response: QueryResponse; createdAt: string }): void {
    this.db
      .prepare(
        `insert into query_runs (
          id, question, status, confidence, response, created_at
        ) values (?, ?, ?, ?, ?, ?)`
      )
      .run(input.id, input.question, input.response.status, input.response.confidence, json(input.response), input.createdAt);

    const claimStatement = this.db.prepare(
      `insert into answer_claims (
        id, query_run_id, text, citation_chunk_ids, supported, confidence, verifier_note, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        text = excluded.text,
        citation_chunk_ids = excluded.citation_chunk_ids,
        supported = excluded.supported,
        confidence = excluded.confidence,
        verifier_note = excluded.verifier_note`
    );
    for (const claim of input.response.claims) {
      claimStatement.run(
        claim.id,
        input.id,
        claim.text,
        json(claim.citationChunkIds),
        claim.supported ? 1 : 0,
        claim.confidence,
        claim.verifierNote ?? null,
        input.createdAt
      );
    }
  }

  listQueryRuns(limit = 20): QueryRunRecord[] {
    return this.db
      .prepare("select * from query_runs order by created_at desc limit ?")
      .all(limit)
      .map((row) => mapQueryRun(row));
  }

  graphForChunkIds(chunkIds: string[]): GraphResponse {
    if (chunkIds.length === 0) {
      return { entities: [], relations: [] };
    }
    const entities = this.listEntities().filter((entity) =>
      entity.evidenceChunkIds.some((chunkId) => chunkIds.includes(chunkId))
    );
    const relations = this.listRelations().filter((relation) =>
      relation.evidenceChunkIds.some((chunkId) => chunkIds.includes(chunkId))
    );
    return { entities, relations };
  }

  listEntities(): EntityRecord[] {
    return this.db
      .prepare("select * from entities order by confidence desc, name asc")
      .all()
      .map((row) => mapEntity(row));
  }

  listRelations(): RelationRecord[] {
    return this.db
      .prepare("select * from relations order by confidence desc, subject asc")
      .all()
      .map((row) => mapRelation(row));
  }

  listClaims(): ClaimRecord[] {
    return this.db
      .prepare("select * from claims order by confidence asc, created_at desc")
      .all()
      .map((row) => mapClaim(row));
  }

  saveHealRun(run: HealRun): HealRun {
    this.db
      .prepare(
        `insert into heal_runs (
          id, scope, status, findings, actions, started_at, completed_at
        ) values (?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          status = excluded.status,
          findings = excluded.findings,
          actions = excluded.actions,
          completed_at = excluded.completed_at`
      )
      .run(
        run.id,
        run.scope,
        run.status,
        json(run.findings),
        json(run.actions),
        run.startedAt,
        run.completedAt ?? null
      );
    return run;
  }

  getHealRun(id: string): HealRun | undefined {
    const row = this.db.prepare("select * from heal_runs where id = ?").get(id);
    return row ? mapHealRun(row) : undefined;
  }

  listHealRuns(limit = 20): HealRun[] {
    return this.db
      .prepare("select * from heal_runs order by started_at desc limit ?")
      .all(limit)
      .map((row) => mapHealRun(row));
  }

  stageStatuses(): StageStatus[] {
    const runs = this.listIngestRuns(1000);
    return INGEST_STAGES.map((stage) => ({
      stage,
      label: STAGE_LABELS[stage],
      completed: runs.filter((run) => run.stageHistory.some((item) => item.stage === stage)).length,
      failed: runs.filter((run) => run.stage === stage && run.status === "failed").length,
      pending: runs.filter((run) => run.status === "queued" || run.status === "running").length
    }));
  }

  stats(): { pendingJobs: number; failedJobs: number; indexedChunks: number } {
    const pending = this.db
      .prepare("select count(*) as count from ingest_runs where status in ('queued', 'running')")
      .get() as { count: number };
    const failed = this.db
      .prepare("select count(*) as count from ingest_runs where status = 'failed'")
      .get() as { count: number };
    const chunks = this.db.prepare("select count(*) as count from chunks").get() as { count: number };
    return {
      pendingJobs: pending.count,
      failedJobs: failed.count,
      indexedChunks: chunks.count
    };
  }

  ragStats(): { staleChunks: number; unembeddedChunks: number } {
    const stale = this.db
      .prepare("select count(*) as count from chunks where indexing_status is null or indexing_status != 'indexed'")
      .get() as { count: number };
    const unembedded = this.db
      .prepare("select count(*) as count from chunks where embedding_status is null or embedding_status != 'embedded'")
      .get() as { count: number };
    return {
      staleChunks: stale.count,
      unembeddedChunks: unembedded.count
    };
  }

  private initialize(): void {
    this.db.exec(`
      pragma journal_mode = WAL;

      create table if not exists sources (
        id text primary key,
        kind text not null,
        uri text,
        content text,
        title text,
        tags text not null,
        crawl_depth integer,
        status text not null,
        content_hash text,
        created_at text not null,
        updated_at text not null,
        last_ingested_at text,
        error text
      );

      create table if not exists documents (
        id text primary key,
        source_id text not null,
        uri text,
        title text not null,
        text text not null,
        content_hash text not null,
        metadata text not null,
        created_at text not null
      );

      create table if not exists chunks (
        id text primary key,
        source_id text not null,
        document_id text not null,
        chunk_index integer not null,
        title text not null,
        text text not null,
        embedding text not null,
        content_hash text not null,
        uri text,
        tags text not null,
        created_at text not null,
        section_heading text,
        token_count integer,
        start_offset integer,
        end_offset integer,
        metadata text not null default '{}',
        embedding_provider text,
        embedding_model text,
        embedding_dimensions integer,
        embedding_version text,
        embedding_status text not null default 'pending',
        embedding_error text,
        indexed_at text,
        indexing_status text not null default 'pending'
      );

      create table if not exists embedding_jobs (
        id text primary key,
        source_id text not null,
        document_id text not null,
        chunk_id text not null,
        provider text,
        model text,
        dimensions integer,
        status text not null,
        error text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists entities (
        id text primary key,
        name text not null,
        normalized_name text not null,
        type text not null,
        aliases text not null,
        confidence real not null,
        evidence_chunk_ids text not null,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists relations (
        id text primary key,
        subject text not null,
        predicate text not null,
        object text not null,
        confidence real not null,
        evidence_chunk_ids text not null,
        created_at text not null
      );

      create table if not exists claims (
        id text primary key,
        text text not null,
        confidence real not null,
        evidence_chunk_ids text not null,
        created_at text not null
      );

      create table if not exists ingest_runs (
        id text primary key,
        source_id text not null,
        status text not null,
        stage text not null,
        stage_history text not null,
        error text,
        documents integer not null,
        chunks integer not null,
        entities integer not null,
        relations integer not null,
        claims integer not null,
        started_at text not null,
        completed_at text
      );

      create table if not exists heal_runs (
        id text primary key,
        scope text not null,
        status text not null,
        findings text not null,
        actions text not null,
        started_at text not null,
        completed_at text
      );

      create table if not exists query_runs (
        id text primary key,
        question text not null,
        status text not null,
        confidence real not null,
        response text not null,
        created_at text not null
      );

      create table if not exists retrieval_runs (
        id text primary key,
        query_run_id text not null,
        planner text not null,
        diagnostics text not null,
        created_at text not null
      );

      create table if not exists answer_claims (
        id text primary key,
        query_run_id text not null,
        text text not null,
        citation_chunk_ids text not null,
        supported integer not null,
        confidence real not null,
        verifier_note text,
        created_at text not null
      );

      create table if not exists eval_runs (
        id text primary key,
        report text not null,
        created_at text not null
      );
    `);
    this.ensureColumn("chunks", "section_heading", "text");
    this.ensureColumn("chunks", "token_count", "integer");
    this.ensureColumn("chunks", "start_offset", "integer");
    this.ensureColumn("chunks", "end_offset", "integer");
    this.ensureColumn("chunks", "metadata", "text not null default '{}'");
    this.ensureColumn("chunks", "embedding_provider", "text");
    this.ensureColumn("chunks", "embedding_model", "text");
    this.ensureColumn("chunks", "embedding_dimensions", "integer");
    this.ensureColumn("chunks", "embedding_version", "text");
    this.ensureColumn("chunks", "embedding_status", "text not null default 'pending'");
    this.ensureColumn("chunks", "embedding_error", "text");
    this.ensureColumn("chunks", "indexed_at", "text");
    this.ensureColumn("chunks", "indexing_status", "text not null default 'pending'");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((item) => item.name === column)) {
      return;
    }
    this.db.exec(`alter table ${table} add column ${column} ${definition}`);
  }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapSource(row: any): SourceRecord {
  return {
    id: row.id,
    kind: row.kind,
    uri: row.uri ?? undefined,
    content: row.content ?? undefined,
    title: row.title ?? undefined,
    tags: parseJson<string[]>(row.tags, []),
    crawlDepth: row.crawl_depth ?? undefined,
    status: row.status,
    contentHash: row.content_hash ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastIngestedAt: row.last_ingested_at ?? undefined,
    error: row.error ?? undefined
  };
}

function mapChunk(row: any): KnowledgeChunk {
  return {
    id: row.id,
    sourceId: row.source_id,
    documentId: row.document_id,
    chunkIndex: row.chunk_index,
    title: row.title,
    text: row.text,
    embedding: parseJson<number[]>(row.embedding, []),
    contentHash: row.content_hash,
    uri: row.uri ?? undefined,
    tags: parseJson<string[]>(row.tags, []),
    createdAt: row.created_at,
    sectionHeading: row.section_heading ?? undefined,
    tokenCount: row.token_count ?? undefined,
    startOffset: row.start_offset ?? undefined,
    endOffset: row.end_offset ?? undefined,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    embeddingProvider: row.embedding_provider ?? undefined,
    embeddingModel: row.embedding_model ?? undefined,
    embeddingDimensions: row.embedding_dimensions ?? undefined,
    embeddingVersion: row.embedding_version ?? undefined,
    embeddingStatus: row.embedding_status ?? undefined,
    embeddingError: row.embedding_error ?? undefined,
    indexedAt: row.indexed_at ?? undefined,
    indexingStatus: row.indexing_status ?? undefined
  };
}

function mapEntity(row: any): EntityRecord {
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    type: row.type,
    aliases: parseJson<string[]>(row.aliases, []),
    confidence: row.confidence,
    evidenceChunkIds: parseJson<string[]>(row.evidence_chunk_ids, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapRelation(row: any): RelationRecord {
  return {
    id: row.id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    confidence: row.confidence,
    evidenceChunkIds: parseJson<string[]>(row.evidence_chunk_ids, []),
    createdAt: row.created_at
  };
}

function mapClaim(row: any): ClaimRecord {
  return {
    id: row.id,
    text: row.text,
    confidence: row.confidence,
    evidenceChunkIds: parseJson<string[]>(row.evidence_chunk_ids, []),
    createdAt: row.created_at
  };
}

function mapIngestRun(row: any): IngestRun {
  return {
    id: row.id,
    sourceId: row.source_id,
    status: row.status,
    stage: row.stage,
    stageHistory: parseJson(row.stage_history, []),
    error: row.error ?? undefined,
    documents: row.documents,
    chunks: row.chunks,
    entities: row.entities,
    relations: row.relations,
    claims: row.claims,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined
  };
}

function mapHealRun(row: any): HealRun {
  return {
    id: row.id,
    scope: row.scope,
    status: row.status,
    findings: parseJson(row.findings, []),
    actions: parseJson(row.actions, []),
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined
  };
}

function mapQueryRun(row: any): QueryRunRecord {
  return {
    id: row.id,
    question: row.question,
    status: row.status,
    confidence: row.confidence,
    response: parseJson<QueryResponse>(row.response, {} as QueryResponse),
    createdAt: row.created_at
  };
}

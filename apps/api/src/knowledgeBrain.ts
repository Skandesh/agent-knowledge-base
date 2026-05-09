import type {
  Citation,
  GraphResponse,
  HealAction,
  HealFinding,
  HealRun,
  HealScope,
  IngestRun,
  IngestStage,
  KnowledgeChunk,
  QueryPlannerOutput,
  QueryRequest,
  QueryResponse,
  RetrievalDiagnostics,
  RetrievedChunk,
  SourceCandidate,
  SourceGap,
  SourceGapRepair,
  SourceInput,
  SourceRecord,
  SystemHealth
} from "@comms-agent/shared";
import { INGEST_STAGES, KNOWLEDGE_INDEX_VERSIONS } from "@comms-agent/shared";
import {
  chunkDocument,
  embedChunks,
  extractKnowledge,
  excerpt,
  type EmbeddingProvider,
  LocalEmbeddingProvider,
  LocalGenerationProvider,
  modeFromPlanner,
  OpenAIEmbeddingProvider,
  OpenAIGenerationProvider,
  type ResearchSourceGapInput,
  type GenerationProvider,
  rankLocalChunks,
  sha256,
  stableId,
  contentTokens,
  isCorpusInventoryQuestion,
  synthesizeAnswer,
  synthesizeInventoryAnswer,
  verifyClaimsAgainstCitations
} from "@comms-agent/core";
import { KnowledgeDatabase } from "@comms-agent/storage";
import { OpenSearchKnowledgeIndex } from "@comms-agent/search";
import type { AppConfig } from "./config.js";
import { loadDocuments, normalizeSourceInput } from "./sourceLoader.js";

export class KnowledgeBrain {
  readonly db: KnowledgeDatabase;
  readonly search: OpenSearchKnowledgeIndex;
  readonly embeddingProvider: EmbeddingProvider;
  readonly generationProvider: GenerationProvider;

  constructor(private readonly config: AppConfig) {
    this.db = new KnowledgeDatabase(config.databasePath);
    this.embeddingProvider =
      config.embeddingProvider === "openai"
        ? new OpenAIEmbeddingProvider({
            apiKey: process.env.OPENAI_API_KEY,
            model: config.embeddingModel,
            dimensions: config.embeddingDimensions
          })
        : new LocalEmbeddingProvider();
    this.search = new OpenSearchKnowledgeIndex({
      ...config.opensearch,
      embeddingDimensions: this.embeddingProvider.dimensions
    });
    this.generationProvider =
      config.generationProvider === "openai"
        ? new OpenAIGenerationProvider({
            apiKey: process.env.OPENAI_API_KEY,
            model: config.generationModel
          })
        : new LocalGenerationProvider();
  }

  async createSource(input: SourceInput): Promise<SourceRecord> {
    const normalized = normalizeSourceInput(input);
    if (!normalized.content && !normalized.uri) {
      throw new Error("Source requires either content or uri");
    }
    const now = new Date().toISOString();
    const source: SourceRecord = {
      ...normalized,
      id: stableId("source", `${normalized.kind}:${normalized.uri ?? normalized.content ?? now}`),
      status: "queued",
      contentHash: normalized.content ? sha256(normalized.content) : undefined,
      createdAt: now,
      updatedAt: now
    };
    return this.db.upsertSource(source);
  }

  listSources(): SourceRecord[] {
    return this.db.listSources();
  }

  listIngestRuns(): IngestRun[] {
    return this.db.listIngestRuns();
  }

  getIngestRun(id: string): IngestRun | undefined {
    return this.db.getIngestRun(id);
  }

  async runIngest(input: { sourceId?: string; source?: SourceInput }): Promise<IngestRun> {
    if (!input.sourceId && !input.source) {
      throw new Error("Ingest requires sourceId or source");
    }
    const source = input.sourceId ? this.db.getSource(input.sourceId) : await this.createSource(input.source!);
    if (!source) {
      throw new Error("Source not found");
    }

    let run: IngestRun = {
      id: stableId("ingest", `${source.id}:${Date.now()}`),
      sourceId: source.id,
      status: "running",
      stage: "queued",
      stageHistory: [],
      documents: 0,
      chunks: 0,
      entities: 0,
      relations: 0,
      claims: 0,
      startedAt: new Date().toISOString()
    };
    this.db.createIngestRun(run);
    let resolvedSourceTitle = source.title;

    try {
      run = this.completeStage(run, "queued", "Ingest run accepted");
      const documents = await loadDocuments(source);
      if (documents.length === 0) {
        throw new Error("Source produced no readable documents");
      }
      resolvedSourceTitle = source.kind === "url" ? documents[0]?.title ?? source.title : source.title;
      run.documents = documents.length;
      run = this.completeStage(run, "fetched", `Loaded ${documents.length} document(s)`);
      run = this.completeStage(run, "parsed", "Normalized and deduplicated document text");

      const rawChunks = documents.flatMap((document) =>
        chunkDocument({
          documentId: document.id,
          source,
          title: document.title,
          text: document.text,
          uri: document.uri
        }, {
          embedLocally: false
        })
      );
      const chunksToEmbed = dedupeChunks(rawChunks);
      if (chunksToEmbed.length === 0) {
        throw new Error("Source produced no indexable chunks after parsing");
      }
      run.chunks = chunksToEmbed.length;
      this.db.deleteDocumentsAndChunksForSource(source.id);
      for (const document of documents) {
        this.db.saveDocument(document);
      }
      this.db.saveChunks(chunksToEmbed);
      this.db.createEmbeddingJobs(chunksToEmbed);
      run = this.completeStage(
        run,
        "chunked",
        `Created ${chunksToEmbed.length} token-aware provenance chunk(s)`
      );

      const embeddedChunks = await embedChunks(chunksToEmbed, this.embeddingProvider);
      this.db.saveChunks(embeddedChunks);
      this.db.createEmbeddingJobs(embeddedChunks);
      run = this.completeStage(
        run,
        "embedded",
        `Generated ${this.embeddingProvider.provider} embeddings with ${this.embeddingProvider.model}`
      );

      const extracted = extractKnowledge(embeddedChunks);
      run.entities = extracted.entities.length;
      run.relations = extracted.relations.length;
      run.claims = extracted.claims.length;
      this.db.saveEntities(extracted.entities);
      this.db.saveRelations(extracted.relations);
      this.db.saveClaims(extracted.claims);
      run = this.completeStage(
        run,
        "extracted",
        `Extracted ${run.entities} entities, ${run.relations} relations, ${run.claims} claims`
      );

      if ((await this.search.health()) === "ok") {
        await this.search.ensureIndices();
        await this.search.deleteChunksBySource(source.id);
        await this.search.indexChunks(embeddedChunks);
        await this.search.indexEntities(extracted.entities);
        await this.search.indexRelations(extracted.relations);
        this.db.markChunksIndexed(embeddedChunks.map((chunk) => chunk.id));
        run = this.completeStage(run, "indexed", "Indexed chunks, entities, and relations in OpenSearch");
      } else {
        run = this.completeStage(
          run,
          "indexed",
          "Stored locally; OpenSearch is degraded and can be reindexed by self-healing"
        );
      }

      run = this.completeStage(run, "verified", "Verified provenance and retrieval-ready records");
      run.status = "completed";
      run.completedAt = new Date().toISOString();
      this.db.updateIngestRun(run);
      this.db.upsertSource({
        ...source,
        title: resolvedSourceTitle,
        status: "ready",
        updatedAt: new Date().toISOString(),
        lastIngestedAt: new Date().toISOString(),
        error: undefined
      });
      return run;
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      run.completedAt = new Date().toISOString();
      run.stageHistory.push({
        stage: run.stage,
        status: "failed",
        message: run.error,
        at: new Date().toISOString()
      });
      this.db.updateIngestRun(run);
      this.db.upsertSource({
        ...source,
        status: "failed",
        updatedAt: new Date().toISOString(),
        error: run.error
      });
      return run;
    }
  }

  async query(request: QueryRequest): Promise<QueryResponse> {
    const topK = request.topK ?? 8;
    const strict = request.strict ?? true;
    const candidateChunks = filterChunks(this.db.listChunks(), request.filters);
    const generationHealth = await this.generationProvider.health();
    const planner = await this.planQuery(request.question, generationHealth.status);
    const mode = modeFromPlanner(planner, request.mode);
    const trace = [
      {
        name: "planner",
        detail: `Planned ${planner.intent} query as ${mode} retrieval with ${planner.noAnswerRisk} no-answer risk.`,
        at: new Date().toISOString()
      }
    ];

    if (this.generationProvider.provider === "openai" && generationHealth.status !== "ok") {
      const error = new Error(generationHealth.message) as Error & { statusCode?: number };
      error.statusCode = 503;
      throw error;
    }

    if (planner.intent === "inventory" || isCorpusInventoryQuestion(request.question)) {
      const representativeChunks = asRepresentativeRetrievedChunks(candidateChunks, topK);
      const sourceIds = new Set(candidateChunks.map((chunk) => chunk.sourceId));
      const sources = this.db.listSources().filter((source) => sourceIds.has(source.id));
      const graph = this.db.graphForChunkIds(representativeChunks.map((chunk) => chunk.id));
      trace.push(
        {
          name: "inspectCorpus",
          detail: `Summarized ${sources.length} source(s) and ${candidateChunks.length} indexed chunk(s) from metadata.`,
          at: new Date().toISOString()
        }
      );

      const inventoryEvidence =
        this.generationProvider.provider === "openai"
          ? [buildInventoryMetadataChunk(sources, candidateChunks.length, representativeChunks), ...representativeChunks]
          : representativeChunks;
      const retrieval = this.buildRetrievalDiagnostics({
        planner,
        retrieved: inventoryEvidence,
        candidatePoolSize: candidateChunks.length,
        usedOpenSearch: false,
        usedLocalFallback: false
      });

      const response =
        this.generationProvider.provider === "openai"
          ? await this.generateStrictResponse({
              question: buildInventoryQuestion(request.question),
              mode,
              retrieved: inventoryEvidence,
              graph,
              trace: [
                ...trace,
                {
                  name: "synthesize",
                  detail: "Generated an OpenAI strict inventory answer from corpus metadata and representative evidence.",
                  at: new Date().toISOString()
                }
              ],
              retrieval,
              strict
            })
          : synthesizeInventoryAnswer({
              mode,
              sources,
              totalChunks: candidateChunks.length,
              retrievedChunks: representativeChunks,
              entities: graph.entities,
              relations: graph.relations,
              trace: [
                ...trace,
                {
                  name: "synthesize",
                  detail: "Answered as a corpus inventory request instead of synthesizing unrelated topical claims.",
                  at: new Date().toISOString()
                }
              ],
              retrieval
            });
      const responseWithGaps = withSourceGaps(response, request.question, inventoryEvidence);
      this.db.saveQueryRun({
        id: stableId("query", `${request.question}:${Date.now()}`),
        question: request.question,
        response: responseWithGaps,
        createdAt: new Date().toISOString()
      });
      return responseWithGaps;
    }

    const queryEmbedding = await this.embedQueryForRetrieval(request.question);
    let retrieved: RetrievedChunk[] = [];
    let usedOpenSearch = false;
    let usedLocalFallback = false;
    if ((await this.search.health()) === "ok") {
      try {
        retrieved = await this.search.search({
          question: request.question,
          mode,
          topK: Math.max(topK, 12),
          queryEmbedding,
          filters: request.filters
        });
        usedOpenSearch = true;
        trace.push({
          name: "searchChunks",
          detail: `OpenSearch returned ${retrieved.length} candidate chunk(s).`,
          at: new Date().toISOString()
        });
      } catch (error) {
        trace.push({
          name: "searchChunks",
          detail: `OpenSearch query failed; falling back locally: ${error instanceof Error ? error.message : error}`,
          at: new Date().toISOString()
        });
      }
    }

    if (retrieved.length === 0) {
      retrieved = rankLocalChunks(request.question, candidateChunks, mode, Math.max(topK, 12));
      usedLocalFallback = true;
      trace.push({
        name: "searchChunks",
        detail: `Local fallback returned ${retrieved.length} candidate chunk(s).`,
        at: new Date().toISOString()
      });
    } else {
      const augmentLimit = Math.max(topK, 12);
      const localAugment = rankLocalChunks(request.question, candidateChunks, mode, augmentLimit);
      retrieved = mergeRetrieved(retrieved, localAugment);
      trace.push({
        name: "searchChunks",
        detail: `Augmented OpenSearch results with ${localAugment.length} canonical local candidate(s).`,
        at: new Date().toISOString()
      });
    }
    const repairAugment = this.approvedRepairEvidence(request.question, candidateChunks, Math.max(topK, 12));
    if (repairAugment.length > 0) {
      retrieved = mergeRetrieved(repairAugment, retrieved);
      trace.push({
        name: "sourceGapRepair",
        detail: `Boosted ${repairAugment.length} chunk(s) from approved self-heal source candidates for a similar unanswered query.`,
        at: new Date().toISOString()
      });
    }
    retrieved = this.rerankEvidence(request.question, retrieved).slice(0, Math.max(topK, 12));

    const graph = this.db.graphForChunkIds(retrieved.map((chunk) => chunk.id));
    trace.push({
      name: "expandGraph",
      detail: `Expanded evidence into ${graph.entities.length} entities and ${graph.relations.length} relations.`,
      at: new Date().toISOString()
    });

    if (mode === "agentic" && retrieved.length < 3) {
      const retry = rankLocalChunks(request.question, this.db.listChunks(), "hybrid", topK);
      retrieved = mergeRetrieved(retrieved, retry).slice(0, topK);
      trace.push({
        name: "reflector",
        detail: "Evidence was thin, so the agent retried with hybrid retrieval.",
        at: new Date().toISOString()
      });
    }

    const retrieval = this.buildRetrievalDiagnostics({
      planner,
      retrieved,
      candidatePoolSize: candidateChunks.length,
      usedOpenSearch,
      usedLocalFallback
    });
    trace.push({
      name: "synthesize",
      detail:
        this.generationProvider.provider === "openai"
          ? "Generated a structured strict answer from supplied evidence only."
          : "Generated a degraded local structured answer from supplied evidence only.",
      at: new Date().toISOString()
    });

    const response =
      this.generationProvider.provider === "openai"
        ? await this.generateStrictResponse({
            question: request.question,
            mode,
            retrieved,
            graph,
            trace,
            retrieval,
            strict
          })
        : synthesizeAnswer({
            question: request.question,
            mode,
            retrievedChunks: retrieved,
            entities: graph.entities,
            relations: graph.relations,
            trace,
            retrieval
          });
    const responseWithGaps = withSourceGaps(response, request.question, retrieved);
    this.db.saveQueryRun({
      id: stableId("query", `${request.question}:${Date.now()}`),
      question: request.question,
      response: responseWithGaps,
      createdAt: new Date().toISOString()
    });
    return responseWithGaps;
  }

  graph(): GraphResponse {
    return {
      entities: this.db.listEntities(),
      relations: this.db.listRelations()
    };
  }

  listHealRuns(): HealRun[] {
    return this.db.listHealRuns();
  }

  getHealRun(id: string): HealRun | undefined {
    return this.db.getHealRun(id);
  }

  async approveSourceCandidate(input: { actionId: string; candidateId: string }): Promise<IngestRun> {
    const healRun = this.db
      .listHealRuns(20)
      .find((candidateRun) => candidateRun.actions.some((action) => action.id === input.actionId));
    const action = healRun?.actions.find((candidateAction) => candidateAction.id === input.actionId);
    const candidate = action?.sourceGapRepair?.candidates.find((item) => item.id === input.candidateId);
    if (!healRun || !action || !candidate) {
      throw Object.assign(new Error("Source candidate not found"), { statusCode: 404 });
    }
    if (!isPublicHttpUrl(candidate.url)) {
      throw Object.assign(new Error("Only public HTTP(S) source candidates can be approved"), { statusCode: 400 });
    }

    const run = await this.runIngest({
      source: {
        kind: "url",
        uri: candidate.url,
        title: candidate.title,
        tags: ["self-heal", "source-gap"]
      }
    });

    const updatedAction: HealAction = {
      ...action,
      status: run.status === "completed" ? "completed" : "failed",
      detail:
        run.status === "completed"
          ? `Approved and ingested ${candidate.title}. Re-run the original question to verify the gap is closed.`
          : `Approved ${candidate.title}, but ingest failed at ${run.stage}: ${run.error ?? "unknown error"}`
    };
    this.db.saveHealRun({
      ...healRun,
      actions: healRun.actions.map((candidateAction) =>
        candidateAction.id === input.actionId ? updatedAction : candidateAction
      ),
      completedAt: new Date().toISOString()
    });
    return run;
  }

  async runHeal(scope: HealScope = "all"): Promise<HealRun> {
    const startedAt = new Date().toISOString();
    const findings: HealFinding[] = [];
    const actions: HealAction[] = [];
    const sources = this.db.listSources();
    const runs = this.db.listIngestRuns(200);
    const chunks = this.db.listChunks();
    const entities = this.db.listEntities();
    const relations = this.db.listRelations();
    const claims = this.db.listClaims();
    const queryRuns = this.db.listQueryRuns(20);
    const now = Date.now();
    const staleMs = this.config.staleSourceHours * 60 * 60 * 1000;
    const sourceById = new Map(sources.map((source) => [source.id, source]));

    if (this.config.staleSourceHours > 0) {
      const staleSources = sources
        .filter((source) => !source.lastIngestedAt || now - new Date(source.lastIngestedAt).getTime() > staleMs)
        .slice(0, 5);
      for (const source of staleSources) {
        findings.push({
          id: stableId("finding", `stale:${source.id}:${startedAt}`),
          type: "stale_source",
          severity: "warning",
          message: `${source.title ?? source.uri ?? source.id} is stale or has never been ingested.`,
          targetId: source.id
        });
        actions.push({
          id: stableId("action", `stale:${source.id}:${startedAt}`),
          kind: "automatic",
          label: "Queued source for freshness review",
          status: "completed",
          targetId: source.id,
          detail: "The source is marked for re-ingestion during the next ingest pass."
        });
      }
    }

    for (const failedRun of runs.filter((run) => run.status === "failed")) {
      const source = sourceById.get(failedRun.sourceId);
      if (isResolvedFailedIngest(failedRun, source)) {
        continue;
      }
      const sourceName = sourceLabel(source, failedRun.sourceId);
      findings.push({
        id: stableId("finding", `failed:${failedRun.id}`),
        type: "failed_ingest",
        severity: "critical",
        message: `Ingest run failed for ${sourceName} at ${failedRun.stage}: ${failedRun.error ?? "unknown error"}`,
        targetId: failedRun.id
      });
      actions.push({
        id: stableId("action", `retry:${failedRun.id}`),
        kind: "proposed",
        label: `Retry ingest: ${compactActionLabel(sourceName)}`,
        status: "pending",
        targetId: failedRun.sourceId,
        detail: `${sourceName}: retry is proposed because fetching external sources can be slow, empty, or rate-limited.`
      });
    }

    const chunkSourceIds = new Set(sources.map((source) => source.id));
    for (const chunk of chunks.filter((candidate) => !chunkSourceIds.has(candidate.sourceId))) {
      findings.push({
        id: stableId("finding", `orphan:${chunk.id}`),
        type: "orphan_chunk",
        severity: "warning",
        message: `Chunk ${chunk.id} points to a missing source.`,
        targetId: chunk.id
      });
      actions.push({
        id: stableId("action", `orphan:${chunk.id}`),
        kind: "proposed",
        label: "Remove orphan chunk",
        status: "pending",
        targetId: chunk.id,
        detail: "Deletion is destructive, so the agent proposes it instead of applying it silently."
      });
    }

    const duplicateGroups = groupBy(entities, (entity) => entity.normalizedName);
    for (const group of duplicateGroups.values()) {
      if (group.length < 2) {
        continue;
      }
      findings.push({
        id: stableId("finding", `duplicate:${group[0].normalizedName}`),
        type: "duplicate_entity",
        severity: "warning",
        message: `${group.length} entity records appear to describe ${group[0].name}.`,
        targetId: group[0].id
      });
      actions.push({
        id: stableId("action", `merge:${group[0].normalizedName}`),
        kind: "proposed",
        label: "Merge duplicate entities",
        status: "pending",
        targetId: group[0].id,
        detail: "Entity merge is proposed because aliases can change user-visible graph structure."
      });
    }

    for (const claim of claims.filter((candidate) => candidate.confidence < 0.55).slice(0, 10)) {
      findings.push({
        id: stableId("finding", `claim:${claim.id}`),
        type: "low_confidence_claim",
        severity: "info",
        message: `Claim confidence is low: ${claim.text.slice(0, 120)}`,
        targetId: claim.id
      });
      actions.push({
        id: stableId("action", `claim:${claim.id}`),
        kind: "automatic",
        label: "Flagged low-confidence claim",
        status: "completed",
        targetId: claim.id,
        detail: "The claim will be deprioritized during answer synthesis until reinforced by more evidence."
      });
    }

    const latestQueryStatusByQuestion = new Map<string, QueryResponse["status"]>();
    for (const queryRun of queryRuns) {
      const normalizedQuestion = normalizeQuestionKey(queryRun.question);
      if (!latestQueryStatusByQuestion.has(normalizedQuestion)) {
        latestQueryStatusByQuestion.set(normalizedQuestion, queryRun.status);
      }
    }

    const seenGapQuestions = new Set<string>();
    for (const queryRun of queryRuns.filter((candidate) => candidate.response.sourceGaps?.length)) {
      const normalizedQuestion = normalizeQuestionKey(queryRun.question);
      if (seenGapQuestions.has(normalizedQuestion)) {
        continue;
      }
      if (latestQueryStatusByQuestion.get(normalizedQuestion) === "answered") {
        continue;
      }
      seenGapQuestions.add(normalizedQuestion);
      const [gap] = queryRun.response.sourceGaps ?? [];
      if (!gap) {
        continue;
      }
      findings.push({
        id: stableId("finding", `source-gap:${queryRun.id}:${gap.id}`),
        type: "source_gap",
        severity: "warning",
        message: `Unanswered query needs more source coverage: ${compactForSearch(gap.reason)}`,
        targetId: queryRun.id
      });
      const sourceGapRepair = await this.researchSourceGap({
        question: queryRun.question,
        reason: gap.reason,
        suggestedQuery: gap.suggestedQuery,
        currentEvidence: gap.currentEvidence,
        existingSources: sources.map((source) => ({
          title: source.title,
          uri: source.uri
        }))
      });
      actions.push({
        id: stableId("action", `source-gap:${queryRun.id}:${gap.id}`),
        kind: "proposed",
        label: "Add source for unanswered query",
        status: "pending",
        targetId: queryRun.id,
        detail: sourceGapActionDetail(gap, sourceGapRepair),
        sourceGapRepair
      });
      if (seenGapQuestions.size >= 3) {
        break;
      }
    }

    if ((await this.search.health()) === "ok") {
      await this.search.reindexAll(chunks, entities, relations);
      actions.push({
        id: stableId("action", `reindex:${startedAt}`),
        kind: "automatic",
        label: "Reindexed OpenSearch from SQLite truth",
        status: "completed",
        detail: `Reindexed ${chunks.length} chunks, ${entities.length} entities, and ${relations.length} relations.`
      });
    } else {
      const fallbackActive = chunks.length > 0;
      findings.push({
        id: stableId("finding", `index-drift:${startedAt}`),
        type: "index_drift",
        severity: fallbackActive ? "warning" : "critical",
        message: fallbackActive
          ? `OpenSearch is unavailable, but local SQLite retrieval fallback is active across ${chunks.length} indexed chunk(s). Reindex when OpenSearch returns.`
          : "OpenSearch is unavailable and there are no local chunks available for fallback retrieval."
      });
      actions.push({
        id: stableId("action", `index-drift:${startedAt}`),
        kind: "automatic",
        label: "Kept local retrieval fallback active",
        status: fallbackActive ? "completed" : "failed",
        detail: fallbackActive
          ? "No data was lost; SQLite remains the source of truth and local retrieval is serving queries until OpenSearch can be reindexed."
          : "No local fallback corpus is available; ingest at least one source or restore OpenSearch before relying on query answers."
      });
    }

    findings.sort(compareHealFindings);
    actions.sort(compareHealActions);

    const run: HealRun = {
      id: stableId("heal", `${scope}:${startedAt}`),
      scope,
      status: "completed",
      findings,
      actions,
      startedAt,
      completedAt: new Date().toISOString()
    };
    return this.db.saveHealRun(run);
  }

  async health(): Promise<SystemHealth> {
    const stats = this.db.stats();
    const ragStats = this.db.ragStats();
    const sources = this.db.listSources();
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const unresolvedFailedJobs = this.db
      .listIngestRuns(200)
      .filter((run) => run.status === "failed" && !isResolvedFailedIngest(run, sourceById.get(run.sourceId))).length;
    const opensearch = await this.search.health();
    const [embeddingProvider, generationProvider] = await Promise.all([
      this.embeddingProvider.health(),
      this.generationProvider.health()
    ]);
    const reranker = this.rerankerHealth();
    const productionReady =
      opensearch === "ok" &&
      embeddingProvider.status === "ok" &&
      generationProvider.status === "ok" &&
      reranker.status === "ok" &&
      ragStats.unembeddedChunks === 0;
    return {
      api: "ok",
      opensearch,
      database: "ok",
      modelProvider: this.config.modelProvider,
      embeddingProvider,
      generationProvider,
      reranker,
      indexVersion: KNOWLEDGE_INDEX_VERSIONS.chunks,
      ...ragStats,
      ...stats,
      failedJobs: unresolvedFailedJobs,
      message:
        productionReady
          ? "Comms Agent is production-ready with OpenAI embeddings/generation, OpenSearch retrieval, and reranking."
          : opensearch !== "ok" && stats.indexedChunks > 0
            ? `Comms Agent is degraded, but local SQLite retrieval fallback is active across ${stats.indexedChunks} indexed chunk(s); restore OpenSearch and reranking for production readiness.`
          : "Comms Agent is degraded; inspect provider, reranker, and indexing health before trusting production answers."
    };
  }

  stages() {
    return this.db.stageStatuses();
  }

  private async planQuery(question: string, generationStatus: "ok" | "degraded" | "disabled"): Promise<QueryPlannerOutput> {
    if (isCorpusInventoryQuestion(question)) {
      return {
        intent: "inventory",
        rewrittenQueries: [question],
        requiredFilters: {},
        expectedAnswerType: "summary",
        noAnswerRisk: "low"
      };
    }
    if (this.generationProvider.provider === "openai" && generationStatus === "ok") {
      return this.generationProvider.planQuery(question);
    }
    return new LocalGenerationProvider().planQuery(question);
  }

  private async embedQueryForRetrieval(question: string): Promise<number[] | undefined> {
    const health = await this.embeddingProvider.health();
    if (this.embeddingProvider.provider === "openai" && health.status !== "ok") {
      return undefined;
    }
    const [result] = await this.embeddingProvider.embedTexts([question]);
    return result?.embedding;
  }

  private approvedRepairEvidence(question: string, candidateChunks: KnowledgeChunk[], limit: number): RetrievedChunk[] {
    const gap = this.recentSourceGapForQuestion(question);
    if (!gap) {
      return [];
    }
    const repairChunks = candidateChunks.filter((chunk) => chunk.tags.includes("source-gap"));
    if (repairChunks.length === 0) {
      return [];
    }
    const repairQuery = `${question}\n${gap.reason}\n${gap.suggestedQuery}`;
    return rankLocalChunks(repairQuery, repairChunks, "hybrid", limit).map((chunk, index) => {
      const boost = Math.max(0.2, 0.55 - index * 0.02);
      const fused = Number(((chunk.scoreBreakdown.fused ?? chunk.score) + boost).toFixed(4));
      return {
        ...chunk,
        score: Number((chunk.score + boost).toFixed(4)),
        scoreBreakdown: {
          ...chunk.scoreBreakdown,
          fused
        },
        retrievalReason:
          "Boosted because this source was approved from self-heal for a similar unanswered query."
      };
    });
  }

  private recentSourceGapForQuestion(question: string): SourceGap | undefined {
    for (const queryRun of this.db.listQueryRuns(20)) {
      if (!areSimilarQuestions(question, queryRun.question)) {
        continue;
      }
      const [gap] = queryRun.response.sourceGaps ?? [];
      if (gap) {
        return gap;
      }
    }
    return undefined;
  }

  private rerankEvidence(question: string, chunks: RetrievedChunk[]): RetrievedChunk[] {
    const queryTokens = [...new Set(contentTokens(question))];
    return chunks
      .map((chunk) => {
        const titleTokens = new Set(contentTokens(chunk.title));
        const textTokens = new Set(contentTokens(chunk.text));
        const titleOverlap = queryTokens.filter((token) => titleTokens.has(token)).length;
        const textOverlap = queryTokens.filter((token) => textTokens.has(token)).length;
        const coverage =
          queryTokens.length === 0
            ? 0
            : queryTokens.filter((token) => titleTokens.has(token) || textTokens.has(token)).length / queryTokens.length;
        const rawRerank = chunk.score + titleOverlap * 0.16 + textOverlap * 0.06 + coverage * 0.25;
        const rerank = Number(Math.min(0.99, rawRerank).toFixed(4));
        return {
          ...chunk,
          score: rerank,
          scoreBreakdown: {
            ...chunk.scoreBreakdown,
            rerank
          },
          retrievalReason: `${chunk.retrievalReason ?? "Selected by retrieval."} Reranked by configured app reranker.`
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  private buildRetrievalDiagnostics(input: {
    planner: QueryPlannerOutput;
    retrieved: RetrievedChunk[];
    candidatePoolSize: number;
    usedOpenSearch: boolean;
    usedLocalFallback: boolean;
  }): RetrievalDiagnostics {
    return {
      planner: input.planner,
      candidatePoolSize: input.candidatePoolSize,
      finalK: input.retrieved.length,
      usedOpenSearch: input.usedOpenSearch,
      usedLocalFallback: input.usedLocalFallback,
      reranker: this.rerankerHealth(),
      candidates: input.retrieved.map((chunk) => ({
        sourceId: chunk.sourceId,
        documentId: chunk.documentId,
        chunkId: chunk.id,
        title: chunk.title,
        lexicalScore: chunk.scoreBreakdown.keyword ?? chunk.scoreBreakdown.lexical,
        vectorScore: chunk.scoreBreakdown.vector,
        fusedScore: chunk.scoreBreakdown.fused ?? chunk.score,
        rerankScore: chunk.scoreBreakdown.rerank,
        selected: true,
        reason: chunk.retrievalReason ?? "Selected as final packed evidence."
      }))
    };
  }

  private async generateStrictResponse(input: {
    question: string;
    mode: QueryResponse["mode"];
    retrieved: RetrievedChunk[];
    graph: GraphResponse;
    trace: QueryResponse["trace"];
    retrieval: RetrievalDiagnostics;
    strict: boolean;
  }): Promise<QueryResponse> {
    const preliminaryCitations = citationsFromRetrieved(input.retrieved);
    const generated = await this.generationProvider.generateAnswer({
      question: input.question,
      evidence: input.retrieved,
      citations: preliminaryCitations,
      strict: input.strict
    });
    const citedChunkIds = new Set(generated.claims.flatMap((claim) => claim.citationChunkIds));
    const citations =
      citedChunkIds.size > 0
        ? preliminaryCitations.filter((citation) => citedChunkIds.has(citation.chunkId))
        : [];
    const verification = verifyClaimsAgainstCitations(generated.claims, citations);
    const confidence =
      generated.status === "answered" && verification.status !== "failed"
        ? generated.confidenceBreakdown.overall
        : Math.min(generated.confidenceBreakdown.overall, 0.2);

    return {
      status: generated.status === "answered" && verification.status !== "failed" ? "answered" : "insufficient_evidence",
      answer:
        generated.status === "answered" && verification.status !== "failed"
          ? generated.answer
          : generated.missingEvidenceReason ??
            "I do not have enough grounded evidence in the current knowledge base to answer that reliably.",
      mode: input.mode,
      confidence,
      claims: generated.claims,
      citations,
      retrieval: input.retrieval,
      verification,
      retrievedChunks: input.retrieved,
      graphContext: input.graph,
      trace: input.trace
    };
  }

  private async researchSourceGap(input: ResearchSourceGapInput): Promise<SourceGapRepair> {
    const searchedAt = new Date().toISOString();
    try {
      const candidates = (await this.generationProvider.researchSourceGap(input)).filter(
        (candidate) => isPublicHttpUrl(candidate.url) && !sourceAlreadyTracked(candidate, input.existingSources)
      );
      return {
        question: input.question,
        reason: input.reason,
        suggestedQuery: input.suggestedQuery,
        currentEvidence: input.currentEvidence,
        searchStatus: candidates.length > 0 ? "completed" : "no_candidates",
        searchedAt,
        candidates
      };
    } catch (error) {
      return {
        question: input.question,
        reason: input.reason,
        suggestedQuery: input.suggestedQuery,
        currentEvidence: input.currentEvidence,
        searchStatus: "failed",
        searchedAt,
        candidates: [],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private rerankerHealth(): SystemHealth["reranker"] {
    if (this.config.rerankerProvider === "disabled") {
      return {
        provider: "disabled",
        status: "disabled",
        message: "Reranking is disabled by configuration."
      };
    }
    if (this.config.rerankerProvider === "opensearch") {
      if (this.config.opensearch.rerankPipeline && this.config.opensearch.rerankModel) {
        return {
          provider: "opensearch",
          status: "ok",
          model: this.config.opensearch.rerankModel,
          message: `OpenSearch rerank pipeline ${this.config.opensearch.rerankPipeline} is configured.`
        };
      }
      return {
        provider: "opensearch",
        status: "degraded",
        message: "Configure OPENSEARCH_RERANK_PIPELINE and OPENSEARCH_RERANK_MODEL for production reranking."
      };
    }
    return {
      provider: "local",
      status: "degraded",
      model: "local-overlap-reranker",
      message: "Local reranking is enabled explicitly; production readiness requires OpenSearch reranking."
    };
  }

  private completeStage(run: IngestRun, stage: IngestStage, message: string): IngestRun {
    if (!INGEST_STAGES.includes(stage)) {
      throw new Error(`Invalid ingest stage: ${stage}`);
    }
    const updated: IngestRun = {
      ...run,
      stage,
      stageHistory: [
        ...run.stageHistory,
        {
          stage,
          status: "completed",
          message,
          at: new Date().toISOString()
        }
      ]
    };
    this.db.updateIngestRun(updated);
    return updated;
  }
}

function mergeRetrieved<T extends { id: string; score: number }>(primary: T[], secondary: T[]): T[] {
  const merged = new Map<string, T>();
  for (const item of [...primary, ...secondary]) {
    const existing = merged.get(item.id);
    if (!existing || item.score > existing.score) {
      merged.set(item.id, item);
    }
  }
  return [...merged.values()].sort((a, b) => b.score - a.score);
}

function asRepresentativeRetrievedChunks(chunks: KnowledgeChunk[], topK: number): RetrievedChunk[] {
  return chunks.slice(0, topK).map((chunk, index) => ({
    ...chunk,
    score: Number((1 / (index + 1)).toFixed(4)),
    scoreBreakdown: {
      keyword: 0,
      fused: Number((1 / (index + 1)).toFixed(4))
    }
  }));
}

function buildInventoryQuestion(question: string): string {
  return `${question}

Use the corpus inventory metadata chunk to answer what is currently indexed. If the supplied evidence does not contain change history, say that directly instead of implying recent changes.`;
}

function buildInventoryMetadataChunk(
  sources: SourceRecord[],
  totalChunks: number,
  representativeChunks: RetrievedChunk[]
): RetrievedChunk {
  const now = new Date().toISOString();
  const sourceKinds = countBy(sources.map((source) => source.kind));
  const sourceLines = sources
    .slice(0, 12)
    .map((source) => {
      const name = source.title ?? source.uri ?? source.id;
      const freshness = source.lastIngestedAt ? `last ingested ${source.lastIngestedAt}` : "not ingested yet";
      return `- ${name}: kind ${source.kind}, status ${source.status}, updated ${source.updatedAt}, ${freshness}`;
    })
    .join("\n");
  const chunkLines = representativeChunks
    .slice(0, 8)
    .map((chunk) => `- ${chunk.title}: ${excerpt(chunk.text, 180)}`)
    .join("\n");
  const text = [
    "Knowledge base inventory metadata.",
    `The knowledge base currently contains ${sources.length} source(s) and ${totalChunks} indexed chunk(s).`,
    `Source kinds: ${formatCounts(sourceKinds)}.`,
    sourceLines ? `Sources:\n${sourceLines}` : "Sources: none.",
    chunkLines ? `Representative indexed chunks:\n${chunkLines}` : "Representative indexed chunks: none.",
    "No historical change log is included in this metadata unless source update or ingest timestamps are listed above."
  ].join("\n\n");

  return {
    id: stableId("chunk", `inventory:${text}`),
    sourceId: "system_inventory",
    documentId: "system_inventory",
    chunkIndex: 0,
    title: "Knowledge Base Inventory",
    text,
    embedding: [],
    contentHash: stableId("content", text),
    tags: ["system", "inventory"],
    createdAt: now,
    tokenCount: text.split(/\s+/).filter(Boolean).length,
    score: 1,
    scoreBreakdown: {
      fused: 1
    },
    retrievalReason: "Selected as system corpus metadata for an inventory question."
  };
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function formatCounts(counts: Map<string, number>): string {
  if (counts.size === 0) {
    return "none";
  }
  return [...counts.entries()].map(([label, count]) => `${label} ${count}`).join(", ");
}

function withSourceGaps(response: QueryResponse, question: string, retrieved: RetrievedChunk[]): QueryResponse {
  if (response.status !== "insufficient_evidence" || response.sourceGaps?.length) {
    return response;
  }
  return {
    ...response,
    sourceGaps: [buildSourceGap(question, response.answer, retrieved)]
  };
}

function buildSourceGap(question: string, reason: string, retrieved: RetrievedChunk[]): SourceGap {
  const currentEvidence = uniqueTitles(retrieved).slice(0, 5);
  return {
    id: stableId("source_gap", `${question}:${reason}:${currentEvidence.join("|")}`),
    reason,
    suggestedQuery: `authoritative documentation for missing evidence: ${compactForSearch(reason)}`,
    currentEvidence,
    proposedAction:
      "Ingest a source that explicitly covers the missing facts, then re-run the query with strict citations."
  };
}

function sourceGapActionDetail(gap: SourceGap, repair: SourceGapRepair): string {
  if (repair.searchStatus === "completed") {
    return `${gap.proposedAction} Found ${repair.candidates.length} candidate source(s) for operator review.`;
  }
  if (repair.searchStatus === "no_candidates") {
    return `${gap.proposedAction} No candidate source was found automatically; try the suggested search manually: ${gap.suggestedQuery}`;
  }
  return `${gap.proposedAction} Source discovery failed: ${repair.error ?? "unknown error"}`;
}

function isResolvedFailedIngest(run: IngestRun, source: SourceRecord | undefined): boolean {
  if (!source || source.status !== "ready" || !source.lastIngestedAt || !run.completedAt) {
    return false;
  }
  return new Date(source.lastIngestedAt).getTime() > new Date(run.completedAt).getTime();
}

function sourceLabel(source: SourceRecord | undefined, fallback: string): string {
  return source?.title ?? source?.uri ?? fallback;
}

function compactActionLabel(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 54) {
    return normalized;
  }
  return `${normalized.slice(0, 51).replace(/\s+\S*$/, "").trim()}...`;
}

function sourceAlreadyTracked(candidate: SourceCandidate, sources: ResearchSourceGapInput["existingSources"]): boolean {
  const candidateUrl = normalizeComparableUrl(candidate.url);
  return sources.some((source) => source.uri && normalizeComparableUrl(source.uri) === candidateUrl);
}

function isPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }
    const hostname = url.hostname.toLowerCase();
    return (
      hostname !== "localhost" &&
      !hostname.endsWith(".local") &&
      !/^127\./.test(hostname) &&
      !/^10\./.test(hostname) &&
      !/^192\.168\./.test(hostname) &&
      !/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname) &&
      hostname !== "::1"
    );
  } catch {
    return false;
  }
}

function normalizeComparableUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return value.trim().replace(/\/$/, "").toLowerCase();
  }
}

function areSimilarQuestions(a: string, b: string): boolean {
  const left = normalizedQuestionTokens(a);
  const right = normalizedQuestionTokens(b);
  if (left.size === 0 || right.size === 0) {
    return false;
  }
  const intersection = [...left].filter((token) => right.has(token)).length;
  const smaller = Math.min(left.size, right.size);
  return intersection >= 3 && intersection / smaller >= 0.45;
}

function normalizeQuestionKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizedQuestionTokens(value: string): Set<string> {
  const stopwords = new Set([
    "about",
    "after",
    "again",
    "all",
    "and",
    "are",
    "can",
    "for",
    "from",
    "have",
    "how",
    "into",
    "like",
    "need",
    "once",
    "that",
    "the",
    "this",
    "what",
    "when",
    "which",
    "with",
    "you",
    "your"
  ]);
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2 && !stopwords.has(token))
  );
}

function uniqueTitles(chunks: RetrievedChunk[]): string[] {
  const titles = new Set<string>();
  for (const chunk of chunks) {
    titles.add(chunk.title);
  }
  return [...titles];
}

function compactForSearch(value: string): string {
  const normalized = value
    .replace(/\s+/g, " ")
    .replace(/["'`]/g, "")
    .trim();
  if (normalized.length <= 150) {
    return normalized;
  }
  return normalized
    .slice(0, 150)
    .replace(/\s+\S*$/, "")
    .replace(/\s+(and|or|nor)$/i, "")
    .trim();
}

function compareHealFindings(a: HealFinding, b: HealFinding): number {
  return healFindingPriority(a) - healFindingPriority(b);
}

function healFindingPriority(finding: HealFinding): number {
  if (finding.type === "source_gap") {
    return 0;
  }
  if (finding.severity === "critical") {
    return 1;
  }
  if (finding.severity === "warning") {
    return 2;
  }
  return 3;
}

function compareHealActions(a: HealAction, b: HealAction): number {
  return healActionPriority(a) - healActionPriority(b);
}

function healActionPriority(action: HealAction): number {
  if (action.label === "Add source for unanswered query") {
    return 0;
  }
  if (action.status === "pending") {
    return 1;
  }
  return 2;
}

function dedupeChunks(chunks: KnowledgeChunk[]): KnowledgeChunk[] {
  const seen = new Set<string>();
  const deduped: KnowledgeChunk[] = [];
  for (const chunk of chunks) {
    if (seen.has(chunk.contentHash)) {
      continue;
    }
    seen.add(chunk.contentHash);
    deduped.push({
      ...chunk,
      chunkIndex: deduped.length
    });
  }
  return deduped;
}

function citationsFromRetrieved(chunks: RetrievedChunk[]): Citation[] {
  return chunks.slice(0, 8).map((chunk) => ({
    chunkId: chunk.id,
    sourceId: chunk.sourceId,
    documentId: chunk.documentId,
    title: chunk.title,
    uri: chunk.uri,
    excerpt: excerpt(chunk.text, 320),
    score: Number(chunk.score.toFixed(4)),
    textSpan:
      chunk.startOffset !== undefined && chunk.endOffset !== undefined
        ? {
            start: chunk.startOffset,
            end: chunk.endOffset
          }
        : undefined
  }));
}

function filterChunks(chunks: KnowledgeChunk[], filters: QueryRequest["filters"]): KnowledgeChunk[] {
  if (!filters?.sourceIds?.length && !filters?.tags?.length) {
    return chunks;
  }
  return chunks.filter((chunk) => {
    const sourceMatch = !filters.sourceIds?.length || filters.sourceIds.includes(chunk.sourceId);
    const tagMatch = !filters.tags?.length || filters.tags.every((tag) => chunk.tags.includes(tag));
    return sourceMatch && tagMatch;
  });
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return grouped;
}

import type {
  AnswerClaim,
  Citation,
  EntityRecord,
  QueryMode,
  QueryPlannerOutput,
  QueryResponse,
  QueryTraceStep,
  RetrievalDiagnostics,
  RelationRecord,
  RetrievedChunk,
  SourceRecord
} from "@knowledge-brain/shared";
import {
  contentTokens,
  decodeHtmlEntities,
  excerpt,
  normalizeWhitespace,
  splitSentences,
  tokenize
} from "./text.js";

const MAX_CITATIONS = 5;
const MIN_GROUNDED_CONFIDENCE = 0.25;
const DATE_SIGNAL =
  /\b(?:(?:1[5-9]|20)\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
const DATE_QUESTION = /\b(when|date|year|timeline|chronolog|how old)\b/i;
const FIRST_QUESTION = /\b(first|earliest|initial|debut|begin|began|start|started)\b/i;
const ORDINAL_TOKENS = new Set(["first", "earliest", "initial", "debut", "last", "latest", "newest"]);
const ACTION_FOCUS_TOKENS = new Set(["begin", "create", "found", "launch", "perform", "start", "write", "wrote"]);
const QUERY_TOKEN_EXPANSIONS: Record<string, string[]> = {
  company: ["startup", "business", "corporation", "firm"],
  founded: ["found", "started", "began", "launched", "created"],
  founder: ["founded", "cofounder", "co-founder"],
  perform: ["performed", "performance", "show", "sang", "sing", "sung"],
  song: ["single", "track", "music", "tune", "sang", "sing", "sung"],
  write: ["wrote", "written", "author", "authored"],
  wrote: ["write", "written", "author", "authored"]
};

export function synthesizeAnswer(input: {
  question: string;
  mode: QueryMode;
  retrievedChunks: RetrievedChunk[];
  entities: EntityRecord[];
  relations: RelationRecord[];
  trace: QueryTraceStep[];
  retrieval?: RetrievalDiagnostics;
}): QueryResponse {
  const evidence = assessEvidence(input.question, input.retrievedChunks);
  const answerContext = buildAnswerContext(input.question, evidence.relevantChunks, evidence.queryTokens);
  const answerSentences = pickAnswerSentences(
    input.question,
    evidence.relevantChunks,
    answerContext
  );
  const initialAnswerSentences = answerContext.asksForFirst ? answerSentences.slice(0, 1) : answerSentences;
  const strictCitations = pickCitations(
    evidence.relevantChunks,
    answerContext.asksForFirst ? 1 : MAX_CITATIONS,
    answerContext,
    initialAnswerSentences
  );
  const citations = mergeCitations(
    strictCitations,
    pickCitations(evidence.relevantChunks, MAX_CITATIONS, answerContext.matchTokens, initialAnswerSentences)
  ).slice(0, answerContext.asksForFirst ? 1 : MAX_CITATIONS);
  const finalAnswerSentences =
    initialAnswerSentences.length === 0 && citations.length > 0 && evidence.bestCoverage >= 0.45
      ? [citations[0].excerpt]
      : initialAnswerSentences;
  const confidence = estimateConfidence(evidence, citations.length, finalAnswerSentences.length);
  const retrieval = input.retrieval ?? defaultRetrievalDiagnostics(input.question, evidence.relevantChunks);

  if (confidence < MIN_GROUNDED_CONFIDENCE || citations.length === 0 || finalAnswerSentences.length === 0) {
    return {
      status: "insufficient_evidence",
      answer:
        "I do not have enough grounded evidence in the current knowledge base to answer that reliably.",
      mode: input.mode,
      confidence,
      claims: [],
      citations,
      retrieval,
      verification: {
        status: "failed",
        supportedClaimIds: [],
        unsupportedClaimIds: [],
        failures: [
          {
            claimId: "answer",
            reason: "Retrieved evidence did not support a grounded answer."
          }
        ]
      },
      retrievedChunks: evidence.relevantChunks,
      graphContext: {
        entities: input.entities,
        relations: input.relations
      },
      trace: input.trace
    };
  }

  const answer = composeAnswer(finalAnswerSentences, answerContext);
  const claimSentences = answerContext.asksForFirst ? [answer] : finalAnswerSentences;
  const claims = buildClaims(claimSentences, citations);
  const verification = verifyClaimsAgainstCitations(claims, citations);

  return {
    status: verification.status === "failed" ? "insufficient_evidence" : "answered",
    answer,
    mode: input.mode,
    confidence: verification.status === "failed" ? Math.min(confidence, 0.2) : confidence,
    claims,
    citations,
    retrieval,
    verification,
    retrievedChunks: evidence.relevantChunks,
    graphContext: {
      entities: input.entities,
      relations: input.relations
    },
    trace: input.trace
  };
}

export function synthesizeInventoryAnswer(input: {
  mode: QueryMode;
  sources: SourceRecord[];
  totalChunks: number;
  retrievedChunks: RetrievedChunk[];
  entities: EntityRecord[];
  relations: RelationRecord[];
  trace: QueryTraceStep[];
  retrieval?: RetrievalDiagnostics;
}): QueryResponse {
  const citations = pickCitations(input.retrievedChunks, MAX_CITATIONS);
  const answer =
    input.totalChunks > 0
      ? buildInventoryAnswer(input.sources, input.totalChunks, input.retrievedChunks)
      : "I do not have any indexed evidence in the current knowledge base yet.";
  const inventoryClaim: AnswerClaim | undefined =
    input.totalChunks > 0
      ? {
          id: "claim_inventory",
          text: `The knowledge base contains ${input.sources.length} source(s) and ${input.totalChunks} indexed chunk(s).`,
          citationChunkIds: citations.map((citation) => citation.chunkId),
          supported: true,
          confidence: 0.9
        }
      : undefined;
  return {
    status: input.totalChunks > 0 ? "answered" : "insufficient_evidence",
    answer,
    mode: input.mode,
    confidence: input.totalChunks > 0 ? 0.68 : 0.12,
    claims: inventoryClaim ? [inventoryClaim] : [],
    citations,
    retrieval:
      input.retrieval ??
      defaultRetrievalDiagnostics("corpus inventory", input.retrievedChunks, {
        intent: "inventory",
        rewrittenQueries: ["corpus inventory"],
        requiredFilters: {},
        expectedAnswerType: "summary",
        noAnswerRisk: input.totalChunks > 0 ? "low" : "high"
      }),
    verification: {
      status: input.totalChunks > 0 ? "passed" : "failed",
      supportedClaimIds: inventoryClaim ? [inventoryClaim.id] : [],
      unsupportedClaimIds: [],
      failures: []
    },
    retrievedChunks: input.retrievedChunks,
    graphContext: {
      entities: input.entities,
      relations: input.relations
    },
    trace: input.trace
  };
}

export function verifyClaimsAgainstCitations(
  claims: AnswerClaim[],
  citations: Citation[]
): QueryResponse["verification"] {
  const citationByChunkId = new Map(citations.map((citation) => [citation.chunkId, citation]));
  const supportedClaimIds: string[] = [];
  const unsupportedClaimIds: string[] = [];
  const failures: QueryResponse["verification"]["failures"] = [];

  for (const claim of claims) {
    const citedText = claim.citationChunkIds
      .map((chunkId) => citationByChunkId.get(chunkId)?.excerpt ?? "")
      .join(" ");
    const claimTokens = contentTokens(claim.text);
    const citedTokens = new Set(contentTokens(citedText));
    const matched = claimTokens.filter((token) => citedTokens.has(token));
    const supportRatio = claimTokens.length === 0 ? 0 : matched.length / claimTokens.length;
    const supported = claim.citationChunkIds.length > 0 && (supportRatio >= 0.35 || matched.length >= 3);

    claim.supported = supported;
    if (supported) {
      supportedClaimIds.push(claim.id);
    } else {
      unsupportedClaimIds.push(claim.id);
      failures.push({
        claimId: claim.id,
        reason: "Claim tokens were not sufficiently present in the cited excerpt."
      });
    }
  }

  return {
    status: unsupportedClaimIds.length === 0 ? "passed" : supportedClaimIds.length > 0 ? "degraded" : "failed",
    supportedClaimIds,
    unsupportedClaimIds,
    failures
  };
}

function composeAnswer(sentences: string[], context?: AnswerContext): string {
  const [lead, ...supporting] = sentences;
  if (context?.asksForFirst) {
    return formatEarliestAnswer(lead, context);
  }
  const bullets = supporting.slice(0, 4);
  if (bullets.length === 0) {
    return lead;
  }

  return [`${lead}`, "Key points:", ...bullets.map((sentence) => `- ${sentence}`)].join("\n");
}

function formatEarliestAnswer(lead: string, context: AnswerContext): string {
  const normalizedLead = lead.replace(/[.!?]$/, "");
  const labeledEvidence = context.asksForDate ? humanizeLabeledEvidence(normalizedLead) : undefined;
  if (labeledEvidence) {
    return `The earliest matching dated evidence I found is ${labeledEvidence}.`;
  }
  if (context.asksForDate) {
    return `The earliest matching dated evidence I found says: ${normalizedLead}.`;
  }
  return `The earliest matching evidence I found says: ${normalizedLead}.`;
}

function humanizeLabeledEvidence(text: string): string | undefined {
  const cells = text
    .split(/\s*;\s*/)
    .map((part) => {
      const match = part.match(/^([^:]{2,48}):\s*(.+)$/);
      return match ? { label: normalizeWhitespace(match[1]), value: normalizeWhitespace(match[2]) } : undefined;
    })
    .filter((cell): cell is { label: string; value: string } => cell !== undefined);
  const yearCell = cells.find((cell) => /^(year|date)$/i.test(cell.label) && /\b(?:1[5-9]|20)\d{2}\b/.test(cell.value));
  if (!yearCell) {
    return undefined;
  }
  const details = cells
    .filter((cell) => cell !== yearCell)
    .filter((cell) => cell.value.length > 0 && !/^[-–—]+$/.test(cell.value))
    .slice(0, 3)
    .map(formatLabeledDetail);
  return details.length > 0 ? `${yearCell.value}, ${details.join("; ")}` : yearCell.value;
}

function formatLabeledDetail(cell: { label: string; value: string }): string {
  const label = cell.label.toLowerCase();
  if (/^(single|song|track|title|name)$/.test(label)) {
    return `${label} ${cell.value}`;
  }
  return `${cell.label}: ${cell.value}`;
}

function buildClaims(sentences: string[], citations: Citation[]): AnswerClaim[] {
  const citationChunkIds = citations.map((citation) => citation.chunkId);
  return sentences.map((sentence, index) => ({
    id: `claim_${index + 1}`,
    text: sentence,
    citationChunkIds,
    supported: true,
    confidence: 0.7
  }));
}

function mergeCitations(primary: Citation[], secondary: Citation[]): Citation[] {
  const merged = new Map<string, Citation>();
  for (const citation of [...primary, ...secondary]) {
    if (!merged.has(citation.chunkId)) {
      merged.set(citation.chunkId, citation);
    }
  }
  return [...merged.values()];
}

function defaultRetrievalDiagnostics(
  question: string,
  chunks: RetrievedChunk[],
  planner: QueryPlannerOutput = {
    intent: "unknown",
    rewrittenQueries: [question],
    requiredFilters: {},
    expectedAnswerType: "unknown",
    noAnswerRisk: chunks.length === 0 ? "high" : "medium"
  }
): RetrievalDiagnostics {
  return {
    planner,
    candidatePoolSize: chunks.length,
    finalK: chunks.length,
    usedOpenSearch: false,
    usedLocalFallback: true,
    reranker: {
      status: "degraded",
      provider: "local",
      message: "Local lexical reranking is active; production reranker is not configured."
    },
    candidates: chunks.map((chunk) => ({
      sourceId: chunk.sourceId,
      documentId: chunk.documentId,
      chunkId: chunk.id,
      title: chunk.title,
      lexicalScore: chunk.scoreBreakdown.keyword ?? chunk.scoreBreakdown.lexical,
      vectorScore: chunk.scoreBreakdown.vector,
      fusedScore: chunk.scoreBreakdown.fused ?? chunk.score,
      rerankScore: chunk.scoreBreakdown.rerank,
      selected: true,
      reason: chunk.retrievalReason ?? "Selected as local evidence."
    }))
  };
}

interface EvidenceAssessment {
  queryTokens: string[];
  relevantChunks: RetrievedChunk[];
  bestCoverage: number;
  averageCoverage: number;
  sourceDiversity: number;
}

interface AnswerContext {
  queryTokens: string[];
  matchTokens: string[];
  topicalFocusTokens: string[];
  requiredFocusTokens: string[];
  asksForDate: boolean;
  asksForFirst: boolean;
}

function assessEvidence(question: string, chunks: RetrievedChunk[]): EvidenceAssessment {
  const queryTokens = uniqueStrings(contentTokens(question));
  if (queryTokens.length === 0) {
    return {
      queryTokens,
      relevantChunks: [],
      bestCoverage: 0,
      averageCoverage: 0,
      sourceDiversity: 0
    };
  }

  const scored = chunks
    .map((chunk) => {
      const chunkTokens = new Set(contentTokens(`${chunk.title} ${chunk.tags.join(" ")} ${chunk.text}`));
      const matches = queryTokens.filter((token) => chunkTokens.has(token));
      const coverage = matches.length / queryTokens.length;
      const enoughLexicalOverlap =
        matches.length >= Math.min(2, queryTokens.length) || coverage >= 0.45;

      return {
        chunk,
        coverage,
        matches: matches.length,
        isRelevant: enoughLexicalOverlap
      };
    })
    .filter((item) => item.isRelevant)
    .sort((a, b) => b.coverage - a.coverage || b.matches - a.matches || b.chunk.score - a.chunk.score);
  const relevantChunks = scored.map((item) => item.chunk);
  const topCoverages = scored.slice(0, 3).map((item) => item.coverage);
  const averageCoverage =
    topCoverages.length === 0
      ? 0
      : topCoverages.reduce((sum, value) => sum + value, 0) / topCoverages.length;

  return {
    queryTokens,
    relevantChunks,
    bestCoverage: scored[0]?.coverage ?? 0,
    averageCoverage,
    sourceDiversity: new Set(relevantChunks.slice(0, MAX_CITATIONS).map((chunk) => chunk.sourceId)).size
  };
}

function buildAnswerContext(
  question: string,
  chunks: RetrievedChunk[],
  queryTokens: string[]
): AnswerContext {
  const dominantTokens = dominantQueryTokens(chunks, queryTokens);
  const focusTokens = queryTokens.filter((token) => !dominantTokens.has(token));
  const baseTopicalFocusTokens = focusTokens.filter((token) => !ORDINAL_TOKENS.has(token));
  const chunkTokenSet = new Set(
    chunks.flatMap((chunk) => contentTokens(`${chunk.title} ${chunk.tags.join(" ")} ${chunk.text}`))
  );
  const requiredBaseFocusTokens = baseTopicalFocusTokens
    .filter((token) => !ACTION_FOCUS_TOKENS.has(token))
    .filter((token) => chunkTokenSet.has(token));
  const topicalFocusTokens = expandTokens(baseTopicalFocusTokens);

  return {
    queryTokens,
    matchTokens: expandTokens(queryTokens),
    topicalFocusTokens,
    requiredFocusTokens: expandTokens(
      requiredBaseFocusTokens.length > 0 ? requiredBaseFocusTokens : baseTopicalFocusTokens
    ),
    asksForDate: DATE_QUESTION.test(question),
    asksForFirst: FIRST_QUESTION.test(question)
  };
}

function dominantQueryTokens(chunks: RetrievedChunk[], queryTokens: string[]): Set<string> {
  const sample = chunks.slice(0, 8);
  if (sample.length < 2) {
    return new Set();
  }
  const counts = new Map<string, number>();
  for (const chunk of sample) {
    const chunkTokens = new Set(contentTokens(`${chunk.title} ${chunk.tags.join(" ")} ${chunk.text}`));
    for (const token of queryTokens) {
      if (chunkTokens.has(token)) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
    }
  }
  const threshold = Math.max(2, Math.ceil(sample.length * 0.6));
  return new Set([...counts.entries()].filter(([, count]) => count >= threshold).map(([token]) => token));
}

function expandTokens(tokens: string[]): string[] {
  return uniqueStrings(
    tokens.flatMap((token) => [token, ...(QUERY_TOKEN_EXPANSIONS[token] ?? [])]).flatMap((token) => contentTokens(token))
  );
}

function pickAnswerSentences(
  question: string,
  chunks: RetrievedChunk[],
  context: AnswerContext = buildAnswerContext(question, chunks, uniqueStrings(contentTokens(question)))
): string[] {
  if (context.queryTokens.length === 0) {
    return [];
  }
  const minimumMatches = context.topicalFocusTokens.length > 0
    ? 1
    : context.queryTokens.length <= 2
      ? 1
      : Math.min(2, Math.ceil(context.queryTokens.length * 0.3));
  const candidates = chunks.flatMap((chunk) =>
    splitEvidenceUnits(chunk.text).map((sentence) => ({
      sentence,
      matches: countTokenMatches(sentence, context.matchTokens),
      focusMatches: countTokenMatches(sentence, context.topicalFocusTokens),
      requiredFocusMatches: countTokenMatches(sentence, context.requiredFocusTokens),
      score: scoreEvidenceUnit(sentence, context, chunk.score),
      year: firstYear(sentence)
    }))
  );

  const picked = candidates
    .filter((candidate) => candidate.matches >= minimumMatches && candidate.score > 0)
    .filter((candidate) => context.topicalFocusTokens.length === 0 || candidate.focusMatches > 0)
    .filter((candidate) => context.requiredFocusTokens.length === 0 || candidate.requiredFocusMatches > 0)
    .sort((a, b) => {
      if (context.asksForFirst && a.year !== undefined && b.year !== undefined && a.year !== b.year) {
        return a.year - b.year;
      }
      return b.score - a.score;
    })
    .map((candidate) => candidate.sentence)
    .filter(uniqueEvidenceUnit)
    .slice(0, 5)
    .map(polishSentence);

  if (picked.length > 0) {
    return picked;
  }

  return [];
}

function pickCitations(
  chunks: RetrievedChunk[],
  maxCitations: number,
  contextOrTokens: AnswerContext | string[] = [],
  answerSentences: string[] = []
): Citation[] {
  const context = Array.isArray(contextOrTokens) ? undefined : contextOrTokens;
  const queryTokens = Array.isArray(contextOrTokens) ? contextOrTokens : contextOrTokens.matchTokens;
  const answerTokens = uniqueStrings(contentTokens(answerSentences.join(" ")));
  const answerYear = firstYear(answerSentences.join(" "));
  const rankedCandidates = chunks
    .map((chunk) => toCitation(chunk, cleanEvidenceText(chunk.text), queryTokens, context))
    .filter((citation): citation is Citation => citation !== undefined)
    .sort((a, b) => compareCitationRank(a, b, queryTokens, context, answerTokens, answerYear));
  const citations: Citation[] = [];
  const seenSources = new Set<string>();
  const seenExcerpts = new Set<string>();

  for (const citation of rankedCandidates) {
    const sourceKey = `${citation.uri ?? citation.documentId}:${citation.title}`;
    const excerptKey = normalizeForDedupe(citation.excerpt);
    if (seenSources.has(sourceKey) || seenExcerpts.has(excerptKey)) {
      continue;
    }
    citations.push(citation);
    seenSources.add(sourceKey);
    seenExcerpts.add(excerptKey);
    if (citations.length >= maxCitations) {
      break;
    }
  }

  if (citations.length > 0) {
    return citations;
  }

  if (context && context.requiredFocusTokens.length > 0) {
    return [];
  }

  return chunks
    .slice(0, maxCitations)
    .map((chunk) => toCitation(chunk, cleanEvidenceText(chunk.text), queryTokens, context))
    .filter((citation): citation is Citation => citation !== undefined);
}

function compareCitationRank(
  a: Citation,
  b: Citation,
  queryTokens: string[],
  context?: AnswerContext,
  answerTokens: string[] = [],
  answerYear?: number
): number {
  if (answerYear !== undefined) {
    const aHasAnswerYear = firstYear(a.excerpt) === answerYear;
    const bHasAnswerYear = firstYear(b.excerpt) === answerYear;
    if (aHasAnswerYear !== bHasAnswerYear) {
      return aHasAnswerYear ? -1 : 1;
    }
  }
  if (answerTokens.length > 0) {
    const aAnswerMatches = countTokenMatches(`${a.title} ${a.excerpt}`, answerTokens);
    const bAnswerMatches = countTokenMatches(`${b.title} ${b.excerpt}`, answerTokens);
    if (aAnswerMatches !== bAnswerMatches) {
      return bAnswerMatches - aAnswerMatches;
    }
  }
  if (context?.asksForFirst) {
    const aYear = firstYear(a.excerpt);
    const bYear = firstYear(b.excerpt);
    if (aYear !== undefined && bYear !== undefined && aYear !== bYear) {
      return aYear - bYear;
    }
    if (aYear !== undefined || bYear !== undefined) {
      return aYear !== undefined ? -1 : 1;
    }
  }
  return citationQuality(b, queryTokens) - citationQuality(a, queryTokens);
}

function citationQuality(citation: Citation, queryTokens: string[]): number {
  const matches = countTokenMatches(`${citation.title} ${citation.excerpt}`, queryTokens);
  const lengthFit = citation.excerpt.length >= 70 && citation.excerpt.length <= 220 ? 1 : 0;
  return matches * 2 + lengthFit + citation.score - boilerplateScore(citation.excerpt);
}

function splitEvidenceUnits(text: string): string[] {
  const cleaned = cleanEvidenceText(text);
  const blocks = cleaned
    .split(/\n+/)
    .map((block) => normalizeWhitespace(block))
    .filter(Boolean);
  const contextualBlocks = addTableHeaderContext(blocks);
  const units = contextualBlocks.flatMap((block) => {
    if (block.includes("|") && hasDateSignal(block)) {
      return [block];
    }
    const sentenceUnits = splitSentences(block);
    return sentenceUnits.length > 0 ? sentenceUnits : [block];
  });

  return units
    .flatMap((unit) => splitSerializedTableUnit(unit))
    .flatMap((unit) => splitLongUnit(unit))
    .map((unit) => normalizeWhitespace(unit.replace(/^[-*•]\s*/, "")))
    .filter((unit) => (unit.length >= 36 || (hasDateSignal(unit) && unit.length >= 16)) && unit.length <= 420)
    .filter((unit) => !isBoilerplate(unit));
}

function addTableHeaderContext(blocks: string[]): string[] {
  const contextualBlocks: string[] = [];
  let tableHeader = "";
  for (const block of blocks) {
    if (!hasDateSignal(block) && block.includes("|") && block.length <= 140) {
      tableHeader = block;
      contextualBlocks.push(block);
      continue;
    }
    contextualBlocks.push(tableHeader && hasDateSignal(block) && block.includes("|") ? `${tableHeader} ${block}` : block);
  }
  return contextualBlocks;
}

function splitSerializedTableUnit(unit: string): string[] {
  if (!unit.includes("| . ")) {
    return [unit];
  }

  const rows = normalizeWhitespace(unit.replace(/\[\s*edit\s*\]/gi, " "))
    .split(/\s+\|\s+\.\s+/)
    .map((row) => normalizeWhitespace(row.replace(/\s+\|\s*$/g, "")))
    .filter(Boolean);
  if (rows.length < 2) {
    return [unit];
  }

  const header = !hasDateSignal(rows[0]) && rows[0].includes("|") ? rows[0] : "";
  const dataRows = header ? rows.slice(1) : rows;
  const expandedRows = dataRows.map((row) => {
    if (header && hasDateSignal(row)) {
      return formatTableRow(header, row);
    }
    return row;
  });
  return expandedRows.length > 0 ? expandedRows : [unit];
}

function formatTableRow(header: string, row: string): string {
  const headerCells = header.split(/\s*\|\s*/).map(cleanTableCell).filter(Boolean);
  const rowCells = row.split(/\s*\|\s*/).map(cleanTableCell).filter(Boolean);
  if (headerCells.length < 2 || rowCells.length === 0) {
    return `${header} ${row}`;
  }
  const labeledCells = rowCells.map((cell, index) => {
    const label = cleanHeaderCell(headerCells[index] ?? `Column ${index + 1}`, cell);
    return `${label}: ${cell}`;
  });
  return labeledCells.join("; ");
}

function cleanTableCell(cell: string): string {
  return normalizeWhitespace(cell.replace(/\[[0-9,\s]+\]/g, "").replace(/\s*\.\s*$/g, ""));
}

function cleanHeaderCell(header: string, value: string): string {
  if (/^(?:1[5-9]|20)\d{2}$/.test(value)) {
    return header.split(/\s+/).at(-1) ?? header;
  }
  return header;
}

function splitLongUnit(unit: string): string[] {
  if (unit.length <= 260) {
    return [unit];
  }
  const pieces = unit
    .split(/\s+(?=(?:The|This|A|An|It|They|We|User|Source|System|Agent)\b)/)
    .flatMap((piece) => (piece.length > 300 ? piece.split(/\s*[;|]\s*/) : [piece]));

  return pieces.flatMap((piece) => (piece.length > 300 ? wordWindows(piece) : [piece]));
}

function wordWindows(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 55) {
    return [text];
  }
  const windows: string[] = [];
  for (let cursor = 0; cursor < words.length; cursor += 36) {
    windows.push(words.slice(cursor, cursor + 55).join(" "));
    if (cursor + 55 >= words.length) {
      break;
    }
  }
  return windows;
}

function scoreEvidenceUnit(sentence: string, context: AnswerContext, chunkScore: number): number {
  const tokenHits = countTokenMatches(sentence, context.matchTokens);
  const focusHits = countTokenMatches(sentence, context.topicalFocusTokens);
  const density = tokenHits / Math.max(1, context.matchTokens.length);
  const lengthFit = sentence.length >= 70 && sentence.length <= 260 ? 0.7 : 0.25;
  const boilerplatePenalty = boilerplateScore(sentence) * 0.6;
  const dateBonus = context.asksForDate && hasDateSignal(sentence) ? 1.2 : 0;
  const focusBonus = focusHits > 0 ? 0.9 + focusHits * 0.25 : 0;
  const firstBonus = context.asksForFirst && hasDateSignal(sentence) ? 0.35 : 0;
  const score =
    density * 4 +
    tokenHits * 0.55 +
    focusBonus +
    dateBonus +
    firstBonus +
    Math.min(chunkScore, 1) * 0.4 +
    lengthFit -
    boilerplatePenalty;
  return Number(score.toFixed(4));
}

function countTokenMatches(sentence: string, queryTokens: string[]): number {
  const sentenceTokens = new Set(contentTokens(sentence));
  return queryTokens.filter((token) => sentenceTokens.has(token)).length;
}

function hasDateSignal(sentence: string): boolean {
  return DATE_SIGNAL.test(sentence);
}

function firstYear(sentence: string): number | undefined {
  const match = sentence.match(/\b((?:1[5-9]|20)\d{2})\b/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function uniqueEvidenceUnit(sentence: string, index: number, sentences: string[]): boolean {
  const current = normalizeForDedupe(sentence);
  return sentences.findIndex((candidate) => {
    const other = normalizeForDedupe(candidate);
    return other === current || other.includes(current) || current.includes(other);
  }) === index;
}

function cleanEvidenceText(text: string): string {
  return normalizeWhitespace(
    decodeHtmlEntities(text)
      .replace(/-->/g, " ")
      .replace(/\[\s*(edit|citation needed|note \d+)\s*\]/gi, " ")
      .replace(/\[[0-9,\s]+\]/g, " ")
      .replace(/\s+›\s+/g, " ")
      .replace(/\s+\/\s+/g, " / ")
  );
}

function isBoilerplate(sentence: string): boolean {
  const lower = sentence.toLowerCase();
  if (
    /\b(archives at|how to use archival material|official website|wikiquote|wikimedia commons)\b/i.test(lower) ||
    /\bsource\s*\|\s*.*\bcollection,\s*(?:1[5-9]|20)\d{2}[–-](?:1[5-9]|20)\d{2}\b/i.test(lower)
  ) {
    return true;
  }
  if (boilerplateScore(sentence) >= 4) {
    return true;
  }
  const words = tokenize(sentence);
  if (words.length > 0 && new Set(words).size / words.length < 0.42) {
    return true;
  }
  return /^(home|login|register|search|share this|more|newsletter|faq)\b/i.test(lower);
}

function boilerplateScore(sentence: string): number {
  const lower = sentence.toLowerCase();
  const patterns = [
    /\blog\s?in\b/,
    /\bregister\b/,
    /\bsearch\b/,
    /\bnewsletter\b/,
    /\bfaqs?\b/,
    /\bcontact us\b/,
    /\bprivacy\b/,
    /\bterms\b/,
    /\bdashboard\b/,
    /\bsettings\b/,
    /\blogout\b/,
    /\bdonate\b/,
    /\bcreate account\b/,
    /\bpersonal tools\b/,
    /\bjump to content\b/,
    /\bedit links\b/,
    /\bexternal links\b/,
    /\barchives at\b/,
    /\bhow to use archival material\b/,
    /\bofficial website\b/,
    /\bwikiquote\b/,
    /\bwikimedia commons\b/,
    /\bfull name\b/,
    /\bemail\b/,
    /\bsubmit\b/,
    /\boptional\b/,
    /\bvisibility preference\b/,
    /\bshare this\b/,
    /\bmore services\b/,
    /\bcollection,\s+(?:1[5-9]|20)\d{2}[–-](?:1[5-9]|20)\d{2}\b/
  ];
  return patterns.reduce((count, pattern) => count + (pattern.test(lower) ? 1 : 0), 0);
}

function polishSentence(sentence: string): string {
  const trimmed = normalizeWhitespace(sentence).replace(/\s+([,.!?;:])/g, "$1");
  const sentenceWithTerminal = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  return `${sentenceWithTerminal.charAt(0).toUpperCase()}${sentenceWithTerminal.slice(1)}`;
}

function normalizeForDedupe(text: string): string {
  return tokenize(text).slice(0, 32).join(" ");
}

function toCitation(
  chunk: RetrievedChunk,
  cleanText: string,
  queryTokens: string[] = [],
  context?: AnswerContext
): Citation | undefined {
  const units = splitEvidenceUnits(cleanText);
  let candidates = units
    .map((unit) => ({
      unit,
      matches: countTokenMatches(unit, queryTokens),
      requiredMatches: context ? countTokenMatches(unit, context.requiredFocusTokens) : 0,
      hasDate: hasDateSignal(unit),
      year: firstYear(unit),
      lengthFit: unit.length >= 60 && unit.length <= 220 ? 1 : 0
    }))
    .filter((candidate) => queryTokens.length === 0 || candidate.matches > 0);

  if (context?.requiredFocusTokens.length) {
    candidates = candidates.filter((candidate) => candidate.requiredMatches > 0);
  }
  if (context?.asksForDate) {
    candidates = candidates.filter((candidate) => candidate.hasDate);
  }
  if (candidates.length === 0 && context?.requiredFocusTokens.length) {
    return undefined;
  }

  const bestExcerpt =
    candidates.sort((a, b) => {
      if (context?.asksForFirst && a.year !== undefined && b.year !== undefined && a.year !== b.year) {
        return a.year - b.year;
      }
      return (
        b.requiredMatches - a.requiredMatches ||
        b.matches - a.matches ||
        Number(b.hasDate) - Number(a.hasDate) ||
        b.lengthFit - a.lengthFit
      );
    })[0]?.unit ??
    units.find((unit) => unit.length >= 60) ??
    cleanText;

  return {
    chunkId: chunk.id,
    sourceId: chunk.sourceId,
    documentId: chunk.documentId,
    title: chunk.title,
    uri: chunk.uri,
    excerpt: excerpt(bestExcerpt, 220),
    score: Number(chunk.score.toFixed(4)),
    textSpan:
      chunk.startOffset !== undefined && chunk.endOffset !== undefined
        ? {
            start: chunk.startOffset,
            end: chunk.endOffset
          }
        : undefined
  };
}

function estimateConfidence(
  evidence: EvidenceAssessment,
  citationCount: number,
  answerSentenceCount: number
): number {
  if (citationCount === 0 || answerSentenceCount === 0) {
    return 0;
  }
  const citationSignal = Math.min(citationCount, 3) * 0.06;
  const diversitySignal = Math.min(evidence.sourceDiversity, 3) * 0.03;
  const answerSignal = Math.min(answerSentenceCount, 3) * 0.04;
  const confidence = Math.min(
    0.92,
    0.12 + evidence.bestCoverage * 0.35 + evidence.averageCoverage * 0.2 + citationSignal + diversitySignal + answerSignal
  );
  return Number(confidence.toFixed(2));
}

function buildInventoryAnswer(
  sources: SourceRecord[],
  totalChunks: number,
  chunks: RetrievedChunk[]
): string {
  const sourceLabels = uniqueStrings(
    sources.map((source) => source.title ?? source.uri ?? source.id).filter((label) => label.length > 0)
  ).slice(0, 6);
  const chunkTitles = uniqueStrings(chunks.map((chunk) => chunk.title).filter(Boolean)).slice(0, 6);
  const tags = uniqueStrings([
    ...sources.flatMap((source) => source.tags ?? []),
    ...chunks.flatMap((chunk) => chunk.tags)
  ]).slice(0, 8);
  const parts = [
    `The current knowledge base has ${sources.length} ${plural(sources.length, "source")} and ${totalChunks} indexed ${plural(totalChunks, "chunk")}.`
  ];

  const representativeLabels = sourceLabels.length > 0 ? sourceLabels : chunkTitles;
  if (representativeLabels.length > 0) {
    parts.push(`Representative sources: ${representativeLabels.join("; ")}.`);
  }
  if (tags.length > 0) {
    parts.push(`Tags present: ${tags.join(", ")}.`);
  }
  if (chunks.length > 0) {
    parts.push("The citations below are representative indexed chunks rather than a synthesized topical claim.");
  }

  return parts.join(" ");
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

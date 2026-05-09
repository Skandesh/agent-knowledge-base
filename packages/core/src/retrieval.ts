import type { KnowledgeChunk, QueryMode, QueryPlannerOutput, RetrievedChunk } from "@knowledge-brain/shared";
import { embedText, cosineSimilarity } from "./embeddings.js";
import { contentTokens } from "./text.js";

export function planQueryMode(question: string, requested?: QueryMode): QueryMode {
  if (requested) {
    return requested;
  }
  const lower = question.toLowerCase();
  if (/\b(compare|relationship|related|connected|why|how)\b/.test(lower)) {
    return "agentic";
  }
  if (/\b(who|what|when|where|list|show)\b/.test(lower)) {
    return "hybrid";
  }
  return "semantic";
}

export function modeFromPlanner(planner: QueryPlannerOutput, requested?: QueryMode): QueryMode {
  if (requested) {
    return requested;
  }
  if (planner.intent === "comparison") {
    return "agentic";
  }
  if (planner.intent === "inventory") {
    return "hybrid";
  }
  if (planner.noAnswerRisk === "high") {
    return "hybrid";
  }
  return "hybrid";
}

export function keywordScore(question: string, chunk: KnowledgeChunk): number {
  const queryTokens = [...new Set(contentTokens(question))];
  if (queryTokens.length === 0) {
    return 0;
  }

  const titleTokens = contentTokens(chunk.title);
  const tagTokens = contentTokens(chunk.tags.join(" "));
  const textTokens = contentTokens(chunk.text);
  const fieldTokens = [...titleTokens, ...tagTokens, ...textTokens];
  const titleCounts = tokenCounts(titleTokens);
  const tagCounts = tokenCounts(tagTokens);
  const textCounts = tokenCounts(textTokens);

  let weightedMatches = 0;
  let coveredTokens = 0;
  for (const token of queryTokens) {
    const titleHits = titleCounts.get(token) ?? 0;
    const tagHits = tagCounts.get(token) ?? 0;
    const textHits = textCounts.get(token) ?? 0;
    if (titleHits + tagHits + textHits > 0) {
      coveredTokens += 1;
    }
    weightedMatches += Math.min(titleHits, 2) * 3 + Math.min(tagHits, 2) * 2 + Math.min(textHits, 4);
  }

  const coverage = coveredTokens / queryTokens.length;
  return weightedMatches / Math.sqrt(fieldTokens.length + 1) + coverage * 1.5;
}

export function vectorScore(question: string, chunk: KnowledgeChunk): number {
  return cosineSimilarity(embedText(question), chunk.embedding);
}

export function rankLocalChunks(
  question: string,
  chunks: KnowledgeChunk[],
  mode: QueryMode,
  topK: number
): RetrievedChunk[] {
  const keywordRanked = chunks
    .map((chunk) => ({ chunk, score: keywordScore(question, chunk) }))
    .sort((a, b) => b.score - a.score);
  const vectorRanked = chunks
    .map((chunk) => ({ chunk, score: vectorScore(question, chunk) }))
    .sort((a, b) => b.score - a.score);

  if (mode === "keyword") {
    return keywordRanked.slice(0, topK).map(({ chunk, score }) => withScore(chunk, score, { keyword: score }));
  }
  if (mode === "semantic") {
    return vectorRanked.slice(0, topK).map(({ chunk, score }) => withScore(chunk, score, { vector: score }));
  }

  return reciprocalRankFusion(keywordRanked, vectorRanked, topK);
}

export function reciprocalRankFusion(
  keywordRanked: Array<{ chunk: KnowledgeChunk; score: number }>,
  vectorRanked: Array<{ chunk: KnowledgeChunk; score: number }>,
  topK: number
): RetrievedChunk[] {
  const scores = new Map<
    string,
    { chunk: KnowledgeChunk; keyword?: number; vector?: number; fused: number }
  >();
  const k = 60;

  keywordRanked.filter(hasPositiveScore).forEach((entry, rank) => {
    const current = scores.get(entry.chunk.id) ?? { chunk: entry.chunk, fused: 0 };
    current.keyword = entry.score;
    current.fused += 1 / (k + rank + 1) + Math.min(entry.score, 4) * 0.02;
    scores.set(entry.chunk.id, current);
  });

  vectorRanked.filter(hasPositiveScore).forEach((entry, rank) => {
    const current = scores.get(entry.chunk.id) ?? { chunk: entry.chunk, fused: 0 };
    current.vector = entry.score;
    current.fused += (1 / (k + rank + 1) + Math.min(entry.score, 1) * 0.01) * 0.35;
    scores.set(entry.chunk.id, current);
  });

  return [...scores.values()]
    .sort((a, b) => b.fused - a.fused)
    .slice(0, topK)
    .map((entry) =>
      withScore(entry.chunk, entry.fused, {
        keyword: entry.keyword,
        vector: entry.vector,
        fused: entry.fused
      })
    );
}

function withScore(
  chunk: KnowledgeChunk,
  score: number,
  scoreBreakdown: RetrievedChunk["scoreBreakdown"]
): RetrievedChunk {
  return {
    ...chunk,
    score,
    scoreBreakdown,
    retrievalReason: reasonFromScore(scoreBreakdown)
  };
}

function tokenCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function hasPositiveScore(entry: { score: number }): boolean {
  return Number.isFinite(entry.score) && entry.score > 0;
}

function reasonFromScore(scoreBreakdown: RetrievedChunk["scoreBreakdown"]): string {
  if (scoreBreakdown.keyword !== undefined && scoreBreakdown.vector !== undefined) {
    return "Selected by reciprocal rank fusion of lexical and vector evidence.";
  }
  if (scoreBreakdown.keyword !== undefined || scoreBreakdown.lexical !== undefined) {
    return "Selected by lexical evidence match.";
  }
  if (scoreBreakdown.vector !== undefined) {
    return "Selected by vector similarity.";
  }
  return "Selected by retrieval score.";
}

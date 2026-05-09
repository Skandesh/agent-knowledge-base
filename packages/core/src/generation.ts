import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type {
  AnswerClaim,
  Citation,
  GenerationProviderName,
  ProviderStatus,
  QueryPlannerOutput,
  QueryStatus,
  RetrievedChunk,
  SourceCandidate
} from "@knowledge-brain/shared";
import { stableId } from "./hash.js";
import { isCorpusInventoryQuestion } from "./text.js";

export const OPENAI_GENERATION_MODEL = "gpt-5.5";
export const LOCAL_GENERATION_MODEL = "local-structured-extractive";

export interface GenerationHealth {
  provider: GenerationProviderName;
  status: ProviderStatus;
  model: string;
  message: string;
}

export interface StrictAnswerResult {
  status: QueryStatus;
  answer: string;
  claims: AnswerClaim[];
  missingEvidenceReason?: string;
  confidenceBreakdown: {
    retrieval: number;
    citationSupport: number;
    answerCompleteness: number;
    overall: number;
  };
}

export interface GenerateAnswerInput {
  question: string;
  evidence: RetrievedChunk[];
  citations: Citation[];
  strict: boolean;
}

export interface ResearchSourceGapInput {
  question: string;
  reason: string;
  suggestedQuery: string;
  currentEvidence: string[];
  existingSources: Array<{
    title?: string;
    uri?: string;
  }>;
}

export interface GenerationProvider {
  readonly provider: GenerationProviderName;
  readonly model: string;
  health(): Promise<GenerationHealth>;
  planQuery(question: string): Promise<QueryPlannerOutput>;
  generateAnswer(input: GenerateAnswerInput): Promise<StrictAnswerResult>;
  researchSourceGap(input: ResearchSourceGapInput): Promise<SourceCandidate[]>;
}

const QueryPlannerSchema = z.object({
  intent: z.enum(["lookup", "summary", "comparison", "inventory", "no_answer_check", "unknown"]),
  rewrittenQueries: z.array(z.string()).min(1).max(5),
  requiredFilters: z.object({
    tags: z.array(z.string()).nullable(),
    sourceIds: z.array(z.string()).nullable()
  }),
  expectedAnswerType: z.enum(["short", "list", "summary", "comparison", "unknown"]),
  noAnswerRisk: z.enum(["low", "medium", "high"])
});

const StrictAnswerSchema = z.object({
  status: z.enum(["answered", "insufficient_evidence"]),
  answer: z.string(),
  claims: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      citationChunkIds: z.array(z.string()),
      supported: z.boolean(),
      confidence: z.number().min(0).max(1),
      verifierNote: z.string().nullable()
    })
  ),
  missingEvidenceReason: z.string().nullable(),
  confidenceBreakdown: z.object({
    retrieval: z.number().min(0).max(1),
    citationSupport: z.number().min(0).max(1),
    answerCompleteness: z.number().min(0).max(1),
    overall: z.number().min(0).max(1)
  })
});

const SourceCandidateSearchSchema = z.object({
  candidates: z.array(
    z.object({
      title: z.string().min(1),
      url: z.string().min(1),
      snippet: z.string().min(1),
      publisher: z.string().nullable(),
      whyRelevant: z.string().min(1),
      confidence: z.number().min(0).max(1)
    })
  ).max(4)
});

export class LocalGenerationProvider implements GenerationProvider {
  readonly provider = "local" as const;
  readonly model = LOCAL_GENERATION_MODEL;

  async health(): Promise<GenerationHealth> {
    return {
      provider: this.provider,
      status: "degraded",
      model: this.model,
      message:
        "Local structured generation is enabled explicitly for tests/offline development. Production generation requires OpenAI."
    };
  }

  async planQuery(question: string): Promise<QueryPlannerOutput> {
    return {
      intent: isCorpusInventoryQuestion(question)
        ? "inventory"
        : /\b(compare|versus|vs\.?|difference|relationship|related)\b/i.test(question)
          ? "comparison"
          : /\b(summarize|overview|what is in|what's in|list)\b/i.test(question)
            ? "summary"
            : "lookup",
      rewrittenQueries: [question],
      requiredFilters: {},
      expectedAnswerType: /\b(list|which|what are)\b/i.test(question) ? "list" : "short",
      noAnswerRisk: "medium"
    };
  }

  async generateAnswer(input: GenerateAnswerInput): Promise<StrictAnswerResult> {
    if (input.evidence.length === 0 || input.citations.length === 0) {
      return insufficient("No retrieved evidence was supplied.");
    }

    const citedChunkIds = new Set(input.citations.map((citation) => citation.chunkId));
    const evidenceText = input.evidence
      .filter((chunk) => citedChunkIds.has(chunk.id))
      .map((chunk) => chunk.text)
      .join("\n");
    const answer = evidenceText.split(/(?<=[.!?])\s+/).find((sentence) => sentence.length > 30) ?? evidenceText;
    if (!answer.trim()) {
      return insufficient("Retrieved evidence did not contain readable answer text.");
    }

    const claim: AnswerClaim = {
      id: stableId("claim", `${input.question}:${answer}:${[...citedChunkIds].join(",")}`),
      text: answer.trim(),
      citationChunkIds: [...citedChunkIds],
      supported: true,
      confidence: 0.68
    };
    return {
      status: "answered",
      answer: answer.trim(),
      claims: [claim],
      confidenceBreakdown: {
        retrieval: Math.min(1, input.evidence.length / 5),
        citationSupport: 0.75,
        answerCompleteness: 0.62,
        overall: 0.68
      }
    };
  }

  async researchSourceGap(_input: ResearchSourceGapInput): Promise<SourceCandidate[]> {
    return [];
  }
}

export interface OpenAIGenerationProviderOptions {
  apiKey?: string;
  model?: string;
}

export class OpenAIGenerationProvider implements GenerationProvider {
  readonly provider = "openai" as const;
  readonly model: string;
  private readonly client?: OpenAI;

  constructor(options: OpenAIGenerationProviderOptions = {}) {
    this.model = options.model ?? OPENAI_GENERATION_MODEL;
    this.client = options.apiKey ? new OpenAI({ apiKey: options.apiKey }) : undefined;
  }

  async health(): Promise<GenerationHealth> {
    if (!this.client) {
      return {
        provider: this.provider,
        status: "degraded",
        model: this.model,
        message: "OPENAI_API_KEY is required for production answer generation."
      };
    }
    return {
      provider: this.provider,
      status: "ok",
      model: this.model,
      message: "OpenAI Responses API provider is configured."
    };
  }

  async planQuery(question: string): Promise<QueryPlannerOutput> {
    if (!this.client) {
      throw new Error("OPENAI_API_KEY is required for OpenAI query planning.");
    }
    const response = await this.client.responses.parse({
      model: this.model,
      input: [
        {
          role: "system",
          content:
            "You are the query planner for a RAG system. Return only structured query intent, rewrites, filters that are explicit in the question, expected answer type, and no-answer risk."
        },
        {
          role: "user",
          content: question
        }
      ],
      text: {
        format: zodTextFormat(QueryPlannerSchema, "query_plan")
      }
    });
    return normalizePlanner(QueryPlannerSchema.parse(response.output_parsed));
  }

  async generateAnswer(input: GenerateAnswerInput): Promise<StrictAnswerResult> {
    if (!this.client) {
      throw new Error("OPENAI_API_KEY is required for OpenAI answer generation.");
    }
    const evidence = input.evidence.map((chunk, index) => ({
      ordinal: index + 1,
      chunkId: chunk.id,
      sourceId: chunk.sourceId,
      documentId: chunk.documentId,
      title: chunk.title,
      uri: chunk.uri,
      text: chunk.text,
      tokenCount: chunk.tokenCount
    }));
    const response = await this.client.responses.parse({
      model: this.model,
      input: [
        {
          role: "system",
          content:
            "You answer strictly from supplied evidence. Do not use outside knowledge. Every claim must cite one or more provided chunk IDs. If evidence is insufficient, return insufficient_evidence with a missingEvidenceReason. Do not invent citations."
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              question: input.question,
              strict: input.strict,
              evidence
            },
            null,
            2
          )
        }
      ],
      text: {
        format: zodTextFormat(StrictAnswerSchema, "strict_rag_answer")
      }
    });
    return normalizeStrictAnswer(StrictAnswerSchema.parse(response.output_parsed));
  }

  async researchSourceGap(input: ResearchSourceGapInput): Promise<SourceCandidate[]> {
    if (!this.client) {
      throw new Error("OPENAI_API_KEY is required for OpenAI source discovery.");
    }
    const response = await this.client.responses.parse({
      model: this.model,
      reasoning: {
        effort: "low"
      },
      tools: [
        {
          type: "web_search",
          search_context_size: "low"
        }
      ],
      tool_choice: "required",
      include: ["web_search_call.action.sources"],
      input: [
        {
          role: "system",
          content:
            "You find candidate sources for a RAG knowledge base. Search the web, prefer primary or authoritative sources over blogs, avoid login-only/search-result pages, and return sources the operator can review before ingestion. Do not answer the user's question."
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              task: "Find source URLs that would fill this evidence gap.",
              question: input.question,
              missingEvidenceReason: input.reason,
              suggestedSearch: input.suggestedQuery,
              currentEvidence: input.currentEvidence,
              existingSources: input.existingSources
            },
            null,
            2
          )
        }
      ],
      text: {
        format: zodTextFormat(SourceCandidateSearchSchema, "source_gap_candidates")
      }
    });

    return normalizeSourceCandidates(SourceCandidateSearchSchema.parse(response.output_parsed).candidates);
  }
}

function normalizePlanner(parsed: z.infer<typeof QueryPlannerSchema>): QueryPlannerOutput {
  return {
    intent: parsed.intent,
    rewrittenQueries: parsed.rewrittenQueries,
    requiredFilters: {
      ...(parsed.requiredFilters.tags ? { tags: parsed.requiredFilters.tags } : {}),
      ...(parsed.requiredFilters.sourceIds ? { sourceIds: parsed.requiredFilters.sourceIds } : {})
    },
    expectedAnswerType: parsed.expectedAnswerType,
    noAnswerRisk: parsed.noAnswerRisk
  };
}

function normalizeStrictAnswer(parsed: z.infer<typeof StrictAnswerSchema>): StrictAnswerResult {
  return {
    status: parsed.status,
    answer: parsed.answer,
    claims: parsed.claims.map((claim) => ({
      id: claim.id,
      text: claim.text,
      citationChunkIds: claim.citationChunkIds,
      supported: claim.supported,
      confidence: claim.confidence,
      ...(claim.verifierNote ? { verifierNote: claim.verifierNote } : {})
    })),
    ...(parsed.missingEvidenceReason ? { missingEvidenceReason: parsed.missingEvidenceReason } : {}),
    confidenceBreakdown: parsed.confidenceBreakdown
  };
}

function normalizeSourceCandidates(
  parsed: z.infer<typeof SourceCandidateSearchSchema>["candidates"]
): SourceCandidate[] {
  const seen = new Set<string>();
  const candidates: SourceCandidate[] = [];
  for (const candidate of parsed) {
    const url = candidate.url.trim();
    if (!/^https?:\/\//i.test(url) || seen.has(normalizeCandidateUrl(url))) {
      continue;
    }
    seen.add(normalizeCandidateUrl(url));
    candidates.push({
      id: stableId("source_candidate", `${url}:${candidate.title}`),
      title: candidate.title.trim(),
      url,
      snippet: candidate.snippet.trim(),
      ...(candidate.publisher ? { publisher: candidate.publisher.trim() } : {}),
      whyRelevant: candidate.whyRelevant.trim(),
      confidence: Number(candidate.confidence.toFixed(2))
    });
  }
  return candidates.slice(0, 3);
}

function normalizeCandidateUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.toLowerCase();
  }
}

function insufficient(reason: string): StrictAnswerResult {
  return {
    status: "insufficient_evidence",
    answer: "I do not have enough grounded evidence in the current knowledge base to answer that reliably.",
    claims: [],
    missingEvidenceReason: reason,
    confidenceBreakdown: {
      retrieval: 0,
      citationSupport: 0,
      answerCompleteness: 0,
      overall: 0
    }
  };
}

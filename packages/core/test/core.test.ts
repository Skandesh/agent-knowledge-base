import { describe, expect, it } from "vitest";
import {
  chunkDocument,
  embedText,
  extractKnowledge,
  isCorpusInventoryQuestion,
  planQueryMode,
  rankLocalChunks,
  stripHtml,
  synthesizeAnswer,
  titleFromHtml
} from "../src/index.js";
import type { RetrievedChunk, SourceRecord } from "@comms-agent/shared";

const source: SourceRecord = {
  id: "source_test",
  kind: "text",
  title: "Test source",
  content: "Comms Agent notes",
  tags: ["test"],
  status: "ready",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

describe("core knowledge primitives", () => {
  it("chunks documents with provenance and local embeddings", () => {
    const chunks = chunkDocument({
      documentId: "doc_test",
      source,
      title: "OpenSearch Comms Agent",
      text:
        "# OpenSearch Comms Agent\n\nComms Agent uses OpenSearch as the retrieval backend. The agent chunks documents, embeds text, extracts entities, and returns cited answers with confidence."
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].sourceId).toBe(source.id);
    expect(chunks[0].embedding).toHaveLength(embedText("x").length);
  });

  it("extracts entities, relations, and claims from chunks", () => {
    const chunks = chunkDocument({
      documentId: "doc_extract",
      source,
      title: "Agentic OpenSearch",
      text:
        "Comms Agent is a TypeScript agent. OpenSearch provides hybrid retrieval. The agent indexes evidence and builds a graph."
    });
    const extracted = extractKnowledge(chunks);

    expect(extracted.entities.some((entity) => entity.name.includes("Comms Agent"))).toBe(true);
    expect(extracted.relations.length).toBeGreaterThan(0);
    expect(extracted.claims.length).toBeGreaterThan(0);
  });

  it("plans and ranks retrieval modes locally", () => {
    const chunks = chunkDocument({
      documentId: "doc_rank",
      source,
      title: "Hybrid retrieval",
      text:
        "Hybrid retrieval combines keyword search and vector search. OpenSearch stores chunks, entities, and relations for the knowledge base."
    });

    const mode = planQueryMode("How does hybrid retrieval work?");
    const ranked = rankLocalChunks("What combines keyword and vector search?", chunks, mode, 3);

    expect(mode).toBe("agentic");
    expect(ranked[0].text).toMatch(/Hybrid retrieval/);
  });

  it("prioritizes specific title terms over generic official-page matches", () => {
    const chunks = [
      ...chunkDocument({
        documentId: "doc_company",
        source,
        title: "Income Tax Department - Domestic Company AY 2026-27",
        text:
          "Income Tax Act, 1961. Tax Slabs for Domestic Company for AY 2026-27. Income Tax Department details for company taxpayers and domestic companies."
      }),
      ...chunkDocument({
        documentId: "doc_salaried",
        source,
        title: "Returns and Forms Applicable for Salaried Individuals for AY 2026-27",
        text:
          "Income Tax Department guidance for salaried individuals. ITR-1 is applicable for a resident individual with income from salary or pension. Forms applicable for salaried individuals for AY 2026-27 include salary and pension return guidance."
      })
    ];

    const ranked = rankLocalChunks(
      "For AY 2026-27, what does the Income Tax Department source say about salaried individuals?",
      chunks,
      "hybrid",
      2
    );

    expect(ranked[0].title).toMatch(/Salaried Individuals/i);
  });

  it("abstains when retrieved chunks do not ground the question terms", () => {
    const unrelatedChunk = makeRetrievedChunk(
      "Tax policy notes describe international coordination and implementation timelines.",
      {
        keyword: 0,
        vector: 0.82
      }
    );

    const response = synthesizeAnswer({
      question: "Which database migration strategy is documented?",
      mode: "hybrid",
      retrievedChunks: [unrelatedChunk],
      entities: [],
      relations: [],
      trace: []
    });

    expect(response.answer).toMatch(/do not have enough grounded evidence/i);
    expect(response.confidence).toBeLessThan(0.25);
    expect(response.citations).toHaveLength(0);
  });

  it("formats answers as grounded briefs and filters generic page boilerplate", () => {
    const noisyChunk = makeRetrievedChunk(
      "full name email repo url demo video url notes optional visibility preference. The manual expects a comms agent build: an agent that ingests information, constructs a structured knowledge base, provides retrieval, and self-heals over time.",
      {
        keyword: 1,
        vector: 0.4
      }
    );

    const response = synthesizeAnswer({
      question: "What does the manual expect from a comms agent?",
      mode: "hybrid",
      retrievedChunks: [noisyChunk],
      entities: [],
      relations: [],
      trace: []
    });

    expect(response.answer).toMatch(/comms agent build/i);
    expect(response.answer).not.toMatch(/full name email/i);
    expect(response.citations[0].excerpt).not.toMatch(/full name email/i);
  });

  it("keeps HTML headings and table rows readable for citation titles and date answers", () => {
    const html =
      "<html><head><title>Fallback title | Example Site</title><meta property=\"og:title\" content=\"Avery Stone\"></head><body><h1>Avery Stone</h1><table><tr><th>Year</th><th>Single</th></tr><tr><td>1936</td><td>Morning Light</td></tr></table></body></html>";
    const text = stripHtml(html);

    expect(titleFromHtml(html, "fallback")).toBe("Avery Stone");
    expect(text).toMatch(/# Avery Stone/);
    expect(text).toMatch(/1936\s+\|\s+Morning Light/);
  });

  it("prefers date-bearing topical evidence over repeated entity-name matches", () => {
    const weakEntityMatch = makeRetrievedChunk(
      "In 1929, Avery Stone informally changed his first name after friends suggested a warmer stage identity.",
      {
        keyword: 1,
        vector: 0.4
      },
      "Avery Stone biography",
      "chunk_name"
    );
    const topicalDateMatch = makeRetrievedChunk(
      "Singles\nYear | Single | Chart.\n1936 | Morning Light | --.\n1938 | Evening Song | 12.",
      {
        keyword: 0.8,
        vector: 0.5
      },
      "Avery Stone discography",
      "chunk_song"
    );

    const response = synthesizeAnswer({
      question: "When did Avery Stone perform his first song?",
      mode: "hybrid",
      retrievedChunks: [weakEntityMatch, topicalDateMatch],
      entities: [],
      relations: [],
      trace: []
    });

    expect(response.answer).toMatch(/1936/);
    expect(response.answer).toMatch(/Morning Light/);
    expect(response.answer).not.toMatch(/changed his first name/i);
    expect(response.answer).not.toMatch(/Key points/i);
    expect(response.citations[0].title).toBe("Avery Stone discography");
  });

  it("recognizes low-specificity corpus inventory questions without matching substrings", () => {
    expect(isCorpusInventoryQuestion("what's there in this base?")).toBe(true);
    expect(isCorpusInventoryQuestion("What database migration strategy is documented?")).toBe(false);
  });
});

function makeRetrievedChunk(
  text: string,
  scoreBreakdown: RetrievedChunk["scoreBreakdown"],
  title = "Unrelated notes",
  id = "chunk_unrelated"
): RetrievedChunk {
  return {
    id,
    sourceId: source.id,
    documentId: "doc_unrelated",
    chunkIndex: 0,
    title,
    text,
    embedding: embedText(text),
    contentHash: "hash",
    tags: [],
    createdAt: new Date().toISOString(),
    score: Math.max(...Object.values(scoreBreakdown).filter((score): score is number => typeof score === "number")),
    scoreBreakdown
  };
}

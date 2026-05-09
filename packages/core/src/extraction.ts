import type { ClaimRecord, EntityRecord, KnowledgeChunk, RelationRecord } from "@comms-agent/shared";
import { stableId } from "./hash.js";
import { splitSentences } from "./text.js";

const ENTITY_STOPWORDS = new Set([
  "The",
  "This",
  "That",
  "These",
  "Those",
  "When",
  "Where",
  "Because",
  "Open",
  "Source"
]);

export interface ExtractionResult {
  entities: EntityRecord[];
  relations: RelationRecord[];
  claims: ClaimRecord[];
}

export function extractKnowledge(chunks: KnowledgeChunk[]): ExtractionResult {
  const entityMap = new Map<string, EntityRecord>();
  const relationMap = new Map<string, RelationRecord>();
  const claimMap = new Map<string, ClaimRecord>();

  for (const chunk of chunks) {
    const entities = extractEntitiesFromText(chunk.text);
    for (const entity of entities) {
      const normalizedName = normalizeEntityName(entity);
      const existing = entityMap.get(normalizedName);
      if (existing) {
        existing.evidenceChunkIds = unique([...existing.evidenceChunkIds, chunk.id]);
        existing.confidence = Math.min(0.95, existing.confidence + 0.03);
        existing.updatedAt = new Date().toISOString();
        continue;
      }
      const now = new Date().toISOString();
      entityMap.set(normalizedName, {
        id: stableId("entity", normalizedName),
        name: entity,
        normalizedName,
        type: inferEntityType(entity),
        aliases: [],
        confidence: 0.62,
        evidenceChunkIds: [chunk.id],
        createdAt: now,
        updatedAt: now
      });
    }

    for (const relation of extractRelationsFromText(chunk.text)) {
      const id = stableId(
        "relation",
        `${relation.subject}:${relation.predicate}:${relation.object}:${chunk.id}`
      );
      relationMap.set(id, {
        id,
        subject: relation.subject,
        predicate: relation.predicate,
        object: relation.object,
        confidence: relation.confidence,
        evidenceChunkIds: [chunk.id],
        createdAt: new Date().toISOString()
      });
    }

    for (const sentence of splitSentences(chunk.text).slice(0, 6)) {
      if (sentence.length < 45 || sentence.length > 320) {
        continue;
      }
      const confidence = sentence.includes(" may ") || sentence.includes(" might ") ? 0.48 : 0.68;
      const id = stableId("claim", `${sentence}:${chunk.id}`);
      claimMap.set(id, {
        id,
        text: sentence,
        confidence,
        evidenceChunkIds: [chunk.id],
        createdAt: new Date().toISOString()
      });
    }
  }

  return {
    entities: [...entityMap.values()],
    relations: [...relationMap.values()],
    claims: [...claimMap.values()]
  };
}

export function normalizeEntityName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function extractEntitiesFromText(text: string): string[] {
  const matches = text.match(/\b[A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*){0,4}\b/g) ?? [];
  return unique(
    matches
      .map((match) => match.trim())
      .filter((match) => match.length > 2)
      .filter((match) => !ENTITY_STOPWORDS.has(match))
      .filter((match) => !/^\d+$/.test(match))
  ).slice(0, 24);
}

function extractRelationsFromText(
  text: string
): Array<{ subject: string; predicate: string; object: string; confidence: number }> {
  const relations: Array<{ subject: string; predicate: string; object: string; confidence: number }> = [];
  const patterns = [
    /\b([A-Z][A-Za-z0-9 ]{2,50})\s+(?:is|are|was|were)\s+(?:a|an|the)?\s*([A-Za-z][^.]{8,90})/g,
    /\b([A-Z][A-Za-z0-9 ]{2,50})\s+(?:uses|supports|provides|builds|ingests|indexes)\s+([A-Za-z][^.]{4,80})/g
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const subject = (match[1] ?? "").trim();
      const object = (match[2] ?? "").trim();
      if (!subject || !object || subject.length > 70 || object.length > 110) {
        continue;
      }
      relations.push({
        subject,
        predicate: pattern.source.includes("uses") ? "acts_on" : "is",
        object,
        confidence: 0.58
      });
    }
  }

  return relations.slice(0, 16);
}

function inferEntityType(entity: string): string {
  if (/\b(AI|ML|API|SDK|URL|HTTP|MCP)\b/.test(entity)) {
    return "concept";
  }
  if (entity.includes("OpenSearch") || entity.includes("Comms Agent")) {
    return "organization_or_product";
  }
  if (entity.includes("Agent") || entity.includes("Search")) {
    return "system";
  }
  return "entity";
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

import type { KnowledgeChunk, SourceRecord } from "@knowledge-brain/shared";
import type { Tiktoken } from "js-tiktoken/lite";
import { getEncoding } from "js-tiktoken";
import { sha256, stableId } from "./hash.js";
import {
  embedText,
  type EmbeddingProvider,
  LOCAL_EMBEDDING_MODEL,
  LOCAL_EMBEDDING_VERSION,
  EMBEDDING_DIMENSIONS
} from "./embeddings.js";
import { normalizeWhitespace } from "./text.js";

export interface ChunkDocumentInput {
  documentId: string;
  source: SourceRecord;
  title: string;
  text: string;
  uri?: string;
}

export interface ChunkingOptions {
  targetTokens?: number;
  overlapTokens?: number;
  embedLocally?: boolean;
  /**
   * Deprecated compatibility knobs. If supplied, they are converted to approximate
   * token budgets; production ingestion should prefer targetTokens/overlapTokens.
   */
  targetWords?: number;
  overlapWords?: number;
}

export const DEFAULT_TARGET_TOKENS = 750;
export const DEFAULT_OVERLAP_TOKENS = 100;
const MIN_CHUNK_TOKENS = 8;
const MAX_CHUNK_TOKENS = 950;

export function chunkDocument(
  input: ChunkDocumentInput,
  options: ChunkingOptions = {}
): KnowledgeChunk[] {
  const targetTokens = options.targetTokens ?? approximateTokens(options.targetWords) ?? DEFAULT_TARGET_TOKENS;
  const overlapTokens = options.overlapTokens ?? approximateTokens(options.overlapWords) ?? DEFAULT_OVERLAP_TOKENS;
  const embedLocally = options.embedLocally ?? true;
  const normalizedText = normalizeWhitespace(input.text);
  const sections = splitByHeadings(normalizedText);
  const chunks: KnowledgeChunk[] = [];

  for (const section of sections) {
    const words = wordsWithOffsets(section.text, section.startOffset);
    if (words.length === 0) {
      continue;
    }

    for (let cursor = 0; cursor < words.length;) {
      const end = chooseWindowEnd(words, cursor, targetTokens);
      const slice = words.slice(cursor, end);
      const text = normalizeWhitespace(slice.map((word) => word.value).join(" "));
      const tokenCount = countTokens(text);
      if (text.length < 40 || tokenCount < MIN_CHUNK_TOKENS) {
        if (end >= words.length) {
          break;
        }
        cursor = end;
        continue;
      }

      const chunkIndex = chunks.length;
      const embedding = embedLocally ? embedText(text) : [];
      chunks.push({
        id: stableId("chunk", `${input.documentId}:${chunkIndex}:${text}`),
        sourceId: input.source.id,
        documentId: input.documentId,
        chunkIndex,
        title: section.heading || input.title,
        text,
        embedding,
        contentHash: sha256(text),
        uri: input.uri,
        tags: input.source.tags ?? [],
        createdAt: new Date().toISOString(),
        sectionHeading: section.heading,
        tokenCount,
        startOffset: slice[0]?.start ?? section.startOffset,
        endOffset: slice.at(-1)?.end ?? section.endOffset,
        metadata: {
          sourceKind: input.source.kind
        },
        embeddingProvider: embedLocally ? "local" : undefined,
        embeddingModel: embedLocally ? LOCAL_EMBEDDING_MODEL : undefined,
        embeddingDimensions: embedLocally ? EMBEDDING_DIMENSIONS : undefined,
        embeddingVersion: embedLocally ? LOCAL_EMBEDDING_VERSION : undefined,
        embeddingStatus: embedLocally ? "embedded" : "pending",
        indexingStatus: "pending"
      });

      if (end >= words.length) {
        break;
      }
      const nextCursor = chooseOverlapCursor(words, end, overlapTokens);
      cursor = nextCursor > cursor ? nextCursor : end;
    }
  }

  return chunks;
}

export async function embedChunks(
  chunks: KnowledgeChunk[],
  provider: EmbeddingProvider
): Promise<KnowledgeChunk[]> {
  const embeddings = await provider.embedTexts(chunks.map((chunk) => chunk.text));
  return chunks.map((chunk, index) => {
    const result = embeddings[index];
    return {
      ...chunk,
      embedding: result?.embedding ?? [],
      embeddingProvider: result?.provider ?? provider.provider,
      embeddingModel: result?.model ?? provider.model,
      embeddingDimensions: result?.dimensions ?? provider.dimensions,
      embeddingVersion: result?.version ?? provider.version,
      embeddingStatus: result ? "embedded" : "failed"
    };
  });
}

export function countTokens(text: string): number {
  return encoder().encode(text).length;
}

interface Section {
  heading?: string;
  text: string;
  startOffset: number;
  endOffset: number;
}

interface WordOffset {
  value: string;
  start: number;
  end: number;
}

function splitByHeadings(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Array<{ heading?: string; text: string[]; startOffset: number }> = [];
  let offset = 0;
  let current: { heading?: string; text: string[]; startOffset: number } = { text: [], startOffset: 0 };

  for (const line of lines) {
    const heading = line.match(/^#{1,4}\s+(.+)$/);
    if (heading && current.text.length > 0) {
      sections.push(current);
      current = { heading: heading[1]?.trim(), text: [], startOffset: offset + line.length + 1 };
      offset += line.length + 1;
      continue;
    }
    if (heading) {
      current.heading = heading[1]?.trim();
      current.startOffset = offset + line.length + 1;
      offset += line.length + 1;
      continue;
    }
    current.text.push(line);
    offset += line.length + 1;
  }

  if (current.text.length > 0) {
    sections.push(current);
  }

  return sections
    .map((section) => {
      const sectionText = normalizeWhitespace(section.text.join("\n"));
      return {
        heading: section.heading,
        text: sectionText,
        startOffset: section.startOffset,
        endOffset: section.startOffset + sectionText.length
      };
    })
    .filter((section) => section.text.length > 0);
}

function wordsWithOffsets(text: string, baseOffset: number): WordOffset[] {
  return [...text.matchAll(/\S+/g)].map((match) => ({
    value: match[0],
    start: baseOffset + (match.index ?? 0),
    end: baseOffset + (match.index ?? 0) + match[0].length
  }));
}

function chooseWindowEnd(words: WordOffset[], cursor: number, targetTokens: number): number {
  let end = Math.min(words.length, cursor + 1);
  let bestEnd = end;
  while (end <= words.length) {
    const tokenCount = countTokens(words.slice(cursor, end).map((word) => word.value).join(" "));
    bestEnd = end;
    if (tokenCount >= targetTokens || tokenCount >= MAX_CHUNK_TOKENS) {
      break;
    }
    end += 1;
  }
  return Math.min(bestEnd, words.length);
}

function chooseOverlapCursor(words: WordOffset[], end: number, overlapTokens: number): number {
  let cursor = end - 1;
  while (cursor > 0) {
    const tokenCount = countTokens(words.slice(cursor, end).map((word) => word.value).join(" "));
    if (tokenCount >= overlapTokens) {
      return cursor;
    }
    cursor -= 1;
  }
  return Math.max(0, end - 1);
}

function approximateTokens(words?: number): number | undefined {
  return words === undefined ? undefined : Math.max(MIN_CHUNK_TOKENS, Math.round(words * 1.35));
}

let cachedEncoder: Tiktoken | undefined;

function encoder(): Tiktoken {
  cachedEncoder ??= getEncoding("cl100k_base");
  return cachedEncoder;
}

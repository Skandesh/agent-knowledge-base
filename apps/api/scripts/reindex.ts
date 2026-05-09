import { buildApp } from "../src/app.js";
import type { EntityRecord, KnowledgeChunk, RelationRecord } from "@comms-agent/shared";
import { embedChunks } from "@comms-agent/core";

const app = await buildApp();
const brain = app as unknown as {
  brain: {
    db: {
      listChunks: () => KnowledgeChunk[];
      listEntities: () => EntityRecord[];
      listRelations: () => RelationRecord[];
      saveChunks: (chunks: KnowledgeChunk[]) => void;
      createEmbeddingJobs: (chunks: KnowledgeChunk[]) => void;
      markChunksIndexed: (chunkIds: string[]) => void;
    };
    embeddingProvider: Parameters<typeof embedChunks>[1];
    search: {
      health: () => Promise<"ok" | "degraded">;
      resetIndices: () => Promise<void>;
      reindexAll: (
        chunks: KnowledgeChunk[],
        entities: EntityRecord[],
        relations: RelationRecord[]
      ) => Promise<void>;
    };
  };
};

if ((await brain.brain.search.health()) !== "ok") {
  await app.close();
  throw new Error("OpenSearch is not healthy; start it before reindexing.");
}

const chunks = brain.brain.db.listChunks();
const entities = brain.brain.db.listEntities();
const relations = brain.brain.db.listRelations();
const embeddedChunks = await embedChunks(chunks, brain.brain.embeddingProvider);
brain.brain.db.saveChunks(embeddedChunks);
brain.brain.db.createEmbeddingJobs(embeddedChunks);

await brain.brain.search.resetIndices();
await brain.brain.search.reindexAll(embeddedChunks, entities, relations);
brain.brain.db.markChunksIndexed(embeddedChunks.map((chunk) => chunk.id));
await app.close();

console.log(
  `Reindexed OpenSearch with ${embeddedChunks.length} chunks, ${entities.length} entities, and ${relations.length} relations.`
);

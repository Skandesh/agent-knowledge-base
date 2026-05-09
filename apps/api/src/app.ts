import cors from "@fastify/cors";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { HealScope, QueryRequest, SourceInput } from "@knowledge-brain/shared";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { KnowledgeBrain } from "./knowledgeBrain.js";

export interface BuildAppOptions {
  config?: Partial<AppConfig>;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info"
    }
  });
  await app.register(cors, {
    origin: true
  });

  const brain = new KnowledgeBrain(loadConfig(options.config));
  app.decorate("brain", brain);

  app.get("/health", async () => brain.health());
  app.get("/stages", async () => brain.stages());
  app.get("/sources", async () => brain.listSources());
  app.post<{ Body: SourceInput }>("/sources", async (request, reply) => {
    const source = await brain.createSource(request.body);
    return reply.code(201).send(source);
  });

  app.get("/ingest-runs", async () => brain.listIngestRuns());
  app.post<{ Body: { sourceId?: string; source?: SourceInput } }>("/ingest-runs", async (request) =>
    brain.runIngest(request.body)
  );
  app.get<{ Params: { id: string } }>("/ingest-runs/:id", async (request, reply) => {
    const run = brain.getIngestRun(request.params.id);
    if (!run) {
      return reply.code(404).send({ error: "Ingest run not found" });
    }
    return run;
  });

  app.post<{ Body: QueryRequest }>("/query", async (request) => brain.query(request.body));
  app.get("/graph", async () => brain.graph());

  app.get("/heal-runs", async () => brain.listHealRuns());
  app.post<{ Body: { scope?: HealScope } }>("/heal-runs", async (request) =>
    brain.runHeal(request.body?.scope ?? "all")
  );
  app.post<{ Params: { actionId: string }; Body: { candidateId: string } }>(
    "/heal-actions/:actionId/approve-source",
    async (request) =>
      brain.approveSourceCandidate({
        actionId: request.params.actionId,
        candidateId: request.body.candidateId
      })
  );
  app.get<{ Params: { id: string } }>("/heal-runs/:id", async (request, reply) => {
    const run = brain.getHealRun(request.params.id);
    if (!run) {
      return reply.code(404).send({ error: "Heal run not found" });
    }
    return run;
  });

  app.addHook("onClose", async () => {
    brain.db.close();
  });

  return app;
}

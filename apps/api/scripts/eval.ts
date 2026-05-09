import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildApp } from "../src/app.js";
import {
  EXPECTED_SOURCES_BY_QUESTION,
  GOLDEN_CORPUS,
  GOLDEN_QUESTIONS,
  type GoldenQuestion
} from "../evals/golden.js";

interface EvalCaseResult {
  id: string;
  passed: boolean;
  confidence: number;
  citations: number;
  status: string;
  expectedSources: string[];
  retrievedSources: string[];
  citedSources: string[];
  retrievalRecallAt10: number;
  citationSupport: boolean;
  answerCorrect: boolean;
  noAnswerCorrect: boolean;
  matchedTerms: string[];
  missingTerms: string[];
  answer: string;
}

interface EvalReport {
  passed: boolean;
  score: number;
  total: number;
  passedCases: number;
  failedCases: number;
  metrics: {
    retrievalRecallAt10: number;
    citationSupportRate: number;
    noAnswerPrecision: number;
    answerCorrectness: number;
  };
  generatedAt: string;
  results: EvalCaseResult[];
}

const outputPath = resolve(process.env.EVAL_REPORT_PATH ?? "./data/eval-report.json");
const databasePath = resolve(process.env.EVAL_DATABASE_PATH ?? "./data/eval.sqlite");

await rm(databasePath, { force: true });
const app = await buildApp({
  config: {
    databasePath,
    staleSourceHours: 0,
    embeddingProvider: "local",
    generationProvider: "local",
    rerankerProvider: "local",
    modelProvider: "local"
  }
});
const brain = app as unknown as {
  brain: {
    search: {
      health: () => Promise<"ok" | "degraded">;
      resetIndices: () => Promise<void>;
    };
  };
};

if ((await brain.brain.search.health()) === "ok") {
  await brain.brain.search.resetIndices();
}

for (const source of GOLDEN_CORPUS) {
  const response = await app.inject({
    method: "POST",
    url: "/ingest-runs",
    payload: { source }
  });
  if (response.statusCode !== 200 || response.json().status !== "completed") {
    throw new Error(`Failed to ingest eval source ${source.title}: ${response.body}`);
  }
}

const results: EvalCaseResult[] = [];
for (const golden of GOLDEN_QUESTIONS) {
  const result = await evaluateQuestion(golden);
  results.push(result);
  const marker = result.passed ? "PASS" : "FAIL";
  console.log(
    `${marker} ${golden.id} status=${result.status} recall@10=${result.retrievalRecallAt10.toFixed(2)} citationSupport=${result.citationSupport} answerCorrect=${result.answerCorrect}`
  );
}

const passedCases = results.filter((result) => result.passed).length;
const answerCases = results.filter((result) => result.expectedSources.length > 0);
const noAnswerCases = results.filter((result) => result.expectedSources.length === 0);
const report: EvalReport = {
  passed: passedCases === results.length,
  score: Number((passedCases / results.length).toFixed(3)),
  total: results.length,
  passedCases,
  failedCases: results.length - passedCases,
  metrics: {
    retrievalRecallAt10: average(answerCases.map((result) => result.retrievalRecallAt10)),
    citationSupportRate: average(answerCases.map((result) => (result.citationSupport ? 1 : 0))),
    noAnswerPrecision: average(noAnswerCases.map((result) => (result.noAnswerCorrect ? 1 : 0))),
    answerCorrectness: average(answerCases.map((result) => (result.answerCorrect ? 1 : 0)))
  },
  generatedAt: new Date().toISOString(),
  results
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2));
await app.close();

console.log(`Eval score ${(report.score * 100).toFixed(1)}% (${passedCases}/${results.length})`);
console.log(
  `Metrics recall@10=${report.metrics.retrievalRecallAt10.toFixed(2)} citationSupport=${report.metrics.citationSupportRate.toFixed(2)} noAnswerPrecision=${report.metrics.noAnswerPrecision.toFixed(2)} answerCorrectness=${report.metrics.answerCorrectness.toFixed(2)}`
);
console.log(`Report written to ${outputPath}`);

if (!report.passed) {
  process.exitCode = 1;
}

async function evaluateQuestion(golden: GoldenQuestion): Promise<EvalCaseResult> {
  const response = await app.inject({
    method: "POST",
    url: "/query",
    payload: {
      question: golden.question,
      mode: golden.mode,
      topK: 10,
      debug: true
    }
  });
  const expectedSources = golden.expectedSourceTitles ?? EXPECTED_SOURCES_BY_QUESTION[golden.id] ?? [];
  if (response.statusCode !== 200) {
    return {
      id: golden.id,
      passed: false,
      confidence: 0,
      citations: 0,
      status: "error",
      expectedSources,
      retrievedSources: [],
      citedSources: [],
      retrievalRecallAt10: 0,
      citationSupport: false,
      answerCorrect: false,
      noAnswerCorrect: false,
      matchedTerms: [],
      missingTerms: golden.expectedTerms,
      answer: response.body
    };
  }

  const body = response.json() as {
    status: string;
    answer: string;
    confidence: number;
    citations: Array<{ excerpt: string; title: string }>;
    retrievedChunks: Array<{ title: string }>;
    retrieval: {
      candidates: Array<{ title: string }>;
    };
  };
  const retrievedSources = unique([
    ...(body.retrievedChunks ?? []).map((chunk) => chunk.title),
    ...(body.retrieval?.candidates ?? []).map((candidate) => candidate.title)
  ]);
  const citedSources = unique(body.citations.map((citation) => citation.title));
  const matchedSources = expectedSources.filter((source) =>
    retrievedSources.some((title) => normalize(title).includes(normalize(source)))
  );
  const citedExpectedSources = expectedSources.filter((source) =>
    citedSources.some((title) => normalize(title).includes(normalize(source)))
  );
  const retrievalRecallAt10 = expectedSources.length === 0 ? 1 : matchedSources.length / expectedSources.length;
  const citationSupport = expectedSources.length === 0 || citedExpectedSources.length === expectedSources.length;
  const evidenceText = normalize(
    [body.answer, ...body.citations.map((citation) => `${citation.title} ${citation.excerpt}`)].join(" ")
  );
  const matchedTerms = golden.expectedTerms.filter((term) => evidenceText.includes(normalize(term)));
  const missingTerms = golden.expectedTerms.filter((term) => !matchedTerms.includes(term));
  const answerCorrect = golden.expectedTerms.length === 0 || matchedTerms.length === golden.expectedTerms.length;
  const noAnswerCorrect =
    (golden.expectedStatus ?? "answered") === "insufficient_evidence"
      ? body.status === "insufficient_evidence"
      : true;
  const passed =
    expectedSources.length === 0
      ? noAnswerCorrect
      : body.status === "answered" &&
        body.confidence >= golden.minConfidence &&
        retrievalRecallAt10 >= 1 &&
        citationSupport;

  return {
    id: golden.id,
    passed,
    confidence: body.confidence,
    citations: body.citations.length,
    status: body.status,
    expectedSources,
    retrievedSources,
    citedSources,
    retrievalRecallAt10,
    citationSupport,
    answerCorrect,
    noAnswerCorrect,
    matchedTerms,
    missingTerms,
    answer: body.answer
  };
}

function normalize(input: string): string {
  return input.toLowerCase().replace(/[^\w/.-]+/g, " ").trim();
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 1;
  }
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

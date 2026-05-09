import type {
  GraphResponse,
  HealRun,
  IngestRun,
  QueryRequest,
  QueryResponse,
  SourceInput,
  SourceRecord,
  StageStatus,
  SystemHealth
} from "@comms-agent/shared";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8787";

export async function getHealth(): Promise<SystemHealth> {
  return request("/health");
}

export async function getStages(): Promise<StageStatus[]> {
  return request("/stages");
}

export async function getSources(): Promise<SourceRecord[]> {
  return request("/sources");
}

export async function getIngestRuns(): Promise<IngestRun[]> {
  return request("/ingest-runs");
}

export async function ingestSource(source: SourceInput): Promise<IngestRun> {
  return request("/ingest-runs", {
    method: "POST",
    body: JSON.stringify({ source })
  });
}

export async function queryKnowledge(payload: QueryRequest): Promise<QueryResponse> {
  return request("/query", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function getGraph(): Promise<GraphResponse> {
  return request("/graph");
}

export async function getHealRuns(): Promise<HealRun[]> {
  return request("/heal-runs");
}

export async function runHeal(): Promise<HealRun> {
  return request("/heal-runs", {
    method: "POST",
    body: JSON.stringify({ scope: "all" })
  });
}

export async function approveSourceCandidate(actionId: string, candidateId: string): Promise<IngestRun> {
  return request(`/heal-actions/${encodeURIComponent(actionId)}/approve-source`, {
    method: "POST",
    body: JSON.stringify({ candidateId })
  });
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "content-type": "application/json",
      ...init.headers
    },
    ...init
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return (await response.json()) as T;
}

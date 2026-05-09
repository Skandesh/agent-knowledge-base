import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Brain,
  Check,
  CheckCircle2,
  CircleAlert,
  Clipboard,
  Copy,
  Database,
  Download,
  ExternalLink,
  FileText,
  Folder,
  Github,
  GitBranch,
  HeartPulse,
  Link2,
  ListChecks,
  Loader2,
  Play,
  PlusCircle,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  X,
  type LucideIcon
} from "lucide-react";
import type {
  GraphResponse,
  HealFinding,
  HealRun,
  IngestRun,
  IngestStage,
  ProviderStatus,
  QueryMode,
  QueryResponse,
  SourceInput,
  SourceKind,
  SourceRecord,
  StageStatus,
  SystemHealth
} from "@knowledge-brain/shared";
import {
  approveSourceCandidate,
  getGraph,
  getHealRuns,
  getHealth,
  getIngestRuns,
  getSources,
  getStages,
  ingestSource,
  queryKnowledge,
  runHeal
} from "./api.js";

const SOURCE_KINDS: SourceKind[] = ["url", "text", "file", "directory", "github_repo"];
const QUERY_MODES: Array<QueryMode | "auto"> = ["auto", "hybrid", "agentic", "semantic", "keyword", "graph"];
const INSPECTOR_TABS = ["evidence", "trace", "retrieval", "graph", "health"] as const;

type ConsoleView = "ask" | "sources" | "system";
type InspectorTab = (typeof INSPECTOR_TABS)[number];
type Tone = "ok" | "warn" | "err" | "info" | "neutral";
type BusyState = "refresh" | "ingest" | "query" | "heal" | "approve";

export function App() {
  const [health, setHealth] = useState<SystemHealth | undefined>();
  const [stages, setStages] = useState<StageStatus[]>([]);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [runs, setRuns] = useState<IngestRun[]>([]);
  const [graph, setGraph] = useState<GraphResponse>({ entities: [], relations: [] });
  const [healRuns, setHealRuns] = useState<HealRun[]>([]);
  const [queryResult, setQueryResult] = useState<QueryResponse | undefined>();
  const [busy, setBusy] = useState<BusyState | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [activeView, setActiveView] = useState<ConsoleView>("ask");
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("evidence");
  const [sourceKind, setSourceKind] = useState<SourceKind>("url");
  const [sourceValue, setSourceValue] = useState("");
  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceTags, setSourceTags] = useState("");
  const [question, setQuestion] = useState("What changed in the indexed knowledge base recently?");
  const [queryMode, setQueryMode] = useState<QueryMode | "auto">("auto");
  const [strict, setStrict] = useState(true);

  const refresh = useCallback(async () => {
    const [nextHealth, nextStages, nextSources, nextRuns, nextGraph, nextHealRuns] = await Promise.all([
      getHealth(),
      getStages(),
      getSources(),
      getIngestRuns(),
      getGraph(),
      getHealRuns()
    ]);
    setHealth(nextHealth);
    setStages(nextStages);
    setSources(nextSources);
    setRuns(nextRuns);
    setGraph(nextGraph);
    setHealRuns(nextHealRuns);
  }, []);

  useEffect(() => {
    void refresh().catch((caught) => setError(errorMessage(caught)));
  }, [refresh]);

  useEffect(() => {
    if (!addSourceOpen) {
      return;
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setAddSourceOpen(false);
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [addSourceOpen]);

  const latestRun = runs[0];
  const latestHeal = healRuns[0];
  const selectedRun = useMemo(() => (selectedRunId ? runs.find((run) => run.id === selectedRunId) : undefined) ?? latestRun, [
    latestRun,
    runs,
    selectedRunId
  ]);
  const completedStages = useMemo(
    () => new Set(latestRun?.stageHistory.filter((stage) => stage.status === "completed").map((stage) => stage.stage) ?? []),
    [latestRun]
  );
  const failedStages = useMemo(
    () => new Set(latestRun?.stageHistory.filter((stage) => stage.status === "failed").map((stage) => stage.stage) ?? []),
    [latestRun]
  );
  const indexedCount = health?.indexedChunks ?? 0;
  const readiness = useMemo(() => readinessLabel(health, indexedCount), [health, indexedCount]);
  const degraded = health ? readiness !== "Production ready" && readiness !== "Awaiting ingest" : false;

  useEffect(() => {
    if (selectedRunId && runs.length > 0 && !runs.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(undefined);
    }
  }, [runs, selectedRunId]);

  async function handleRefresh() {
    setBusy("refresh");
    setError(undefined);
    try {
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(undefined);
    }
  }

  async function handleIngest(event?: FormEvent) {
    event?.preventDefault();
    const value = sourceValue.trim();
    if (!value) {
      return;
    }

    setBusy("ingest");
    setError(undefined);
    try {
      const title = sourceTitle.trim();
      const tags = parseTags(sourceTags);
      const source: SourceInput =
        sourceKind === "text"
          ? {
              kind: sourceKind,
              ...(title ? { title } : {}),
              content: value,
              ...(tags.length > 0 ? { tags } : {})
            }
          : {
              kind: sourceKind,
              ...(title ? { title } : {}),
              uri: value,
              ...(tags.length > 0 ? { tags } : {})
            };
      const run = await ingestSource(source);
      setSelectedRunId(run.id);
      setActiveView("sources");
      setAddSourceOpen(false);
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(undefined);
    }
  }

  async function handleQuery(event?: FormEvent) {
    event?.preventDefault();
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) {
      return;
    }

    setBusy("query");
    setError(undefined);
    try {
      const result = await queryKnowledge({
        question: trimmedQuestion,
        mode: queryMode === "auto" ? undefined : queryMode,
        topK: 8,
        strict,
        debug: true
      });
      setQueryResult(result);
      setInspectorTab(result.citations.length > 0 ? "evidence" : "retrieval");
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(undefined);
    }
  }

  async function handleHeal() {
    setBusy("heal");
    setError(undefined);
    try {
      await runHeal();
      setActiveView("system");
      setInspectorTab("health");
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(undefined);
    }
  }

  async function handleApproveSourceCandidate(actionId: string, candidateId: string) {
    setBusy("approve");
    setError(undefined);
    try {
      await approveSourceCandidate(actionId, candidateId);
      setActiveView("sources");
      setAddSourceOpen(false);
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(undefined);
    }
  }

  const navItems: Array<{
    id: ConsoleView;
    label: string;
    icon: LucideIcon;
    count?: number;
    tone?: Tone;
  }> = [
    { id: "ask", label: "Ask", icon: Sparkles, tone: queryResult ? statusTone(queryResult.status) : undefined },
    { id: "sources", label: "Sources", icon: Database, count: sources.length },
    { id: "system", label: "System", icon: HeartPulse, count: health?.failedJobs, tone: degraded ? "warn" : "ok" }
  ];

  function switchView(view: ConsoleView) {
    setActiveView(view);
    setAddSourceOpen(false);
  }

  function openAddSource() {
    setActiveView("sources");
    setAddSourceOpen(true);
  }

  function selectRun(runId: string) {
    setSelectedRunId(runId);
    setActiveView("sources");
    setAddSourceOpen(false);
  }

  return (
    <main className="kb-app-shell">
      <header className="kb-topbar">
        <div className="kb-brand">
          <span className="kb-logo" aria-hidden="true">
            kb
          </span>
          <div className="kb-brand-text">
            <strong>Knowledge Brain</strong>
          </div>
        </div>

        <TopbarSummary readiness={readiness} latestRun={latestRun} indexedCount={indexedCount} />

        <div className="kb-topbar-status">
          <button className="kb-icon-button" type="button" onClick={handleRefresh} title="Refresh" disabled={busy === "refresh"}>
            <RefreshCw aria-hidden="true" className={busy === "refresh" ? "kb-spin" : undefined} />
          </button>
        </div>
      </header>

      <section className={activeView === "ask" ? "kb-console" : "kb-console kb-console-wide"}>
        <aside className="kb-sidebar">
          <div className="kb-eyebrow">Workspace</div>
          <nav className="kb-nav-list" aria-label="Workspace">
            {navItems.map((item) => (
              <button
                key={item.id}
                className="kb-nav-item"
                data-active={activeView === item.id}
                type="button"
                onClick={() => switchView(item.id)}
              >
                <item.icon aria-hidden="true" />
                <span>{item.label}</span>
                {item.tone ? <span className="kb-pip" data-tone={item.tone} /> : null}
                {typeof item.count === "number" ? <span className="kb-count">{item.count}</span> : null}
              </button>
            ))}
          </nav>

          <div className="kb-sidebar-section">
            <div className="kb-eyebrow">Recent runs</div>
            <RecentRuns runs={runs} selectedRunId={selectedRun?.id} onSelectRun={selectRun} />
          </div>

          <button className="kb-btn kb-sidebar-action" type="button" onClick={openAddSource}>
            <Database aria-hidden="true" />
            Add source
          </button>
        </aside>

        <section className="kb-workspace" aria-live="polite">
          {error ? <ErrorBanner message={error} /> : null}
          {activeView === "ask" ? (
            <AskWorkspace
              question={question}
              setQuestion={setQuestion}
              queryMode={queryMode}
              setQueryMode={setQueryMode}
              strict={strict}
              setStrict={setStrict}
              queryResult={queryResult}
              busy={busy}
              sources={sources}
              onQuery={handleQuery}
              onOpenSources={openAddSource}
              onRepairSourceGap={handleHeal}
              onLoosenStrict={() => setStrict(false)}
            />
          ) : null}
          {activeView === "sources" ? (
            <SourcesWorkspace
              sources={sources}
              sourceKind={sourceKind}
              setSourceKind={setSourceKind}
              sourceTitle={sourceTitle}
              setSourceTitle={setSourceTitle}
              sourceValue={sourceValue}
              setSourceValue={setSourceValue}
              sourceTags={sourceTags}
              setSourceTags={setSourceTags}
              latestRun={latestRun}
              selectedRun={selectedRun}
              stages={stages}
              completedStages={completedStages}
              failedStages={failedStages}
              busy={busy}
              addSourceOpen={addSourceOpen}
              onOpenAddSource={openAddSource}
              onCloseAddSource={() => setAddSourceOpen(false)}
              onIngest={handleIngest}
              onRefresh={handleRefresh}
            />
          ) : null}
          {activeView === "system" ? (
            <SystemWorkspace
              health={health}
              latestHeal={latestHeal}
              busy={busy}
              onHeal={handleHeal}
              onRefresh={handleRefresh}
              onApproveSourceCandidate={handleApproveSourceCandidate}
            />
          ) : null}

          {activeView === "ask" ? (
            <MobileDetailStack
              queryResult={queryResult}
              graph={graph}
              health={health}
              latestHeal={latestHeal}
              onHeal={handleHeal}
              busy={busy}
            />
          ) : null}
        </section>

        {activeView === "ask" ? (
          <Inspector
            activeTab={inspectorTab}
            setActiveTab={setInspectorTab}
            queryResult={queryResult}
            graph={graph}
            health={health}
            latestHeal={latestHeal}
            busy={busy}
            onHeal={handleHeal}
          />
        ) : null}
      </section>

      <nav className="kb-mobile-nav" aria-label="Mobile workspace">
        {navItems.map((item) => (
          <button key={item.id} type="button" data-active={activeView === item.id} onClick={() => switchView(item.id)}>
            <item.icon aria-hidden="true" />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </main>
  );
}

function AskWorkspace({
  question,
  setQuestion,
  queryMode,
  setQueryMode,
  strict,
  setStrict,
  queryResult,
  busy,
  sources,
  onQuery,
  onOpenSources,
  onRepairSourceGap,
  onLoosenStrict
}: {
  question: string;
  setQuestion: (question: string) => void;
  queryMode: QueryMode | "auto";
  setQueryMode: (mode: QueryMode | "auto") => void;
  strict: boolean;
  setStrict: (strict: boolean) => void;
  queryResult?: QueryResponse;
  busy?: BusyState;
  sources: SourceRecord[];
  onQuery: (event?: FormEvent) => void;
  onOpenSources: () => void;
  onRepairSourceGap: () => void;
  onLoosenStrict: () => void;
}) {
  return (
    <section className="kb-ask">
      <form className="kb-query-band" onSubmit={onQuery}>
        <div className="kb-query-field">
          <Search aria-hidden="true" />
          <textarea
            value={question}
            rows={2}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask a question about the indexed knowledge base..."
          />
          <button className="kb-btn" data-variant="primary" type="submit" disabled={busy === "query" || !question.trim()}>
            {busy === "query" ? <Loader2 aria-hidden="true" className="kb-spin" /> : <Send aria-hidden="true" />}
            Ask
          </button>
        </div>
        <div className="kb-query-options">
          <label>
            Mode
            <select value={queryMode} onChange={(event) => setQueryMode(event.target.value as QueryMode | "auto")}>
              {QUERY_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {formatQueryMode(mode)}
                </option>
              ))}
            </select>
          </label>
          <label className="kb-toggle">
            <input type="checkbox" checked={strict} onChange={(event) => setStrict(event.target.checked)} />
            <span>Strict citations</span>
          </label>
          <span className="kb-query-meta">topK 8 · debug trace on</span>
        </div>
      </form>

      {busy === "query" ? <StreamingState /> : null}

      {busy !== "query" && queryResult?.status === "answered" ? <AnswerBlock result={queryResult} /> : null}

      {busy !== "query" && queryResult?.status === "insufficient_evidence" ? (
        <LowConfidenceBlock
          result={queryResult}
          busy={busy}
          onLoosenStrict={onLoosenStrict}
          onOpenSources={onOpenSources}
          onRepairSourceGap={onRepairSourceGap}
        />
      ) : null}

      {busy !== "query" && !queryResult && sources.length === 0 ? <EmptySourceState onOpenSources={onOpenSources} /> : null}

      {busy !== "query" && !queryResult && sources.length > 0 ? (
        <section className="kb-empty-answer">
          <Sparkles aria-hidden="true" />
          <div>
            <h2>Ask with evidence.</h2>
            <p>Answers will appear here with citations, confidence, verification, retrieval diagnostics, and trace.</p>
          </div>
        </section>
      ) : null}
    </section>
  );
}

function AnswerBlock({ result }: { result: QueryResponse }) {
  const unsupported = result.claims.filter((claim) => !claim.supported).length;
  const verificationLabel =
    result.verification.status === "passed"
      ? "verified"
      : result.verification.status === "degraded"
        ? "verification degraded"
        : "verification failed";

  return (
    <section className="kb-answer-block">
      <div className="kb-answer-meta">
        <span className="kb-eyebrow">Answer</span>
        <StatusChip tone={verificationTone(result.verification.status)} icon={result.verification.status === "passed" ? Check : AlertTriangle}>
          {verificationLabel}
        </StatusChip>
        {unsupported > 0 ? <StatusChip tone="warn">{unsupported} unsupported</StatusChip> : null}
        <span className="kb-spacer" />
        <span className="kb-mono kb-num">conf {formatScore(result.confidence)}</span>
        <span className="kb-mono kb-num">{pluralize(result.citations.length, "citation")}</span>
      </div>

      <article className="kb-answer-copy">{renderAnswer(result.answer)}</article>

      <section className="kb-answer-summary">
        <MetricBlock label="Mode" value={formatQueryMode(result.mode)} />
        <MetricBlock label="Candidates" value={`${result.retrieval.finalK}/${result.retrieval.candidatePoolSize}`} />
        <MetricBlock label="Claims" value={`${result.verification.supportedClaimIds.length}/${result.claims.length}`} />
        <MetricBlock label="Verification" value={result.verification.status} tone={verificationTone(result.verification.status)} />
      </section>

      <section className="kb-claims">
        <div className="kb-section-title">
          <span className="kb-eyebrow">Claims</span>
          <span>{result.claims.length} total</span>
        </div>
        {result.claims.length > 0 ? (
          result.claims.map((claim) => (
            <div className="kb-claim-row" key={claim.id}>
              <span className="kb-pip" data-tone={claim.supported ? "ok" : "warn"} />
              <p>{claim.text}</p>
              <span className="kb-mono kb-num">conf {formatScore(claim.confidence)}</span>
              <span className="kb-count">{claim.citationChunkIds.length} cited</span>
            </div>
          ))
        ) : (
          <p className="kb-muted-line">No claim-level verifier output was returned.</p>
        )}
      </section>

      {result.verification.failures.length > 0 ? (
        <VerificationFailureList result={result} />
      ) : null}

      <div className="kb-answer-actions">
        <button className="kb-btn" type="button">
          <Copy aria-hidden="true" />
          Copy
        </button>
        <button className="kb-btn" type="button">
          <Download aria-hidden="true" />
          Export
        </button>
        <button className="kb-btn" data-variant="ghost" type="button">
          <RefreshCw aria-hidden="true" />
          Re-run
        </button>
      </div>
    </section>
  );
}

function VerificationFailureList({ result }: { result: QueryResponse }) {
  const claimById = new Map(result.claims.map((claim) => [claim.id, claim]));

  return (
    <section className="kb-failure-list">
      <div className="kb-section-title">
        <span className="kb-eyebrow">Verification failures</span>
        <span>{result.verification.failures.length} total</span>
      </div>
      {result.verification.failures.map((failure) => {
        const claim = claimById.get(failure.claimId);
        return (
          <div className="kb-failure-row" key={`${failure.claimId}-${failure.reason}`}>
            <strong>{failure.claimId}</strong>
            <div className="kb-failure-detail">
              <p>{claim?.text ?? "The verifier reported a missing claim."}</p>
              <span>{failure.reason}</span>
              {claim?.citationChunkIds.length ? (
                <code>cited {claim.citationChunkIds.join(", ")}</code>
              ) : (
                <code>no cited chunks</code>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function LowConfidenceBlock({
  result,
  busy,
  onLoosenStrict,
  onOpenSources,
  onRepairSourceGap
}: {
  result: QueryResponse;
  busy?: BusyState;
  onLoosenStrict: () => void;
  onOpenSources: () => void;
  onRepairSourceGap: () => void;
}) {
  const hasSourceGap = Boolean(result.sourceGaps?.length);

  return (
    <section className="kb-low-confidence">
      <div className="kb-answer-meta">
        <span className="kb-eyebrow">Answer</span>
        <StatusChip tone="warn" icon={AlertTriangle}>
          insufficient evidence
        </StatusChip>
        <span className="kb-spacer" />
        <span className="kb-mono kb-num">conf {formatScore(result.confidence)}</span>
      </div>
      <h2>Sources are insufficient to answer with confidence.</h2>
      <article className="kb-answer-copy">{renderAnswer(result.answer)}</article>
      <div className="kb-warning-box">
        <strong>Why confidence is low</strong>
        {result.verification.failures.length > 0 ? (
          <ul>
            {result.verification.failures.map((failure) => {
              const claim = result.claims.find((candidate) => candidate.id === failure.claimId);
              return (
                <li key={`${failure.claimId}-${failure.reason}`}>
                  {claim?.text ? `${claim.text} (${failure.reason})` : failure.reason}
                </li>
              );
            })}
          </ul>
        ) : (
          <p>The returned evidence did not satisfy the current verification threshold.</p>
        )}
      </div>
      {result.sourceGaps?.length ? (
        <section className="kb-source-gap-box">
          <strong>Source gap detected</strong>
          {result.sourceGaps.map((gap) => (
            <div className="kb-source-gap-row" key={gap.id}>
              <p>{gap.reason}</p>
              {gap.currentEvidence.length > 0 ? (
                <span className="kb-mono">current evidence: {gap.currentEvidence.join(", ")}</span>
              ) : null}
              <span className="kb-mono">suggested search: {gap.suggestedQuery}</span>
              <span>{gap.proposedAction}</span>
            </div>
          ))}
        </section>
      ) : null}
      <div className="kb-next-actions">
        <button className="kb-btn" type="button" onClick={onLoosenStrict}>
          Re-run without strict citations
        </button>
        {hasSourceGap ? (
          <button className="kb-btn" data-variant="primary" type="button" onClick={onRepairSourceGap} disabled={busy === "heal"}>
            {busy === "heal" ? <Loader2 aria-hidden="true" className="kb-spin" /> : <Search aria-hidden="true" />}
            {busy === "heal" ? "Finding sources" : "Find source candidates"}
          </button>
        ) : null}
        <button className="kb-btn" data-variant={hasSourceGap ? "ghost" : "primary"} type="button" onClick={onOpenSources}>
          <Database aria-hidden="true" />
          Add manually
        </button>
      </div>
    </section>
  );
}

function SourcesWorkspace({
  sources,
  sourceKind,
  setSourceKind,
  sourceTitle,
  setSourceTitle,
  sourceValue,
  setSourceValue,
  sourceTags,
  setSourceTags,
  latestRun,
  selectedRun,
  stages,
  completedStages,
  failedStages,
  busy,
  addSourceOpen,
  onOpenAddSource,
  onCloseAddSource,
  onIngest,
  onRefresh
}: {
  sources: SourceRecord[];
  sourceKind: SourceKind;
  setSourceKind: (kind: SourceKind) => void;
  sourceTitle: string;
  setSourceTitle: (title: string) => void;
  sourceValue: string;
  setSourceValue: (value: string) => void;
  sourceTags: string;
  setSourceTags: (tags: string) => void;
  latestRun?: IngestRun;
  selectedRun?: IngestRun;
  stages: StageStatus[];
  completedStages: Set<IngestStage>;
  failedStages: Set<IngestStage>;
  busy?: BusyState;
  addSourceOpen: boolean;
  onOpenAddSource: () => void;
  onCloseAddSource: () => void;
  onIngest: (event?: FormEvent) => void;
  onRefresh: () => void;
}) {
  return (
    <section className="kb-sources-view">
      <header className="kb-page-header">
        <div>
          <h1>Sources</h1>
          <p>{sources.length} sources tracked · {selectedRun ? `${formatStatus(selectedRun.status)} ingest run selected` : "no ingest run yet"}</p>
        </div>
        <div className="kb-page-actions">
          <button
            className="kb-btn"
            type="button"
            aria-controls="add-source-panel"
            aria-expanded={addSourceOpen}
            onClick={onOpenAddSource}
          >
            <PlusCircle aria-hidden="true" />
            Add source
          </button>
          <button className="kb-btn" type="button" onClick={onRefresh} disabled={busy === "refresh"}>
            <RefreshCw aria-hidden="true" className={busy === "refresh" ? "kb-spin" : undefined} />
            Sync view
          </button>
        </div>
      </header>

      <div className="kb-sources-layout">
        <section className="kb-source-table-wrap">
          {sources.length > 0 ? (
            <table className="kb-table">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Updated</th>
                  <th>Ingested</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <tr key={source.id}>
                    <td>
                      <SourceKindBadge kind={source.kind} />
                    </td>
                    <td>
                      <div className="kb-table-title">{source.title || source.uri || source.id}</div>
                      {source.uri ? <div className="kb-table-subtitle">{source.uri}</div> : null}
                    </td>
                    <td>
                      <StatusChip tone={sourceStatusTone(source.status)}>{formatStatus(source.status)}</StatusChip>
                    </td>
                    <td className="kb-mono">{formatDate(source.updatedAt)}</td>
                    <td className="kb-mono">{source.lastIngestedAt ? formatDate(source.lastIngestedAt) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptySourceState compact />
          )}
        </section>
        <RunDetailsPanel run={selectedRun} stages={stages} sources={sources} />
      </div>

      {addSourceOpen ? (
        <div className="kb-add-source-overlay" role="presentation" onClick={onCloseAddSource}>
          <aside
            id="add-source-panel"
            className="kb-add-source"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-source-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button className="kb-icon-button kb-add-source-close" type="button" aria-label="Close add source" onClick={onCloseAddSource}>
              <X aria-hidden="true" />
            </button>
          <form onSubmit={onIngest}>
            <div className="kb-add-source-head">
              <span aria-hidden="true">
                <PlusCircle />
              </span>
              <div>
                <strong id="add-source-title">Add knowledge source</strong>
                <p>URL, text, local file, directory, or GitHub repository</p>
              </div>
            </div>
            <label>
              Source type
              <select value={sourceKind} onChange={(event) => setSourceKind(event.target.value as SourceKind)}>
                {SOURCE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {formatSourceKind(kind)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Title
              <input value={sourceTitle} onChange={(event) => setSourceTitle(event.target.value)} placeholder="Optional display name" />
            </label>
            <label>
              {sourceKind === "text" ? "Content" : "URI or path"}
              <textarea
                value={sourceValue}
                rows={sourceKind === "text" ? 8 : 3}
                onChange={(event) => setSourceValue(event.target.value)}
                placeholder={sourceKind === "text" ? "Paste source text..." : "https://, /path/to/file, or repository URL"}
              />
            </label>
            <label>
              Tags
              <input value={sourceTags} onChange={(event) => setSourceTags(event.target.value)} placeholder="Optional, comma-separated" />
            </label>
            <button className="kb-btn" data-variant="primary" type="submit" disabled={busy === "ingest" || !sourceValue.trim()}>
              {busy === "ingest" ? <Loader2 aria-hidden="true" className="kb-spin" /> : <Play aria-hidden="true" />}
              Add source & ingest
            </button>
          </form>

          <section className="kb-running-run">
            <div className="kb-section-title">
              <span className="kb-eyebrow">Latest pipeline</span>
              <span>{latestRun ? latestRun.status : "Idle"}</span>
            </div>
            {latestRun ? (
              <>
                <div className="kb-run-metrics">
                  <MetricBlock label="Documents" value={String(latestRun.documents)} />
                  <MetricBlock label="Chunks" value={String(latestRun.chunks)} />
                  <MetricBlock label="Entities" value={String(latestRun.entities)} />
                </div>
                <PipelineRail stages={stages} latestRun={latestRun} completedStages={completedStages} failedStages={failedStages} stacked />
                {latestRun.error ? <p className="kb-error-text">{latestRun.error}</p> : null}
              </>
            ) : (
              <p className="kb-muted-line">Ingest runs will show stage progress here.</p>
            )}
          </section>
          </aside>
        </div>
      ) : null}
    </section>
  );
}

function SystemWorkspace({
  health,
  latestHeal,
  busy,
  onHeal,
  onRefresh,
  onApproveSourceCandidate
}: {
  health?: SystemHealth;
  latestHeal?: HealRun;
  busy?: BusyState;
  onHeal: () => void;
  onRefresh: () => void;
  onApproveSourceCandidate: (actionId: string, candidateId: string) => void;
}) {
  return (
    <section className="kb-system-view">
      <header className="kb-page-header">
        <div>
          <h1>System</h1>
          <p>{health ? readinessLabel(health, health.indexedChunks) : "Waiting for health checks"}</p>
        </div>
        <div className="kb-page-actions">
          <button className="kb-btn" type="button" onClick={onRefresh} disabled={busy === "refresh"}>
            <RefreshCw aria-hidden="true" className={busy === "refresh" ? "kb-spin" : undefined} />
            Refresh
          </button>
          <button className="kb-btn" data-variant="primary" type="button" onClick={onHeal} disabled={busy === "heal"}>
            {busy === "heal" ? <Loader2 aria-hidden="true" className="kb-spin" /> : <ShieldCheck aria-hidden="true" />}
            Run self-heal
          </button>
        </div>
      </header>

      <HealthGrid health={health} />

      <section className="kb-system-columns">
        <div>
          <div className="kb-section-title">
            <span className="kb-eyebrow">Self-healing</span>
            <span>{latestHeal ? `${latestHeal.findings.length} findings` : "No runs yet"}</span>
          </div>
          <HealFindingList heal={latestHeal} />
        </div>

        <div>
          <div className="kb-section-title">
            <span className="kb-eyebrow">Recent actions</span>
            <span>{latestHeal?.actions.length ?? 0} actions</span>
          </div>
          <HealActionList heal={latestHeal} busy={busy} onApproveSourceCandidate={onApproveSourceCandidate} />
        </div>
      </section>
    </section>
  );
}

function Inspector({
  activeTab,
  setActiveTab,
  queryResult,
  graph,
  health,
  latestHeal,
  busy,
  onHeal
}: {
  activeTab: InspectorTab;
  setActiveTab: (tab: InspectorTab) => void;
  queryResult?: QueryResponse;
  graph: GraphResponse;
  health?: SystemHealth;
  latestHeal?: HealRun;
  busy?: BusyState;
  onHeal: () => void;
}) {
  const counts: Record<InspectorTab, number | undefined> = {
    evidence: queryResult?.citations.length,
    trace: queryResult?.trace.length,
    retrieval: queryResult?.retrieval.finalK,
    graph: queryResult?.graphContext.entities.length || graph.entities.length,
    health: latestHeal?.findings.length
  };

  return (
    <aside className="kb-inspector">
      <div className="kb-tabs">
        {INSPECTOR_TABS.map((tab) => (
          <button key={tab} className="kb-tab" data-active={activeTab === tab} type="button" onClick={() => setActiveTab(tab)}>
            {formatTab(tab)}
            {typeof counts[tab] === "number" ? <span>{formatNumber(counts[tab])}</span> : null}
          </button>
        ))}
      </div>
      <div className="kb-inspector-body">
        {activeTab === "evidence" ? <EvidencePane result={queryResult} /> : null}
        {activeTab === "trace" ? <TracePane result={queryResult} /> : null}
        {activeTab === "retrieval" ? <RetrievalPane result={queryResult} /> : null}
        {activeTab === "graph" ? <GraphPane result={queryResult} graph={graph} /> : null}
        {activeTab === "health" ? <HealthPane health={health} latestHeal={latestHeal} busy={busy} onHeal={onHeal} /> : null}
      </div>
    </aside>
  );
}

function EvidencePane({ result }: { result?: QueryResponse }) {
  if (!result) {
    return <InspectorEmpty icon={ShieldCheck} title="No evidence yet" body="Run a query to inspect citations and excerpts." />;
  }

  if (result.citations.length === 0) {
    return <InspectorEmpty icon={ShieldCheck} title="No citations returned" body="The answer did not include source citations." />;
  }

  return (
    <div className="kb-evidence-list">
      {result.citations.map((citation, index) => (
        <a key={citation.chunkId} className="kb-evidence-row" href={citation.uri} target="_blank" rel="noreferrer">
          <span className="kb-cite">{index + 1}</span>
          <div>
            <div className="kb-evidence-title">
              <strong>{citation.title}</strong>
              <span className="kb-conf">{formatScore(citation.score)}</span>
            </div>
            <p className="kb-mono">{citation.uri ? hostFromUri(citation.uri) : citation.documentId}</p>
            <blockquote>{citation.excerpt}</blockquote>
            <code>{citation.chunkId}</code>
          </div>
        </a>
      ))}
    </div>
  );
}

function TracePane({ result }: { result?: QueryResponse }) {
  if (!result) {
    return <InspectorEmpty icon={GitBranch} title="Trace pending" body="Agent steps will appear after a query completes." />;
  }

  if (result.trace.length === 0) {
    return <InspectorEmpty icon={GitBranch} title="No trace returned" body="The API did not include debug trace steps for this answer." />;
  }

  return (
    <div className="kb-trace-list">
      {result.trace.map((step, index) => (
        <div className="kb-trace-row" key={`${step.name}-${step.at}`}>
          <span className="kb-trace-index">{String(index + 1).padStart(2, "0")}</span>
          <div>
            <strong>{step.name}</strong>
            <p>{step.detail}</p>
            <span className="kb-mono">{formatDate(step.at)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function RetrievalPane({ result }: { result?: QueryResponse }) {
  if (!result) {
    return <InspectorEmpty icon={ListChecks} title="No retrieval run" body="Candidate scores and selected chunks will appear after a query." />;
  }

  if (result.retrieval.candidates.length === 0) {
    return <InspectorEmpty icon={ListChecks} title="No candidates returned" body="Retrieval did not emit candidate diagnostics." />;
  }

  return (
    <table className="kb-table kb-retrieval-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Candidate</th>
          <th>Score</th>
        </tr>
      </thead>
      <tbody>
        {result.retrieval.candidates.map((candidate, index) => (
          <tr key={candidate.chunkId} data-muted={!candidate.selected}>
            <td className="kb-mono kb-num">{index + 1}</td>
            <td>
              <div className="kb-table-title">{candidate.title}</div>
              <div className="kb-table-subtitle">{candidate.reason}</div>
              <code>{candidate.chunkId}</code>
            </td>
            <td>
              <ScoreCell score={candidateScore(candidate)} muted={!candidate.selected} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GraphPane({ result, graph }: { result?: QueryResponse; graph: GraphResponse }) {
  const entities = result?.graphContext.entities.length ? result.graphContext.entities : graph.entities;
  const relations = result?.graphContext.relations.length ? result.graphContext.relations : graph.relations;

  if (entities.length === 0 && relations.length === 0) {
    return <InspectorEmpty icon={GitBranch} title="No graph context" body="Entities and relations will appear once indexed or returned with a query." />;
  }

  return (
    <div className="kb-graph-pane">
      <div className="kb-graph-cloud">
        {entities.slice(0, 12).map((entity) => (
          <span className="kb-entity-chip" key={entity.id}>
            {entity.name}
            <small>{entity.type}</small>
          </span>
        ))}
      </div>
      <div className="kb-section-title">
        <span className="kb-eyebrow">Relations</span>
        <span>{relations.length} total</span>
      </div>
      <div className="kb-relation-list">
        {relations.slice(0, 10).map((relation) => (
          <div className="kb-relation-row" key={relation.id}>
            <span>{relation.subject}</span>
            <strong>{relation.predicate}</strong>
            <span>{relation.object}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HealthPane({
  health,
  latestHeal,
  busy,
  onHeal
}: {
  health?: SystemHealth;
  latestHeal?: HealRun;
  busy?: BusyState;
  onHeal: () => void;
}) {
  return (
    <div className="kb-health-pane">
      <HealthGrid health={health} compact />
      <button className="kb-btn" data-variant="primary" type="button" onClick={onHeal} disabled={busy === "heal"}>
        {busy === "heal" ? <Loader2 aria-hidden="true" className="kb-spin" /> : <ShieldCheck aria-hidden="true" />}
        Run self-heal
      </button>
      <HealFindingList heal={latestHeal} compact />
    </div>
  );
}

function HealthGrid({ health, compact = false }: { health?: SystemHealth; compact?: boolean }) {
  const providers = health
    ? [
        {
          label: "OpenSearch",
          status: health.opensearch === "ok" ? "ok" : "degraded",
          detail: health.opensearch === "ok" ? health.indexVersion : health.indexedChunks > 0 ? "local fallback active" : "offline"
        },
        { label: "Database", status: health.database, detail: `${health.pendingJobs} pending jobs` },
        { label: "Embeddings", status: health.embeddingProvider.status, detail: health.embeddingProvider.model },
        { label: "Generation", status: health.generationProvider.status, detail: health.generationProvider.model },
        { label: "Reranker", status: health.reranker.status, detail: health.reranker.model ?? health.reranker.provider }
      ]
    : [];

  if (!health) {
    return (
      <section className={compact ? "kb-health-grid compact" : "kb-health-grid"}>
        {["OpenSearch", "Database", "Embeddings", "Generation", "Reranker"].map((label) => (
          <div className="kb-provider-card" key={label}>
            <HealthDot label={label} tone="neutral" />
            <strong>Checking</strong>
            <span className="kb-mono">waiting for API</span>
          </div>
        ))}
      </section>
    );
  }

  return (
    <section className={compact ? "kb-health-grid compact" : "kb-health-grid"}>
      {providers.map((provider) => (
        <div className="kb-provider-card" key={provider.label}>
          <HealthDot label={provider.label} tone={providerTone(provider.status as ProviderStatus)} />
          <strong>{provider.status === "ok" ? "OK" : provider.status.toUpperCase()}</strong>
          <span className="kb-mono">{provider.detail}</span>
        </div>
      ))}
      {!compact ? (
        <>
          <MetricBlock label="Indexed chunks" value={formatNumber(health.indexedChunks)} />
          <MetricBlock label="Unembedded" value={formatNumber(health.unembeddedChunks)} tone={health.unembeddedChunks > 0 ? "warn" : "ok"} />
          <MetricBlock label="Stale chunks" value={formatNumber(health.staleChunks)} tone={health.staleChunks > 0 ? "warn" : "ok"} />
        </>
      ) : null}
    </section>
  );
}

function MobileDetailStack({
  queryResult,
  graph,
  health,
  latestHeal,
  busy,
  onHeal
}: {
  queryResult?: QueryResponse;
  graph: GraphResponse;
  health?: SystemHealth;
  latestHeal?: HealRun;
  busy?: BusyState;
  onHeal: () => void;
}) {
  return (
    <section className="kb-mobile-details">
      <details open>
        <summary>
          Evidence <span>{queryResult?.citations.length ?? 0}</span>
        </summary>
        <EvidencePane result={queryResult} />
      </details>
      <details>
        <summary>
          Retrieval <span>{queryResult?.retrieval.finalK ?? 0}</span>
        </summary>
        <RetrievalPane result={queryResult} />
      </details>
      <details>
        <summary>
          Trace <span>{queryResult?.trace.length ?? 0}</span>
        </summary>
        <TracePane result={queryResult} />
      </details>
      <details>
        <summary>
          Graph <span>{formatNumber(queryResult?.graphContext.entities.length || graph.entities.length)}</span>
        </summary>
        <GraphPane result={queryResult} graph={graph} />
      </details>
      <details>
        <summary>
          Health <span>{latestHeal?.findings.length ?? 0}</span>
        </summary>
        <HealthPane health={health} latestHeal={latestHeal} busy={busy} onHeal={onHeal} />
      </details>
    </section>
  );
}

function EmptySourceState({ onOpenSources, compact = false }: { onOpenSources?: () => void; compact?: boolean }) {
  return (
    <section className={compact ? "kb-empty-source compact" : "kb-empty-source"}>
      <Brain aria-hidden="true" />
      <h2>Add a source to begin.</h2>
      <p>Knowledge Brain answers from sources you ingest. Start with a URL, text, a file, a directory, or a repository.</p>
      {onOpenSources ? (
        <button className="kb-btn" data-variant="primary" type="button" onClick={onOpenSources}>
          <Database aria-hidden="true" />
          Add source
        </button>
      ) : null}
    </section>
  );
}

function StreamingState() {
  return (
    <section className="kb-streaming">
      <div className="kb-streaming-head">
        <span className="kb-pip" data-tone="info" data-pulse="true" />
        <span className="kb-mono">thinking · retrieval and synthesis running</span>
      </div>
      <div className="kb-progress">
        <span />
      </div>
      <div className="kb-skeleton-lines">
        <span />
        <span />
        <span />
      </div>
    </section>
  );
}

function TopbarSummary({ readiness, latestRun, indexedCount }: { readiness: string; latestRun?: IngestRun; indexedCount: number }) {
  const latestLabel = latestRun ? `${formatStatus(latestRun.status)} at ${formatStatus(latestRun.stage)}` : "No ingest runs";
  return (
    <div className="kb-topbar-summary" aria-label="Current system summary">
      <StatusChip tone={readinessTone(readiness)}>{readiness}</StatusChip>
      <span className="kb-summary-item">
        <span>Latest run</span>
        <strong>{latestLabel}</strong>
      </span>
      <span className="kb-summary-item">
        <span>Indexed</span>
        <strong>{formatNumber(indexedCount)} chunks</strong>
      </span>
    </div>
  );
}

function RecentRuns({
  runs,
  selectedRunId,
  onSelectRun
}: {
  runs: IngestRun[];
  selectedRunId?: string;
  onSelectRun: (runId: string) => void;
}) {
  if (runs.length === 0) {
    return <p className="kb-sidebar-empty">No ingest runs yet</p>;
  }

  return (
    <div className="kb-recent-list">
      {runs.slice(0, 5).map((run) => (
        <button className="kb-recent-run" data-active={run.id === selectedRunId} key={run.id} type="button" onClick={() => onSelectRun(run.id)}>
          <span className="kb-pip" data-tone={jobTone(run.status)} />
          <div className="kb-recent-run-copy">
            <strong>{formatStatus(run.status)}</strong>
            <span className="kb-mono">{run.stage}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

function RunDetailsPanel({ run, stages, sources }: { run?: IngestRun; stages: StageStatus[]; sources: SourceRecord[] }) {
  const completedStages = useMemo(
    () => new Set(run?.stageHistory.filter((stage) => stage.status === "completed").map((stage) => stage.stage) ?? []),
    [run]
  );
  const failedStages = useMemo(
    () => new Set(run?.stageHistory.filter((stage) => stage.status === "failed").map((stage) => stage.stage) ?? []),
    [run]
  );
  const source = useMemo(() => sources.find((item) => item.id === run?.sourceId), [run?.sourceId, sources]);

  if (!run) {
    return (
      <aside className="kb-run-panel">
        <div className="kb-section-title">
          <span className="kb-eyebrow">Run details</span>
          <span>Idle</span>
        </div>
        <p className="kb-muted-line">Select a recent run to inspect its pipeline, metrics, and stage history.</p>
      </aside>
    );
  }

  const sourceName = source?.title || source?.uri || run.sourceId;
  const stageHistory = run.stageHistory.slice(-6).reverse();

  return (
    <aside className="kb-run-panel" aria-live="polite">
      <div className="kb-run-panel-head">
        <div>
          <span className="kb-eyebrow">Run details</span>
          <h2>{formatStatus(run.stage)}</h2>
        </div>
        <StatusChip tone={jobTone(run.status)}>{formatStatus(run.status)}</StatusChip>
      </div>

      <div className="kb-run-metrics">
        <MetricBlock label="Documents" value={String(run.documents)} />
        <MetricBlock label="Chunks" value={String(run.chunks)} />
        <MetricBlock label="Entities" value={String(run.entities)} />
      </div>

      <PipelineRail stages={stages} latestRun={run} completedStages={completedStages} failedStages={failedStages} stacked />

      <dl className="kb-run-meta">
        <div>
          <dt>Source</dt>
          <dd title={sourceName}>{sourceName}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{formatDate(run.startedAt)}</dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd>{run.completedAt ? formatDate(run.completedAt) : "-"}</dd>
        </div>
      </dl>

      {run.error ? <p className="kb-error-text">{run.error}</p> : null}

      <section className="kb-stage-history">
        <div className="kb-section-title">
          <span className="kb-eyebrow">Stage history</span>
          <span>{run.stageHistory.length} events</span>
        </div>
        {stageHistory.length > 0 ? (
          stageHistory.map((step) => (
            <div className="kb-stage-history-row" key={`${step.stage}-${step.at}-${step.status}`}>
              <span className="kb-pip" data-tone={step.status === "failed" ? "err" : "ok"} />
              <div>
                <strong>{formatStatus(step.stage)}</strong>
                <p>{step.message}</p>
              </div>
              <span className="kb-mono">{formatDate(step.at)}</span>
            </div>
          ))
        ) : (
          <p className="kb-muted-line">No stage events have been recorded yet.</p>
        )}
      </section>
    </aside>
  );
}

function PipelineRail({
  stages,
  latestRun,
  completedStages,
  failedStages,
  stacked = false
}: {
  stages: StageStatus[];
  latestRun?: IngestRun;
  completedStages: Set<IngestStage>;
  failedStages: Set<IngestStage>;
  stacked?: boolean;
}) {
  if (stages.length === 0) {
    return <div className={stacked ? "kb-pipeline stacked" : "kb-pipeline"} />;
  }

  return (
    <div className={stacked ? "kb-pipeline stacked" : "kb-pipeline"}>
      {stages.map((stage, index) => {
        const state = stageState(stage.stage, latestRun, completedStages, failedStages);
        return (
          <span className="kb-pipeline-step" data-state={state} key={stage.stage}>
            <span className="kb-pip" data-tone={state === "done" ? "ok" : state === "failed" ? "err" : state === "active" ? "info" : "neutral"} data-pulse={state === "active"} />
            {stage.label}
            {state === "active" ? <span className="kb-count">{stage.completed}</span> : null}
            {index < stages.length - 1 ? <span className="kb-pipeline-tick" /> : null}
          </span>
        );
      })}
    </div>
  );
}

function HealFindingList({ heal, compact = false }: { heal?: HealRun; compact?: boolean }) {
  if (!heal) {
    return <p className="kb-muted-line">No self-healing run has completed yet.</p>;
  }

  if (heal.findings.length === 0) {
    return (
      <div className="kb-clean-state">
        <CheckCircle2 aria-hidden="true" />
        <span>No findings in the latest run.</span>
      </div>
    );
  }

  const findings = [...heal.findings].sort(compareHealFindings);

  return (
    <div className={compact ? "kb-heal-list compact" : "kb-heal-list"}>
      {findings.slice(0, compact ? 5 : undefined).map((finding) => (
        <div className="kb-heal-row" key={finding.id}>
          <strong data-tone={findingTone(finding)}>{severityLabel(finding)}</strong>
          <div>
            <p>{finding.message}</p>
            <span className="kb-mono">{finding.type}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function HealActionList({
  heal,
  busy,
  onApproveSourceCandidate
}: {
  heal?: HealRun;
  busy?: BusyState;
  onApproveSourceCandidate: (actionId: string, candidateId: string) => void;
}) {
  if (!heal || heal.actions.length === 0) {
    return <p className="kb-muted-line">Actions from self-healing runs will appear here.</p>;
  }

  const actions = [...heal.actions].sort(compareHealActions);

  return (
    <div className="kb-action-list">
      {actions.map((action) => (
        <div className="kb-action-row" key={action.id}>
          <span className="kb-pip" data-tone={action.status === "completed" ? "ok" : action.status === "failed" ? "err" : "info"} />
          <div>
            <strong>{action.label}</strong>
            <p>{action.detail}</p>
            <span className="kb-mono">{action.kind} · {action.status}</span>
            {action.sourceGapRepair ? (
              <SourceCandidateReview
                action={action}
                busy={busy}
                onApproveSourceCandidate={onApproveSourceCandidate}
              />
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function SourceCandidateReview({
  action,
  busy,
  onApproveSourceCandidate
}: {
  action: HealRun["actions"][number];
  busy?: BusyState;
  onApproveSourceCandidate: (actionId: string, candidateId: string) => void;
}) {
  const repair = action.sourceGapRepair;
  if (!repair) {
    return null;
  }

  if (repair.searchStatus !== "completed" || repair.candidates.length === 0) {
    return (
      <div className="kb-source-candidate-empty">
        <Search aria-hidden="true" />
        <span>
          {repair.searchStatus === "failed"
            ? `Source search failed: ${repair.error ?? "unknown error"}`
            : "No source candidate was found automatically."}
        </span>
      </div>
    );
  }

  return (
    <div className="kb-source-candidates">
      <div className="kb-source-candidates-title">
        <Search aria-hidden="true" />
        <span>{repair.candidates.length} source candidate(s) ready for review</span>
      </div>
      {repair.candidates.map((candidate) => (
        <article className="kb-source-candidate-card" key={candidate.id}>
          <div>
            <strong>{candidate.title}</strong>
            {candidate.publisher ? <span>{candidate.publisher}</span> : null}
          </div>
          <p>{candidate.snippet}</p>
          <p>{candidate.whyRelevant}</p>
          <div className="kb-source-candidate-actions">
            <a className="kb-btn" href={candidate.url} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden="true" />
              Verify
            </a>
            <button
              className="kb-btn"
              data-variant="primary"
              type="button"
              disabled={busy === "approve" || action.status !== "pending"}
              onClick={() => onApproveSourceCandidate(action.id, candidate.id)}
            >
              {busy === "approve" ? <Loader2 aria-hidden="true" className="kb-spin" /> : <Check aria-hidden="true" />}
              Approve & ingest
            </button>
            <span className="kb-mono">conf {formatScore(candidate.confidence)}</span>
          </div>
          <span className="kb-mono kb-source-candidate-url">{candidate.url}</span>
        </article>
      ))}
    </div>
  );
}

function SourceKindBadge({ kind }: { kind: SourceKind }) {
  const Icon = sourceIcon(kind);
  return (
    <span className="kb-source-kind">
      <Icon aria-hidden="true" />
      {formatSourceKind(kind)}
    </span>
  );
}

function HealthDot({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span className="kb-health-dot">
      <span className="kb-pip" data-tone={tone} />
      <span>{label}</span>
    </span>
  );
}

function StatusChip({ children, tone = "neutral", icon: Icon }: { children: ReactNode; tone?: Tone; icon?: LucideIcon }) {
  return (
    <span className="kb-chip" data-tone={tone}>
      {Icon ? <Icon aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

function MetricBlock({ label, value, tone = "neutral" }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="kb-metric" data-tone={tone}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ScoreCell({ score, muted = false }: { score?: number; muted?: boolean }) {
  const normalized = score ?? 0;
  const pct = Math.max(0, Math.min(100, normalized * 100));
  return (
    <span className="kb-score" data-muted={muted}>
      <span className="kb-score-bar">
        <span style={{ width: `${pct}%` }} />
      </span>
      <strong>{score === undefined ? "-" : formatScore(score)}</strong>
    </span>
  );
}

function InspectorEmpty({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div className="kb-inspector-empty">
      <span className="kb-inspector-empty-icon" aria-hidden="true">
        <Icon />
      </span>
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <section className="kb-error-band">
      <CircleAlert aria-hidden="true" />
      <span>{message}</span>
    </section>
  );
}

function renderAnswer(answer: string): ReactNode {
  const lines = answer
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const rendered: ReactNode[] = [];
  let bullets: string[] = [];

  function flushBullets() {
    if (bullets.length === 0) {
      return;
    }
    rendered.push(
      <ul className="kb-answer-points" key={`bullets-${rendered.length}`}>
        {bullets.map((bullet) => (
          <li key={bullet}>{bullet}</li>
        ))}
      </ul>
    );
    bullets = [];
  }

  for (const line of lines) {
    if (line.endsWith(":") && !line.startsWith("- ")) {
      flushBullets();
      rendered.push(
        <h3 className="kb-answer-subhead" key={`${line}-${rendered.length}`}>
          {line.replace(/:$/, "")}
        </h3>
      );
      continue;
    }
    if (line.startsWith("- ")) {
      bullets.push(line.slice(2));
      continue;
    }
    flushBullets();
    rendered.push(
      <p className={rendered.length === 0 ? "kb-answer-lede" : "kb-answer-paragraph"} key={`${line}-${rendered.length}`}>
        {line}
      </p>
    );
  }

  flushBullets();
  return rendered.length > 0 ? rendered : <p className="kb-answer-lede">{answer}</p>;
}

function readinessLabel(health: SystemHealth | undefined, indexedCount: number): string {
  if (!health) {
    return "Starting";
  }
  const providersOk =
    health.embeddingProvider.status === "ok" &&
    health.generationProvider.status === "ok" &&
    health.reranker.status === "ok" &&
    health.opensearch === "ok" &&
    health.database === "ok";
  if (indexedCount > 0 && providersOk) {
    return "Production ready";
  }
  if (indexedCount > 0) {
    return "Degraded";
  }
  return "Awaiting ingest";
}

function stageState(stage: IngestStage, latestRun: IngestRun | undefined, completedStages: Set<IngestStage>, failedStages: Set<IngestStage>) {
  if (failedStages.has(stage)) {
    return "failed";
  }
  if (completedStages.has(stage)) {
    return "done";
  }
  if (latestRun?.stage === stage && latestRun.status === "running") {
    return "active";
  }
  return "queued";
}

function providerTone(status: ProviderStatus | "ok" | "degraded" | undefined): Tone {
  if (status === "ok") {
    return "ok";
  }
  if (status === "degraded" || status === "disabled") {
    return "warn";
  }
  return "neutral";
}

function statusTone(status: QueryResponse["status"]): Tone {
  return status === "answered" ? "ok" : "warn";
}

function verificationTone(status: QueryResponse["verification"]["status"]): Tone {
  if (status === "passed") {
    return "ok";
  }
  if (status === "failed") {
    return "err";
  }
  return "warn";
}

function readinessTone(readiness: string): Tone {
  if (readiness === "Production ready") {
    return "ok";
  }
  if (readiness === "Awaiting ingest") {
    return "neutral";
  }
  return "warn";
}

function jobTone(status: IngestRun["status"]): Tone {
  if (status === "completed") {
    return "ok";
  }
  if (status === "failed") {
    return "err";
  }
  if (status === "running") {
    return "info";
  }
  return "neutral";
}

function sourceStatusTone(status: SourceRecord["status"]): Tone {
  if (status === "ready" || status === "completed") {
    return "ok";
  }
  if (status === "failed") {
    return "err";
  }
  if (status === "running") {
    return "info";
  }
  return "neutral";
}

function findingTone(finding: HealFinding): Tone {
  if (finding.severity === "critical") {
    return "err";
  }
  if (finding.severity === "warning") {
    return "warn";
  }
  return "info";
}

function severityLabel(finding: HealFinding): string {
  if (finding.severity === "critical") {
    return "Critical";
  }
  if (finding.severity === "warning") {
    return "Warn";
  }
  return "Info";
}

function compareHealFindings(a: HealFinding, b: HealFinding): number {
  return findingPriority(a) - findingPriority(b);
}

function findingPriority(finding: HealFinding): number {
  if (finding.type === "source_gap") {
    return 0;
  }
  if (finding.severity === "critical") {
    return 1;
  }
  if (finding.severity === "warning") {
    return 2;
  }
  return 3;
}

function compareHealActions(a: HealRun["actions"][number], b: HealRun["actions"][number]): number {
  return actionPriority(a) - actionPriority(b);
}

function actionPriority(action: HealRun["actions"][number]): number {
  if (action.label === "Add source for unanswered query") {
    return 0;
  }
  if (action.status === "pending") {
    return 1;
  }
  return 2;
}

function candidateScore(candidate: QueryResponse["retrieval"]["candidates"][number]): number | undefined {
  return candidate.rerankScore ?? candidate.fusedScore ?? candidate.vectorScore ?? candidate.lexicalScore;
}

function sourceIcon(kind: SourceKind): LucideIcon {
  if (kind === "github_repo") {
    return Github;
  }
  if (kind === "directory") {
    return Folder;
  }
  if (kind === "file") {
    return FileText;
  }
  if (kind === "text") {
    return Clipboard;
  }
  return Link2;
}

function formatSourceKind(kind: SourceKind): string {
  const labels: Record<SourceKind, string> = {
    url: "URL",
    text: "Text",
    file: "File",
    directory: "Directory",
    github_repo: "GitHub"
  };
  return labels[kind];
}

function formatStatus(status: string): string {
  return status.replace(/_/g, " ");
}

function formatQueryMode(mode: QueryMode | "auto"): string {
  return mode === "auto" ? "Auto" : mode.charAt(0).toUpperCase() + mode.slice(1);
}

function formatTab(tab: InspectorTab): string {
  return tab.charAt(0).toUpperCase() + tab.slice(1);
}

function formatScore(value: number): string {
  return value.toFixed(2);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const month = new Intl.DateTimeFormat(undefined, { month: "short" }).format(date);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
  return `${month} ${date.getDate()} ${time}`;
}

function hostFromUri(uri: string): string {
  try {
    return new URL(uri).host.replace(/^www\./, "");
  } catch {
    return uri;
  }
}

function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function pluralize(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

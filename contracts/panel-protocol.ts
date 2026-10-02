import type { ClawdState } from "./clawd-state";
import type { LiveTelemetry } from "./telemetry";
import type { SessionProjection } from "./events";
import type { CostView } from "./cost";

/**
 * Plan-quota pressure. `sampledAt` is epoch milliseconds; the `*ResetsAt` fields
 * are ISO-8601 UTC, converted from the epoch SECONDS the harness reports. A band
 * is only computed from a fresh sample: `stale` true always reads `unknown`.
 */
export type QuotaPressure = {
  fiveHourPct: number | null;
  fiveHourResetsAt: string | null;
  sevenDayPct: number | null;
  sevenDayResetsAt: string | null;
  sampledAt: number | null;
  stale: boolean;
  band: "green" | "amber" | "red" | "unknown";
  source: "statusline rate_limits (heurística informativa)";
};

export type RunPhase =
  | "queued"
  | "investigating"
  | "planning"
  | "implementing"
  | "validating"
  | "reviewing"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export type RunStatus =
  | "running"
  | "waiting"
  | "blocked"
  | "passed"
  | "failed"
  | "stopped";

export interface RunSummary {
  id: string;
  title: string;
  branch?: string;
  worktreeId?: string;
  phase: RunPhase;
  status: RunStatus;
  progress?: number;
  startedAt?: string;
  updatedAt: string;
  requiresInput?: boolean;
  blockedReason?: string;
}

export interface WorktreeSummary {
  id: string;
  path: string;
  branch: string;
  services: Array<{
    id: string;
    status: "running" | "stopped" | "failed" | "unknown";
    pid?: number;
    port?: number;
    url?: string;
  }>;
  lastActivity?: string;
}

export interface ValidationCheck {
  id: string;
  label: string;
  project?: string;
  status: "queued" | "running" | "passed" | "failed" | "skipped";
  blocking: boolean;
  command?: string;
  durationMs?: number;
  summary?: string;
}

export interface ReviewFinding {
  id: string;
  severity: "blocking" | "high" | "medium" | "low" | "advisory";
  title: string;
  description?: string;
  file?: string;
  line?: number;
  resolved: boolean;
}

export type WorkflowEvent =
  | { type: "snapshot"; emittedAt: string }
  | { type: "run.started"; run: RunSummary; emittedAt: string }
  | { type: "run.updated"; run: RunSummary; emittedAt: string }
  | {
      type: "run.phase-changed";
      runId: string;
      phase: RunPhase;
      emittedAt: string;
    }
  | {
      type: "run.attention-required";
      runId: string;
      reason: string;
      emittedAt: string;
    }
  | { type: "run.blocked"; runId: string; reason: string; emittedAt: string }
  | { type: "run.completed"; runId: string; emittedAt: string }
  | {
      type: "validation.updated";
      runId: string;
      check: ValidationCheck;
      emittedAt: string;
    }
  | {
      type: "review.updated";
      runId: string;
      finding: ReviewFinding;
      emittedAt: string;
    }
  | {
      type: "log";
      runId?: string;
      service?: string;
      level: "debug" | "info" | "warn" | "error";
      message: string;
      emittedAt: string;
    }
  | {
      type: "clawd.state";
      state: ClawdState;
      message?: string;
      emittedAt: string;
    };

/**
 * The full runtime snapshot. This interface is authoritative for the top-level
 * KEY SET (a drift test asserts the builder emits exactly these keys); nested
 * shapes are typed where a dedicated contract exists and left structural
 * elsewhere, with the runtime builder (`lib/snapshot.mjs`) as the detail source.
 */
export interface TraceSpan {
  id: string;
  endTs?: string;
  errorSignature?: string;
  tool: string;
  summary: string;
  startTs: string;
  /** null = unknown (unpaired in a closed turn). */
  durMs: number | null;
  /** Live-state assertion: true only while the session itself is live. */
  running: boolean;
  /** Unfinished span of a dead session; duration unknowable. */
  incomplete: boolean;
  ok: boolean | null;
  isTask: boolean;
  /** Human-wait span (plan approval / question); UI caps its width. */
  wait: boolean;
  agent: { agentType: string; description: string } | null;
}

export interface TraceTurn {
  index: number;
  startTs: string;
  lastActivityAt?: string;
  endTs: string | null;
  open: boolean;
  durMs: number | null;
  model: string | null;
  gapBeforeMs: number | null;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreate: number;
    requests: number;
  } | null;
  /** Capped at 80; excess reported via spansDropped. */
  spans: TraceSpan[];
  spansDropped?: number;
}

export interface SessionTrace {
  diagnostics?: {
    findings: Array<{
      id: string;
      type:
        | "long_running"
        | "no_activity"
        | "repeated_tool"
        | "repeated_error"
        | "possible_loop";
      severity: string;
      message: string;
      turn: number;
      startTs: string;
      spanIds: string[];
      evidence: Array<
        Pick<TraceSpan, "id" | "tool" | "startTs" | "durMs" | "ok">
      >;
    }>;
    errors: Array<{
      tool: string;
      count: number;
      occurrences: Array<{ turn: number; spanId: string; startTs: string }>;
    }>;
    partial: boolean;
    thresholds: Record<string, number>;
  };
  session: string;
  missing?: true;
  model: string | null;
  turns: TraceTurn[];
  /** Older history beyond the byte/turn budget was not read. */
  truncated: boolean;
  caps: { maxTurns: number; tailBytes: number };
  sessionLive: boolean;
}

/** One axis of delivery readiness, with the reasons behind the verdict. */
export interface ReadinessAxis {
  state: "READY" | "BLOCKED" | "UNKNOWN";
  blocking: Array<{ id: string; title: string; reason?: string }>;
  unknown: Array<{ id: string; title: string; reason?: string }>;
}

export interface SubscriptionAllowance {
  provider: "codex" | "claude";
  status: "ready" | "unavailable";
  message: string | null;
  sampledAt: number | null;
  plan: string | null;
  source?: string | null;
  profileId?: string | null;
  profileLabel?: string | null;
  accountLabel?: string | null;
  accountKey?: string | null;
  windows: Array<{
    id: string;
    label: string;
    remainingPercent: number | null;
    resetsAt: number | null;
    minutes: number | null;
    extra: boolean;
  }>;
}

export interface SubscriptionTotal {
  remainingPercent: number | null;
  incomplete: boolean;
  accountCount: number;
  availableCount: number;
}

export type SubscriptionSnapshot = Record<
  "codex" | "claude",
  SubscriptionAllowance
> & {
  profiles?: SubscriptionAllowance[];
  totalsAt?: number;
  totals?: Record<
    "lowest" | "weekly" | "five-hour",
    Record<"codex" | "claude", SubscriptionTotal>
  >;
  observedAccounts?: Array<{
    key: string;
    provider: "codex" | "claude";
    label: string;
    clients: string[];
  }>;
};

export interface PanelSnapshot {
  checkout: { id: string; root: string; branch?: string; isWorktree: boolean };
  runs: RunSummary[];
  worktrees: WorktreeSummary[];
  validation: {
    status: string;
    checks: ValidationCheck[];
    passed?: boolean;
    ranAt?: string | null;
  };
  reviews: {
    status: string;
    findings: ReviewFinding[];
    blockCount: number;
    warnCount: number;
    base?: string | null;
  };
  findings: ReviewFinding[];
  attention: Array<{
    id: string;
    kind: string;
    severity: string;
    title: string;
    detail?: string | null;
    link?: string;
  }>;
  jobs: unknown[];
  sessions: { total: number; activeCount: number; agents: unknown[] };
  telemetry: LiveTelemetry;
  events: { sessions: SessionProjection[]; count: number };
  policy: { sessions: Record<string, unknown>; count: number };
  cost: CostView;
  governor: unknown;
  /**
   * Plan-quota pressure from the harness's rate-limit windows. Informational: a
   * separate axis from the API-equivalent cost rollup, and it drives no routing
   * and no gate. One sample decides every field; windows are never mixed.
   * Missing data is `unknown`, never zero.
   */
  quotaPressure: QuotaPressure;
  subscriptions: SubscriptionSnapshot | null;
  remoteBranches: unknown[];
  recentCommits: unknown[];
  commitActivity: unknown[];
  authorBreakdown: unknown[];
  reviewHistory: unknown;
  readiness: unknown;
  logSources: unknown;
  setup: unknown;
  /** Always-loaded instruction files + on-demand material, char-based estimates. */
  instructionBudget: {
    alwaysLoaded: Array<{
      path: string;
      chars: number;
      bytes: number;
      estTokens: number;
      reason: string;
    }>;
    onDemand: Array<{ path: string; files: number; bytes: number }>;
    totalChars: number;
    totalEstTokens: number;
    estimated: true;
    /** Real runtime evidence aggregated from InstructionsLoaded hook events.
     *  Not an estimate: the event carries no content and no size. */
    observed: {
      files: Array<{
        file: string;
        loads: number;
        sessions: number;
        lastAt: number;
        loadReason: string | null;
        memoryType: string | null;
      }>;
      fileCount: number;
      totalLoads: number;
      source: string;
    };
    note: string;
  };
  history: unknown[];
  panel: unknown;
  forge: unknown;
  delivery: {
    stages: { key: string; label: string; state: string; detail: string }[];
    blockers: string[];
    nextAction: string;
    hasChanges: boolean;
  };
  /** Panel self-performance (p50/p95 snapshot + adapter latency, counters). */
  perf: unknown;
  /**
   * Remote review threads, counts only. Comment bodies never ride here: the
   * SSE stream that carries the snapshot is the one route without a bearer,
   * and hashing large churning text every tick is waste. Full data comes from
   * the token-gated GET /api/review-inbox.
   *
   * `coverage` has two axes because listing every thread is not the same as
   * knowing every resolution (GitHub reports resolution only via GraphQL).
   * An empty result under incomplete coverage is unknown, never "clear".
   */
  reviewInbox: {
    configured: boolean;
    available: boolean;
    provider?: "github" | "gitlab" | null;
    mrIid?: number | string | null;
    reviewDecision?: string | null;
    reason?: string | null;
    detail?: string | null;
    fetchedAt?: string | null;
    freshness?: "fresh" | "stale" | "unknown";
    coverage: {
      threads: { complete: boolean; reason?: string };
      resolution: { complete: boolean; reason?: string };
    };
    degraded?: string[];
    noteCount?: number;
    counts: {
      total: number;
      remoteResolved: number;
      remoteUnresolved: number;
      resolutionUnknown: number;
      unread: number;
      needsHuman: number;
      replyDrafted: number;
      likelyAddressed: number;
      locallyChanged: number;
    } | null;
    top: Array<{
      id: string;
      file: string | null;
      line: number | null;
      state: string;
      authority: string;
      certainty: "known" | "likely" | "unknown";
    }>;
  };
  /**
   * CI for the commit the change is on, never for "the latest run". Job logs
   * stay behind the token-gated route; only names and links ride here.
   *
   * `state: "missing"` means no check context exists; `"unknown"` means one
   * could not be read. They are different answers and neither is a pass.
   */
  ci: {
    configured: boolean;
    available: boolean;
    provider?: "github" | "gitlab" | null;
    ref?: string | null;
    reason?: string | null;
    observedAt?: string | null;
    freshness?: "fresh" | "stale" | "unknown";
    summary: {
      state: "passing" | "failing" | "pending" | "missing" | "unknown";
      authority: "ci";
      native: boolean;
      observedAt: string;
      coverage: { complete: boolean; reason?: string };
      counts: {
        total: number;
        passing: number;
        failing: number;
        pending: number;
      };
    } | null;
    failures?: Array<{
      name: string;
      /** Provider job id, when the job's log is one Clawdeck can fetch. */
      jobId: string | null;
      source: string | null;
      detailsUrl: string | null;
      inspectable: boolean;
    }>;
    failureCount?: number;
  };
  /**
   * The provider's own merge verdict, or null when it was never read. Absent
   * and unknown both mean the same thing here: no basis for calling a change
   * ready, and never a basis for calling it refused.
   */
  mergeability: {
    ok: boolean;
    provider: "github" | "gitlab" | null;
    mergeable: boolean | "unknown";
    hasConflicts: boolean | null;
    blockingDiscussionsResolved: boolean | null;
    /** The provider's own status string, shown verbatim. */
    status: string | null;
    /** True when the provider requires the branch to be up to date. */
    behindBlocks: boolean | null;
    reason: string | null;
    observedAt: string | null;
  } | null;
  /**
   * Both delivery axes and the blockers behind them. Separate from `readiness`
   * (the local /pre-mr push marker), and separate per axis because a dirty
   * worktree must never read as "the provider refuses to merge".
   */
  deliveryReadiness: {
    headline: "READY" | "BLOCKED" | "UNKNOWN";
    remoteMerge: ReadinessAxis;
    localDelivery: ReadinessAxis;
    blockers: Array<{
      id: string;
      kind: string;
      title: string;
      detail: string | null;
      authority: string;
      blocking: {
        remoteMerge: boolean | "unknown";
        localDelivery: boolean | "unknown";
      };
      blockingReason: { remoteMerge?: string; localDelivery?: string };
      evidence: Array<{ kind: string; note: string; ref?: string | null }>;
      needsHuman: boolean;
      freshness: string;
      coverage?: { complete: boolean; reason?: string };
      links: Record<string, unknown>;
    }>;
  };
  /**
   * Why this change went the way it did. Only a human action mints a record,
   * so `decidedBy` never carries a model. Reasons stay behind the token-gated
   * route; the snapshot carries the decision line and who made it.
   */
  decisions: {
    /** `pr-<iid>` once a change is open, `branch-<name>` before that. */
    changeId: string;
    total: number;
    recent: Array<{
      id: string;
      decision: string;
      decidedBy: "human" | "mechanical-policy";
      createdAt: string;
    }>;
  };
  /**
   * What needs a person. Distinct from `attention` (run/validation nags) and
   * from delivery blocking: a mechanical blocker like an unpushed commit never
   * appears here, and no advisory suggestion can enter without a human click.
   */
  attentionInbox: {
    items: Array<{
      id: string;
      kind: string;
      severity: "blocking" | "attention" | "warning";
      title: string;
      detail: string | null;
      authority: string;
      link: string | null;
      evidence: Array<{ kind: string; note: string }>;
    }>;
    counts: {
      total: number;
      blocking: number;
      attention: number;
      warning: number;
    };
  };
  /**
   * Assisted Claude work, as counts and identities. A task's brief lives in a
   * file and its evidence can list dozens of paths; neither belongs in a
   * payload the tokenless SSE stream carries. Full records: GET /api/tasks.
   */
  tasks: {
    counts: {
      total: number;
      open: number;
      awaitingLaunch: number;
      running: number;
      needsHuman: number;
      stalled: number;
      settled: number;
      failed: number;
      cancelled: number;
      unboundSessions: number;
    } | null;
    /** Time work sat waiting on a person, from recorded transitions only. */
    waits?: {
      tasks: number;
      closedWaits: number;
      openWaits: number;
      medianWaitMs: number | null;
      longest: { state: string; ms: number } | null;
      measured: boolean;
    };
    /** Which open tasks could proceed at once, by mechanical non-overlap. */
    lanes?: {
      lanes: Array<{ id: string; items: string[]; reasons: string[] }>;
      parallelism: number;
      unpartitionable: string[];
    };
    recent: Array<{
      id: string;
      source: { kind: string | null; id: string | null };
      intent: string;
      lifecycle: string;
      outcome: string | null;
      sessionId: string | null;
      commit: string | null;
      fileCount: number;
      reconciliation: "bound" | "unknown";
      createdAt: string;
    }>;
  };
  clawd: unknown;
  /**
   * Per-section FNV-1a content hashes. `version` doubles as the /api/snapshot
   * ETag. Time-driven sections (`panel`, `perf`, `history`, `emittedAt`) are
   * deliberately absent from `byKey`: consumers must treat them as always
   * changed.
   */
  sections: { version: string; byKey: Record<string, string> };
  emittedAt: string;
}

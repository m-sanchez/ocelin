#!/usr/bin/env node
// @ts-check
/**
 * Clawdeck local service. Controlled HTTP + SSE boundary on 127.0.0.1.
 *
 * Routes:
 *   GET  /health                 liveness + version
 *   GET  /api/version            package + checkout version metadata
 *   GET  /api/snapshot           full PanelSnapshot (cheap adapters live, costly cached)
 *   GET  /api/runs/:id           one run's detail + timeline
 *   GET  /api/logs               bounded recent log backlog
 *   GET  /events                 SSE stream of workflow events + periodic snapshots
 *   POST /api/actions/:name      allowlisted, same-origin-guarded mutating actions
 *   GET  /clawd-playground       the canonical Clawd reference (exact file)
 *   GET  /*                      static UI under ui/ (allowlisted, traversal-safe)
 *
 * No arbitrary filesystem or shell endpoint exists. The server never watches the
 * tree; it polls adapters per request and on a bounded SSE interval.
 */
import http from "node:http";
import { readDisplay, saveDisplay } from "./core/display-preferences.mjs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { cpus, homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// CPU count is fixed for the process lifetime; read it once.
const CPU_COUNT = cpus().length;
import { git } from "./lib/git.mjs";
import {
  EventHub,
  sendJson,
  sendText,
  sendStaticFile,
  sendExactFile,
  escapeHtml,
} from "./lib/http.mjs";
import { buildSnapshot } from "./lib/snapshot.mjs";
import { EventStore } from "./core/events/store.mjs";
import { OtelStore } from "./core/otel/receiver.mjs";
import { PerfMetrics } from "./core/telemetry/perf.mjs";
import { getRunDetails } from "./adapters/runs.mjs";
import { getRecentLogs } from "./adapters/logs.mjs";
import { getReviews } from "./adapters/reviews.mjs";
import { getDiffPreview, resolveBase } from "./adapters/diff-preview.mjs";
import { isSafeRelativeFile, isSafeRef } from "./lib/validate.mjs";
import { getValidation } from "./adapters/validation.mjs";
import { runAction, ACTION_NAMES } from "./lib/actions.mjs";
import { JobManager } from "./lib/jobs.mjs";
import {
  COMMANDS,
  findCommand,
  commandAvailable,
} from "./lib/command-registry.mjs";
import { getWorktrees } from "./adapters/worktrees.mjs";
import { slugForPath, agentIsActive } from "./adapters/sessions.mjs";
import { getSessionFeed } from "./adapters/session-feed.mjs";
import { monitorTranscript } from "./monitor/shared.mjs";
import { readSubscriptionSnapshot } from "./monitor/subscriptions.mjs";
import { getSessionTrace } from "./adapters/session-trace.mjs";
import {
  resolveCodexTranscript,
  codexSessionIsLive,
} from "./adapters/codex-sessions.mjs";
import { getSubagentTree } from "./adapters/subagent-tree.mjs";
import { bindSession } from "./core/tasks/model.mjs";
import {
  openTasks,
  readTasks,
  sweepStalled,
  reconcileTasks,
  upsertTask,
  writeTasks,
} from "./core/tasks/store.mjs";
import {
  candidateTranscripts,
  findMarkers,
} from "./core/tasks/correlate.mjs";
import { collectTaskEvidence } from "./core/tasks/evidence.mjs";
import { summarizeTasks } from "./core/tasks/summary.mjs";
import {
  pruneSessionRecords,
  getLiveTelemetry,
} from "./adapters/telemetry-live.mjs";
import { recordBurnSample } from "./core/telemetry/burn.mjs";
import { sampleHostMetrics } from "./adapters/host-metrics.mjs";
import { getMcpAnalytics } from "./adapters/mcp-analytics.mjs";
import { discoverConfig, overlayUsage } from "./adapters/config-map.mjs";
import { getForgeStatus, newMrUrl } from "./forge/index.mjs";
import {
  getReviewInbox,
  summarizeInbox,
} from "./adapters/review-inbox.mjs";
import { getCi, getCiLogTail, summarizeCi } from "./adapters/ci.mjs";
import { getMergeability } from "./forge/index.mjs";
import { attributeFailure } from "./core/tasks/attribution.mjs";
import { readDraft } from "./core/review-inbox/store.mjs";

const HOST = "127.0.0.1";
const PORT = Number(
  process.env.PANEL_SERVICE_PORT || process.env.PANEL_PORT || 4318,
);
const checkoutRoot = resolve(process.env.PANEL_CHECKOUT_ROOT || process.cwd());
const repoRoot = resolve(process.env.PANEL_REPO_ROOT || checkoutRoot);
const checkoutId = process.env.PANEL_CHECKOUT_ID || "unknown";
// Per-launch ownership token; lifecycle scripts must match it (via /health) before
// terminating a recorded PID, so a reused PID can never be killed by mistake.
const NONCE = process.env.PANEL_NONCE || null;
const runtimeDir = resolve(
  process.env.PANEL_RUNTIME_DIR ||
    join(checkoutRoot, ".claude", ".runtime", "panel", checkoutId),
);
// The panel's own install root (this repository), independent of the observed checkout.
const panelRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = join(panelRoot, "ui");
const clawdReferencePath = join(
  panelRoot,
  "reference",
  "clawd-playground-v16.html",
);
let VERSION = "0.0.0-unknown";
try {
  VERSION =
    JSON.parse(readFileSync(join(panelRoot, "package.json"), "utf8")).version ||
    VERSION;
} catch {
  /* unreadable: report the placeholder rather than a number that is not real */
}
const APP_NAME = "Ocelin";
let SCHEMA_VERSION = null;
// Copyable Claude slash-commands a host project may advertise via
// panel.config.json `claudeCommands` ({ cmd, hint } entries). Default: none.
let CLAUDE_COMMANDS = [];
try {
  const panelConfig = JSON.parse(
    readFileSync(join(panelRoot, "panel.config.json"), "utf8"),
  );
  SCHEMA_VERSION = panelConfig.schemaVersion ?? null;
  if (Array.isArray(panelConfig.claudeCommands))
    CLAUDE_COMMANDS = panelConfig.claudeCommands
      .filter((c) => c && typeof c.cmd === "string")
      .map((c) => ({ cmd: c.cmd, hint: String(c.hint ?? "") }));
} catch {
  /* config unreadable: leave defaults */
}

// Only our exact loopback origin may address the panel (anti-DNS-rebinding).
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  `[::1]:${PORT}`,
]);

// Strict allowlist of third-party assets. Keys are fixed; no user-supplied path
// ever reaches the filesystem. Each key maps to an ordered candidate list —
// first the panel's own vendor/ dir, then the observed checkout's node_modules.
const VENDOR = {
  "d3.js": [
    join(panelRoot, "vendor", "d3.min.js"),
    join(checkoutRoot, "node_modules", "d3", "dist", "d3.min.js"),
  ],
};

/** @type {{ checkoutId: string, checkoutRoot: string, repoRoot: string, branch?: string, runtimeDir: string, panelRoot: string }} */
const ctx = {
  checkoutId,
  checkoutRoot,
  repoRoot,
  runtimeDir,
  panelRoot,
  branch: undefined,
};

const hub = new EventHub();
const jobs = new JobManager(hub);
// Panel self-performance metrics (snapshot/adapter latency, ingest counters).
const perf = new PerfMetrics();

// Event spine: the panel-owned single-writer store over the REPOSITORY-SHARED
// events dir (the main checkout's runtime dir), fed by the live ingest POST and
// by promoting the hook-owned spool that every worktree emitter appends to. A
// writer lock keeps the canonical log single-writer even if a second panel is
// launched from another checkout: the non-owner degrades to its local
// per-checkout events dir instead of corrupting the shared store. A per-launch
// bearer token gates the ingest route; the shared ingest descriptor advertises
// this panel's port+token to every worktree's emitter.
const spoolLib = createRequire(import.meta.url)(
  join(panelRoot, "hooks", "lib", "event-spool.cjs"),
);
const sharedEventsDir = spoolLib.sharedEventsDir(checkoutRoot);
const localEventsDir = join(checkoutRoot, ".claude", ".runtime", "events");
const writerLock = spoolLib.acquireWriterLock(sharedEventsDir, process.pid);
const eventsDir = writerLock.ok ? sharedEventsDir : localEventsDir;
if (!writerLock.ok)
  console.error(
    `Canonical event store is owned by pid ${writerLock.ownerPid}; using the local per-checkout store (degraded).`,
  );
let eventStore = new EventStore(eventsDir);
// Optional OTLP-JSON receiver: populated only if Claude's OTEL exporter is
// pointed at this panel; loopback + Host-check gate it (OTEL sends no auth).
// Persist attributed records under the shared runtime dir so history survives
// a restart; retention drops day files past the window.
// 90 days so the Cost view's 30d window (and a meaningful "all-time") have
// history to answer from; day files are small NDJSON.
const otelStore = new OtelStore({
  dir: join(sharedEventsDir, "..", "otel"),
  retentionDays: 90,
});
const INGEST_TOKEN = randomBytes(24).toString("hex");
try {
  spoolLib.writeIngestDescriptor(eventsDir, {
    token: INGEST_TOKEN,
    port: PORT,
  });
} catch {
  /* the emitter POST will be rejected; spool promotion still delivers */
}

// Per-launch bearer for the privileged routes. It is written to the runtime dir
// (profile ACLs) and handed to the browser in a URL fragment, so it never enters
// the served HTML, an API body, a log line or a Referer. This raises the bar for
// other local users and stray clients; a process running as THIS user can read
// the file, and is deliberately out of scope. See docs/SECURITY.md.
const PANEL_TOKEN = randomBytes(24).toString("hex");
const panelTokenPath = join(runtimeDir, "panel.token");
try {
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(panelTokenPath, `${PANEL_TOKEN}\n`, { mode: 0o600 });
} catch {
  /* the UI will surface a 401 rather than fail silently */
}

/**
 * Constant-time bearer check. Both sides are hashed to fixed-length digests
 * first, so timingSafeEqual never sees variable-length input (it throws on
 * length mismatch, and a length-gated compare leaks the length).
 */
function tokenMatches(supplied, expected) {
  if (typeof supplied !== "string" || supplied.length === 0) return false;
  const a = createHash("sha256").update(supplied, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Bearer check for privileged routes. */
function hasPanelToken(request) {
  return tokenMatches(request.headers["x-panel-token"], PANEL_TOKEN);
}

/** Roots holding statusline session records: this checkout and its worktrees. */
async function telemetryRoots() {
  try {
    const worktrees = await getWorktrees(ctx);
    return [checkoutRoot, ...(worktrees || []).map((w) => w.path)].filter(
      Boolean,
    );
  } catch {
    return [checkoutRoot];
  }
}

const artifactsRoot = resolve(join(runtimeDir, "artifacts"));

/**
 * Validate a requested working directory for a job. Only the current checkout or a
 * worktree that `git worktree list` knows about may be a job cwd, no arbitrary path.
 * @returns {Promise<{ cwd: string, worktree: string|null } | null>}
 */
async function resolveJobCwd(worktreePath) {
  if (!worktreePath) return { cwd: checkoutRoot, worktree: ctx.branch ?? null };
  const norm = (p) =>
    String(p || "")
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
  const target = norm(worktreePath);
  if (target === norm(checkoutRoot))
    return { cwd: checkoutRoot, worktree: ctx.branch ?? null };
  const trees = await getWorktrees(ctx);
  const match = trees.find((w) => norm(w.path) === target);
  return match
    ? { cwd: resolve(match.path), worktree: match.branch || null }
    : null;
}

// Cached costly adapter results. Reviews recompute on demand / startup; the
// validation report is read from disk (written by the validation.run action).
let reviewsCache = /** @type {any} */ ({
  status: "pending",
  findings: [],
  blockCount: 0,
  warnCount: 0,
  base: null,
});
function readValidationCache() {
  return getValidation({ runtimeDir });
}

// GitLab is an external, slow call: poll it on its own cadence and serve the last
// result from the snapshot, so the 8s tick never blocks on the network.
let forgeCache = /** @type {any} */ ({ configured: false });
let forgeInFlight = false;
let forgeAt = 0;
// Last pipeline/MR state we notified on, so a 60s poll only fires when something
// actually changed. Seeded by the first poll (no notification on startup).
const forgeNotified = { pipelineKey: null, mrKey: null, seeded: false };

function detectGitlabChanges(next) {
  if (!next || !next.configured) return;
  const p = next.pipeline;
  const mr = next.mr;
  const pipelineKey = p ? `${p.id}:${p.status}` : null;
  const mrKey = mr ? `${mr.iid}:${mr.updatedAt}` : null;
  if (forgeNotified.seeded) {
    if (pipelineKey && pipelineKey !== forgeNotified.pipelineKey)
      hub.broadcast("panel", {
        type: "forge.pipeline",
        message: `Pipeline ${p.status} on ${next.branch}`,
        status: p.status,
        webUrl: p.webUrl,
        emittedAt: new Date().toISOString(),
      });
    if (mrKey && mrKey !== forgeNotified.mrKey)
      hub.broadcast("panel", {
        type: "forge.mr",
        message: `MR !${mr.iid} updated: ${mr.title}`,
        webUrl: mr.webUrl,
        emittedAt: new Date().toISOString(),
      });
  }
  forgeNotified.pipelineKey = pipelineKey;
  forgeNotified.mrKey = mrKey;
  forgeNotified.seeded = true;
}

async function refreshForge() {
  if (forgeInFlight || !ctx.branch) return;
  forgeInFlight = true;
  try {
    const next = await getForgeStatus(checkoutRoot, ctx.branch);
    detectGitlabChanges(next);
    forgeCache = next;
  } catch (e) {
    forgeCache = { configured: true, error: String((e && e.message) || e) };
  } finally {
    forgeInFlight = false;
    forgeAt = Date.now();
  }
}

// Review threads move slower than pipelines and cost more requests, so they get
// their own, slower poll. Nothing is fetched until a forge and an open change
// exist, and the config toggle stops it entirely.
let inboxCache = /** @type {any} */ (null);
let inboxInFlight = false;
let inboxAt = 0;
const INBOX_POLL_MS = 120000;

async function refreshReviewInbox() {
  if (inboxInFlight) return;
  const mr = forgeCache?.configured ? forgeCache.mr : null;
  if (!mr?.iid) {
    inboxCache = null;
    return;
  }
  inboxInFlight = true;
  try {
    inboxCache = await getReviewInbox(ctx, {
      mr,
      enabled: reviewInboxEnabled(),
    });
  } catch (e) {
    inboxCache = {
      available: false,
      reason: "fetch-failed",
      detail: String((e && e.message) || e),
      provider: forgeCache?.provider ?? null,
      items: [],
      notes: [],
    };
  } finally {
    inboxInFlight = false;
    inboxAt = Date.now();
  }
}

/**
 * Opt-out for the review poll: `PANEL_REVIEW_INBOX=off`, or `reviewInbox:false`
 * in the checkout's .claude/settings.local.json. Absent means on; off means the
 * poller issues no requests at all.
 */
function reviewInboxEnabled() {
  if (String(process.env.PANEL_REVIEW_INBOX || "").toLowerCase() === "off")
    return false;
  try {
    const settings = JSON.parse(
      readFileSync(
        join(checkoutRoot, ".claude", "settings.local.json"),
        "utf8",
      ),
    );
    return settings?.reviewInbox !== false;
  } catch {
    return true;
  }
}

// CI is read for the commit the change is on, not for whatever ran last. Its
// own cadence sits between the forge poll and the inbox poll: checks move while
// you watch them, but every read costs two requests.
let ciCache = /** @type {any} */ (null);
let ciInFlight = false;
let ciAt = 0;
const CI_POLL_MS = 60000;

async function refreshCi() {
  if (ciInFlight) return;
  const mr = forgeCache?.configured ? forgeCache.mr : null;
  const sha = mr?.headSha ?? null;
  if (!sha) {
    ciCache = null;
    return;
  }
  ciInFlight = true;
  try {
    ciCache = await getCi(
      checkoutRoot,
      { sha, pipelineId: forgeCache?.pipeline?.id ?? null },
      { enabled: reviewInboxEnabled() },
    );
  } catch (e) {
    ciCache = {
      available: false,
      reason: String((e && e.message) || e),
      provider: forgeCache?.provider ?? null,
      ref: sha,
      failures: [],
      observedAt: new Date().toISOString(),
    };
  } finally {
    ciInFlight = false;
    ciAt = Date.now();
  }
}

// Whether the provider will merge, asked of the provider. Slower than CI: the
// answer changes on a push or an approval, not while you watch it.
let mergeCache = /** @type {any} */ (null);
let mergeInFlight = false;
let mergeAt = 0;
const MERGE_POLL_MS = 90000;

async function refreshMergeability() {
  if (mergeInFlight) return;
  const mr = forgeCache?.configured ? forgeCache.mr : null;
  if (!mr?.iid) {
    mergeCache = null;
    return;
  }
  mergeInFlight = true;
  try {
    mergeCache = await getMergeability(checkoutRoot, mr);
  } catch (e) {
    mergeCache = {
      ok: false,
      provider: forgeCache?.provider ?? null,
      mergeable: "unknown",
      reason: String((e && e.message) || e),
      observedAt: new Date().toISOString(),
    };
  } finally {
    mergeInFlight = false;
    mergeAt = Date.now();
  }
}

// Assisted tasks: bind the ones whose marker has appeared, notice the ones that
// went quiet, and refresh what each has actually changed. Nothing here launches
// anything - a task the human never submitted simply stays in CREATED.
let taskCache = /** @type {any} */ ({ counts: null, recent: [] });
let tasksInFlight = false;
let tasksAt = 0;
const TASK_POLL_MS = 30000;

async function refreshTasks(worktrees = []) {
  if (tasksInFlight) return;
  tasksInFlight = true;
  try {
    let store = readTasks(runtimeDir);
    let changed = false;

    const pending = openTasks(store).filter((t) => !t.sessionId);
    if (pending.length) {
      const transcripts = candidateTranscripts(ctx, worktrees, {
        now: Date.now(),
      });
      const found = findMarkers(
        pending.map((t) => t.correlationMarker),
        transcripts,
      );
      for (const task of pending) {
        const sessionId = found.get(task.correlationMarker);
        if (!sessionId) continue;
        // The baseline is HEAD as it stands when the work is first observed,
        // so evidence later comes from an exact range rather than a clock.
        const baselineSha = await git(["rev-parse", "HEAD"], ctx.checkoutRoot);
        const bound = bindSession(task, {
          sessionId,
          marker: task.correlationMarker,
          now: Date.now(),
          baselineSha: baselineSha || null,
        });
        if (!bound.ok) continue;
        store = upsertTask(store, bound.task);
        changed = true;
        hub.broadcast("panel", {
          type: "task.bound",
          taskId: task.id,
          sessionId,
          emittedAt: new Date().toISOString(),
        });
      }
    }

    for (const task of openTasks(store)) {
      if (!task.startedAt) continue;
      const evidence = await collectTaskEvidence(ctx.checkoutRoot, task);
      const next = {
        files: evidence.files,
        commit: evidence.commit,
        tests: task.evidence?.tests ?? [],
      };
      if (JSON.stringify(next) === JSON.stringify(task.evidence)) continue;
      store = upsertTask(store, { ...task, evidence: next });
      changed = true;
    }

    const swept = sweepStalled(store);
    store = swept.store;
    changed = changed || swept.changed;

    if (changed) writeTasks(runtimeDir, store);
    taskCache = summarizeTasks(store);
  } catch {
    /* tasks are supporting evidence; a failure here must not break the tick */
  } finally {
    tasksInFlight = false;
    tasksAt = Date.now();
  }
}

/** On boot, re-check every open task against the sessions that exist now. */
function reconcileTasksOnBoot() {
  try {
    const store = readTasks(runtimeDir);
    // Summarize even an empty store, so the snapshot's shape is the same from
    // the very first tick rather than filling in once a poll has run.
    taskCache = summarizeTasks(store);
    if (!store.tasks.length) return;
    const live = new Set(
      candidateTranscripts(ctx, [], { now: Date.now() }).map((t) => t.sessionId),
    );
    const result = reconcileTasks(store, { liveSessionIds: live });
    if (result.changed) writeTasks(runtimeDir, result.store);
    taskCache = summarizeTasks(result.store);
  } catch {
    /* an unreadable task store degrades to an empty summary */
  }
}

/** Recursive byte size of this panel's runtime dir (logs + artifacts). Small + own. */
function dirSize(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSize(full);
      else if (e.isFile()) total += statSync(full).size;
    } catch {
      /* skip unreadable entry */
    }
  }
  return total;
}

async function currentSnapshot() {
  // The checkout adapter resolves the branch; no extra git call needed here.
  const snapshot = await buildSnapshot(ctx, {
    subscriptions: await readSubscriptionSnapshot(),
    reviews: reviewsCache,
    validation: readValidationCache(),
    jobs: jobs.list(),
    forge: forgeCache,
    reviewInbox: summarizeInbox(inboxCache),
    ci: summarizeCi(ciCache),
    mergeability: mergeCache,
    tasks: taskCache,
    otel: otelStore.summary(),
    events: eventStore.reconcile().snapshot(),
    perf,
    panel: {
      host: sampleHostMetrics(checkoutRoot),
      pid: process.pid,
      port: PORT,
      uptimeSec: Math.round(process.uptime()),
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
      sseClients: hub.clients.size,
      ownership: Boolean(NONCE),
      runtimeBytes: dirSize(runtimeDir),
      version: VERSION,
      schemaVersion: SCHEMA_VERSION,
      node: process.version,
      platform: process.platform,
      cpus: CPU_COUNT,
    },
  });
  // Remember the branch so the forge poller queries the right ref, and refresh
  // it at most once a minute (fire-and-forget; never blocks the snapshot).
  if (snapshot.checkout?.branch) ctx.branch = snapshot.checkout.branch;
  if (ctx.branch && Date.now() - forgeAt > 60000) void refreshForge();
  if (Date.now() - inboxAt > INBOX_POLL_MS) void refreshReviewInbox();
  if (Date.now() - ciAt > CI_POLL_MS) void refreshCi();
  if (Date.now() - mergeAt > MERGE_POLL_MS) void refreshMergeability();
  if (Date.now() - tasksAt > TASK_POLL_MS)
    void refreshTasks(snapshot.worktrees || []);
  return snapshot;
}

async function refreshAndBroadcast() {
  try {
    const snapshot = await currentSnapshot();
    hub.broadcast("snapshot", snapshot);
  } catch (error) {
    hub.broadcast("panel", {
      type: "log",
      level: "error",
      message: `snapshot failed: ${error?.message ?? error}`,
      emittedAt: new Date().toISOString(),
    });
  }
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true; // same-origin fetch may omit Origin
  try {
    const host = new URL(origin).host;
    return host === `${HOST}:${PORT}` || host === `localhost:${PORT}`;
  } catch {
    return false;
  }
}

function readBody(request, limit = 64 * 1024) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks = [];
    request.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        rejectPromise(new Error("Body too large"));
        request.destroy();
        return;
      }
      chunks.push(c);
    });
    request.on("end", () =>
      resolvePromise(Buffer.concat(chunks).toString("utf8")),
    );
    request.on("error", rejectPromise);
  });
}

const server = http.createServer(async (request, response) => {
  let url;
  try {
    url = new URL(request.url || "/", `http://${HOST}:${PORT}`);
  } catch {
    sendJson(response, 400, { error: "Bad request" });
    return;
  }
  const path = url.pathname;
  const method = request.method || "GET";

  // Defeat DNS rebinding: a privileged loopback service must reject any Host that
  // is not exactly our loopback origin, for reads AND writes (binding to 127.0.0.1
  // alone does not stop a rebound attacker page from reading these endpoints).
  if (!ALLOWED_HOSTS.has(String(request.headers.host || "").toLowerCase())) {
    sendJson(response, 421, {
      error: "Misdirected request: unexpected Host header",
    });
    return;
  }

  // One read-auth policy, applied in one place: every /api route needs the
  // panel bearer. The exceptions are each a different trust story - /health
  // and /api/version are liveness, ingest carries its own token, and
  // /events is the one tokenless stream because EventSource cannot send
  // headers (its payload scope is documented in docs/SECURITY.md).
  const TOKENLESS_API = new Set(["/api/version", "/api/ingest/event"]);
  if (
    path.startsWith("/api/") &&
    !TOKENLESS_API.has(path) &&
    !hasPanelToken(request)
  ) {
    sendJson(response, 401, { error: "Missing or invalid panel token" });
    return;
  }

  try {
    // ── Mutating actions ──
    if (path === "/api/display-preferences") {
      const file = join(
        process.env.OCELIN_DATA_DIR || runtimeDir,
        "workspace-display.json",
      );
      if (method === "GET") return sendJson(response, 200, readDisplay(file));
      if (method !== "POST")
        return sendJson(response, 405, { error: "Method not allowed" });
      if (!isSameOrigin(request))
        return sendJson(response, 403, { error: "Cross-origin request refused" });
      try {
        const patch = JSON.parse(await readBody(request, 4096));
        return sendJson(response, 200, saveDisplay(file, patch));
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
    }
    if (path.startsWith("/api/actions/")) {
      if (method !== "POST")
        return sendJson(response, 405, { error: "Method not allowed" });
      if (!isSameOrigin(request))
        return sendJson(response, 403, {
          error: "Cross-origin request refused",
        });
      if (!hasPanelToken(request))
        return sendJson(response, 401, {
          error: "Missing or invalid panel token",
        });
      const name = decodeURIComponent(path.slice("/api/actions/".length));
      if (!ACTION_NAMES.includes(name))
        return sendJson(response, 404, { error: `Unknown action: ${name}` });
      /** @type {Record<string, unknown>} */
      let params = {};
      try {
        const raw = await readBody(request);
        params = raw ? JSON.parse(raw) : {};
      } catch (error) {
        return sendJson(response, 400, {
          error: error?.message ?? "Invalid body",
        });
      }
      const result = await runAction(name, params, {
        ctx,
        hub,
        setReviews: (r) => (reviewsCache = r),
        refresh: refreshAndBroadcast,
        resolveWorktree: resolveJobCwd,
        snapshot: currentSnapshot,
        reviewInbox: async () => inboxCache,
        ci: async () => {
          if (!ciCache) await refreshCi();
          return ciCache;
        },
        ciLog: (job) => getCiLogTail(checkoutRoot, job),
      });
      return sendJson(response, result.ok === false ? 400 : 200, result);
    }

    // ── Event ingest (the emitter hook, not a browser: bearer token, no Origin) ──
    if (path === "/api/ingest/event" && method === "POST") {
      if (!tokenMatches(request.headers["x-panel-token"], INGEST_TOKEN))
        return sendJson(response, 401, { error: "Invalid ingest token" });
      let evt = null;
      try {
        const raw = await readBody(request, 256 * 1024);
        evt = raw ? JSON.parse(raw) : null;
      } catch (error) {
        return sendJson(response, 400, {
          error: error?.message ?? "Invalid body",
        });
      }
      const result = eventStore.ingest(evt);
      perf.recordIngest(result.ok === true);
      if (!result.ok) return sendJson(response, 400, result);
      if (!result.duplicate) hub.broadcast("event", evt); // low-latency delta
      return sendJson(response, 200, result);
    }

    // ── Event / session projection (read-only) ──
    if (path === "/api/events" && method === "GET") {
      return sendJson(response, 200, eventStore.reconcile().snapshot());
    }

    // ── Cost / economics rollup (read-only) ──
    if (path === "/api/cost" && method === "GET") {
      const snap = await currentSnapshot();
      return sendJson(response, 200, snap.cost);
    }

    // ── OTLP-JSON metrics receiver (bearer token: it appends to disk) ──
    if (path === "/v1/metrics" && method === "POST") {
      if (!hasPanelToken(request))
        return sendJson(response, 401, {
          error: "Missing or invalid panel token",
        });
      let body = null;
      try {
        const raw = await readBody(request, 2 * 1024 * 1024);
        body = raw ? JSON.parse(raw) : null;
      } catch {
        return sendJson(response, 400, {});
      }
      try {
        otelStore.ingestMetrics(body);
      } catch {
        /* tolerate an unexpected OTLP shape */
      }
      return sendJson(response, 200, {}); // OTLP/HTTP expects a 200
    }

    // ── OTEL usage summary (read-only) ──
    if (path === "/api/otel" && method === "GET") {
      return sendJson(response, 200, otelStore.summary());
    }

    // ── Job control (mutating, allowlisted commands only) ──
    if (path === "/api/jobs" && method === "POST") {
      if (!hasPanelToken(request))
        return sendJson(response, 401, {
          error: "Missing or invalid panel token",
        });
      if (!isSameOrigin(request))
        return sendJson(response, 403, {
          error: "Cross-origin request refused",
        });
      let body = {};
      try {
        const raw = await readBody(request);
        body = raw ? JSON.parse(raw) : {};
      } catch (error) {
        return sendJson(response, 400, {
          error: error?.message ?? "Invalid body",
        });
      }
      const command = findCommand(String(body.key ?? ""));
      if (!command)
        return sendJson(response, 404, {
          error: `Unknown command: ${body.key}`,
        });
      if (!commandAvailable(ctx, command))
        return sendJson(response, 400, {
          error: "This command's tooling is not present in the checkout.",
        });
      if (command.scope === "checkout" && body.worktreePath)
        return sendJson(response, 400, {
          error: "This command runs in the current checkout only.",
        });
      const resolved = await resolveJobCwd(
        command.scope === "checkout" ? null : body.worktreePath,
      );
      if (!resolved)
        return sendJson(response, 400, {
          error: "Unknown or invalid worktree.",
        });
      const slug =
        (resolved.worktree || "checkout")
          .replace(/[^a-zA-Z0-9._-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "checkout";
      const stamp = `${Date.now().toString(36)}`;
      let built;
      try {
        built = command.build(ctx, {
          cwd: resolved.cwd,
          slug,
          stamp,
          params: body.params || {},
        });
      } catch (e) {
        return sendJson(response, 400, {
          error: String((e && e.message) || e),
        });
      }
      const started = jobs.start({
        key: command.key,
        label: command.label,
        group: command.group,
        cwd: resolved.cwd,
        worktree: resolved.worktree,
        mutating: command.mutating,
        bin: built.bin,
        args: built.args,
        artifactPath: built.artifactPath ?? null,
      });
      if (started.ok) refreshAndBroadcast();
      return sendJson(response, started.ok ? 200 : 429, started);
    }

    if (
      path.startsWith("/api/jobs/") &&
      path.endsWith("/cancel") &&
      method === "POST"
    ) {
      if (!hasPanelToken(request))
        return sendJson(response, 401, {
          error: "Missing or invalid panel token",
        });
      if (!isSameOrigin(request))
        return sendJson(response, 403, {
          error: "Cross-origin request refused",
        });
      const id = decodeURIComponent(
        path.slice("/api/jobs/".length, -"/cancel".length),
      );
      const result = jobs.cancel(id);
      if (result.ok) refreshAndBroadcast();
      return sendJson(response, result.ok ? 200 : 404, result);
    }

    if (method !== "GET")
      return sendJson(response, 405, { error: "Method not allowed" });

    if (path === "/api/commands") {
      return sendJson(response, 200, {
        commands: COMMANDS.filter((c) => commandAvailable(ctx, c)).map((c) => ({
          key: c.key,
          label: c.label,
          description: c.description,
          group: c.group,
          scope: c.scope,
          mutating: Boolean(c.mutating),
          network: Boolean(c.network),
        })),
        claude: CLAUDE_COMMANDS,
      });
    }

    if (path === "/api/jobs") {
      return sendJson(response, 200, { jobs: jobs.list() });
    }

    if (path.startsWith("/api/jobs/") && path.endsWith("/artifact")) {
      const id = decodeURIComponent(
        path.slice("/api/jobs/".length, -"/artifact".length),
      );
      const art = jobs.artifact(id);
      if (!art)
        return sendJson(response, 404, { error: "No artifact for this job" });
      const resolved = resolve(art.path);
      if (
        resolved !== artifactsRoot &&
        !resolved.startsWith(artifactsRoot + sep)
      ) {
        return sendJson(response, 403, {
          error: "Artifact path outside the artifacts root",
        });
      }
      response.setHeader(
        "content-disposition",
        `attachment; filename="${art.name.replace(/[^a-zA-Z0-9._-]+/g, "_")}"`,
      );
      return sendExactFile(response, resolved, "application/zip");
    }

    if (path.startsWith("/api/jobs/")) {
      const id = decodeURIComponent(path.slice("/api/jobs/".length));
      const detail = jobs.get(id);
      return detail
        ? sendJson(response, 200, detail)
        : sendJson(response, 404, { error: "Job not found" });
    }

    if (path === "/health") {
      return sendJson(response, 200, {
        status: "ok",
        service: "claude-panel",
        version: VERSION,
        checkoutId,
        nonce: NONCE,
        pid: process.pid,
        now: new Date().toISOString(),
      });
    }

    if (path === "/api/version") {
      return sendJson(response, 200, {
        name: APP_NAME,
        version: VERSION,
        checkout: {
          id: checkoutId,
          root: checkoutRoot,
          repoRoot,
          branch:
            (await git(["branch", "--show-current"], checkoutRoot)) || null,
          commit:
            (await git(["rev-parse", "--short", "HEAD"], checkoutRoot)) || null,
        },
        node: process.version,
        runtimeDir,
      });
    }

    if (path === "/api/review-inbox") {
      if (!inboxCache) await refreshReviewInbox();
      const inbox = inboxCache;
      if (!inbox) return sendJson(response, 200, { available: false, reason: "no-change", items: [] });
      return sendJson(response, 200, inbox);
    }

    if (path === "/api/review-inbox/thread") {
      const id = String(url.searchParams.get("id") || "");
      if (!/^rt_[0-9a-f]{24}$/.test(id))
        return sendJson(response, 400, { error: "Bad thread id" });
      const item = (inboxCache?.items || []).find((i) => i.thread.id === id);
      if (!item) return sendJson(response, 404, { error: "Unknown thread" });
      return sendJson(response, 200, {
        item,
        draft: readDraft(runtimeDir, id),
      });
    }

    if (path === "/api/ci") {
      if (!ciCache) await refreshCi();
      return sendJson(
        response,
        200,
        ciCache ?? { available: false, reason: "no-head-commit" },
      );
    }

    if (path === "/api/ci/log") {
      // Job output is the one CI payload that never rides the snapshot: it is
      // unbounded third-party text, so it is fetched on demand, per job, here.
      const job = String(url.searchParams.get("job") || "");
      if (!/^[0-9]{1,20}$/.test(job))
        return sendJson(response, 400, { error: "Bad job id" });
      const known = (ciCache?.contexts || []).some(
        (c) => String(c.jobId ?? c.id) === job,
      );
      if (!known)
        return sendJson(response, 404, {
          error: "That job is not part of the CI read for this commit.",
        });
      const tail = await getCiLogTail(checkoutRoot, job);
      if (!tail.ok || tail.refused) return sendJson(response, 200, tail);
      // Attribution is computed here, next to the log that justifies it, and
      // defaults to "no reliable attribution" when the evidence does not line up.
      return sendJson(response, 200, {
        ...tail,
        attribution: attributeFailure(
          { name: job, jobId: job },
          { logText: tail.text, tasks: readTasks(runtimeDir)?.tasks ?? [] },
        ),
      });
    }

    if (path === "/api/snapshot") {
      const snap = await currentSnapshot();
      const etag = `"${snap.sections?.version || "0"}"`;
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { etag });
        return response.end();
      }
      return sendJson(response, 200, snap, { etag });
    }

    if (path.startsWith("/api/runs/")) {
      const id = decodeURIComponent(path.slice("/api/runs/".length));
      const detail = await getRunDetails(ctx, id);
      return detail
        ? sendJson(response, 200, detail)
        : sendJson(response, 404, { error: "Run not found" });
    }

    if (path === "/api/logs") {
      const limit = Number(url.searchParams.get("limit")) || 400;
      const service = url.searchParams.get("service") || undefined;
      return sendJson(response, 200, {
        lines: getRecentLogs({ runtimeDir }, { limit, service }),
      });
    }

    if (path === "/api/reviews") {
      const wtParam = url.searchParams.get("worktree");
      if (wtParam) {
        const resolved = await resolveJobCwd(wtParam);
        if (!resolved)
          return sendJson(response, 400, {
            error: "Unknown or invalid worktree.",
          });
        const scoped = await getReviews({ ...ctx, checkoutRoot: resolved.cwd });
        return sendJson(response, 200, {
          ...scoped,
          worktree: resolved.worktree,
        });
      }
      reviewsCache = await getReviews(ctx);
      return sendJson(response, 200, reviewsCache);
    }

    if (path === "/api/review-pack/preview") {
      const wtParam = url.searchParams.get("worktree");
      let cwd = ctx.checkoutRoot;
      let worktree = null;
      if (wtParam) {
        const resolved = await resolveJobCwd(wtParam);
        if (!resolved)
          return sendJson(response, 400, {
            error: "Unknown or invalid worktree.",
          });
        cwd = resolved.cwd;
        worktree = resolved.worktree;
      }
      const preview = await getDiffPreview(cwd);
      return sendJson(response, 200, { ...preview, worktree });
    }

    if (path === "/api/diff") {
      // Unified diff of one file between the review base and HEAD. Read-only; the
      // path is a git pathspec after `--`, and rejected if it escapes the tree.
      const wtParam = url.searchParams.get("worktree");
      const file = url.searchParams.get("file") || "";
      let cwd = ctx.checkoutRoot;
      if (wtParam) {
        const resolved = await resolveJobCwd(wtParam);
        if (!resolved)
          return sendJson(response, 400, {
            error: "Unknown or invalid worktree.",
          });
        cwd = resolved.cwd;
      }
      if (!isSafeRelativeFile(file))
        return sendJson(response, 400, { error: "Invalid file path." });
      // mode=working shows uncommitted changes vs HEAD (untracked files are
      // diffed against an empty tree); default shows the committed branch diff.
      if (url.searchParams.get("mode") === "working") {
        let diff = await git(["diff", "HEAD", "--", file], cwd);
        if (!String(diff || "").trim())
          diff = await git(
            ["diff", "--no-index", "--", "/dev/null", file],
            cwd,
          );
        return sendJson(response, 200, {
          file,
          base: "working tree",
          diff: String(diff || "").slice(0, 200000),
        });
      }
      const { base } = await resolveBase(cwd);
      if (!base) return sendJson(response, 200, { file, base: null, diff: "" });
      const diff = await git(["diff", `${base}...HEAD`, "--", file], cwd);
      return sendJson(response, 200, {
        file,
        base: base.slice(0, 9),
        diff: String(diff || "").slice(0, 200000),
      });
    }

    if (path === "/api/working-tree") {
      // Uncommitted (staged + unstaged + untracked) file list for a worktree.
      const wtParam = url.searchParams.get("worktree");
      let cwd = ctx.checkoutRoot;
      let worktree = null;
      if (wtParam) {
        const resolved = await resolveJobCwd(wtParam);
        if (!resolved)
          return sendJson(response, 400, {
            error: "Unknown or invalid worktree.",
          });
        cwd = resolved.cwd;
        worktree = resolved.worktree;
      }
      // Tab-delimited so the trimmed git() output parses cleanly (porcelain's
      // leading status space would be eaten by the trim on the first line).
      const tracked = await git(["diff", "--name-status", "HEAD"], cwd);
      const files = [];
      for (const line of String(tracked || "").split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        const status = (parts[0] || "?")[0];
        const p = parts[parts.length - 1];
        if (p) files.push({ path: p, status });
      }
      const untracked = await git(
        ["ls-files", "--others", "--exclude-standard"],
        cwd,
      );
      for (const p of String(untracked || "").split(/\r?\n/)) {
        if (p.trim()) files.push({ path: p.trim(), status: "?" });
      }
      return sendJson(response, 200, { files, worktree, dirty: files.length });
    }

    if (path === "/api/session-tasks") {
      // Full task list for one Claude session from the harness task store
      // (~/.claude/tasks/<sessionId>/N.json). Read-only; the id is validated to a
      // uuid shape so it can never escape the tasks dir. Token-gated: task
      // subjects are user-authored text.
      if (!hasPanelToken(request))
        return sendJson(response, 401, {
          error: "Missing or invalid panel token",
        });
      const sid = (url.searchParams.get("session") || "").trim();
      if (!/^[0-9a-fA-F-]{8,64}$/.test(sid))
        return sendJson(response, 400, { error: "Invalid session id." });
      const dir = join(homedir(), ".claude", "tasks", sid);
      let names = [];
      try {
        names = readdirSync(dir);
      } catch {
        return sendJson(response, 200, { session: sid, tasks: [] });
      }
      const tasks = [];
      for (const name of names
        .filter((n) => /^\d+\.json$/.test(n))
        .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
        try {
          const t = JSON.parse(readFileSync(join(dir, name), "utf8"));
          if (t && typeof t.status === "string")
            tasks.push({
              id: t.id,
              subject: t.subject || "",
              status: t.status,
              activeForm: t.activeForm || "",
              blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy : [],
            });
        } catch {
          /* skip unreadable task */
        }
      }
      return sendJson(response, 200, { session: sid, tasks });
    }

    if (path === "/api/session-feed") {
      if (!hasPanelToken(request))
        return sendJson(response, 401, {
          error: "Missing or invalid panel token",
        });
      const sid = (url.searchParams.get("session") || "").trim();
      if (!/^(?:[0-9a-fA-F-]{8,64}|agent-[a-f0-9]{8,64})$/.test(sid))
        return sendJson(response, 400, { error: "Invalid session id." });
      const provider = url.searchParams.get("provider") || "claude";
      if (!["claude", "codex"].includes(provider))
        return sendJson(response, 400, { error: "Invalid session provider." });
      const wtParam = url.searchParams.get("worktree");
      let basePath = ctx.checkoutRoot;
      if (wtParam) {
        const resolved = await resolveJobCwd(wtParam);
        if (!resolved)
          return sendJson(response, 400, {
            error: "Unknown or invalid worktree.",
          });
        basePath = resolved.cwd;
      }
      const file = monitorTranscript(provider, sid, basePath) || (provider === "codex"
        ? resolveCodexTranscript(sid, basePath)
        : join(homedir(), ".claude", "projects", slugForPath(basePath), `${sid}.jsonl`));
      const feed = file
        ? getSessionFeed(file, { limit: 60, provider })
        : { events: [], missing: true };
      return sendJson(response, 200, { session: sid, provider, ...feed });
    }

    if (path === "/api/trace") {
      // Turn/span waterfall from the transcript. Token-gated like the feed:
      // span summaries carry command lines and file paths verbatim.
      if (!hasPanelToken(request))
        return sendJson(response, 401, {
          error: "Missing or invalid panel token",
        });
      const sid = (url.searchParams.get("session") || "").trim();
      if (!/^(?:[0-9a-fA-F-]{8,64}|agent-[a-f0-9]{8,64})$/.test(sid))
        return sendJson(response, 400, { error: "Invalid session id." });
      const provider = url.searchParams.get("provider") || "claude";
      if (!["claude", "codex"].includes(provider))
        return sendJson(response, 400, { error: "Invalid session provider." });
      const wtParam = url.searchParams.get("worktree");
      let basePath = ctx.checkoutRoot;
      if (wtParam) {
        const resolved = await resolveJobCwd(wtParam);
        if (!resolved)
          return sendJson(response, 400, {
            error: "Unknown or invalid worktree.",
          });
        basePath = resolved.cwd;
      }
      const turnsRaw = url.searchParams.get("turns");
      const turnsParam = turnsRaw == null ? NaN : Number(turnsRaw);
      const maxTurns = Number.isInteger(turnsParam)
        ? Math.max(1, Math.min(50, turnsParam))
        : undefined;
      const file = monitorTranscript(provider, sid, basePath) || (provider === "codex"
        ? resolveCodexTranscript(sid, basePath)
        : join(homedir(), ".claude", "projects", slugForPath(basePath), `${sid}.jsonl`));
      // Liveness = the transcript still being appended to; a dead session must
      // never present its unfinished tail as running tools.
      let sessionLive = false;
      try {
        sessionLive = provider === "codex"
          ? codexSessionIsLive(file)
          : agentIsActive({
              lastMs: statSync(file).mtimeMs,
              sampleAgeMs: null,
              now: Date.now(),
            });
      } catch {
        /* missing file: adapter reports missing */
      }
      const trace = file
        ? getSessionTrace(file, { maxTurns, sessionLive, provider })
        : {
            missing: true,
            turns: [],
            model: null,
            truncated: false,
            caps: { maxTurns: maxTurns ?? 20, tailBytes: 4 * 1024 * 1024 },
          };
      return sendJson(response, 200, { ...trace, session: sid, provider, sessionLive });
    }

    if (path === "/api/tasks") {
      // Full task records: briefs live in files, but evidence paths and session
      // ids are still local detail, so this stays behind the bearer.
      if (!hasPanelToken(request))
        return sendJson(response, 401, {
          error: "Missing or invalid panel token",
        });
      const store = readTasks(runtimeDir);
      return sendJson(response, 200, {
        tasks: store.tasks,
        summary: summarizeTasks(store),
      });
    }

    if (path === "/api/subagents") {
      // The session's subagent tree. Token-gated like the trace: an agent's
      // closing report carries file paths and command output verbatim.
      if (!hasPanelToken(request))
        return sendJson(response, 401, {
          error: "Missing or invalid panel token",
        });
      const sid = (url.searchParams.get("session") || "").trim();
      if (!/^[0-9a-fA-F-]{8,64}$/.test(sid))
        return sendJson(response, 400, { error: "Invalid session id." });
      const wtParam = url.searchParams.get("worktree");
      let basePath = ctx.checkoutRoot;
      if (wtParam) {
        const resolved = await resolveJobCwd(wtParam);
        if (!resolved)
          return sendJson(response, 400, {
            error: "Unknown or invalid worktree.",
          });
        basePath = resolved.cwd;
      }
      const file = join(
        homedir(),
        ".claude",
        "projects",
        slugForPath(basePath),
        `${sid}.jsonl`,
      );
      return sendJson(response, 200, getSubagentTree(file));
    }

    if (path === "/api/mcp") {
      // Recent-session MCP/skill usage; adapter caches for a minute.
      const worktrees = await getWorktrees(ctx).catch(() => []);
      return sendJson(response, 200, getMcpAnalytics(ctx, worktrees || []));
    }

    if (path === "/api/config-map") {
      // Declared Claude config correlated with observed usage.
      const worktrees = await getWorktrees(ctx).catch(() => []);
      const usage = getMcpAnalytics(ctx, worktrees || []);
      return sendJson(
        response,
        200,
        overlayUsage(discoverConfig(ctx.checkoutRoot), usage),
      );
    }

    if (path === "/api/mr-draft") {
      // Read-only inputs for the MR composer: the branch's commits + diff totals
      // vs the review base, plus the forge's new-MR URL (branch params only). The
      // panel never opens or writes the MR; the user does that on the forge.
      const cwd = ctx.checkoutRoot;
      let target = (url.searchParams.get("target") || "").trim();
      if (!target) {
        const head = (
          (await git(
            ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
            cwd,
          )) || ""
        ).trim();
        target = head.replace(/^origin\//, "") || "main";
      }
      let source = (url.searchParams.get("source") || ctx.branch || "").trim();
      // ctx.branch is unset until the first snapshot; resolve HEAD directly.
      if (!source)
        source = (
          (await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)) || ""
        ).trim();
      if (!isSafeRef(target))
        return sendJson(response, 400, { error: "Invalid target branch." });
      if (!isSafeRef(source))
        return sendJson(response, 400, { error: "Invalid source branch." });
      // Base = merge-base(target, source); prefer the remote target if present.
      let base = null;
      for (const t of [`origin/${target}`, target]) {
        const mb = (await git(["merge-base", t, source], cwd)) || "";
        if (mb.trim()) {
          base = mb.trim();
          break;
        }
      }
      let commits = [];
      let totalFiles = 0;
      let totalAdded = 0;
      let totalRemoved = 0;
      if (base) {
        const log = await git(
          ["log", `${base}..${source}`, "--format=%h\t%s", "--no-merges"],
          cwd,
        );
        commits = String(log || "")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => {
            const tab = line.indexOf("\t");
            return tab === -1
              ? { hash: line, subject: "" }
              : { hash: line.slice(0, tab), subject: line.slice(tab + 1) };
          });
        const ns = await git(["diff", "--numstat", `${base}...${source}`], cwd);
        for (const line of String(ns || "").split(/\r?\n/)) {
          if (!line.trim()) continue;
          const [a, r] = line.split("\t");
          totalFiles += 1;
          if (a !== "-") totalAdded += Number(a) || 0;
          if (r !== "-") totalRemoved += Number(r) || 0;
        }
      }
      return sendJson(response, 200, {
        branch: source,
        target,
        base: base ? base.slice(0, 9) : null,
        commits,
        totalFiles,
        totalAdded,
        totalRemoved,
        newMrUrl: await newMrUrl(ctx.checkoutRoot, source, target),
      });
    }

    if (path === "/api/branches") {
      const out = await git(
        ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        ctx.checkoutRoot,
      );
      const branches = String(out || "")
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);
      const current =
        ctx.branch ||
        (
          (await git(
            ["rev-parse", "--abbrev-ref", "HEAD"],
            ctx.checkoutRoot,
          )) || ""
        ).trim();
      return sendJson(response, 200, { branches, current });
    }

    if (path === "/api/validation") {
      const wtParam = url.searchParams.get("worktree");
      if (!wtParam)
        return sendJson(response, 200, {
          ...readValidationCache(),
          worktree: null,
        });
      const resolved = await resolveJobCwd(wtParam);
      if (!resolved)
        return sendJson(response, 400, {
          error: "Unknown or invalid worktree.",
        });
      const slug =
        (resolved.worktree || "current")
          .replace(/[^a-zA-Z0-9._-]+/g, "-")
          .slice(0, 40) || "current";
      return sendJson(response, 200, {
        ...getValidation({ runtimeDir }, slug),
        worktree: resolved.worktree,
      });
    }

    if (path === "/events") {
      const remove = hub.add(response);
      const snapshot = await currentSnapshot();
      response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      request.on("close", remove);
      return;
    }

    if (path === "/clawd-playground") {
      return sendExactFile(
        response,
        clawdReferencePath,
        "text/html; charset=utf-8",
      );
    }

    // ── Allowlisted third-party vendor assets ──
    if (path.startsWith("/vendor/")) {
      const key = path.slice("/vendor/".length);
      const candidates = Object.prototype.hasOwnProperty.call(VENDOR, key)
        ? VENDOR[key]
        : null;
      if (!candidates)
        return sendJson(response, 404, { error: "Unknown vendor asset" });
      const found = candidates.find((candidate) => {
        try {
          return statSync(candidate).isFile();
        } catch {
          return false;
        }
      });
      if (!found) {
        // 204 (not 404) so the UI's feature probe stays console-quiet.
        response.writeHead(204);
        return response.end();
      }
      return sendExactFile(response, found, "text/javascript; charset=utf-8");
    }

    // ── Static UI ──
    const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
    return await sendStaticFile(response, uiDir, rel);
  } catch (error) {
    sendJson(response, 500, {
      error: escapeHtml(error?.message ?? String(error)),
    });
  }
});

server.on("error", (error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});

server.listen(PORT, HOST, async () => {
  console.log(`Clawdeck listening at http://${HOST}:${PORT}`);
  console.log(`Checkout: ${checkoutRoot}`);
  // Compute reviews once at startup (best-effort) so the first snapshot is complete.
  try {
    reviewsCache = await getReviews(ctx);
  } catch {
    /* leave the pending placeholder */
  }
  // Tasks outlive this process, so re-check every open one against the sessions
  // that exist now. A link we cannot prove again becomes unknown, never failed.
  reconcileTasksOnBoot();
  // Promote anything the spool captured while the panel was down, plus (once)
  // any pre-federation legacy spool this checkout still holds locally.
  try {
    eventStore.promoteSpool();
    if (eventsDir !== localEventsDir)
      eventStore.promoteSpoolFrom(join(localEventsDir, "spool"), "legacy:");
  } catch {
    /* spool absent or unreadable: nothing to promote */
  }
  // Drop day files past the retention window and prune in-memory state, so
  // disk AND memory track the window rather than the whole process lifetime.
  try {
    otelStore.rotate();
    if (writerLock.ok) eventStore.rotate();
    pruneSessionRecords(await telemetryRoots());
  } catch {
    /* rotation is best-effort */
  }
});

// Rotate the canonical event store + OTEL once a day so a long-lived panel
// bounds disk + memory (seen/sessions) to the retention window.
const rotateTick = setInterval(
  () => {
    try {
      if (writerLock.ok) eventStore.rotate();
      otelStore.rotate();
      telemetryRoots().then((roots) => pruneSessionRecords(roots));
    } catch {
      /* next day retries */
    }
  },
  24 * 60 * 60 * 1000,
);
rotateTick.unref();

// Burn sampler: independent of the SSE tick (which is skipped with no browser
// open) so cost history keeps accruing while the bridge writes records. Deltas
// key on each record's own ts, so an unchanged minute appends nothing.
const burnTick = setInterval(async () => {
  try {
    const worktrees = await getWorktrees(ctx).catch(() => []);
    const telemetry = getLiveTelemetry(ctx, worktrees || []);
    recordBurnSample(ctx.runtimeDir, telemetry.sessions);
  } catch {
    /* next minute retries */
  }
}, 60000);
burnTick.unref();

// Periodic refresh keeps Clawd + views truthful without any filesystem watcher.
// Skipped entirely when no browser is connected, so an idle panel spawns nothing.
const tick = setInterval(() => {
  if (hub.clients.size > 0) refreshAndBroadcast();
}, 8000);
tick.unref();
// Promote spool -> canonical store and reconcile stale sessions on a short
// cycle. Every worktree's emitter appends to the SAME shared spool, so this
// pass genuinely recovers events whose live POST never reached us.
const promoteTick = setInterval(() => {
  try {
    // Heartbeat the writer lock; if another panel reclaimed it after our
    // heartbeat lapsed, DEMOTE to the local store rather than keep writing the
    // shared one behind the new owner (which would race its promote/rotate and
    // duplicate lines). touchWriterLock returns false once we no longer own it.
    if (
      writerLock.ok &&
      !spoolLib.touchWriterLock(sharedEventsDir, process.pid)
    ) {
      writerLock.ok = false;
      eventStore = new EventStore(localEventsDir);
      console.error(
        "Lost the canonical event-store lock; demoted to the local per-checkout store.",
      );
    }
    const promoted = eventStore.promoteSpool();
    eventStore.reconcile();
    if (promoted > 0 && hub.clients.size > 0) refreshAndBroadcast();
  } catch {
    /* ignore: next cycle retries */
  }
}, 4000);
promoteTick.unref();
// Lightweight heartbeat so a stalled stream is detectable client-side.
const heartbeat = setInterval(
  () =>
    hub.broadcast("panel", {
      type: "heartbeat",
      emittedAt: new Date().toISOString(),
    }),
  15000,
);
heartbeat.unref();

function shutdown() {
  clearInterval(tick);
  clearInterval(heartbeat);
  clearInterval(promoteTick);
  clearInterval(rotateTick);
  clearInterval(burnTick);
  try {
    if (writerLock.ok) spoolLib.releaseWriterLock(sharedEventsDir, process.pid);
  } catch {
    /* stale locks are reclaimed by pid-liveness on the next start */
  }
  hub.closeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// @ts-check
/** Typed-ish client for the panel's local API + SSE boundary. Same-origin only. */
import { withToken } from "./token-bootstrap.mjs";

// Shadows the global so every call below carries the bearer without touching
// each call site. EventSource cannot send headers, so /events stays a plain
// read stream (metadata only, no prompt or command text).
const fetch = (url, init = {}) => globalThis.fetch(url, withToken(init));

async function asJson(response) {
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Bad JSON from ${response.url}`);
  }
  if (!response.ok)
    throw new Error(data?.error || `${response.status} ${response.statusText}`);
  return data;
}

export const api = {
  displayPreferences: () => fetch("/api/display-preferences").then(asJson),
  saveDisplayPreferences: (value) => fetch("/api/display-preferences", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  }).then(asJson),
  /** With `opts.etag`, resolves to null when the server answers 304 (unchanged). */
  snapshot: (opts = {}) =>
    fetch(
      "/api/snapshot",
      opts.etag ? { headers: { "if-none-match": opts.etag } } : {},
    ).then((r) => (r.status === 304 ? null : asJson(r))),
  version: () => fetch("/api/version").then(asJson),
  run: (id) => fetch(`/api/runs/${encodeURIComponent(id)}`).then(asJson),
  logs: (opts = {}) => {
    const q = new URLSearchParams();
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.service) q.set("service", opts.service);
    return fetch(`/api/logs?${q}`).then(asJson);
  },
  reviews: (worktree) =>
    fetch(
      `/api/reviews${worktree ? `?worktree=${encodeURIComponent(worktree)}` : ""}`,
    ).then(asJson),
  validation: (worktree) =>
    fetch(
      `/api/validation${worktree ? `?worktree=${encodeURIComponent(worktree)}` : ""}`,
    ).then(asJson),
  commands: () => fetch("/api/commands").then(asJson),
  reviewPackPreview: (worktree) =>
    fetch(
      `/api/review-pack/preview${worktree ? `?worktree=${encodeURIComponent(worktree)}` : ""}`,
    ).then(asJson),
  fileDiff: (file, worktree, mode) => {
    const q = new URLSearchParams({ file });
    if (worktree) q.set("worktree", worktree);
    if (mode) q.set("mode", mode);
    return fetch(`/api/diff?${q}`).then(asJson);
  },
  workingTree: (worktree) =>
    fetch(
      `/api/working-tree${worktree ? `?worktree=${encodeURIComponent(worktree)}` : ""}`,
    ).then(asJson),
  mrDraft: (target, source) => {
    const q = new URLSearchParams();
    if (target) q.set("target", target);
    if (source) q.set("source", source);
    return fetch(`/api/mr-draft?${q}`).then(asJson);
  },
  branches: () => fetch("/api/branches").then(asJson),
  sessionTasks: (session) =>
    fetch(`/api/session-tasks?session=${encodeURIComponent(session)}`).then(
      asJson,
    ),
  mcp: () => fetch("/api/mcp").then(asJson),
  configMap: () => fetch("/api/config-map").then(asJson),
  reviewInbox: (refresh) =>
    fetch(`/api/review-inbox${refresh ? "?refresh=1" : ""}`).then(asJson),
  ciLog: (job) =>
    fetch(`/api/ci/log?job=${encodeURIComponent(job)}`).then(asJson),
  reviewThread: (id) =>
    fetch(`/api/review-inbox/thread?id=${encodeURIComponent(id)}`).then(asJson),
  trace: (session, worktree, turns, provider) => {
    const q = new URLSearchParams({ session });
    if (worktree) q.set("worktree", worktree);
    if (turns) q.set("turns", String(turns));
    if (provider) q.set("provider", provider);
    return fetch(`/api/trace?${q}`).then(asJson);
  },
  subagents: (session, worktree) => {
    const q = new URLSearchParams({ session });
    if (worktree) q.set("worktree", worktree);
    return fetch(`/api/subagents?${q}`).then(asJson);
  },
  sessionFeed: (session, worktree, provider) => {
    const q = new URLSearchParams({ session });
    if (worktree) q.set("worktree", worktree);
    if (provider) q.set("provider", provider);
    return fetch(`/api/session-feed?${q}`).then(asJson);
  },
  jobs: () => fetch("/api/jobs").then(asJson),
  job: (id) => fetch(`/api/jobs/${encodeURIComponent(id)}`).then(asJson),
  runJob: (params) =>
    fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    }).then(asJson),
  cancelJob: (id) =>
    fetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    }).then(asJson),
  artifactUrl: (id) => `/api/jobs/${encodeURIComponent(id)}/artifact`,
  /** Invoke an allowlisted action. `opts.signal` aborts the client-side wait. */
  action: (name, params = {}, opts = {}) =>
    fetch(`/api/actions/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: opts.signal,
    }).then(asJson),
};

/**
 * Connect to the SSE stream. Returns the EventSource so callers can close it.
 * @param {{ onSnapshot: Function, onEvent: Function, onOpen?: Function, onError?: Function }} handlers
 */
export function connectEvents(handlers) {
  const source = new EventSource("/events");
  source.addEventListener("snapshot", (e) => {
    try {
      handlers.onSnapshot(JSON.parse(e.data));
    } catch {
      /* ignore malformed frame */
    }
  });
  source.addEventListener("panel", (e) => {
    try {
      handlers.onEvent(JSON.parse(e.data));
    } catch {
      /* ignore */
    }
  });
  source.addEventListener("job", (e) => {
    try {
      handlers.onEvent(JSON.parse(e.data));
    } catch {
      /* ignore */
    }
  });
  source.onopen = () => handlers.onOpen?.();
  source.onerror = () => handlers.onError?.();
  return source;
}

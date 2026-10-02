// @ts-check
/** Panel SPA bootstrap: router, store, SSE wiring, Clawd integration, config. */
import "./ocelin/ocelin-element.mjs";
import { bootstrapToken } from "./lib/token-bootstrap.mjs";
import { el, clear, relTime, absTime, forgeLabel } from "./lib/dom.mjs";
import { api, connectEvents } from "./lib/api.mjs";
import { diffSections, needsRender } from "./lib/dirty.mjs";
import { openPalette } from "./lib/command-palette.mjs";
import { initTooltips } from "./lib/tooltip.mjs";
import { render as overview } from "./views/overview.mjs";
import { render as runs } from "./views/runs.mjs";
import { render as runDetails } from "./views/run-details.mjs";
import { render as worktrees } from "./views/worktrees.mjs";
import { render as validation } from "./views/validation.mjs";
import { render as reviews } from "./views/reviews.mjs";
import { render as findings } from "./views/findings.mjs";
import { render as logs } from "./views/logs.mjs";
import { render as config } from "./views/config.mjs";
import { render as commands } from "./views/commands.mjs";
import { render as diff } from "./views/diff.mjs";
import { render as timeline } from "./views/timeline.mjs";
import { render as trace } from "./views/trace.mjs";
import { render as subagents } from "./views/subagents.mjs";
import { render as session } from "./views/session.mjs";
import { render as mr } from "./views/mr.mjs";
import { render as prompt } from "./views/prompt.mjs";
import { render as cost } from "./views/cost.mjs";
import { render as delivery } from "./views/delivery.mjs";
import { render as reviewInbox } from "./views/review-inbox.mjs";
import { render as attention } from "./views/attention.mjs";
import { render as health } from "./views/health.mjs";
import { tabStrip } from "./lib/tabs.mjs";
import { resolveRoute, canonicalHash } from "./lib/route.mjs";
import { maybeOpenWizard } from "./lib/wizard.mjs";

// Top-level hubs. A hub is either a single view (`render`) or a set of tabs.
// `auto` marks a view/tab that may re-render on every snapshot (no input state).
// `deps` lists the snapshot sections an auto view reads: when a snapshot
// arrives with none of them changed (per snapshot.sections hashes), the
// re-render is skipped. A dep the server does not hash (panel, perf) counts
// as always changed, so live-vitals views keep updating.
const HUBS = [
  {
    key: "overview",
    label: "Overview",
    render: overview,
    auto: true,
    deps: [
      "attention",
      "authorBreakdown",
      "checkout",
      "commitActivity",
      "forge",
      "history",
      "jobs",
      "panel",
      "readiness",
      "recentCommits",
      "reviews",
      "runs",
      "sessions",
      "validation",
      "worktrees",
    ],
  },
  {
    key: "activity",
    label: "Activity",
    tabs: [
      { id: "session", label: "Session", render: session },
      { id: "trace", label: "Trace", render: trace },
      { id: "agents", label: "Agents", render: subagents },
      { id: "timeline", label: "Timeline", render: timeline },
      { id: "logs", label: "Logs", render: logs },
    ],
  },
  {
    key: "run",
    label: "Run",
    count: "run",
    tabs: [
      { id: "runs", label: "Runs", render: runs },
      { id: "commands", label: "Commands", render: commands },
    ],
  },
  {
    key: "worktrees",
    label: "Worktrees",
    render: worktrees,
    count: "worktrees",
  },
  {
    key: "review",
    label: "Review",
    tabs: [
      { id: "diff", label: "Diff", render: diff },
      {
        id: "validation",
        label: "Validation",
        render: validation,
        auto: true,
        deps: ["validation", "readiness"],
      },
      {
        id: "reviews",
        label: "Reviews",
        render: reviews,
        auto: true,
        deps: ["reviews", "reviewHistory", "readiness"],
      },
      {
        id: "findings",
        label: "Fix Station",
        render: findings,
        auto: true,
        deps: ["checkout", "findings", "reviews"],
      },
      { id: "mr", label: "Merge Request", render: mr },
    ],
  },
  { key: "prompt", label: "Prompt", render: prompt },
  {
    key: "cost",
    label: "Cost",
    render: cost,
    auto: true,
    deps: ["cost", "governor", "quotaPressure", "telemetry", "subscriptions"],
  },
  {
    key: "delivery",
    label: "Delivery",
    tabs: [
      {
        id: "readiness",
        label: "Readiness",
        render: delivery,
        auto: true,
        deps: [
          "ci",
          "delivery",
          "deliveryReadiness",
          "forge",
          "mergeability",
          "reviewInbox",
        ],
      },
      // Not auto: it holds filters, expanded threads and in-flight assists.
      { id: "inbox", label: "Inbox", render: reviewInbox },
      // Not auto: the ledger form holds text the engineer is still typing.
      { id: "attention", label: "Attention", render: attention },
    ],
  },
  {
    key: "health",
    label: "Health",
    render: health,
    auto: true,
    deps: [
      "checkout",
      "events",
      "instructionBudget",
      "panel",
      "perf",
      "policy",
      "sessions",
      "telemetry",
      "worktrees",
    ],
  },
  { key: "config", label: "Settings", render: config },
];
const HUB_BY_KEY = Object.fromEntries(HUBS.map((h) => [h.key, h]));
// Minimal config the pure route resolver needs (hub key → its tab ids).
const ROUTE_HUBS = Object.fromEntries(
  HUBS.map((h) => [
    h.key,
    { tabs: h.tabs ? h.tabs.map((t) => t.id) : undefined },
  ]),
);
// Number-key shortcuts map to the hubs in order.
const NAV_ORDER = HUBS.map((h) => h.key);

// Old single-route links (and any external bookmarks) redirect to their hub/tab,
// so existing app.navigate("#/reviews") call sites keep working unchanged.
const ROUTE_ALIASES = {
  session: "activity/session",
  trace: "activity/trace",
  subagents: "activity/agents",
  runs: "run/runs",
  commands: "run/commands",
  timeline: "activity/timeline",
  logs: "activity/logs",
  validation: "review/validation",
  reviews: "review/reviews",
  diff: "review/diff",
  mr: "review/mr",
};

const store = {
  snapshot: null,
  recentEvents: [],
  logBacklog: [],
  runsFilter: "all",
  logsPaused: false,
  logAutoscroll: true,
  validationRunning: false,
  reviewRunning: false,
  connection: "connecting",
  selectedRunId: null,
  lastSnapshotAt: 0,
  jobs: [],
  jobLogs: {},
  /** @type {any[]} allowlisted command catalog, fetched once for palette search */
  commandCatalog: [],
  /** @type {Array<() => void>} per-second DOM updaters registered by the active view */
  tickers: [],
  /** @type {Record<string, string>|null} previous snapshot's section hashes */
  sectionHashes: null,
  /** @type {string|null} last seen snapshot version (the /api/snapshot ETag) */
  snapshotVersion: null,
  /** Auto re-render accounting, surfaced in Health → panel self-performance. */
  renderStats: { rendered: 0, skipped: 0, lastMs: 0 },
};

const params = new URLSearchParams(location.search);

const app = {
  get snapshot() {
    return store.snapshot;
  },
  store,
  params: {},
  api,
  config: loadConfig(),
  navigate(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  },
  rerender: () => route(),
  selectRun(id) {
    store.selectedRunId = id;
    app.navigate(`#/run/runs/${encodeURIComponent(id)}`);
  },
  refreshNow,
  cycleTheme,
  exportSnapshot,
  copyStatusReport,
  downloadStatusReport,
  openShortcuts: () => openShortcuts(),
  toast,
  applyConfig,
  updateClawd: () => updateClawd(),
  pulseClawd: (state, message, ms) => pulseClawd(state, message, ms),
};

function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem("panelConfig") || "{}");
  } catch {
    /* ignore */
  }
  const devMode = params.has("dev") || params.has("clawdDemo");
  return {
    display: {},
    theme: saved.theme || "system",
    motion: saved.motion || "full",
    badges: saved.badges || "on",
    patrol: saved.patrol || "on",
    demo: params.has("clawdDemo") ? "on" : saved.demo || "off",
    compactWorktrees: saved.compactWorktrees === true,
    autoFocusRun: saved.autoFocusRun === true,
    notifications: saved.notifications !== false,
    desktopNotifications: saved.desktopNotifications === true,
    clawdHidden: saved.clawdHidden === true,
    devMode,
  };
}

function applyConfig() {
  const c = app.config;
  try {
    localStorage.setItem(
      "panelConfig",
      JSON.stringify({
        theme: c.theme,
        motion: c.motion,
        badges: c.badges,
        patrol: c.patrol,
        demo: c.demo,
        compactWorktrees: c.compactWorktrees,
        autoFocusRun: c.autoFocusRun,
        notifications: c.notifications,
        desktopNotifications: c.desktopNotifications,
        clawdHidden: c.clawdHidden,
      }),
    );
  } catch {
    /* storage may be unavailable */
  }
  const html = document.documentElement;
  if (c.theme === "system") html.removeAttribute("data-theme");
  else html.setAttribute("data-theme", c.theme);
  applyClawdVisibility();
  updateClawd();
}

/** Show/hide the assistant footer and flip the corner toggle. */
function applyClawdVisibility() {
  const hidden = Boolean(app.config.clawdHidden);
  document.querySelector(".shell")?.classList.toggle("clawd-hidden", hidden);
  const btn = document.getElementById("clawd-toggle");
  if (btn) {
    btn.textContent = hidden ? "◠" : "⌄";
    btn.title = hidden ? "Show assistant" : "Hide assistant";
    btn.setAttribute("aria-label", btn.title);
  }
}

function toggleClawd() {
  app.config.clawdHidden = !app.config.clawdHidden;
  applyConfig();
}

/**
 * The big Clawd's live state. The server stamps `snapshot.clawd` (attention →
 * running job → active agents → idle/sleeping); this overlays ephemeral client
 * signals the server can't see, a dropped connection, a panel run the user just
 * kicked off, and short-lived reactions to real events, so the creature actually
 * works as the panel does.
 */
function liveClawd() {
  const base = store.snapshot?.clawd || { state: "sleeping", message: "" };
  if (store.connection === "disconnected")
    return {
      state: "blocked",
      message: "Lost the panel connection, retrying.",
    };
  // Something the user must act on outranks panel busywork.
  if (base.state === "attention" || base.state === "blocked") return base;
  // A fresh reaction to a real event (job finished, manual refresh).
  const pulse = store.clawdPulse;
  if (pulse && pulse.until > Date.now())
    return { state: pulse.state, message: pulse.message };
  if (store.reviewRunning)
    return { state: "reviewing", message: "Running the review scan…" };
  if (store.validationRunning)
    return { state: "inspecting", message: "Running validation…" };
  const job = (store.jobs || []).find((j) => j.status === "running");
  if (job)
    return {
      state: jobKindState(job.key),
      message: `Running ${job.label}…`,
    };
  return base;
}

/** A short-lived reaction to a real event, overriding the derived state briefly. */
function pulseClawd(state, message, ms) {
  store.clawdPulse = { state, message, until: Date.now() + ms };
  updateClawd();
  clearTimeout(store._pulseTimer);
  store._pulseTimer = setTimeout(updateClawd, ms + 50);
}

function updateClawd() {
  const clawd = document.getElementById("clawd");
  if (!clawd) return;
  const c = app.config;
  clawd.setAttribute("motion", c.motion);
  clawd.setAttribute("badge", c.badges === "off" ? "off" : "");
  clawd.setAttribute("patrol", c.patrol === "off" ? "off" : "");
  if (c.demo === "on" && c.devMode) {
    clawd.setAttribute("demo", "");
    return;
  }
  clawd.removeAttribute("demo");
  const cl = liveClawd();
  clawd.setAttribute("message", cl.message || "");
  clawd.setAttribute("state", cl.state);
}

/** Map a running job key to the Clawd state describing the work, for mini agents. */
function jobKindState(key) {
  const k = String(key || "");
  if (/review|pack/.test(k)) return "reviewing";
  if (/verify|test|validat/.test(k)) return "inspecting";
  if (/lint|fix/.test(k)) return "coding";
  if (/git|disk|cleanup|doctor/.test(k)) return "reading";
  return "coding";
}

const STATE_VERB = {
  reading: "reading",
  thinking: "planning",
  coding: "coding",
  inspecting: "validating",
  reviewing: "reviewing",
  waiting: "waiting",
  idle: "idle",
  sleeping: "idle",
};

/**
 * A live Claude session's real state, derived from its worktree's signals (a
 * running panel job in that worktree, services up, otherwise working). We never
 * read transcript content.
 */
function agentMiniState(a) {
  const job = (store.snapshot?.jobs ?? []).find(
    (j) => j.status === "running" && j.worktree === a.branch,
  );
  if (job) return jobKindState(job.key);
  const wt = (store.snapshot?.worktrees ?? []).find((w) => w.path === a.path);
  if (wt && (wt.services ?? []).some((s) => s.status === "running"))
    return "idle";
  return "thinking";
}

/**
 * Render a free-standing mini Clawd for each OTHER live Claude session beside the
 * big one (the big Clawd already represents this session, so it is excluded). Each
 * mini shows its real derived state with no bubble or floor, is hoverable for a
 * branch+state tooltip, and jumps to its worktree on click. Rebuilt only when the
 * set or any of their states change.
 */
function updateClawdSwarm() {
  const host = document.getElementById("clawd-swarm");
  if (!host) return;
  const agents = (store.snapshot?.sessions?.agents ?? []).filter(
    (a) => a.active && !a.isOwn,
  );
  const shown = agents.slice(0, 5);
  const items = shown.map((a) => ({ a, state: agentMiniState(a) }));
  const key = items.map((x) => `${x.a.path}:${x.state}`).join("|");
  const overflow = agents.length - shown.length;
  if (host.dataset.key === key) return;
  host.dataset.key = key;
  clear(host);
  for (const { a, state } of items) {
    const mascot = el("ocelin-assistant", {
      state,
      patrol: "off",
      badge: "off",
      bubble: "off",
      dock: "off",
      tooltip: "off",
      motion: app.config.motion,
    });
    const mini = el(
      "span",
      {
        class: "clawd-mini",
        "data-tip": `${a.branch} · ${STATE_VERB[state] || state}`,
        onClick: () => {
          app.store.worktreeQuery =
            (a.branch || a.path || "").split("/").pop() || "";
          app.navigate("#/worktrees");
        },
      },
      mascot,
    );
    host.append(mini);
  }
  if (overflow > 0)
    host.append(
      el("span", {
        class: "clawd-more",
        "data-tip": `${overflow} more active session${overflow === 1 ? "" : "s"}`,
        text: `+${overflow}`,
      }),
    );
}

/** @type {HTMLElement|null} */
let clawdMenuEl = null;

function closeClawdMenu() {
  if (!clawdMenuEl) return;
  clawdMenuEl.remove();
  clawdMenuEl = null;
  document.removeEventListener("pointerdown", onClawdMenuAway, true);
  document.removeEventListener("keydown", onClawdMenuKey, true);
}

function onClawdMenuAway(e) {
  const pop = clawdMenuEl?.querySelector(".clawd-pop");
  if (pop && !pop.contains(/** @type {Node} */ (e.target))) closeClawdMenu();
}

function onClawdMenuKey(e) {
  if (!clawdMenuEl) return;
  if (e.key === "Escape") {
    closeClawdMenu();
    return;
  }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const items = [...clawdMenuEl.querySelectorAll(".clawd-menu-item")];
  const i = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
  const next =
    e.key === "ArrowDown"
      ? items[(i + 1) % items.length]
      : items[(i - 1 + items.length) % items.length];
  /** @type {HTMLElement} */ (next)?.focus();
}

/** Greeting reflects the live snapshot so the prompt is never generic noise. */
function clawdGreeting() {
  const att = (store.snapshot?.attention ?? []).length;
  if (att > 0)
    return `How can I help? ${att} item${att === 1 ? "" : "s"} need attention.`;
  const jobs = (store.jobs || []).filter((j) => j.status === "running").length;
  if (jobs > 0)
    return `How can I help? ${jobs} job${jobs === 1 ? "" : "s"} running.`;
  return "How can I help?";
}

/** Click the big Clawd → a centred "How can I help?" command launcher. */
function openClawdMenu() {
  if (clawdMenuEl) {
    closeClawdMenu();
    return;
  }
  const att = (store.snapshot?.attention ?? []).length;
  const commands = [
    { label: "Search commands…", hint: "Ctrl K", run: () => openPalette(app) },
    { label: "Refresh now", run: refreshNow },
    att > 0 ? { label: `Needs attention (${att})`, run: ringBell } : null,
    { label: "Runs", run: () => app.navigate("#/runs") },
    { label: "Worktrees", run: () => app.navigate("#/worktrees") },
    { label: "Review readiness", run: () => app.navigate("#/reviews") },
  ].filter(Boolean);
  // Jump straight to any OTHER live session's worktree from the launcher.
  const sessions = (store.snapshot?.sessions?.agents ?? [])
    .filter((a) => a.active && !a.isOwn)
    .slice(0, 5)
    .map((a) => {
      const state = agentMiniState(a);
      return {
        label: a.branch || "",
        sub: STATE_VERB[state] || state,
        run: () => {
          app.store.worktreeQuery =
            (a.branch || a.path || "").split("/").pop() || "";
          app.navigate("#/worktrees");
        },
      };
    });
  const mkItem = (it) =>
    el(
      "button",
      {
        class: "clawd-menu-item",
        role: "menuitem",
        type: "button",
        onClick: () => {
          closeClawdMenu();
          it.run();
        },
      },
      [
        el("span", { class: "clawd-menu-label", text: it.label }),
        it.hint ? el("kbd", { class: "clawd-menu-kbd", text: it.hint }) : null,
        it.sub ? el("span", { class: "clawd-menu-sub", text: it.sub }) : null,
      ].filter(Boolean),
    );
  const children = [
    el("div", { class: "clawd-menu-head", text: clawdGreeting() }),
    ...commands.map(mkItem),
  ];
  if (sessions.length) {
    children.push(
      el("div", { class: "clawd-menu-section", text: "Active sessions" }),
      ...sessions.map(mkItem),
    );
  }
  const menu = el(
    "div",
    { class: "clawd-menu clawd-pop", role: "menu" },
    children,
  );
  openClawdLayer(menu);
}

/** Mount a centred popover in a dimmed full-screen layer. */
function openClawdLayer(panel) {
  const layer = el("div", { class: "clawd-menu-layer" }, panel);
  document.body.append(layer);
  clawdMenuEl = layer;
  // Defer so the click that opened the layer does not immediately close it.
  setTimeout(() => {
    if (!clawdMenuEl) return;
    document.addEventListener("pointerdown", onClawdMenuAway, true);
    document.addEventListener("keydown", onClawdMenuKey, true);
    clawdMenuEl.querySelector("button")?.focus();
  }, 0);
}

function parseHash() {
  const raw = (location.hash || "#/overview").replace(/^#\/?/, "");
  return resolveRoute(raw, {
    hubs: ROUTE_HUBS,
    aliases: ROUTE_ALIASES,
    fallback: "overview",
  });
}

function loadLastTabs() {
  try {
    return JSON.parse(localStorage.getItem("panelLastTab") || "{}");
  } catch {
    return {};
  }
}
function saveLastTab(hub, tab) {
  const m = loadLastTabs();
  if (m[hub] === tab) return;
  m[hub] = tab;
  try {
    localStorage.setItem("panelLastTab", JSON.stringify(m));
  } catch {
    /* storage unavailable */
  }
}

/** Whether the active hub/tab may re-render on every snapshot. */
function isAutoRoute() {
  const { hub, tab } = parseHash();
  const def = HUB_BY_KEY[hub];
  if (def.tabs) return Boolean(def.tabs.find((t) => t.id === tab)?.auto);
  return Boolean(def.auto);
}

function route() {
  const t0 = performance.now();
  const { hub, tab, id, explicitTab } = parseHash();
  const def = HUB_BY_KEY[hub];

  // Arriving at a hub without an explicit tab restores the last one used there.
  if (def.tabs && !explicitTab) {
    const last = loadLastTabs()[hub];
    if (last && last !== tab && def.tabs.some((t) => t.id === last)) {
      app.navigate(`#/${hub}/${last}`);
      return;
    }
  }

  app.params = { id, tab };
  store.tickers = [];
  setActiveNav(hub);
  // Rewrite an aliased or bare URL to its canonical #/hub/tab form (no history
  // entry), so the address bar matches the active tab.
  const canonical = canonicalHash(hub, tab, id, Boolean(def.tabs));
  if (location.hash !== canonical) history.replaceState(null, "", canonical);
  if (def.tabs) saveLastTab(hub, tab);

  const main = document.getElementById("main");
  if (!main) return;
  let node;
  try {
    if (def.tabs) {
      const active = def.tabs.find((t) => t.id === tab) || def.tabs[0];
      const detail = hub === "run" && active.id === "runs" && id;
      node = el("div", { class: "hub" }, [
        hub === "review" ? reviewForgeHeader() : null,
        tabStrip(app, hub, def.tabs, active.id),
        el(
          "div",
          {
            class: "hub-body",
            id: `panel-${hub}`,
            role: "tabpanel",
            "aria-labelledby": `tab-${hub}-${active.id}`,
          },
          [detail ? runDetails(app) : active.render(app)],
        ),
      ]);
    } else {
      node = def.render(app);
    }
  } catch (err) {
    node = el(
      "div",
      { class: "view" },
      el("div", { class: "card" }, [
        el("h2", { text: "View error" }),
        el("pre", {
          class: "evidence",
          text: String(err && err.stack ? err.stack : err),
        }),
      ]),
    );
  }
  clear(main).append(node);
  main.focus({ preventScroll: true });
  store.renderStats.lastMs = Math.round((performance.now() - t0) * 10) / 10;
}

/** Compact forge MR/pipeline status shown above the Review hub tabs. */
function reviewForgeHeader() {
  const g = store.snapshot?.forge;
  if (!g || !g.configured) return null;
  const { name, ref } = forgeLabel(g.provider);
  const parts = [];
  if (g.mr)
    parts.push(
      `MR ${ref}${g.mr.iid} (${g.mr.state}${g.mr.draft ? ", draft" : ""})`,
    );
  if (g.pipeline) parts.push(`pipeline ${g.pipeline.status}`);
  if (g.error) parts.push(`error: ${g.error}`);
  if (!parts.length) parts.push("no open MR for this branch");
  const link = g.mr?.webUrl || g.pipeline?.webUrl || null;
  return el("div", { class: "hub-forge small" }, [
    el("span", { class: "muted", text: `${name}: ${parts.join(" · ")}` }),
    link
      ? el("a", {
          class: "link-out",
          href: link,
          target: "_blank",
          rel: "noopener",
          text: "open ↗",
        })
      : null,
  ]);
}

function setActiveNav(name) {
  for (const a of document.querySelectorAll(".nav-link")) {
    const active = a.getAttribute("data-route") === name;
    a.hidden = !active && !app.config.display.advancedNavigation &&
      ["run", "worktrees", "review", "prompt", "delivery", "health"].includes(a.dataset.route);
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

function setConnection(state) {
  store.connection = state;
  const dot = document.getElementById("conn-dot");
  const label = document.getElementById("conn-label");
  if (dot) dot.className = `conn-dot conn-${state}`;
  if (label)
    label.textContent =
      state === "live"
        ? "Live"
        : state === "connecting"
          ? "Connecting…"
          : "Disconnected, retrying";
  // Reflect a dropped/restored connection on the creature immediately.
  updateClawd();
}

function updateHeader() {
  const c = store.snapshot?.checkout;
  const meta = document.getElementById("checkout-meta");
  if (meta && c) {
    const idChip = el("button", {
      class: "checkout-id mono",
      "data-tip": "Copy checkout id",
      text: c.id,
    });
    idChip.addEventListener("click", () =>
      copyText(c.id, "Checkout id copied."),
    );
    clear(meta).append(
      idChip,
      el("span", { class: "mono", text: c.branch || "(detached)" }),
      c.dirty
        ? el("span", { class: "pill pill-warn", text: `${c.dirtyCount} dirty` })
        : el("span", { class: "pill pill-ok", text: "clean" }),
    );
  }
}

function setNavCount(key, n) {
  const node = /** @type {HTMLElement|null} */ (
    document.querySelector(`.nav-count[data-count="${key}"]`)
  );
  if (!node) return;
  node.textContent = n > 0 ? String(n) : "";
  node.hidden = n === 0;
}

function updateChrome() {
  const s = store.snapshot;
  const runs = s?.runs ?? [];
  const activeRuns = runs.filter(
    (r) => r.status === "running" || r.status === "waiting",
  ).length;
  const activeJobs = (store.jobs || []).filter(
    (j) => j.status === "running",
  ).length;
  // The Run hub badge counts both active autoloop runs and running jobs.
  setNavCount("run", activeRuns + activeJobs);
  setNavCount("worktrees", (s?.worktrees ?? []).length);
  const att = (s?.attention ?? []).length;
  const badge = document.getElementById("bell-badge");
  if (badge) {
    badge.textContent = String(att);
    badge.hidden = att === 0;
  }
}

function ringBell() {
  const items = store.snapshot?.attention ?? [];
  if (!items.length) return toast("No notifications.", "info");
  toast(
    `${items.length} item(s) need attention: ${items[0].title}`,
    items[0].severity === "blocking" ? "danger" : "warn",
  );
  app.navigate("#/overview");
}

function updateClock() {
  const updated = document.getElementById("updated");
  if (updated)
    updated.textContent = store.lastSnapshotAt
      ? `updated ${relTime(store.lastSnapshotAt)}`
      : "";
}

export function copyText(text, okMsg) {
  navigator.clipboard?.writeText(String(text)).then(
    () => toast(okMsg || "Copied.", "ok"),
    () => toast("Clipboard unavailable.", "warn"),
  );
}

let toastTimer = 0;
function toast(message, tone = "info") {
  const host = document.getElementById("toasts");
  if (!host) return;
  const node = el("div", {
    class: `toast toast-${tone}`,
    role: "status",
    text: message,
  });
  host.append(node);
  setTimeout(() => node.classList.add("show"), 10);
  setTimeout(() => {
    node.classList.remove("show");
    setTimeout(() => node.remove(), 300);
  }, 4200);
  clearTimeout(toastTimer);
}

function upsertJob(job) {
  const i = store.jobs.findIndex((j) => j.id === job.id);
  if (i === -1) store.jobs.unshift(job);
  else store.jobs[i] = job;
}

/**
 * Fire an OS notification when the opt-in setting is on and permission is granted.
 * Always paired with an in-panel toast, so it is purely additive (useful when the
 * panel is in a background tab).
 */
function desktopNotify(title, body) {
  if (!app.config.desktopNotifications) return;
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  )
    return;
  try {
    new Notification(title, { body, silent: true });
  } catch {
    /* notifications unavailable in this context */
  }
}

function pushEvent(event) {
  // Job lifecycle/log events drive the command cockpit live.
  if (typeof event.type === "string" && event.type.startsWith("job.")) {
    if (event.type === "job.progress") {
      // The open stream says a job produced output, not what it produced.
      // The text is fetched from the token-gated job route instead.
      store._onJobProgress?.(event.jobId, event.lineCount);
    } else if (event.job) {
      upsertJob(event.job);
      if (event.type === "job.completed") {
        const ok = event.job.status === "succeeded";
        toast(
          `${event.job.label}: ${event.job.status}.`,
          ok ? "ok" : event.job.status === "cancelled" ? "warn" : "danger",
        );
        desktopNotify(`Job ${event.job.status}`, event.job.label);
        if (ok) pulseClawd("success", `${event.job.label} done.`, 3500);
        else if (event.job.status === "failed")
          pulseClawd("blocked", `${event.job.label} failed.`, 3500);
      }
      store._onJobChange?.(event.job);
      updateChrome();
    }
    return;
  }
  event._at = Date.now();
  store.recentEvents.push(event);
  if (store.recentEvents.length > 600)
    store.recentEvents.splice(0, store.recentEvents.length - 600);
  if (parseHash().tab === "logs" && typeof store._onLogEvent === "function")
    store._onLogEvent();
  if (event.type === "validation.completed") {
    store.validationRunning = false;
    toast(
      `Validation ${event.ok ? "passed" : "failed"}.`,
      event.ok ? "ok" : "danger",
    );
    pulseClawd(
      event.ok ? "success" : "blocked",
      event.ok ? "Validation passed." : "Validation failed.",
      3500,
    );
  } else if (
    (event.type === "forge.pipeline" || event.type === "forge.mr") &&
    app.config.notifications
  ) {
    const failed = event.status === "failed";
    const tone = failed ? "danger" : event.status === "success" ? "ok" : "info";
    toast(event.message || event.type, tone);
    desktopNotify("Forge", event.message || event.type);
    if (event.type === "forge.pipeline")
      pulseClawd(failed ? "blocked" : "success", event.message, 3500);
    updateChrome();
  }
}

/**
 * Toast when a worktree's Claude session goes active (its transcript started
 * updating) since the last snapshot. Skips our own session and the first paint.
 */
function notifyNewAgents(snapshot) {
  const active = new Set(
    (snapshot.sessions?.agents ?? [])
      .filter((a) => a.active && !a.isOwn)
      .map((a) => a.path),
  );
  const prev = store._activeAgents;
  if (prev && app.config.notifications) {
    for (const a of snapshot.sessions?.agents ?? []) {
      if (a.active && !a.isOwn && !prev.has(a.path)) {
        toast(`Agent active: ${a.branch}`, "info");
        desktopNotify("Claude agent active", a.branch);
      }
    }
  }
  store._activeAgents = active;
}

/** A new HEAD between snapshots means a commit just landed, let Clawd cheer. */
function reactToCommit(snapshot) {
  const head = snapshot.checkout?.commit ?? null;
  const prev = store._lastHead;
  store._lastHead = head;
  if (!prev || !head || head === prev) return;
  const cur = (snapshot.worktrees ?? []).find((w) => w.isCurrent);
  const subject = cur?.lastCommit?.subject;
  pulseClawd(
    "success",
    subject ? `Committed: ${subject}` : "New commit landed.",
    3500,
  );
}

let hadSnapshot = false;
function onSnapshot(snapshot) {
  const prevSections = store.sectionHashes;
  store.snapshot = snapshot;
  store.sectionHashes = snapshot.sections?.byKey ?? null;
  store.snapshotVersion = snapshot.sections?.version ?? null;
  notifyNewAgents(snapshot);
  if (Array.isArray(snapshot.jobs)) store.jobs = snapshot.jobs;
  store.lastSnapshotAt = Date.now();
  setConnection("live");
  reactToCommit(snapshot);
  updateHeader();
  updateClock();
  updateChrome();
  updateClawd();
  updateClawdSwarm();
  const first = !hadSnapshot;
  hadSnapshot = true;
  if (first) {
    route();
    maybeOpenWizard(app);
    return;
  }
  if (!isAutoRoute()) return;
  const changed = diffSections(prevSections, store.sectionHashes);
  if (needsRender(activeAutoDeps(), changed, store.sectionHashes)) {
    route();
    store.renderStats.rendered++;
  } else {
    store.renderStats.skipped++;
  }
}

/** The active auto view's declared snapshot deps, or null (always render). */
function activeAutoDeps() {
  const { hub, tab } = parseHash();
  const def = HUB_BY_KEY[hub];
  const active = def.tabs ? def.tabs.find((t) => t.id === tab) : def;
  return active?.deps ?? null;
}

/**
 * Stale-while-revalidate on tab focus: the rendered snapshot stays up while a
 * conditional GET checks for drift (cheap 304 when nothing changed - typical
 * after the machine slept through the SSE stream).
 */
async function revalidateSnapshot() {
  try {
    const snap = await api.snapshot(
      store.snapshotVersion ? { etag: `"${store.snapshotVersion}"` } : {},
    );
    if (snap) onSnapshot(snap);
    else {
      store.lastSnapshotAt = Date.now();
      updateClock();
    }
  } catch {
    /* offline or restarting: SSE reconnect owns the error surface */
  }
}

async function refreshNow() {
  pulseClawd("reading", "Refreshing…", 1500);
  try {
    const [snap] = await Promise.all([
      api.snapshot(),
      api.reviews().catch(() => null),
    ]);
    onSnapshot(snap);
    toast("Refreshed.", "ok");
  } catch {
    setConnection("disconnected");
    toast("Refresh failed.", "danger");
  }
}

function cycleTheme() {
  const order = ["system", "light", "dark"];
  app.config.theme =
    order[(order.indexOf(app.config.theme) + 1) % order.length];
  applyConfig();
  toast(`Theme: ${app.config.theme}`, "info");
}

function exportSnapshot() {
  if (!store.snapshot) return toast("No snapshot to export yet.", "warn");
  const blob = new Blob([JSON.stringify(store.snapshot, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `panel-snapshot-${store.snapshot.checkout?.id || "checkout"}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast("Snapshot exported.", "ok");
}

/** Build a human-readable Markdown status summary of the current snapshot. */
function statusReport() {
  const s = store.snapshot;
  if (!s) return null;
  const lines = [];
  const c = s.checkout || {};
  lines.push(`# Ocelin status: ${c.branch || "(detached)"}`);
  lines.push("");
  lines.push(`- Checkout: ${c.id || "?"} (${c.branch || "(detached)"})`);
  lines.push(`- Working tree: ${c.dirty ? `${c.dirtyCount} dirty` : "clean"}`);
  const r = s.readiness;
  lines.push(
    `- Ready to push: ${r ? (r.ready ? "yes" : `no (${r.blockers + r.unknown} blocker(s))`) : "unknown"}`,
  );
  const blocking =
    (Number(s.reviews?.blockCount) || 0) +
    (s.validation?.checks ?? []).filter((x) => x.status === "failed").length;
  lines.push(`- Blocking findings: ${blocking}`);
  const agents = s.sessions?.agents ?? [];
  const activeAgents = agents.filter((a) => a.active);
  lines.push(
    `- Active Claude agents: ${activeAgents.length}${activeAgents.length ? ` (${activeAgents.map((a) => a.branch).join(", ")})` : ""}`,
  );
  const activeRuns = (s.runs ?? []).filter(
    (x) => x.status === "running" || x.status === "waiting",
  );
  lines.push(`- Active autoloop runs: ${activeRuns.length}`);
  const wts = s.worktrees ?? [];
  const cleanup = wts.filter((w) => w.cleanupCandidate);
  lines.push(
    `- Worktrees: ${wts.length} (${cleanup.length} cleanup candidate)`,
  );
  if (cleanup.length) {
    lines.push("", "## Cleanup candidates (merged into develop, idle)");
    for (const w of cleanup) lines.push(`- ${w.branch}`);
  }
  if (activeAgents.length) {
    lines.push("", "## Active agents");
    for (const a of activeAgents)
      lines.push(
        `- ${a.branch}: ${a.sessionCount} session(s), last ${relTime(a.lastActivity)}`,
      );
  }
  lines.push("", `_Generated ${absTime(s.emittedAt)}_`);
  return lines.join("\n");
}

function copyStatusReport() {
  const md = statusReport();
  if (!md) return toast("No snapshot yet.", "warn");
  copyText(md, "Status report copied (Markdown).");
}

function downloadStatusReport() {
  const md = statusReport();
  if (!md) return toast("No snapshot yet.", "warn");
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `panel-status-${store.snapshot.checkout?.branch?.replace(/[^\w.-]+/g, "-") || "checkout"}.md`;
  a.click();
  URL.revokeObjectURL(url);
  toast("Status report downloaded.", "ok");
}

function renderSkeleton() {
  const main = document.getElementById("main");
  if (!main) return;
  const block = () =>
    el(
      "div",
      { class: "card skeleton-card" },
      el("div", { class: "skeleton-lines" }, [
        el("span", { class: "sk sk-1" }),
        el("span", { class: "sk sk-2" }),
        el("span", { class: "sk sk-3" }),
      ]),
    );
  clear(main).append(
    el("div", { class: "view" }, [
      block(),
      el("div", { class: "grid grid-2" }, [block(), block()]),
    ]),
  );
}

function onKey(e) {
  // Command palette is global, works even from inputs and with the modifier held.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openPalette(app);
    return;
  }
  const t = /** @type {HTMLElement} */ (e.target);
  if (
    t &&
    (t.tagName === "INPUT" ||
      t.tagName === "TEXTAREA" ||
      t.tagName === "SELECT" ||
      t.isContentEditable)
  )
    return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key >= "1" && e.key <= "9" && NAV_ORDER[Number(e.key) - 1]) {
    app.navigate(`#/${NAV_ORDER[Number(e.key) - 1]}`);
  } else if (e.key === "[" || e.key === "]") {
    const { hub, tab } = parseHash();
    const def = HUB_BY_KEY[hub];
    if (def.tabs) {
      const i = def.tabs.findIndex((t) => t.id === tab);
      const len = def.tabs.length;
      const n = e.key === "]" ? (i + 1) % len : (i - 1 + len) % len;
      app.navigate(`#/${hub}/${def.tabs[n].id}`);
    }
  } else if (e.key === "r") {
    refreshNow();
  } else if (e.key === "t") {
    cycleTheme();
  } else if (e.key === "/") {
    const input = document.querySelector(".view input, .view select");
    if (input) {
      e.preventDefault();
      /** @type {HTMLElement} */ (input).focus();
    }
  } else if (e.key === "?") {
    openShortcuts();
  }
}

let shortcutsEl = null;
/** Modal listing the keyboard shortcuts. Opened with `?`, closed on Esc/backdrop. */
function openShortcuts() {
  if (shortcutsEl) return;
  const rows = [
    ["⌘ / Ctrl + K", "Command palette"],
    ["1-9", "Switch hubs (Overview to Configuration)"],
    ["[ / ]", "Previous / next tab in the current hub"],
    ["r", "Refresh now"],
    ["t", "Toggle theme"],
    ["/", "Focus the filter on the current view"],
    ["?", "This help"],
    ["Esc", "Close palette, help, or a tooltip"],
  ];
  const close = () => {
    shortcutsEl?.remove();
    shortcutsEl = null;
    document.removeEventListener("keydown", onEsc, true);
  };
  const onEsc = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  const box = el("div", { class: "shortcuts-box" }, [
    el("div", { class: "shortcuts-head" }, [
      el("h2", { text: "Keyboard shortcuts" }),
      el("button", { class: "link-btn", text: "Close", onClick: close }),
    ]),
    el(
      "dl",
      { class: "shortcuts-list" },
      rows.flatMap(([k, d]) => [
        el("dt", {}, el("kbd", { text: k })),
        el("dd", { text: d }),
      ]),
    ),
  ]);
  shortcutsEl = el(
    "div",
    {
      class: "cmd-overlay",
      role: "dialog",
      "aria-modal": "true",
      onMousedown: (e) => {
        if (e.target === shortcutsEl) close();
      },
    },
    box,
  );
  document.body.append(shortcutsEl);
  document.addEventListener("keydown", onEsc, true);
}

/** Append a dim shortcut digit (1-9) to each nav link, for discoverability. */
function decorateNavKeys() {
  NAV_ORDER.forEach((key, i) => {
    if (i >= 9) return;
    const link = document.querySelector(`.nav-link[data-route="${key}"]`);
    if (!link || link.querySelector(".nav-key")) return;
    link.append(
      el("span", {
        class: "nav-key",
        "aria-hidden": "true",
        text: String(i + 1),
      }),
    );
  });
}

function boot() {
  // Before any request: take the token out of the fragment and clean the URL.
  bootstrapToken();
  const requested = new URLSearchParams(location.search);
  if (["codex", "claude"].includes(requested.get("provider")) && /^[a-zA-Z0-9_-]{1,128}$/.test(requested.get("session") || ""))
    store.feedSession = { id: requested.get("session"), provider: requested.get("provider") };
  applyConfig();
  api.displayPreferences().then((display) => {
    app.config.display = display;
    route();
  }).catch(() => {});
  initTooltips();
  decorateNavKeys();
  document.getElementById("theme-btn")?.addEventListener("click", cycleTheme);
  document.getElementById("refresh-btn")?.addEventListener("click", refreshNow);
  document.getElementById("bell-btn")?.addEventListener("click", ringBell);
  document
    .getElementById("clawd-toggle")
    ?.addEventListener("click", toggleClawd);
  // The big Clawd's inner control is a native button: it emits clawd-activate
  // (bubbles from its shadow root) on click and on Enter/Space when focused, so
  // the launcher is keyboard-operable for free. Minis are separate hosts so they
  // never reach this listener.
  document
    .getElementById("clawd")
    ?.addEventListener("clawd-activate", openClawdMenu);
  window.addEventListener("hashchange", route);
  window.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") revalidateSnapshot();
  });
  renderSkeleton();
  connectEvents({
    onSnapshot,
    onEvent: pushEvent,
    onOpen: () => setConnection("live"),
    onError: () => setConnection("disconnected"),
  });
  api
    .snapshot()
    .then(onSnapshot)
    .catch(() => {
      setConnection("disconnected");
      route();
    });
  // Command catalog rarely changes; fetch once so the palette can search it.
  api
    .commands()
    .then((d) => {
      store.commandCatalog = d.commands || [];
    })
    .catch(() => {});
  // One-second heartbeat: refresh the "updated N ago" label and run any view tickers.
  setInterval(() => {
    updateClock();
    for (const fn of store.tickers) {
      try {
        fn();
      } catch {
        /* a ticker for an unmounted node, ignore */
      }
    }
  }, 1000);
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", boot);
else boot();

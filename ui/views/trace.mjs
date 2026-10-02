// @ts-check
/**
 * Trace waterfall: each turn of the selected session as a row of tool-call
 * spans with real durations, scaled to that turn's own duration. Wait spans
 * (plan approval, questions) are width-capped and dashed so human wait time
 * never flattens the compute spans; the true duration stays in the label.
 */
import { el, card, clear, relTime, emptyState, pill } from "../lib/dom.mjs";
import {
  agentsList,
  pickSession,
  sessionPicker,
  providerLabel,
} from "../lib/session-picker.mjs";

const POLL_MS = 4000;
let pollTimer = null;

const compact = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return String(v);
};

function fmtMs(ms) {
  if (ms == null) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ${Math.round((ms % 60000) / 1000)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function render(app) {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (!(app.store.traceOpenTurns instanceof Set))
    app.store.traceOpenTurns = new Set();
  if (!(app.store.traceOpenSpans instanceof Set))
    app.store.traceOpenSpans = new Set();

  const agents = agentsList(app);
  const sel = pickSession(app, agents);
  const picker = sessionPicker(app, agents, sel);
  const meta = el("div", { class: "feed-meta small muted" });
  const host = el("div", { class: "trace-host" }, [
    el("div", { class: "df-running" }, [
      el("span", { class: "spinner-inline" }),
      el("span", { class: "muted small", text: "Loading trace…" }),
    ]),
  ]);

  const refresh = () => {
    if (!sel) return;
    app.api
      .trace(sel.id, sel.path || undefined, undefined, sel.provider)
      .then((d) => {
        if (!host.isConnected) {
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = null;
          return;
        }
        renderMeta(meta, sel, d);
        renderTrace(app, host, d);
      })
      .catch((e) => {
        if (host.isConnected)
          clear(host).append(
            emptyState("Trace unavailable.", String((e && e.message) || e)),
          );
      });
  };

  if (sel) {
    refresh();
    pollTimer = setInterval(refresh, POLL_MS);
  } else {
    clear(host).append(
      emptyState(
        "No sessions to trace.",
        "Sessions appear here as Claude Code or Codex works in this checkout or its worktrees.",
      ),
    );
  }

  return el("div", { class: "view view-trace" }, [
    card(
      "Trace waterfall",
      [
        el("p", {
          class: "muted small",
          text: "Every turn broken into tool-call spans with real durations - where the time and tokens actually went. Read-only, from the session transcript.",
        }),
        el("div", { class: "feed-controls" }, [
          el("label", { class: "field" }, [
            el("span", { class: "field-label", text: "Session" }),
            picker,
          ]),
          meta,
        ]),
        host,
      ],
      {
        help: "Spans pair each tool call with its result inside the transcript. Token counts are per turn, deduplicated per request. Dashed spans are human wait time (width capped, true duration in the label). A dead session's unfinished tools show as incomplete, never as running.",
      },
    ),
  ]);
}

function renderMeta(hostEl, sel, d) {
  clear(hostEl);
  hostEl.append(
    el("span", { class: "feed-live" }, [
      el("span", { class: `agent-dot ${d.sessionLive ? "on" : ""}` }),
      el("span", { text: d.sessionLive ? "live" : "ended" }),
    ]),
    el("span", { class: "mono", text: d.model || providerLabel(sel.provider) }),
    el("span", { text: sel.branch || "" }),
    el("span", {
      text: `${(d.turns || []).length} turn(s)${d.truncated ? " · older history truncated" : ""}`,
    }),
  );
}

function renderTrace(app, host, d) {
  clear(host);
  if (d.missing) {
    host.append(
      emptyState(
        "Transcript not found.",
        "No local transcript was found for this session in the selected checkout.",
      ),
    );
    return;
  }
  const turns = d.turns || [];
  if (!turns.length) {
    host.append(emptyState("No turns yet.", "The transcript tail was empty."));
    return;
  }
  const open = app.store.traceOpenTurns;
  const rows = [];
  const diagnostics = d.diagnostics;
  if (diagnostics?.findings.length) {
    rows.push(
      el(
        "section",
        { class: "trace-diagnostics", "aria-label": "Session diagnostics" },
        [
          el("h3", { text: "Worth checking" }),
          el("p", {
            class: "muted small",
            text: `Heuristics from ${diagnostics.partial ? "partial" : "recorded"} history. Findings do not change session status.`,
          }),
          ...diagnostics.findings.map((finding) =>
            el("button", {
              class: "trace-finding",
              type: "button",
              text: `Turn ${finding.turn + 1}: ${finding.message}`,
              onclick: () => {
                open.add(finding.startTs);
                app.rerender();
              },
            }),
          ),
        ],
      ),
    );
  }
  for (const t of turns) {
    if (t.gapBeforeMs != null && t.gapBeforeMs > 5000)
      rows.push(
        el("div", { class: "trace-gap muted small" }, [
          el("span", { text: `idle ${fmtMs(t.gapBeforeMs)}` }),
        ]),
      );
    rows.push(turnBlock(app, t, open));
  }
  host.replaceChildren(...rows);
}

function turnBlock(app, t, open) {
  const key = t.startTs;
  const expanded = open.has(key) || t.open;
  const usage = t.usage;
  const head = el(
    "button",
    {
      class: "trace-turn-head",
      type: "button",
      "aria-expanded": String(expanded),
      "aria-label": `Turn ${t.index + 1}: ${expanded ? "collapse" : "expand"} span details`,
    },
    [
      el("span", { class: "trace-caret", text: expanded ? "▾" : "▸" }),
      el("span", { class: "trace-turn-title", text: `Turn ${t.index + 1}` }),
      t.model ? pill(t.model, "info") : null,
      el("span", { class: "muted small", text: relTime(t.startTs) }),
      el("span", {
        class: "muted small",
        text: t.durMs != null ? fmtMs(t.durMs) : t.open ? "in progress" : "",
      }),
      el("span", {
        class: "mono small trace-tokens",
        text: usage
          ? `${compact(usage.input + usage.output)} tok · ${usage.requests} req`
          : "tokens unknown",
      }),
      el("span", {
        class: "muted small",
        text: `${t.spans.length} span(s)${t.spansDropped ? ` (+${t.spansDropped} dropped)` : ""}`,
      }),
    ],
  );
  head.addEventListener("click", () => {
    if (open.has(key)) open.delete(key);
    else open.add(key);
    app.rerender();
  });
  const children = [head];
  if (expanded) children.push(spanTable(t, app));
  return el(
    "div",
    { class: `trace-turn ${t.open ? "open-turn" : ""}` },
    children,
  );
}

function spanTable(t, app) {
  const start = Date.parse(t.startTs);
  const total = Math.max(
    1,
    t.durMs ??
      t.spans.reduce(
        (m, s) => Math.max(m, Date.parse(s.startTs) - start + (s.durMs || 0)),
        1,
      ),
  );
  const rows = t.spans.map((s) => spanRow(s, start, total, app));
  if (!rows.length)
    rows.push(
      el("div", {
        class: "muted small trace-nospans",
        text: "No tool calls this turn.",
      }),
    );
  return el("div", { class: "trace-spans" }, [...rows, ruler(total)]);
}

function spanRow(s, turnStart, total, app) {
  const offset = Math.max(0, Date.parse(s.startTs) - turnStart);
  let leftPct = Math.min(96, (offset / total) * 100);
  let widthPct;
  let label = `${fmtMs(s.durMs)}`;
  if (s.wait && s.durMs != null) {
    // Cap human-wait width so it cannot flatten compute spans.
    widthPct = Math.min(Math.max((30000 / total) * 100, 12), 96 - leftPct);
    label = `⏸ ${fmtMs(s.durMs)} waiting`;
  } else if (s.durMs != null) {
    widthPct = Math.max(0.8, Math.min((s.durMs / total) * 100, 100 - leftPct));
  } else {
    widthPct = 2;
    label = s.incomplete ? "incomplete" : "?";
  }
  const tone = s.running
    ? "running"
    : s.incomplete
      ? "incomplete"
      : s.wait
        ? "wait"
        : s.ok === false
          ? "err"
          : s.isTask
            ? "task"
            : "ok";
  const status = s.running
    ? "running"
    : s.incomplete
      ? "incomplete (no result recorded)"
      : s.wait
        ? "waiting on a human"
        : s.ok === false
          ? "error"
          : "ok";
  const tip = [
    `${s.tool} - ${status}`,
    s.durMs != null ? `duration ${fmtMs(s.durMs)}` : null,
    s.agent ? `subagent ${s.agent.agentType}: ${s.agent.description}` : null,
    s.agent ? null : s.summary || null,
  ]
    .filter(Boolean)
    .join("\n");
  const row = el(
    "details",
    {
      class: "trace-span-row",
      open: app.store.traceOpenSpans.has(s.id),
      tabindex: "0",
      "data-tip": tip,
      "aria-label": tip,
    },
    [
      el("summary", { class: "trace-span-summary" }, [
        el("span", { class: "trace-span-label" }, [
          el("span", { class: "trace-tool", text: s.tool }),
          s.agent
            ? el("span", {
                class: "muted small",
                text: ` ${s.agent.agentType}: ${s.agent.description}`,
              })
            : s.summary
              ? el("span", { class: "mono small muted", text: ` ${s.summary}` })
              : null,
        ]),
        el("div", { class: "trace-track" }, [
          el("div", {
            class: `trace-bar trace-${tone}`,
            style: `left:${leftPct}%;width:${widthPct}%`,
          }),
          el("span", {
            class: "trace-dur mono small",
            text: s.running ? `▶ ${fmtMs(s.durMs)}` : label,
          }),
        ]),
      ]),
      el("div", { class: "trace-inspector small" }, [
        el("p", {
          text: `Started ${s.startTs}${s.endTs ? ` · Finished ${s.endTs}` : ""}`,
        }),
        el("p", { text: `Status: ${status} · Duration: ${fmtMs(s.durMs)}` }),
        el("p", {
          class: "mono",
          text: s.summary || "No argument summary recorded.",
        }),
        el("p", { class: "muted", text: `Call ID: ${s.id || "unknown"}` }),
      ]),
    ],
  );
  row.addEventListener("toggle", () => {
    if (!row.isConnected) return;
    row.open
      ? app.store.traceOpenSpans.add(s.id)
      : app.store.traceOpenSpans.delete(s.id);
  });
  return row;
}

function ruler(totalMs) {
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) =>
    el("span", { class: "trace-tick mono", text: fmtMs(totalMs * f) }),
  );
  return el("div", { class: "trace-ruler muted small" }, ticks);
}

// @ts-check
import {
  el,
  card,
  clear,
  pill,
  statusTone,
  relTime,
  emptyState,
  forgeLabel,
} from "../lib/dom.mjs";
import { sparkline, donut, lines } from "../lib/charts.mjs";
import { masonry } from "../lib/masonry.mjs";
import { pulseStrip } from "../lib/pulse.mjs";
import { providerLabel } from "../lib/session-picker.mjs";

function agentsCard(s, app) {
  const sess = s?.sessions ?? { agents: [], activeCount: 0 };
  const agents = sess.agents || [];
  const active = agents.filter((a) => a.active);
  const recent = agents.filter((a) => !a.active).slice(0, 4);
  const shown = [...active, ...recent].slice(0, 5);
  const trend = app.config.display?.metrics ? agentTrend(s) : null;
  const list = shown.length
    ? el(
        "ul",
        { class: "agent-list" },
        shown.map((a) => agentItem(a, app)),
      )
    : emptyState(
        "No Claude Code or Codex sessions found.",
        "Sessions appear per checkout as you work in them.",
      );
  const body = trend ? el("div", {}, [trend, list]) : list;
  return card(
    `Agents${sess.activeCount ? ` (${sess.activeCount} active)` : ""}`,
    body,
    {
      help: "Claude Code and Codex sessions in this checkout and its worktrees. Recent transcript activity indicates liveness; recorded completion marks a session idle.",
      aside: el("button", {
        class: "link-btn",
        text: "Worktrees →",
        onClick: () => app.navigate("#/worktrees"),
      }),
    },
  );
}

/** Compact task progress for a session: a thin bar, a done/total count, and the
 *  task it is on right now. Null when the session has no task list. */
function taskProgress(tasks) {
  if (!tasks || !tasks.total) return null;
  const pct = Math.round((tasks.pct || 0) * 100);
  return el("div", { class: "task-prog" }, [
    el(
      "div",
      {
        class: "task-bar",
        "data-tip": `${tasks.completed}/${tasks.total} done · ${tasks.inProgress} in progress · ${tasks.pending} pending`,
      },
      el("div", { class: "task-bar-fill", style: `width:${pct}%` }),
    ),
    el("span", {
      class: "task-count mono small",
      text: `${tasks.completed}/${tasks.total}`,
    }),
    tasks.current
      ? el("span", { class: "task-current muted small", text: tasks.current })
      : null,
  ]);
}

/** Approve/Reject controls for a session awaiting mutation approval. */
function approvalControls(a, app) {
  const act = (name) => async (e) => {
    e.stopPropagation();
    try {
      const r = await app.api.action(name, {
        sessionId: a.latestSessionId,
        expectedRevision: a.policyRevision,
      });
      if (r.ok === false)
        app.toast?.(
          r.stale
            ? "Policy changed underneath, refresh and retry."
            : r.error || "Action failed.",
          "err",
        );
      else
        app.toast?.(
          name === "policy.approve" ? "Session approved." : "Session rejected.",
          "ok",
        );
    } catch (err) {
      app.toast?.(String((err && err.message) || err), "err");
    }
  };
  return el("span", { class: "row", style: "gap:4px;align-items:center" }, [
    pill("awaiting approval", "warn"),
    el("button", {
      class: "btn small",
      type: "button",
      text: "Approve",
      "data-tip": "Allow this session's gated mutation workflow.",
      onClick: act("policy.approve"),
    }),
    el("button", {
      class: "btn small",
      type: "button",
      text: "Reject",
      "data-tip": "Keep this session's mutations blocked.",
      onClick: act("policy.reject"),
    }),
  ]);
}

/** Runtime-truth chips per agent: event state, workflow, model, context, cost. */
function agentMeta(a, app) {
  const chips = [
    pill(providerLabel(a.provider), "neutral"),
    a.eventState ? pill(a.eventState, statusTone(a.eventState)) : null,
    a.workflow
      ? pill(
          a.readOnly ? `${a.workflow} · read-only` : a.workflow,
          a.readOnly ? "warn" : "neutral",
        )
      : null,
    a.approvalRequired && a.policyRevision != null && app
      ? approvalControls(a, app)
      : null,
    a.rejected ? pill("rejected", "err") : null,
    a.model ? el("span", { class: "muted small", text: a.model }) : null,
    a.ctxPct != null
      ? el("span", {
          class: "muted small",
          text: `${Math.round(a.ctxPct)}% ctx`,
        })
      : null,
    a.costUsd != null
      ? el("span", {
          class: "muted small",
          title: "estimated session cost (statusline)",
          text: `Est. $${Number(a.costUsd).toFixed(2)}`,
        })
      : null,
  ].filter(Boolean);
  if (!chips.length) return null;
  return el(
    "div",
    {
      class: "agent-meta row",
      style: "gap:6px;flex-wrap:wrap;align-items:center;margin-top:3px",
    },
    chips,
  );
}

/** One Agents-card entry: the clickable session row plus a lazily-loaded,
 *  toggleable panel listing every task in that session. */
function agentItem(a, app) {
  const tasksHost = el("div", { class: "agent-tasks-host", hidden: true });
  let loaded = false;
  const caret = a.tasks
    ? el("button", {
        class: "agent-caret",
        type: "button",
        "data-tip": "Show this agent's task list",
        text: "▸",
        onClick: (e) => {
          e.stopPropagation();
          const show = tasksHost.hidden;
          tasksHost.hidden = !show;
          caret.classList.toggle("open", show);
          if (show && !loaded) {
            loaded = true;
            tasksHost.append(
              el("span", { class: "muted small", text: "Loading tasks…" }),
            );
            app.api
              .sessionTasks(a.latestSessionId)
              .then((r) => renderTaskList(tasksHost, r.tasks || []))
              .catch((err) =>
                clear(tasksHost).append(
                  el("span", {
                    class: "muted small",
                    text: String((err && err.message) || err),
                  }),
                ),
              );
          }
        },
      })
    : null;
  const row = el(
    "div",
    {
      class: `agent-row ${a.active ? "active" : ""}`,
      tabindex: "0",
      role: "button",
      "data-tip": "Open this session's live transcript.",
      onClick: () => openSession(app, a),
      onKeydown: (e) => e.key === "Enter" && openSession(app, a),
    },
    [
      el("span", { class: `agent-dot ${a.active ? "on" : ""}` }),
      el("div", { class: "agent-main" }, [
        el("strong", { class: "mono", text: a.branch }),
        el("div", {
          class: "muted small",
          text: `${a.sessionCount} session${a.sessionCount === 1 ? "" : "s"} · ${a.lastActivity ? relTime(a.lastActivity) : "·"}`,
        }),
        agentMeta(a, app),
        taskProgress(a.tasks),
      ]),
      a.isOwn
        ? pill("this session", "info")
        : a.active
          ? pill("active", "ok")
          : null,
      caret,
    ],
  );
  return el("li", { class: "agent-item" }, [row, tasksHost]);
}

const TASK_MARK = { completed: "✓", in_progress: "●" };

function renderTaskList(host, tasks) {
  clear(host);
  if (!tasks.length) {
    host.append(el("span", { class: "muted small", text: "No tasks." }));
    return;
  }
  host.append(
    el(
      "ul",
      { class: "task-list" },
      tasks.map((t) =>
        el("li", { class: `task-item ts-${t.status}` }, [
          el("span", { class: "task-mark", text: TASK_MARK[t.status] || "○" }),
          el("span", {
            class: "task-subject small",
            text: t.subject || t.activeForm || t.id,
          }),
        ]),
      ),
    ),
  );
}

/** Open the live transcript mirror for a session. */
function openSession(app, a) {
  app.store.feedSession = {
    id: a.latestSessionId,
    path: a.path,
    branch: a.branch,
    provider: a.provider || "claude",
  };
  app.navigate("#/activity/session");
}

/** Jump straight to a worktree's uncommitted diff (the live work in it). */
function openWorktreeDiff(app, path) {
  app.store.diffTarget = path;
  app.store.diffMode = "working";
  app.store.diffFile = "";
  app.navigate("#/diff");
}

function normPath(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

const LIVE_WINDOW_MS = 3 * 60 * 1000;

function liveActivityCard(s, app) {
  const wts = s?.worktrees ?? [];
  const byPath = new Map();
  for (const a of s?.sessions?.agents ?? []) {
    const key = normPath(a.path);
    const previous = byPath.get(key);
    if (!previous || (!previous.active && a.active)) byPath.set(key, a);
  }
  const now = Date.now();
  const rows = wts.map((w) => {
    const agent = byPath.get(normPath(w.path));
    const changeT = w.lastChange ? Date.parse(w.lastChange) : NaN;
    const churning = Number.isFinite(changeT) && now - changeT < LIVE_WINDOW_MS;
    const sessionActive = Boolean(agent?.active);
    return {
      w,
      agent,
      changeT,
      churning,
      sessionActive,
      live: churning || sessionActive,
    };
  });
  rows.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    const at = Number.isFinite(a.changeT) ? a.changeT : 0;
    const bt = Number.isFinite(b.changeT) ? b.changeT : 0;
    if (bt !== at) return bt - at;
    return (b.w.dirty || 0) - (a.w.dirty || 0);
  });
  const liveCount = rows.filter((r) => r.live).length;
  const dirtyTotal = rows.reduce((n, r) => n + (r.w.dirty || 0), 0);

  const shown = rows.slice(0, 12);
  const body = rows.length
    ? el("div", {}, [
        el(
          "ul",
          { class: "live-board" },
          shown.map((r) => liveRow(r, app)),
        ),
        rows.length > shown.length
          ? el("button", {
              class: "link-btn",
              text: `+${rows.length - shown.length} more → Worktrees`,
              onClick: () => app.navigate("#/worktrees"),
            })
          : null,
      ])
    : emptyState(
        "No worktrees found.",
        "git worktree list returned nothing for this checkout.",
      );

  return card(
    `Live activity${liveCount ? ` · ${liveCount} active` : ""}`,
    body,
    {
      class: "card-wide",
      help: "Every worktree, with its assistant sessions and uncommitted churn. Active = a session is live or a file changed in the last 3 minutes. Click a row to see that worktree's in-progress diff. Updates every refresh.",
      aside: el("span", {
        class: "muted small",
        text: dirtyTotal ? `${dirtyTotal} uncommitted file(s)` : "all clean",
      }),
    },
  );
}

function liveRow(r, app) {
  const { w } = r;
  const branch = (w.branch || w.id || "").replace(/^MS\//, "");
  const dirtyPill =
    w.dirty > 0
      ? pill(`${w.dirty} changed`, r.churning ? "warn" : "neutral")
      : el("span", { class: "muted small", text: "clean" });
  return el(
    "li",
    {
      class: `live-row ${r.live ? "live" : ""}`,
      tabindex: "0",
      role: "button",
      "data-tip": "Open this worktree's uncommitted diff.",
      onClick: () => openWorktreeDiff(app, w.path),
      onKeydown: (e) => e.key === "Enter" && openWorktreeDiff(app, w.path),
    },
    [
      el("span", { class: `agent-dot ${r.live ? "on" : ""}` }),
      el("div", { class: "live-main" }, [
        el("strong", { class: "mono", text: branch || "(detached)" }),
        el("div", { class: "live-sub muted small" }, [
          r.sessionActive ? pill("agent", "ok") : null,
          w.isCurrent ? pill("this", "info") : null,
          el("span", {
            text: r.changeT
              ? `changed ${relTime(w.lastChange)}`
              : w.dirty
                ? "uncommitted"
                : "no changes",
          }),
        ]),
        taskProgress(r.agent?.tasks),
      ]),
      dirtyPill,
    ],
  );
}

/** Sparkline of active-agent count sampled since the panel started. */
function agentTrend(s) {
  const history = s?.history ?? [];
  if (history.length < 2) return null;
  const points = history.map((h) => h.activeAgents || 0);
  const peak = Math.max(...points);
  const host = el("div", { class: "spark-host" });
  queueMicrotask(() => sparkline(host, points, { tone: "ok", height: 34 }));
  return el("div", { class: "agent-trend" }, [
    el("div", { class: "agent-trend-cap muted small" }, [
      el("span", { text: "Active agents over time" }),
      el("span", { class: "mono", text: `peak ${peak}` }),
    ]),
    host,
  ]);
}

/** Full-width multi-series chart of live counts sampled since panel start. */
function throughputCard(s) {
  const history = s?.history ?? [];
  const series = [
    {
      label: "agents",
      points: history.map((h) => h.activeAgents || 0),
      tone: "ok",
    },
    {
      label: "jobs",
      points: history.map((h) => h.runningJobs || 0),
      tone: "info",
    },
    {
      label: "runs",
      points: history.map((h) => h.activeRuns || 0),
      tone: "warn",
    },
  ];
  let body;
  if (history.length < 2) {
    body = emptyState(
      "Collecting samples.",
      "The throughput chart appears once the panel has sampled a few times.",
    );
  } else {
    const host = el("div", { class: "lines-host" });
    queueMicrotask(() => lines(host, series, { height: 72 }));
    const legend = el(
      "div",
      { class: "lines-legend" },
      series.map((x) =>
        el("span", { class: "lines-legend-item" }, [
          el("span", { class: `legend-dot tone-${x.tone}` }),
          el("span", {
            class: "muted small",
            text: `${x.label}: ${x.points.at(-1) ?? 0}`,
          }),
        ]),
      ),
    );
    body = el("div", {}, [host, legend]);
  }
  return card("Throughput", body, {
    help: "Live counts sampled since the panel started: active assistant sessions, running panel jobs, and active autoloop runs. Resets on restart.",
  });
}

const SEV_TONE = { blocking: "danger", attention: "warn", warning: "warn" };

/** Overview, strict hierarchy: attention → active runs → selected run → health → evidence → activity. */
export function render(app) {
  const s = app.snapshot;
  const display = app.config.display || {};
  const runs = s?.runs ?? [];
  const active = runs.filter(
    (r) => r.status === "running" || r.status === "waiting",
  );
  const attention = s?.attention ?? [];
  const selected = pickSelected(app, runs, active);

  // Widget cards masonry-pack to fill the width: one column on narrow, more as
  // the screen grows, with no height gaps between uneven cards.
  const tiles = el("div", { class: "grid-tiles" }, [
    agentsCard(s, app),
    ...(display.runs
      ? [
          activeRunsCard(active, app, selected),
          selectedRunCard(selected, app),
          jobsWidget(app),
        ]
      : []),
    ...(display.health ? [healthCard(s, app), panelHealthCard(s)] : []),
    ...(display.repository
      ? [
          pushReadinessCard(s, app),
          forgeCard(s),
          evidenceCard(s, app),
          recentCommitsCard(s),
        ]
      : []),
    ...(display.activity ? [activityCard(app)] : []),
  ]);
  requestAnimationFrame(() => masonry(tiles));

  return el("div", { class: "view view-overview" }, [
    el("div", { class: "row", style: "justify-content:flex-end" }, [
      el("button", {
        class: "btn small",
        text: "Customize view",
        onClick: () => app.navigate("#/config"),
      }),
    ]),
    display.metrics ? kpiRow(s, app) : null,
    display.activity ? pulseStrip(app) : null,
    attentionCard(attention, app),
    display.activity ? liveActivityCard(s, app) : null,
    tiles,
    display.metrics ? throughputCard(s) : null,
  ]);
}

/** Recent commits on the current branch: what landed lately, with a per-day spark. */
function recentCommitsCard(s) {
  const commits = s?.recentCommits ?? [];
  const activity = s?.commitActivity ?? [];
  const list = commits.length
    ? el(
        "ul",
        { class: "commit-list" },
        commits.slice(0, 6).map((c) =>
          el("li", { class: "commit-row" }, [
            el("span", { class: "commit-hash mono small", text: c.hash }),
            el("span", {
              class: "commit-subject",
              "data-tip": c.subject,
              text: c.subject,
            }),
            el("span", {
              class: "commit-meta muted small",
              text: `${c.author}${c.date ? ` · ${relTime(c.date)}` : ""}`,
            }),
          ]),
        ),
      )
    : emptyState("No commits found.", "git log returned nothing for HEAD.");
  let trendBlock = null;
  if (activity.length >= 2 && activity.some((d) => d.count > 0)) {
    const spark = el("div", { class: "spark-host" });
    const total = activity.reduce((a, d) => a + d.count, 0);
    queueMicrotask(() =>
      sparkline(
        spark,
        activity.map((d) => d.count),
        { tone: "brand", height: 30 },
      ),
    );
    trendBlock = el("div", { class: "agent-trend" }, [
      el("div", { class: "agent-trend-cap muted small" }, [
        el("span", { text: `Commits per day (${activity.length}d)` }),
        el("span", { class: "mono", text: `${total} total` }),
      ]),
      spark,
    ]);
  }
  const authors = s?.authorBreakdown ?? [];
  const authorsLine = authors.length
    ? el("div", {
        class: "muted small commit-authors",
        text: `Authors: ${authors.map((a) => `${a.author} (${a.count})`).join(", ")}`,
      })
    : null;
  const body =
    trendBlock || authorsLine
      ? el("div", {}, [trendBlock, authorsLine, list])
      : list;
  return card("Recent commits", body, {
    help: "Latest commits on this checkout's branch (git log HEAD), with a per-day commit count over the last two weeks.",
  });
}

function kpiRow(s, app) {
  const runs = s?.runs ?? [];
  const running = runs.filter((r) => r.status === "running").length;
  const waiting = runs.filter((r) => r.status === "waiting" || r.stale).length;
  const wts = s?.worktrees ?? [];
  const services = wts.reduce(
    (n, w) =>
      n + (w.services ?? []).filter((x) => x.status === "running").length,
    0,
  );
  const blocking =
    (Number(s?.reviews?.blockCount) || 0) +
    (s?.validation?.checks ?? []).filter((c) => c.status === "failed").length;
  const ready = s?.readiness?.ready;
  const kpi = (label, value, foot, tone, onClick) =>
    el(
      "button",
      {
        class: `kpi-card ${tone ? `kpi-${tone}` : ""}`,
        onClick: onClick || null,
      },
      [
        el("span", { class: "kpi-label", text: label }),
        el("strong", { class: "kpi-value", text: String(value) }),
        el("span", { class: "kpi-foot muted small", text: foot }),
      ],
    );
  return el("div", { class: "kpi-row" }, [
    kpi(
      "Active runs",
      running + waiting,
      `${running} progressing · ${waiting} waiting`,
      null,
      () => app.navigate("#/runs"),
    ),
    kpi("Worktrees", wts.length, `${services} services running`, null, () =>
      app.navigate("#/worktrees"),
    ),
    kpi(
      "Blocking findings",
      blocking,
      blocking ? "needs review" : "all clear",
      blocking ? "danger" : "ok",
      () => app.navigate(blocking ? "#/reviews" : "#/validation"),
    ),
    kpi(
      "Ready to push",
      ready ? "Yes" : "No",
      s?.readiness
        ? ready
          ? `commit ${s.readiness.head || ""}`
          : `${s.readiness.blockers + s.readiness.unknown} blocker(s)`
        : "·",
      ready ? "ok" : "warn",
      null,
    ),
  ]);
}

function pushReadinessCard(s, app) {
  const r = s?.readiness;
  const verdict = !r
    ? pill("·", "neutral")
    : r.ready
      ? pill("Ready", "ok")
      : pill(
          `${r.blockers + r.unknown} blocker${r.blockers + r.unknown === 1 ? "" : "s"}`,
          r.blockers ? "danger" : "warn",
        );
  const items = [...(r?.evidence ?? [])];
  // Live remote CI for this branch (from the forge adapter) as one more line.
  const ci = s?.forge?.configured ? s.forge.pipeline : null;
  if (ci)
    items.push({
      ok:
        ci.status === "success" ? true : ci.status === "failed" ? false : null,
      label: "CI pipeline",
      detail: `${ci.status} on origin (${ci.sha})`,
    });
  const evidence = items.map((e) =>
    el("div", { class: "evidence-item" }, [
      el("span", {
        class: `evidence-mark ${e.ok === true ? "ok" : e.ok === false ? "bad" : "unknown"}`,
        text: e.ok === true ? "✓" : e.ok === false ? "✕" : "•",
      }),
      el("div", {}, [
        el("strong", { text: e.label }),
        el("div", { class: "muted small", text: e.detail }),
      ]),
    ]),
  );
  const pushCmd = "git push origin HEAD";
  const body = [
    el(
      "div",
      { class: "evidence-list" },
      evidence.length
        ? evidence
        : [
            el("p", {
              class: "muted small",
              text: "Readiness evidence unavailable.",
            }),
          ],
    ),
    el("div", { class: "btn-row" }, [
      el("button", {
        class: "btn",
        text: "Copy push command",
        onClick: () => copyText(pushCmd, app),
      }),
      el("button", {
        class: "btn",
        "data-tip": "Copy a Markdown status summary for a standup or handover",
        text: "Copy status",
        onClick: () => app.copyStatusReport(),
      }),
      el("button", {
        class: "link-btn",
        text: "Review",
        onClick: () => app.navigate("#/reviews"),
      }),
    ]),
    el("p", {
      class: "muted small",
      text: r?.ready
        ? "Evidence is green. The panel never pushes for you, copy the command and push from your shell."
        : "Resolve the blockers above before pushing.",
    }),
  ];
  return card("Push readiness", body, {
    help: "Concrete evidence (not a score) that the branch is safe to push: validation green, zero blocking review findings, and a /pre-mr marker matching HEAD.",
    aside: verdict,
  });
}

function copyText(text, app) {
  navigator.clipboard?.writeText(text).then(
    () => app.toast("Push command copied.", "ok"),
    () => app.toast("Clipboard unavailable.", "warn"),
  );
}

function jobsWidget(app) {
  const jobs = app.store.jobs || [];
  const running = jobs.filter((j) => j.status === "running");
  const recent = jobs.filter((j) => j.status !== "running").slice(0, 4);
  const shown = [...running, ...recent].slice(0, 6);
  const tone = {
    running: "info",
    succeeded: "ok",
    failed: "danger",
    cancelled: "warn",
  };
  const body = shown.length
    ? el(
        "ul",
        { class: "job-mini-list" },
        shown.map((j) =>
          el(
            "li",
            {
              class: "job-mini",
              onClick: () => openJobInCommands(app, j.id),
              tabindex: "0",
              role: "button",
              onKeydown: (e) =>
                e.key === "Enter" && openJobInCommands(app, j.id),
            },
            [
              el("div", { class: "job-mini-main" }, [
                el("strong", { text: j.label }),
                el("div", {
                  class: "muted small",
                  text: `${j.worktree || "current"} · ${relTime(j.startedAt)}`,
                }),
              ]),
              j.status === "running"
                ? el("span", { class: "spinner" })
                : pill(j.status, tone[j.status] || "neutral"),
            ],
          ),
        ),
      )
    : emptyState(
        "No jobs running.",
        "Run review-pack, verify or git commands from Commands.",
      );
  return card(
    `Running now${running.length ? ` (${running.length})` : ""}`,
    body,
    {
      aside: el("button", {
        class: "link-btn",
        text: "Commands →",
        onClick: () => app.navigate("#/commands"),
      }),
    },
  );
}

function openJobInCommands(app, id) {
  app.store.openJobId = id;
  app.navigate("#/commands");
}

function pickSelected(app, runs, active) {
  const sel =
    app.store.selectedRunId &&
    runs.find((r) => r.id === app.store.selectedRunId);
  if (sel) return sel;
  const a = (app.snapshot?.attention ?? []).find((x) => x.kind === "run");
  if (a)
    return (
      runs.find((r) => a.link?.endsWith(r.id)) ?? active[0] ?? runs[0] ?? null
    );
  return active[0] || runs[0] || null;
}

function attentionCard(items, app) {
  const body = items.length
    ? el(
        "ul",
        { class: "attention-list" },
        items.map((it) =>
          el(
            "li",
            {
              class: `attention-item sev-${SEV_TONE[it.severity] || "neutral"}`,
            },
            [
              pill(it.severity, SEV_TONE[it.severity] || "neutral"),
              el("div", { class: "attention-text" }, [
                el("strong", { text: it.title }),
                it.detail
                  ? el("div", { class: "muted small", text: it.detail })
                  : null,
              ]),
              it.link
                ? el("button", {
                    class: "link-btn",
                    text: "Open",
                    onClick: () => app.navigate(it.link),
                  })
                : null,
            ],
          ),
        ),
      )
    : el("div", { class: "attention-clear" }, [
        el("span", { class: "attention-clear-mark", text: "✓" }),
        el("span", { text: "All clear, nothing needs attention right now." }),
      ]);
  return card("Needs attention", body, {
    class: items.length ? "card-accent-danger" : "",
  });
}

function activeRunsCard(active, app, selected) {
  const body = active.length
    ? el(
        "ul",
        { class: "run-list" },
        active.map((r) =>
          el(
            "li",
            {
              class: `run-row ${selected && r.id === selected.id ? "selected" : ""}`,
              onClick: () => app.selectRun(r.id),
              tabindex: "0",
              role: "button",
              onKeydown: (e) => e.key === "Enter" && app.selectRun(r.id),
            },
            [
              el("div", { class: "run-main" }, [
                el("strong", { text: r.title }),
                el("div", {
                  class: "muted small",
                  text: `${r.phase} · iteration ${r.iteration ?? "?"}/${r.maxIterations ?? "?"}`,
                }),
              ]),
              pill(
                r.stale ? "stale" : r.status,
                r.stale ? "warn" : statusTone(r.status),
              ),
            ],
          ),
        ),
      )
    : emptyState(
        "No active runs.",
        "Start an autoloop run from the launcher in Runs.",
      );
  return card(`Active runs (${active.length})`, body, {
    help: "Tracked autoloop runs (bounded iterative loops). Your interactive assistant sessions are in the Agents card, so this is often empty even when you're busy.",
    aside: el("button", {
      class: "link-btn",
      text: "All runs →",
      onClick: () => app.navigate("#/runs"),
    }),
  });
}

function selectedRunCard(run, app) {
  if (!run)
    return card(
      "Selected run",
      emptyState("No run selected.", "Click a run to inspect it."),
    );
  const pct = run.progress != null ? Math.round(run.progress * 100) : 0;
  return card("Selected run", [
    el("div", { class: "kv" }, [
      el("span", { class: "k", text: "Task" }),
      el("span", { class: "v", text: run.title }),
    ]),
    el("div", { class: "kv" }, [
      el("span", { class: "k", text: "Status" }),
      el("span", { class: "v" }, [
        pill(
          run.stale ? "stale" : run.status,
          run.stale ? "warn" : statusTone(run.status),
        ),
      ]),
    ]),
    el("div", { class: "kv" }, [
      el("span", { class: "k", text: "Phase" }),
      el("span", { class: "v", text: run.phase }),
    ]),
    el(
      "div",
      { class: "progress", "data-tip": `${pct}%` },
      el("div", { class: "progress-bar", style: `width:${pct}%` }),
    ),
    el("button", {
      class: "btn",
      text: "Open run details",
      onClick: () => app.navigate(`#/runs/${run.id}`),
    }),
  ]);
}

function healthCard(s, app) {
  const wts = s?.worktrees ?? [];
  const current = wts.find((w) => w.isCurrent);
  const runningServices = wts.reduce(
    (n, w) =>
      n + (w.services ?? []).filter((x) => x.status === "running").length,
    0,
  );
  const c = s?.checkout ?? {};
  return card(
    "Worktree & service health",
    [
      el("div", { class: "kv" }, [
        el("span", { class: "k", text: "Branch" }),
        el("span", { class: "v" }, [
          el("span", { class: "mono", text: c.branch || "(detached)" }),
          c.dirty ? pill(`${c.dirtyCount} dirty`, "warn") : pill("clean", "ok"),
        ]),
      ]),
      el("div", { class: "kv" }, [
        el("span", { class: "k", text: "Commit" }),
        el("span", { class: "v mono", text: c.commit || "·" }),
      ]),
      el("div", { class: "kv" }, [
        el("span", { class: "k", text: "Worktrees" }),
        el("span", { class: "v", text: String(wts.length) }),
      ]),
      el("div", { class: "kv" }, [
        el("span", { class: "k", text: "Running services" }),
        el("span", { class: "v", text: String(runningServices) }),
      ]),
      el("button", {
        class: "link-btn",
        text: "All worktrees →",
        onClick: () => app.navigate("#/worktrees"),
      }),
    ],
    { aside: current ? pill("this worktree", "info") : null },
  );
}

function panelHealthCard(s) {
  const p = s?.panel ?? {};
  const fmtDur = (sec) => {
    if (sec == null) return "·";
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m ${sec % 60}s`;
  };
  const fmtBytes = (b) => {
    if (!b) return "·";
    const mb = b / 1048576;
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
  };
  const row = (k, v, mono) =>
    el("div", { class: "kv" }, [
      el("span", { class: "k", text: k }),
      el("span", { class: `v${mono ? " mono" : ""}`, text: v }),
    ]);
  return card("Panel health", [
    row("Uptime", fmtDur(p.uptimeSec)),
    row("Memory", p.rssMB != null ? `${p.rssMB} MB` : "·"),
    row("Live clients", String(p.sseClients ?? 0)),
    row("Runtime size", fmtBytes(p.runtimeBytes)),
    row("Node", p.node || "·", true),
    row("Platform", p.platform || "·"),
  ]);
}

const PIPE_TONE = {
  success: "ok",
  failed: "danger",
  running: "info",
  pending: "warn",
  canceled: "neutral",
  skipped: "neutral",
  manual: "neutral",
  created: "neutral",
};

function glLink(text, href, extra) {
  return el("a", {
    class: `link-out ${extra || ""}`,
    href,
    target: "_blank",
    rel: "noreferrer",
    text,
  });
}

/** This branch's open MR + latest pipeline, polled read-only from the forge. */
function forgeCard(s) {
  const g = s?.forge ?? { configured: false };
  const name = forgeLabel(g.provider).name;
  let body;
  if (!g.configured) {
    body = emptyState(
      "No git forge connected.",
      "Set GITLAB_TOKEN or GITHUB_TOKEN in .claude/settings.local.json to show MR and pipeline status.",
    );
  } else if (g.error) {
    body = emptyState(`${name} unavailable.`, g.error);
  } else {
    const rows = [];
    if (g.mr) {
      rows.push(
        el("div", { class: "kv" }, [
          el("span", { class: "k", text: "Merge request" }),
          el("span", { class: "v" }, [
            glLink(`!${g.mr.iid}`, g.mr.webUrl),
            g.mr.draft ? pill("draft", "warn") : pill(g.mr.state, "ok"),
            g.mr.hasConflicts ? pill("conflicts", "danger") : null,
          ]),
        ]),
        el("div", { class: "gl-title small", text: g.mr.title }),
        el("div", { class: "kv" }, [
          el("span", { class: "k", text: "Target" }),
          el("span", {
            class: "v small mono",
            text: `${g.mr.target} · ${g.mr.notes} note${g.mr.notes === 1 ? "" : "s"}`,
          }),
        ]),
      );
    } else {
      rows.push(
        el("div", {
          class: "muted small",
          text: "No open MR for this branch.",
        }),
      );
    }
    if (g.pipeline) {
      rows.push(
        el("div", { class: "kv" }, [
          el("span", { class: "k", text: "Pipeline" }),
          el("span", { class: "v" }, [
            pill(g.pipeline.status, PIPE_TONE[g.pipeline.status] || "neutral"),
            glLink(g.pipeline.sha, g.pipeline.webUrl, "mono small"),
          ]),
        ]),
      );
    } else if (g.mr) {
      rows.push(
        el("div", {
          class: "muted small",
          text: "No pipeline for this branch.",
        }),
      );
    }
    body = el("div", { class: "gl-body" }, rows);
  }
  return card(name, body, {
    help: "Read-only view of this branch's open merge request and latest pipeline, polled from the forge. The token stays server-side and is never sent to the browser.",
  });
}

function evidenceCard(s, app) {
  const v = s?.validation ?? {};
  const r = s?.reviews ?? {};
  const checks = v.checks ?? [];
  const vEmpty = v.status === "ok" && checks.length === 0;
  const vTone =
    v.status === "none" || vEmpty ? "neutral" : v.passed ? "ok" : "danger";
  const vLabel =
    v.status === "none"
      ? "not run"
      : vEmpty
        ? "no scope"
        : v.passed
          ? "passing"
          : "failing";
  const rTone =
    r.status !== "ok"
      ? "neutral"
      : r.blockCount > 0
        ? "danger"
        : r.warnCount > 0
          ? "warn"
          : "ok";
  const rLabel =
    r.status !== "ok"
      ? r.status
      : r.blockCount > 0
        ? `${r.blockCount} blocking`
        : r.warnCount > 0
          ? `${r.warnCount} warnings`
          : "clean";

  const donutEl = el("div", { class: "donut-host" });
  // Findings severity makeup gives the donut something meaningful even pre-validation.
  const findings = r.findings ?? [];
  const segs = [
    {
      label: "blocking",
      value: findings.filter((f) => f.severity === "blocking").length,
      tone: "danger",
    },
    {
      label: "warnings",
      value: findings.filter((f) => f.severity !== "blocking").length,
      tone: "warn",
    },
  ];
  const hasFindings = segs.some((x) => x.value > 0);
  queueMicrotask(() =>
    hasFindings
      ? donut(donutEl, segs, { centerLabel: "findings" })
      : donutEl.replaceChildren(
          el("div", { class: "donut-clean" }, [
            el("div", { class: "donut-tick", text: "✓" }),
            el("div", { class: "muted small", text: "no findings" }),
          ]),
        ),
  );

  return card("Validation & review", [
    el("div", { class: "evidence-split" }, [
      donutEl,
      el("div", { class: "evidence-kv" }, [
        el("div", { class: "kv" }, [
          el("span", { class: "k", text: "Validation" }),
          el("span", { class: "v" }, [
            pill(vLabel, vTone),
            el("button", {
              class: "link-btn",
              text: "view",
              onClick: () => app.navigate("#/validation"),
            }),
          ]),
        ]),
        el("div", { class: "kv" }, [
          el("span", { class: "k", text: "Review" }),
          el("span", { class: "v" }, [
            pill(rLabel, rTone),
            el("button", {
              class: "link-btn",
              text: "view",
              onClick: () => app.navigate("#/reviews"),
            }),
          ]),
        ]),
        r.base
          ? el("div", { class: "kv" }, [
              el("span", { class: "k", text: "Base" }),
              el("span", { class: "v mono small", text: r.base }),
            ])
          : null,
      ]),
    ]),
  ]);
}

/** Bucket recent events into a short time series for the sparkline. */
function activityBuckets(events, buckets = 32, windowMs = 20 * 60 * 1000) {
  const now = Date.now();
  const series = new Array(buckets).fill(0);
  for (const e of events) {
    const t = Date.parse(e.emittedAt);
    if (!Number.isFinite(t)) continue;
    const age = now - t;
    if (age < 0 || age > windowMs) continue;
    const idx = buckets - 1 - Math.floor((age / windowMs) * buckets);
    if (idx >= 0 && idx < buckets) series[idx] += 1;
  }
  return series;
}

function activityCard(app) {
  const events = app.store.recentEvents || [];
  const spark = el("div", { class: "spark-host" });
  queueMicrotask(() =>
    sparkline(spark, activityBuckets(events), { tone: "brand" }),
  );
  const recent = events.slice(-6).reverse();
  const list = recent.length
    ? el(
        "ul",
        { class: "log-preview" },
        recent.map((e) =>
          el("li", { class: `log-line lvl-${e.level || "info"}` }, [
            el("span", { class: "log-time mono", text: relTime(e.emittedAt) }),
            el("span", { class: "log-msg", text: e.message || e.type }),
          ]),
        ),
      )
    : emptyState(
        "No recent events yet.",
        "Live workflow events appear here and in Logs.",
      );
  return card(
    "Activity",
    [
      el("div", {
        class: "muted small",
        text: "Events over the last 20 minutes",
      }),
      spark,
      list,
    ],
    {
      aside: el("button", {
        class: "link-btn",
        text: "Logs →",
        onClick: () => app.navigate("#/logs"),
      }),
    },
  );
}

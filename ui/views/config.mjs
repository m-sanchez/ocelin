// @ts-check
import { el, card, pill, clear, emptyState } from "../lib/dom.mjs";
import { masonry } from "../lib/masonry.mjs";
import { openWizard } from "../lib/wizard.mjs";
import { displayOptions, normalizeDisplay } from "../lib/display.mjs";

/** Configuration, presentation + behaviour prefs (persisted), plus integration status. */
export function render(app) {
  const cfg = app.config;
  const saveDisplay = async (patch) => {
    try {
      cfg.display = await app.api.saveDisplayPreferences(patch);
      app.rerender();
    } catch (error) {
      app.toast(error.message, "err");
    }
  };
  const display = card("What you see", [
    el("p", {
      class: "muted small",
      text: "Sessions and attention stay visible. Add the information you use. Changes save automatically.",
    }),
    el("div", { class: "row" }, [
      el("button", {
        class: "btn small",
        text: "Keep it simple",
        onClick: () => saveDisplay(normalizeDisplay()),
      }),
      el("button", {
        class: "btn small",
        text: "Show all details",
        onClick: () =>
          saveDisplay(
            Object.fromEntries(
              Object.keys(displayOptions).map((key) => [key, true]),
            ),
          ),
      }),
    ]),
    ...Object.entries(displayOptions).map(([key, label]) =>
      el("label", { class: "setting-row" }, [
        el("span", { text: label }),
        el("input", {
          type: "checkbox",
          "data-display": key,
          checked: !!cfg.display?.[key],
          onChange: (event) => saveDisplay({ [key]: event.target.checked }),
        }),
      ]),
    ),
  ]);

  const themeSel = choice(
    ["system", "light", "dark"],
    cfg.theme,
    (v) => set(app, "theme", v),
    "theme",
  );
  const motionSel = choice(
    ["full", "reduced", "none"],
    cfg.motion,
    (v) => set(app, "motion", v),
    "motion",
  );
  const badgeSel = choice(
    ["on", "off"],
    cfg.badges,
    (v) => set(app, "badges", v),
    "badges",
  );
  const patrolSel = choice(
    ["on", "off"],
    cfg.patrol,
    (v) => set(app, "patrol", v),
    "patrol",
  );

  const presentation = card("Presentation", [
    field("Theme", themeSel, "Defaults to your OS preference."),
    field(
      "Ocelin motion",
      motionSel,
      "Reduced/none also respected automatically via prefers-reduced-motion.",
    ),
    field(
      "Priority badges",
      badgeSel,
      "Badges show for attention, blocked and success.",
    ),
    field(
      "Idle patrol",
      patrolSel,
      "When off, Ocelin stays planted even while idle.",
    ),
  ]);

  const behaviour = card("Behaviour", [
    toggleRow(
      app,
      "compactWorktrees",
      "Compact worktree table",
      "Dense table rows for repositories with many worktrees.",
    ),
    toggleRow(
      app,
      "autoFocusRun",
      "Auto-focus selected run",
      "Open run details when you select a run.",
    ),
    toggleRow(
      app,
      "notifications",
      "Attention notifications",
      "Toast when a check fails or input is needed.",
    ),
    desktopNotifyRow(app),
  ]);

  const browserNote = card("Browser opening", [
    el("p", {
      class: "muted small",
      text: "Automatic browser opening is a launcher setting in Ocelin's panel.config.json (browser.openByDefault) applied by the launcher. It is server-side and cannot be changed from the browser.",
    }),
  ]);

  const devSection = cfg.devMode
    ? card("Development / demo", [
        field(
          "Ocelin demo cycling",
          choice(["off", "on"], cfg.demo, (v) => set(app, "demo", v), "demo"),
          "Cycles every Ocelin state for inspection. Development only, never drives production state.",
        ),
        el("p", {
          class: "muted small",
          text: "Dev mode is active (?dev=1 or ?clawdDemo=1). In production this section is hidden and Ocelin reflects only real workflow state.",
        }),
      ])
    : card("Development / demo", [
        el("p", {
          class: "muted small",
          text: "Hidden in production. Append ?dev=1 to the URL to expose demo controls. Ocelin never cycles fake states outside demo mode.",
        }),
      ]);

  const s = app.snapshot ?? {};
  const integration = card("Service integration", [
    statusRow(
      "Worktree registry",
      (s.worktrees ?? []).some((w) => w.registered)
        ? "detected"
        : "present (no registered entries)",
      (s.worktrees ?? []).some((w) => w.registered) ? "ok" : "neutral",
    ),
    statusRow(
      "Autoloop runs (loop-state)",
      s.runs ? "available" : "unavailable",
      s.runs ? "ok" : "neutral",
    ),
    statusRow(
      "Review pipeline",
      s.reviews?.status === "unavailable" ? "not present" : "available",
      s.reviews?.status === "unavailable" ? "neutral" : "ok",
    ),
    statusRow("Validation gate", "on demand (/wt-verify)", "neutral"),
    el("p", {
      class: "muted small",
      text: "Adapters reuse existing repository scripts; missing harness components degrade gracefully rather than erroring.",
    }),
  ]);

  const p = s.panel;
  const panelHealth = card(
    "Panel health",
    p
      ? [
          kvRow(
            "Build",
            `v${p.version || "?"}${p.schemaVersion != null ? ` · schema ${p.schemaVersion}` : ""}${s.checkout?.commit ? ` · ${String(s.checkout.commit).slice(0, 9)}` : ""}`,
          ),
          kvRow("Uptime", formatUptime(p.uptimeSec)),
          kvRow("Memory (RSS)", `${p.rssMB} MB`),
          kvRow(
            "Runtime files",
            p.runtimeBytes != null ? mbExact(p.runtimeBytes) : "·",
          ),
          kvRow("Live viewers (SSE)", String(p.sseClients)),
          kvRow("History samples", String(p.historyPoints)),
          kvRow("Process", `pid ${p.pid} · port ${p.port}`),
          p.node
            ? kvRow(
                "Host",
                `node ${p.node} · ${p.platform || "?"} · ${p.cpus ?? "?"} cpu`,
              )
            : null,
          statusRow(
            "Ownership token",
            p.ownership ? "set" : "none",
            p.ownership ? "ok" : "warn",
          ),
        ]
      : [
          el("p", {
            class: "muted small",
            text: "Panel stats unavailable until the next snapshot.",
          }),
        ],
    {
      help: "Live stats for this panel server process. Uptime, memory and history reset when the panel restarts.",
    },
  );

  const tiles = el("div", { class: "grid-tiles" }, [
    gettingStartedCard(app),
    configMapCard(app),
    credentialsCard(app),
    presentation,
    behaviour,
    devSection,
    integration,
    panelHealth,
    browserNote,
  ]);
  requestAnimationFrame(() => masonry(tiles));
  const more = el("details", { class: "settings-more" }, [
    el("summary", { text: "Appearance, connections and advanced settings" }),
    tiles,
  ]);
  more.addEventListener("toggle", () => {
    if (more.open) requestAnimationFrame(() => masonry(tiles));
  });
  return el("div", { class: "view view-config" }, [display, more]);
}

/**
 * Declared Claude config with a usage overlay: bright chips were invoked in
 * recent sessions, dim chips are declared but unused - dead config is visible.
 */
let configMapCache = null;
function configMapCard(app) {
  const body = el("div", { class: "cfgmap" });
  const chip = (name, used, extra = "") =>
    el("span", {
      class: `cfgmap-chip ${used > 0 ? "used" : "dead"} ${extra}`,
      text: used > 0 ? `${name} ×${used}` : name,
      "data-tip":
        used > 0
          ? `${used} call(s) in recent sessions`
          : "no calls in recent sessions",
    });
  const group = (label, items, mapper) =>
    items.length
      ? el("div", { class: "cfgmap-group" }, [
          el("span", { class: "cfgmap-label muted small", text: label }),
          el("div", { class: "cfgmap-chips" }, items.map(mapper)),
        ])
      : null;
  const renderMap = (d) => {
    body.replaceChildren();
    const groups = [
      group("MCP servers", d.mcpServers, (m) => chip(m.name, m.used)),
      group("Skills", d.skills, (k) => chip(k.name, k.used)),
      group("Commands", d.commands, (c) => chip(c.name, c.used)),
      group("Agents", d.agents, (a) => chip(a.name, a.used)),
      group("Rules", d.rules, (r) =>
        el("span", {
          class: "cfgmap-chip rule",
          text: r.scoped ? `${r.name} (scoped)` : r.name,
          "data-tip": r.scoped
            ? "Loads only when matching files are touched"
            : "Loaded every session",
        }),
      ),
      group("Hooks", d.hooks, (h) => chip(`${h.event}`, 1, "hook")),
      d.observedUnknown &&
      (d.observedUnknown.agents.length ||
        d.observedUnknown.commands.length ||
        d.observedUnknown.servers?.length)
        ? group(
            "Used but declared elsewhere (global/user/plugin config)",
            [
              ...d.observedUnknown.agents,
              ...d.observedUnknown.commands,
              ...(d.observedUnknown.servers || []),
            ],
            (name) => chip(name, 1, "external"),
          )
        : null,
    ].filter(Boolean);
    if (!groups.length) {
      body.append(
        emptyState(
          "No Claude config declared in this checkout.",
          "Rules, commands, skills, agents and MCP servers appear here.",
        ),
      );
      return;
    }
    body.append(...groups);
  };
  if (configMapCache) renderMap(configMapCache);
  else
    body.append(
      el("div", { class: "df-running" }, [
        el("span", { class: "spinner-inline" }),
        el("span", { class: "muted small", text: "Mapping config…" }),
      ]),
    );
  app.api
    .configMap()
    .then((d) => {
      configMapCache = d;
      if (body.isConnected) renderMap(d);
    })
    .catch(() => {
      if (body.isConnected && !configMapCache)
        body.replaceChildren(emptyState("Config map unavailable."));
    });
  return card("Config map (usage overlay)", body, {
    help: "Everything this checkout declares to Claude Code, correlated with what recent sessions actually invoked. Bright = used, dim = declared but never called recently; the last group shows calls whose definitions live outside this checkout.",
  });
}

/** Re-open the first-run setup wizard (forge, preferences, a short tour). */
function gettingStartedCard(app) {
  const open = el("button", {
    class: "btn btn-primary",
    text: "Open setup wizard",
  });
  open.addEventListener("click", () => openWizard(app));
  return card("Getting started", [
    el("p", {
      class: "muted small",
      text: "Walk through forge setup, preferences, and a short tour. Safe to run any time.",
    }),
    el("div", { class: "btn-row" }, [open]),
  ]);
}

/** Editable credentials from settings.local.json. Secrets are write-only. */
function credentialsCard(app) {
  const body = el("div", { class: "cred-body" }, [
    el("p", { class: "muted small", text: "Loading…" }),
  ]);
  app.api
    .action("config.read")
    .then((res) => {
      if (res && res.ok) populateCreds(body, res.config, app);
      else
        clear(body).append(
          el("p", { class: "muted small", text: "Could not read config." }),
        );
    })
    .catch(() =>
      clear(body).append(
        el("p", { class: "muted small", text: "Could not read config." }),
      ),
    );
  return card("Credentials & config", body, {
    help: "Edit credentials in .claude/settings.local.json. Secrets are write-only: the panel shows only whether they are set and never sends their value to the browser. A .bak backup is written on save.",
  });
}

function inp(attrs) {
  return /** @type {HTMLInputElement} */ (
    el("input", { class: "input", ...attrs })
  );
}

// Secret fields show a mask when set (so it's clearly set) without the value ever
// leaving the server. Focus clears the mask for editing; leaving it blank restores
// it. secretValue() returns "" while masked, which the server reads as keep-current.
const MASK = "••••••••••••••••";
function applyMask(i, isSet) {
  i.dataset.wasSet = isSet ? "1" : "0";
  i.dataset.masked = isSet ? "1" : "0";
  i.value = isSet ? MASK : "";
}
function secretInput(isSet, placeholder) {
  const i = inp({ type: "password", autocomplete: "off", placeholder });
  i.addEventListener("focus", () => {
    if (i.dataset.masked === "1") {
      i.value = "";
      i.dataset.masked = "0";
    }
  });
  i.addEventListener("blur", () => {
    if (i.value === "" && i.dataset.wasSet === "1") {
      i.value = MASK;
      i.dataset.masked = "1";
    }
  });
  applyMask(i, isSet);
  return i;
}
/** "" while still masked (unchanged) so the server keeps the current secret. */
function secretValue(i) {
  return i.dataset.masked === "1" ? "" : i.value;
}
function credSave(app, body, payload, btn) {
  btn.disabled = true;
  app.api
    .action("config.save", payload)
    .then((res) => {
      if (res && res.ok) {
        app.toast("Saved.", "ok");
        clear(body);
        populateCreds(body, res.config, app);
      } else {
        app.toast((res && res.error) || "Save failed.", "danger");
        btn.disabled = false;
      }
    })
    .catch((e) => {
      app.toast(String((e && e.message) || e), "danger");
      btn.disabled = false;
    });
}
function credSection(title, badge, children) {
  return el("div", { class: "cred-section" }, [
    el("div", { class: "cred-head" }, [el("strong", { text: title }), badge]),
    ...children,
  ]);
}

function populateCreds(body, cfg, app) {
  clear(body).append(
    forgeTokenSection("GitLab", "gitlabToken", cfg.gitlabTokenSet, app, body),
    forgeTokenSection("GitHub", "githubToken", cfg.githubTokenSet, app, body),
  );
}

function forgeTokenSection(label, param, isSet, app, body) {
  const token = secretInput(isSet, "paste token");
  const save = /** @type {HTMLButtonElement} */ (
    el("button", { class: "btn btn-primary", text: "Save" })
  );
  save.addEventListener("click", () =>
    credSave(app, body, { [param]: secretValue(token) }, save),
  );
  return credSection(
    label,
    pill(isSet ? "token set" : "no token", isSet ? "ok" : "neutral"),
    [
      field("Token (write-only)", token, "Blank keeps the current token."),
      el("div", { class: "btn-row" }, [save]),
    ],
  );
}

function formatUptime(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function kvRow(k, v) {
  return el("div", { class: "kv" }, [
    el("span", { class: "k muted small", text: k }),
    el("span", { class: "v mono", text: v }),
  ]);
}

function mbExact(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function toggleRow(app, key, label, hint) {
  const on = Boolean(app.config[key]);
  const sw = el("button", {
    class: `switch ${on ? "on" : ""}`,
    role: "switch",
    type: "button",
    "aria-checked": String(on),
    "aria-label": label,
  });
  sw.addEventListener("click", () => {
    const next = !sw.classList.contains("on");
    sw.classList.toggle("on", next);
    sw.setAttribute("aria-checked", String(next));
    app.config[key] = next;
    app.applyConfig();
    app.toast(`${label}: ${next ? "on" : "off"}.`, "ok");
  });
  return el("div", { class: "setting-row" }, [
    el("div", {}, [
      el("strong", { text: label }),
      el("p", { class: "muted small", text: hint }),
    ]),
    sw,
  ]);
}

/**
 * Like toggleRow, but enabling it first requests OS notification permission and
 * only sticks if the user grants it. Reverts and explains otherwise.
 */
function desktopNotifyRow(app) {
  const supported = typeof Notification !== "undefined";
  const on = Boolean(app.config.desktopNotifications) && supported;
  const sw = el("button", {
    class: `switch ${on ? "on" : ""}`,
    role: "switch",
    type: "button",
    "aria-checked": String(on),
    "aria-label": "Desktop notifications",
    disabled: supported ? null : true,
  });
  const apply = (next) => {
    sw.classList.toggle("on", next);
    sw.setAttribute("aria-checked", String(next));
    app.config.desktopNotifications = next;
    app.applyConfig();
  };
  sw.addEventListener("click", async () => {
    if (!supported) return app.toast("Notifications unsupported here.", "warn");
    const next = !sw.classList.contains("on");
    if (!next) {
      apply(false);
      return app.toast("Desktop notifications: off.", "ok");
    }
    if (Notification.permission === "granted") {
      apply(true);
      return app.toast("Desktop notifications: on.", "ok");
    }
    const perm = await Notification.requestPermission();
    if (perm === "granted") {
      apply(true);
      app.toast("Desktop notifications: on.", "ok");
    } else {
      apply(false);
      app.toast("Notification permission denied by the browser.", "warn");
    }
  });
  return el("div", { class: "setting-row" }, [
    el("div", {}, [
      el("strong", { text: "Desktop notifications" }),
      el("p", {
        class: "muted small",
        text: supported
          ? "OS notification when an agent goes active or a job finishes (needs browser permission)."
          : "This browser context does not support notifications.",
      }),
    ]),
    sw,
  ]);
}

function field(label, node, hint) {
  return el("label", { class: "field" }, [
    el("span", { class: "field-label", text: label }),
    node,
    hint ? el("span", { class: "field-hint", text: hint }) : null,
  ]);
}

function choice(options, value, onChange, name) {
  return el(
    "select",
    { class: "input", name, onChange: (e) => onChange(e.target.value) },
    options.map((o) =>
      el("option", { value: o, selected: o === value ? true : null, text: o }),
    ),
  );
}

function statusRow(label, value, tone) {
  return el("div", { class: "kv" }, [
    el("span", { class: "k", text: label }),
    el("span", { class: "v" }, pill(value, tone)),
  ]);
}

function set(app, key, value) {
  app.config[key] = value;
  app.applyConfig();
  app.toast(`Saved ${key} = ${value}.`, "ok");
}

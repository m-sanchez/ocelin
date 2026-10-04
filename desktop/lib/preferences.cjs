const {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} = require("node:fs");
const { join } = require("node:path");

const defaults = {
  tray: true,
  bar: false,
  dashboard: true,
  alwaysOnTop: true,
  density: "compact",
  barLayout: "sessions",
  barPlacement: "floating",
  historySince: 0,
  taskbarBridge: false,
  taskbarDetail: "allowance",
  taskbarAllowance: "lowest",
  nativeTasks: false,
  motion: "system",
  theme: "system",
  quiet: false,
  completions: false,
  sound: false,
  startup: false,
  automaticUpdates: false,
  showSummary: true,
  showAllowances: false,
  showMemory: false,
  showWorkspace: false,
  showSessionDetails: false,
  showHints: false,
  firstReturnDismissed: false,
  mutedProviders: [],
  mutedProjects: [],
  sources: null,
  accountProfiles: [],
  lastProjectKey: null,
  lastProjectPath: null,
  bounds: {},
};
function validate(input, previous = defaults) {
  const next = { ...previous };
  for (const key of [
    "tray",
    "bar",
    "dashboard",
    "alwaysOnTop",
    "quiet",
    "completions",
    "sound",
    "startup",
    "taskbarBridge",
    "nativeTasks",
    "automaticUpdates",
    "showSummary",
    "showAllowances",
    "showMemory",
    "showWorkspace",
    "showSessionDetails",
    "showHints",
    "firstReturnDismissed",
  ])
    if (typeof input[key] === "boolean") next[key] = input[key];
  for (const [key, values] of Object.entries({
    density: ["compact", "comfortable"],
    barLayout: ["sessions", "summary"],
    barPlacement: ["floating", "taskbar"],
    taskbarDetail: ["allowance", "sessions", "memory"],
    taskbarAllowance: ["lowest", "weekly", "five-hour"],
    motion: ["system", "full", "reduced", "none"],
    theme: ["system", "light", "dark"],
  }))
    if (values.includes(input[key])) next[key] = input[key];
  if (Array.isArray(input.mutedProviders))
    next.mutedProviders = input.mutedProviders.filter((p) =>
      ["codex", "claude"].includes(p),
    );
  if (!next.tray && !next.bar && !next.dashboard) next.dashboard = true;
  if (
    Number.isFinite(input.historySince) &&
    input.historySince >= 0 &&
    input.historySince <= Date.now()
  )
    next.historySince = input.historySince;
  return next;
}
class Preferences {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, "preferences.json");
    let saved = {};
    try {
      saved = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {}
    this.value = {
      ...validate(saved),
      firstReturnDismissed:
        typeof saved.firstReturnDismissed === "boolean"
          ? saved.firstReturnDismissed
          : Object.keys(saved).length > 0,
      sources: Array.isArray(saved.sources) ? saved.sources : null,
      accountProfiles: Array.isArray(saved.accountProfiles)
        ? saved.accountProfiles
        : [],
      lastProjectKey:
        typeof saved.lastProjectKey === "string" ? saved.lastProjectKey : null,
      lastProjectPath:
        typeof saved.lastProjectPath === "string"
          ? saved.lastProjectPath
          : null,
      mutedProjects: Array.isArray(saved.mutedProjects)
        ? saved.mutedProjects
        : [],
      bounds: saved.bounds || {},
    };
  }
  save(patch) {
    this.value = { ...this.value, ...patch };
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.value, null, 2), {
      mode: 0o600,
    });
    renameSync(`${this.file}.tmp`, this.file);
    return this.value;
  }
  update(input) {
    return this.save(validate(input, this.value));
  }
}
function recoverBounds(saved, displays, fallback) {
  const candidate =
    saved &&
    ["x", "y", "width", "height"].every((k) => Number.isFinite(saved[k]))
      ? saved
      : fallback;
  const area = (
    displays.find(
      (d) =>
        candidate.x + candidate.width > d.workArea.x &&
        candidate.x < d.workArea.x + d.workArea.width &&
        candidate.y + candidate.height > d.workArea.y &&
        candidate.y < d.workArea.y + d.workArea.height,
    ) || displays[0]
  ).workArea;
  const width = Math.min(Math.max(candidate.width, 280), area.width);
  const height = Math.min(Math.max(candidate.height, 70), area.height);
  return {
    width,
    height,
    x: Math.max(area.x, Math.min(candidate.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(candidate.y, area.y + area.height - height)),
  };
}
module.exports = { Preferences, validate, recoverBounds, defaults };

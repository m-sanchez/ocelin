const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  protocol,
  net,
  screen,
  nativeImage,
  nativeTheme,
  systemPreferences,
  Notification,
  utilityProcess,
  shell,
  dialog,
  powerMonitor,
  globalShortcut,
} = require("electron");
const { join, resolve, relative, extname, isAbsolute } = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomBytes } = require("node:crypto");
const { readFileSync, mkdirSync, existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { stat, realpath, writeFile } = require("node:fs/promises");
const { createServer } = require("node:net");
const { Worker } = require("node:worker_threads");
const { Preferences, recoverBounds } = require("./lib/preferences.cjs");
const { panelBounds, panelDuration } = require("./lib/panel.cjs");
const { Resources } = require("./lib/resources.cjs");
const { Updates } = require("./lib/updates.cjs");
const {
  TaskbarBridge,
  taskbarSummary,
  widgetSetupArguments,
} = require("./lib/taskbar-bridge.cjs");
const { NativeTasks } = require("./lib/native-tasks.cjs");
const { runtimeCaches, ProcessStops } = require("./lib/doctor.cjs");
const {
  appId,
  iconPath,
  brandWindow,
  installMenu,
  repairWindowsIdentity,
} = require("./lib/branding.cjs");
const {
  sessionLink,
  activation,
  activationUri,
} = require("./lib/session-links.cjs");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "ocelin",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
app.commandLine.appendSwitch("force-renderer-accessibility");
const core = app.isPackaged
  ? join(process.resourcesPath, "core")
  : resolve(__dirname, "..");
const dataDir = resolve(
  process.env.OCELIN_DATA_DIR ||
    join(process.env.LOCALAPPDATA || app.getPath("userData"), "Ocelin"),
);
mkdirSync(dataDir, { recursive: true });
process.chdir(dataDir);
const smokeTest =
  process.argv.includes("--smoke-test") && Boolean(process.env.OCELIN_DATA_DIR);
app.setPath("userData", dataDir);
app.setName("Ocelin");
app.setAppUserModelId(appId);
const preferences = new Preferences(dataDir);
const { accountProfiles, profileSources, profileLabel } = require(
  join(core, "server", "monitor", "profiles.cjs"),
);
const sources = () =>
  profileSources(
    preferences.value.sources ??
      (process.env.OCELIN_SOURCES
        ? JSON.parse(process.env.OCELIN_SOURCES)
        : null),
    preferences.value.accountProfiles,
  );
const { sourceKind } = require(join(core, "server/monitor/source-path.cjs"));
const taskbarBridge = new TaskbarBridge(dataDir);
const nativeTasks = new NativeTasks(
  dataDir,
  join(
    app.isPackaged ? process.resourcesPath : __dirname,
    "native",
    "activate.ps1",
  ),
  () => publish(),
);
let library,
  libraryIdleTimer,
  librarySequence = 0,
  hiddenKeys = new Set(),
  connections = {};
const libraryRequests = new Map();
const windows = new Map();
let tray,
  monitor,
  integrations,
  quitting = false,
  project = null,
  sequence = 0,
  projectOpening = false;
let snapshot = {
  sessions: [],
  counts: { running: 0, attention: 0, unseen: 0 },
  diagnostics: [],
  metrics: {},
};
let error = null;
const resources = new Resources(() => publish());
let updatePublisher = null;
try {
  updatePublisher = JSON.parse(
    readFileSync(join(__dirname, "assets/update-policy.json"), "utf8"),
  ).publisher;
} catch {}
const updates = new Updates({
  updater:
    app.isPackaged && !smokeTest && updatePublisher
      ? require("electron-updater").autoUpdater
      : null,
  publisher: app.isPackaged && !smokeTest ? updatePublisher : null,
  onChange: () => publish(),
});
const processStops = new ProcessStops({
  sample: () => resources.value,
  sessions: () => snapshot.sessions,
});
let doctorBusy = false;
const requests = new Map();
const icon = () =>
  nativeImage.createFromPath(join(__dirname, "assets", "ocelin.png"));
const state = () => {
  const value = {
    ...snapshot,
    sessions: snapshot.sessions.filter(
      (s) => Date.now() - s.lastTs < 86400000 || !s.stale,
    ),
    preferences: preferences.value,
    accountProfiles: accountProfiles(preferences.value.accountProfiles),
    error,
    version: app.getVersion(),
    packaged: app.isPackaged,
    resources: resources.value,
    updates: updates.value,
    taskbarTheme: nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
      ? "dark"
      : "light",
    reducedMotion:
      systemPreferences.getAnimationSettings().prefersReducedMotion,
    nativeTasks: nativeTasks.value,
    connections,
    hiddenKeys: [...hiddenKeys],
  };
  return { ...value, statusSummary: taskbarSummary(value, true) };
};
function publish() {
  const needsResources =
    !quitting &&
    ([...windows.values()].some(
      (window) => !window.isDestroyed() && window.isVisible(),
    ) ||
      (project?.window &&
        !project.window.isDestroyed() &&
        project.window.isVisible()) ||
      (preferences.value.taskbarBridge &&
        preferences.value.taskbarDetail === "memory") ||
      preferences.value.nativeTasks);
  if (needsResources) resources.start();
  else if (resources.active) resources.stop();
  taskbarBridge.publish(state(), preferences.value.taskbarBridge);
  nativeTasks.publish(state(), preferences.value.nativeTasks);
  library?.postMessage({ type: "snapshot", sessions: snapshot.sessions });
  for (const window of windows.values())
    if (!window.isDestroyed()) window.webContents.send("ocelin:state", state());
  if (tray)
    tray.setToolTip(
      `Ocelin · ${state().statusSummary.headline} · ${state().statusSummary.detail}`,
    );
  if (project) project.worker.postMessage({ type: "snapshot", snapshot });
  const dashboard = windows.get("dashboard");
  if (dashboard && !dashboard.isDestroyed()) {
    dashboard.setOverlayIcon(
      snapshot.counts.attention ? icon() : null,
      `${snapshot.counts.attention} sessions need you`,
    );
    dashboard.setProgressBar(snapshot.counts.running ? 2 : -1);
  }
}
function libraryRequest(type, args = {}) {
  clearTimeout(libraryIdleTimer);
  if (!library) {
    library = backgroundWorker(join(core, "server", "library", "worker.mjs"), {
      env: {
        ...process.env,
        OCELIN_DATA_DIR: dataDir,
        OCELIN_SOURCES: JSON.stringify(sources()),
        OCELIN_ACCOUNT_PROFILES: JSON.stringify(
          preferences.value.accountProfiles,
        ),
      },
      name: "Ocelin session library",
    });
    library.postMessage({ type: "snapshot", sessions: snapshot.sessions });
    library.on("message", (message) => {
      const pending = libraryRequests.get(message.id);
      if (!pending) return;
      libraryRequests.delete(message.id);
      clearTimeout(pending.timeout);
      message.error
        ? pending.reject(new Error(message.error))
        : pending.resolve(message.value);
      if (!libraryRequests.size) {
        const current = library;
        libraryIdleTimer = setTimeout(() => {
          if (library === current && !libraryRequests.size)
            library?.postMessage({ type: "stop" });
        }, 60000);
        libraryIdleTimer.unref();
      }
    });
    library.on("exit", () => {
      library = null;
      for (const pending of libraryRequests.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Session library stopped; try again"));
      }
      libraryRequests.clear();
    });
  }
  return new Promise((resolve, reject) => {
    const id = ++librarySequence;
    const timeout =
      type === "apply" || type === "plan" || type === "doctor"
        ? null
        : setTimeout(() => {
            libraryRequests.delete(id);
            reject(
              new Error(
                "The session library is still indexing. Try again shortly.",
              ),
            );
          }, 60000);
    libraryRequests.set(id, { resolve, reject, timeout });
    library.postMessage({ id, type, args });
  });
}
async function openSession(key) {
  const session =
    snapshot.sessions.find((s) => s.key === key) ||
    (await libraryRequest("target", { key }));
  const url = sessionLink(session);
  if (process.argv.includes("--smoke-test") && process.env.OCELIN_DATA_DIR)
    return { url };
  try {
    await shell.openExternal(url);
  } catch {
    throw new Error(
      `Windows could not open ${session.provider === "codex" ? "Codex" : "Claude"}. Install its Desktop app and try again.`,
    );
  }
  return { opened: true, provider: session.provider };
}
async function activate(args) {
  const route = args.map(activation).find(Boolean);
  if (route?.type === "panel") {
    showWindow("tray");
    return;
  }
  if (route?.type === "session") {
    try {
      await openSession(route.key);
      return;
    } catch (e) {
      error = e.message;
      publish();
    }
  }
  showWindow("dashboard");
}
async function refreshConnections() {
  const { detectProviderApps } = require("./lib/provider-apps.cjs");
  const installed = await detectProviderApps();
  for (const provider of ["codex", "claude"]) {
    let owned = [];
    let configured = [];
    try {
      owned = JSON.parse(
        readFileSync(
          join(dataDir, "hooks", `${provider}-ownership.json`),
          "utf8",
        ),
      );
    } catch {}
    try {
      const config = JSON.parse(
        readFileSync(
          join(
            integrations.homes[provider],
            provider === "codex" ? "hooks.json" : "settings.json",
          ),
          "utf8",
        ),
      );
      configured = Object.values(config.hooks || {}).flatMap((groups) =>
        Array.isArray(groups)
          ? groups.flatMap((g) => (g.hooks || []).map((h) => h.command))
          : [],
      );
    } catch {}
    connections[provider] = {
      nativeOpen: Boolean(
        installed[provider] ||
          app.getApplicationNameForProtocol(`${provider}://`),
      ),
      hooksInstalled: owned.some((command) => configured.includes(command)),
      lastHookAt:
        snapshot.diagnostics.find((d) => d.provider === provider)?.lastHookAt ||
        0,
    };
  }
  publish();
}
function request(type, args = {}) {
  return new Promise((resolveRequest, reject) => {
    if (!monitor) return reject(new Error("Monitor is unavailable"));
    const id = ++sequence;
    const timeout = setTimeout(() => {
      requests.delete(id);
      reject(new Error("Monitor is still loading; try again"));
    }, 30000);
    requests.set(id, { resolve: resolveRequest, reject, timeout });
    monitor.postMessage({ id, type, ...args });
  });
}
function startMonitor() {
  monitor = backgroundWorker(join(core, "server", "monitor", "worker.mjs"), {
    env: {
      ...process.env,
      OCELIN_DATA_DIR: dataDir,
      ...(smokeTest ? { OCELIN_SMOKE_TEST: "1" } : {}),
      OCELIN_SOURCES: JSON.stringify(sources()),
      OCELIN_ACCOUNT_PROFILES: JSON.stringify(
        preferences.value.accountProfiles,
      ),
    },
    name: "Ocelin session monitor",
  });
  monitor.postMessage({ type: "preferences", value: preferences.value });
  monitor.stderr.on("data", (chunk) => {
    error = `Monitor: ${String(chunk).slice(0, 300)}`;
    publish();
  });
  monitor.on("message", (message) => {
    if (message.type === "snapshot") {
      snapshot = message.snapshot;
      error = null;
      publish();
    }
    if (message.type === "error") {
      error = message.message;
      publish();
    }
    if (message.type === "reply") {
      const pending = requests.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        requests.delete(message.id);
        message.error
          ? pending.reject(new Error(message.error))
          : pending.resolve(message.value);
      }
    }
    if (
      !smokeTest &&
      message.type === "notification" &&
      Notification.isSupported()
    ) {
      const s = message.session;
      const toast = new Notification({
        title: `Ocelin · ${s.provider === "codex" ? "Codex" : "Claude"}`,
        body: `${s.title}: ${s.label}`,
        icon: icon(),
        silent: !preferences.value.sound,
      });
      toast.on("click", () => {
        openSession(s.key).catch((e) => {
          error = e.message;
          showWindow("dashboard");
          publish();
        });
      });
      toast.show();
    }
  });
  monitor.on("exit", () => {
    monitor = null;
    for (const pending of requests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Monitor restarted"));
    }
    requests.clear();
    if (!quitting) {
      error = "Monitor restarting";
      publish();
      setTimeout(startMonitor, 3000);
    }
  });
}
function backgroundWorker(file, options) {
  const worker = new Worker(file, { ...options, stdout: true, stderr: true });
  worker.kill = () => {
    void worker.terminate();
  };
  worker.on("error", (failure) => {
    error = `${options.name}: ${failure.message}`;
    publish();
  });
  return worker;
}
function secure(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("ocelin://app/")) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.session.setPermissionRequestHandler(
    (_wc, _permission, done) => done(false),
  );
}
function createWindow(kind) {
  const work = screen.getPrimaryDisplay().workArea;
  const fallback =
    kind === "bar"
      ? {
          x: work.x + 120,
          y: work.y + 24,
          width: Math.min(850, work.width),
          height: 96,
        }
      : {
          x: work.x + 60,
          y: work.y + 60,
          width: Math.min(1120, work.width),
          height: Math.min(800, work.height),
        };
  const window = new BrowserWindow({
    ...(kind === "tray"
      ? panelBounds(
          screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
        )
      : recoverBounds(
          preferences.value.bounds[kind],
          screen.getAllDisplays(),
          fallback,
        )),
    title: "Ocelin",
    icon: iconPath,
    show: false,
    frame: kind === "dashboard",
    resizable: kind !== "tray",
    movable: kind !== "tray",
    minWidth: kind === "tray" ? 0 : kind === "bar" ? 280 : 320,
    minHeight: kind === "tray" ? 0 : kind === "bar" ? 62 : 360,
    skipTaskbar: kind !== "dashboard",
    alwaysOnTop:
      kind === "tray" ||
      (kind !== "dashboard" && preferences.value.alwaysOnTop),
    transparent: kind === "tray",
    backgroundColor: kind === "tray" ? "#00000000" : "#171a19",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  brandWindow(window);
  windows.set(kind, window);
  window.ocelinSurface = kind;
  window.once("closed", () => {
    if (windows.get(kind) === window) windows.delete(kind);
  });
  secure(window);
  window.webContents.on("console-message", (details) => {
    if (details?.level === "error")
      console.error(`${kind}: ${details.message}`);
  });
  window.webContents.on("did-finish-load", () =>
    console.log(`Ocelin ${kind} ready`),
  );
  window
    .loadURL(`ocelin://app/desktop/renderer/index.html?surface=${kind}`)
    .catch((e) => {
      error = `${kind}: ${e.message}`;
      publish();
    });
  window.once("ready-to-show", () => {
    if (window.ocelinVisible && kind !== "tray") presentWindow(window);
  });
  let saveTimer;
  const saveBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!window.isDestroyed())
        preferences.save({
          bounds: { ...preferences.value.bounds, [kind]: window.getBounds() },
        });
    }, 300);
  };
  if (kind !== "tray") {
    window.on("move", saveBounds);
    window.on("resize", saveBounds);
  }
  if (kind === "bar")
    window.on("will-move", () => {
      if (preferences.value.barPlacement === "taskbar") {
        preferences.update({ barPlacement: "floating" });
        publish();
      }
    });
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (kind === "bar") {
      dismissBar();
      return;
    }
    if (kind === "tray") {
      hideWindow(window);
      return;
    }
    if (
      tray ||
      [...windows.values()].some((w) => w !== window && w.isVisible())
    )
      hideWindow(window);
    else showWindow("dashboard");
  });
  if (kind === "tray") {
    window.on("blur", () => {
      clearTimeout(window.ocelinBlur);
      window.ocelinBlur = setTimeout(() => {
        if (!window.isDestroyed() && !window.isFocused()) hideWindow(window);
      }, 120);
    });
    window.on("focus", () => clearTimeout(window.ocelinBlur));
    window.on("closed", () => clearTimeout(window.ocelinBlur));
  }
  return window;
}
function dismissBar() {
  preferences.update({ bar: false });
  hideWindow(windows.get("bar"));
  if (!tray && ![...windows.values()].some((window) => window.isVisible()))
    showWindow("dashboard");
  publish();
}
function hideWindow(window) {
  if (!window || window.isDestroyed()) return;
  clearTimeout(window.ocelinBlur);
  window.ocelinVisible = false;
  if (window.ocelinSurface === "tray")
    window.webContents.send("ocelin:panel-open", {
      visible: false,
      duration: 0,
    });
  window.hide();
  clearTimeout(window.ocelinSleep);
  window.ocelinSleep = setTimeout(() => {
    if (!window.isDestroyed() && !window.isVisible()) window.destroy();
  }, 30000);
  window.ocelinSleep.unref();
}
function presentWindow(window) {
  const opening = !window.isVisible();
  window.ocelinFocus ? window.show() : window.showInactive();
  if (opening && window.ocelinSurface === "tray")
    window.webContents.send("ocelin:panel-open", {
      visible: true,
      duration: panelDuration(
        preferences.value.motion,
        systemPreferences.getAnimationSettings().prefersReducedMotion,
      ),
    });
  if (window.ocelinFocus) window.focus();
}
function showWindow(kind, focus = true) {
  const window = windows.get(kind) || createWindow(kind);
  clearTimeout(window.ocelinSleep);
  clearTimeout(window.ocelinBlur);
  window.ocelinVisible = true;
  window.ocelinFocus = focus;
  if (kind === "tray")
    window.setBounds(
      panelBounds(
        screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
      ),
    );
  if (kind === "tray" ? window.ocelinReady : !window.webContents.isLoading())
    presentWindow(window);
}
function applySurfaces({ panelLaunch = false } = {}) {
  if (preferences.value.tray && !tray) {
    tray = new Tray(icon());
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Ocelin", click: () => showWindow("dashboard") },
        { label: "Session panel", click: () => showWindow("tray") },
        {
          label: "Toggle floating bar",
          click: () => {
            preferences.update({ bar: !preferences.value.bar });
            applySurfaces();
            publish();
          },
        },
        { type: "separator" },
        { label: "Quit Ocelin", click: () => app.quit() },
      ]),
    );
    tray.on("click", () => {
      const panel = windows.get("tray");
      panel?.isVisible() ? hideWindow(panel) : showWindow("tray");
    });
    tray.on("double-click", () => showWindow("dashboard"));
  } else if (!preferences.value.tray && tray) {
    tray.destroy();
    tray = null;
    hideWindow(windows.get("tray"));
  }
  for (const kind of ["bar", "dashboard"]) {
    if (kind === "dashboard" && panelLaunch) continue;
    if (preferences.value[kind]) showWindow(kind, false);
    else hideWindow(windows.get(kind));
  }
  windows.get("bar")?.setAlwaysOnTop(preferences.value.alwaysOnTop);
  placeBar();
  nativeTheme.themeSource = preferences.value.theme;
  monitor?.postMessage({ type: "preferences", value: preferences.value });
  publish();
}
function placeBar() {
  const bar = windows.get("bar");
  if (!bar) return;
  const p = preferences.value;
  if (bar.ocelinLayout !== p.barLayout) {
    const area = screen.getDisplayMatching(bar.getBounds()).workArea;
    bar.setSize(
      Math.min(p.barLayout === "summary" ? 340 : 860, area.width),
      p.barLayout === "summary" ? 64 : 76,
    );
    bar.setBounds(
      recoverBounds(bar.getBounds(), screen.getAllDisplays(), bar.getBounds()),
    );
    bar.ocelinLayout = p.barLayout;
  }
  if (p.barPlacement === "taskbar") {
    const area = screen.getDisplayMatching(bar.getBounds()).workArea;
    const bounds = bar.getBounds();
    bar.setBounds({
      x: area.x + 10,
      y: area.y + area.height - bounds.height - 8,
      width: Math.min(bounds.width, area.width - 20),
      height: bounds.height,
    });
  }
  bar.setMovable(true);
}
async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
}
async function closeProject() {
  if (!project) return;
  const old = project;
  project = null;
  if (!old.window.isDestroyed()) old.window.destroy();
  old.worker.postMessage({ type: "stop" });
  setTimeout(() => old.worker.kill(), 2000).unref();
}
async function openProject(key, overview = false, directory = null) {
  const target = directory
    ? { cwd: directory }
    : await request("target", { key });
  const cwd = await realpath(target.cwd);
  if (/^[/\\]{2}/.test(cwd) || !(await stat(cwd)).isDirectory())
    throw new Error("Project directory is unavailable");
  preferences.save({ lastProjectKey: key || null, lastProjectPath: cwd });
  await closeProject();
  const port = await freePort();
  const nonce = randomBytes(24).toString("hex");
  const runtime = join(dataDir, "dashboard", nonce);
  mkdirSync(runtime, { recursive: true });
  const worker = utilityProcess.fork(
    join(core, "server", "monitor", "dashboard-worker.mjs"),
    [],
    {
      cwd,
      serviceName: "Ocelin project dashboard",
      stdio: "pipe",
      env: {
        ...process.env,
        PANEL_CHECKOUT_ROOT: cwd,
        PANEL_REPO_ROOT: cwd,
        PANEL_CHECKOUT_ID: "ocelin-desktop",
        PANEL_RUNTIME_DIR: runtime,
        OCELIN_DATA_DIR: dataDir,
        PANEL_SERVICE_PORT: String(port),
        PANEL_NONCE: nonce,
      },
    },
  );
  worker.postMessage({ type: "snapshot", snapshot });
  const window = new BrowserWindow({
    width: 1200,
    height: 850,
    title: "Ocelin",
    icon: iconPath,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  brandWindow(window);
  project = { worker, window, cwd, port, nonce };
  window.once("closed", () => {
    if (project?.window === window) void closeProject();
  });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      hideWindow(window);
      showWindow("dashboard");
    }
  });
  const origin = `http://127.0.0.1:${port}`;
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const link = new URL(url);
      if (
        link.protocol === "https:" &&
        ["github.com", "gitlab.com"].includes(link.hostname)
      )
        void shell.openExternal(link.href);
    } catch {}
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  let ready = false;
  for (let tries = 0; tries < 150; tries++) {
    try {
      const health = await (await net.fetch(`${origin}/health`)).json();
      if (health.nonce === nonce) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((done) => setTimeout(done, 200));
  }
  if (!ready) {
    await closeProject();
    throw new Error("Project dashboard did not become ready");
  }
  const token = readFileSync(join(runtime, "panel.token"), "utf8").trim();
  await window.loadURL(
    overview
      ? `${origin}/?desktop=1#token=${token}&/overview`
      : `${origin}/?desktop=1&provider=${target.provider}&session=${encodeURIComponent(target.sessionId)}#token=${token}&/activity/session`,
  );
  window.show();
  return true;
}
function trusted(event) {
  return (
    [...windows.values()].some(
      (w) =>
        !w.isDestroyed() &&
        w.webContents === event.sender &&
        event.senderFrame === w.webContents.mainFrame,
    ) && event.senderFrame.url.startsWith("ocelin://app/desktop/renderer/")
  );
}
async function action(name, args = {}) {
  if (name === "update-check") return updates.check();
  if (name === "update-download") return updates.download();
  if (name === "update-install") {
    updates.install();
    return true;
  }
  if (name === "update-releases") {
    await shell.openExternal("https://github.com/m-sanchez/ocelin/releases");
    return true;
  }
  if (
    name === "doctor-report" ||
    name === "doctor-tidy" ||
    name === "doctor-undo"
  ) {
    if (doctorBusy) throw new Error("Doctor is already working.");
    doctorBusy = true;
    try {
      const operation = name.slice(7);
      const report = await libraryRequest("doctor", {
        operation,
        olderDays: args.olderDays ?? 30,
      });
      hiddenKeys = new Set(report.hiddenKeys);
      const activeDir = project
        ? join(dataDir, "dashboard", project.nonce)
        : null;
      const caches = await runtimeCaches(
        dataDir,
        activeDir,
        Date.now(),
        operation === "tidy",
      );
      publish();
      return {
        ...report,
        caches,
        workspaceOpen: Boolean(project),
        resources: resources.value,
      };
    } finally {
      doctorBusy = false;
    }
  }
  if (name === "doctor-stop-plan") return processStops.plan(args.provider);
  if (name === "doctor-stop-apply") {
    if (smokeTest)
      throw new Error("Live process stopping is disabled in UI fixtures.");
    return processStops.apply(args.id);
  }
  if (name === "doctor-release") {
    if (projectOpening || libraryRequests.size)
      throw new Error(
        "Ocelin is busy. Try again when the current operation finishes.",
      );
    await closeProject();
    if (library) library.postMessage({ type: "stop" });
    for (const [kind, window] of windows)
      if (!window.isDestroyed() && !window.isVisible()) {
        window.destroy();
        windows.delete(kind);
      }
    publish();
    return true;
  }
  if (name === "install-widget") {
    const destination = join(dataDir, "integrations", "Ocelin.twidget");
    mkdirSync(join(dataDir, "integrations"), { recursive: true });
    await writeFile(
      destination,
      readFileSync(join(__dirname, "integrations", "Ocelin.twidget")),
    );
    const roots = [
      join(process.env.LOCALAPPDATA || "", "Programs", "TaskbarWidgets"),
      join(process.env.LOCALAPPDATA || "", "TaskbarWidgets"),
      join(process.env.ProgramFiles || "", "TaskbarWidgets"),
    ];
    const host = roots
      .map((root) => join(root, "TaskbarWidgets.exe"))
      .find(existsSync);
    if (host) {
      const bundled = JSON.parse(
        readFileSync(
          join(__dirname, "integrations", "taskbar-widgets", "widget.json"),
          "utf8",
        ),
      );
      let installed;
      if (process.env.LOCALAPPDATA) {
        try {
          installed = JSON.parse(
            readFileSync(
              join(
                process.env.LOCALAPPDATA,
                "TaskbarWidgets",
                "CommunityWidgets",
                bundled.id,
                "widget.json",
              ),
              "utf8",
            ),
          );
        } catch {}
      }
      for (const hostArgs of [
        ["--no-update-check"],
        widgetSetupArguments(installed, bundled, destination),
      ]) {
        const child = spawn(host, hostArgs, {
          windowsHide: true,
          detached: true,
          stdio: "ignore",
        });
        await new Promise((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        child.unref();
      }
      return true;
    }
    const failure = await shell.openPath(destination);
    if (failure)
      throw new Error(
        "Install Taskbar Widgets first, then use Connect taskbar strip to review the Ocelin package.",
      );
    return true;
  }
  if (name === "session-open") return openSession(args.key);
  if (name === "session-preview")
    return libraryRequest("preview", {
      key: args.key,
      hint: snapshot.sessions.find((s) => s.key === args.key),
    });
  if (name === "library-query") return libraryRequest("query", args);
  if (name === "library-plan") return libraryRequest("plan", args);
  if (name === "library-apply") {
    const result = await libraryRequest("apply", args);
    hiddenKeys = new Set(result.hiddenKeys);
    publish();
    return result;
  }
  if (name === "connections") {
    await refreshConnections();
    return connections;
  }
  if (name === "taskbar-guide") {
    await shell.openExternal(
      "https://github.com/m-sanchez/ocelin/blob/main/desktop/integrations/taskbar-widgets/README.md",
    );
    return true;
  }
  if (name === "export-widget") {
    const selected = await dialog.showSaveDialog({
      title: "Save Ocelin taskbar widget",
      defaultPath: "Ocelin.twidget",
      filters: [{ name: "Taskbar Widgets package", extensions: ["twidget"] }],
    });
    if (selected.canceled) return false;
    await writeFile(
      selected.filePath,
      readFileSync(join(__dirname, "integrations", "Ocelin.twidget")),
    );
    return true;
  }
  if (name === "preferences") {
    const previousUpdates = preferences.value.automaticUpdates;
    const previousStartup = preferences.value.startup;
    const previousNative = preferences.value.nativeTasks;
    preferences.update(args);
    if (previousUpdates !== preferences.value.automaticUpdates)
      updates.configure(preferences.value.automaticUpdates);
    if (!previousNative && preferences.value.nativeTasks)
      nativeTasks.lastLaunch = 0;
    if (preferences.value.startup !== previousStartup) {
      if (!app.isPackaged) {
        preferences.save({ startup: false });
        throw new Error("Sign-in startup is available after installing Ocelin");
      }
      app.setLoginItemSettings({
        openAtLogin: preferences.value.startup,
        path: process.execPath,
        args: ["--background"],
      });
    }
    applySurfaces();
    return state();
  }
  if (name === "acknowledge") return request("acknowledge", { key: args.key });
  if (["project", "workspace", "workspace-choose"].includes(name)) {
    if (projectOpening)
      throw new Error("A project is opening; try again when it is ready");
    projectOpening = true;
    try {
      if (name === "workspace-choose") {
        const chosen = await dialog.showOpenDialog({
          title: "Choose a project for the full workspace",
          properties: ["openDirectory"],
        });
        if (chosen.canceled) return false;
        return await openProject(null, true, chosen.filePaths[0]);
      }
      const directory =
        name === "workspace" && args.key === "last"
          ? preferences.value.lastProjectPath
          : null;
      return await openProject(args.key, name === "workspace", directory);
    } finally {
      projectOpening = false;
    }
  }
  if (name === "folder") {
    const target = await request("target", { key: args.key });
    const path = await realpath(target.cwd);
    if (/^[/\\]{2}/.test(path) || !(await stat(path)).isDirectory())
      throw new Error("Project directory is unavailable");
    const failure = await shell.openPath(path);
    if (failure) throw new Error(failure);
    return true;
  }
  if (name === "mute-project") {
    const target = await request("target", { key: args.key });
    const set = new Set(preferences.value.mutedProjects);
    set.has(target.cwd) ? set.delete(target.cwd) : set.add(target.cwd);
    preferences.save({ mutedProjects: [...set] });
    monitor.postMessage({ type: "preferences", value: preferences.value });
    publish();
    return true;
  }
  if (name === "refresh") return request("refresh");
  if (name === "show" && ["dashboard", "bar", "tray"].includes(args.surface)) {
    showWindow(args.surface);
    return true;
  }
  if (name === "hide") {
    if (args.surface === "tray") {
      hideWindow(windows.get("tray"));
      return true;
    }
    if (args.surface === "bar") {
      dismissBar();
      return true;
    }
    const window = windows.get(args.surface);
    if (
      window &&
      (tray || [...windows.values()].some((w) => w !== window && w.isVisible()))
    )
      hideWindow(window);
    else showWindow("dashboard");
    return true;
  }
  if (name === "source" && ["claude", "codex"].includes(args.provider)) {
    const result = await dialog.showOpenDialog({
      title: `Select ${args.provider === "codex" ? "Codex sessions" : "Claude projects"} directory`,
      properties: ["openDirectory"],
    });
    if (result.canceled) return false;
    const { defaultSources } = await import(
      pathToFileURL(join(core, "server/monitor/collector.mjs")).href
    );
    const sources = preferences.value.sources || defaultSources();
    const root = await realpath(result.filePaths[0]);
    if (!sourceKind(root))
      throw new Error(
        "Choose a local or WSL source folder. Mirror remote transcripts locally first.",
      );
    if (!sources.some((s) => s.provider === args.provider && s.root === root))
      sources.push({
        provider: args.provider,
        root,
        kind: args.mirror === true ? "mirror" : sourceKind(root),
      });
    preferences.save({ sources });
    await request("sources", {
      value: profileSources(sources, preferences.value.accountProfiles),
    });
    library?.postMessage({ type: "stop" });
    publish();
    return true;
  }
  if (
    name === "account-profile-add" &&
    ["codex", "claude"].includes(args.provider)
  ) {
    const result = await dialog.showOpenDialog({
      title: `Select the ${args.provider === "codex" ? "Codex home" : "Claude configuration"} folder for this account`,
      properties: ["openDirectory"],
    });
    if (result.canceled) return false;
    const home = await realpath(result.filePaths[0]);
    if (/^[/\\]{2}/.test(home))
      throw new Error("Choose a local profile folder.");
    const items = accountProfiles(preferences.value.accountProfiles);
    const candidate = accountProfiles([
      { provider: args.provider, home, label: args.label },
    ]).find((p) => !p.builtin);
    if (!candidate || items.some((p) => p.id === candidate.id))
      throw new Error("That profile is already connected.");
    if (items.length >= 10)
      throw new Error("Up to eight additional profiles can be connected.");
    const marker = args.provider === "codex" ? "sessions" : "projects";
    const credential =
      args.provider === "codex" ? "auth.json" : ".credentials.json";
    if (
      !existsSync(join(home, marker)) &&
      !existsSync(join(home, credential)) &&
      !existsSync(join(home, "config.toml"))
    )
      throw new Error(
        `Choose the profile folder containing ${marker} or ${credential}.`,
      );
    preferences.save({
      accountProfiles: [...items.filter((p) => !p.builtin), candidate],
    });
    await request("profiles", {
      profiles: preferences.value.accountProfiles,
      sources: sources(),
    });
    library?.postMessage({ type: "stop" });
    publish();
    return true;
  }
  if (["account-profile-remove", "account-profile-rename"].includes(name)) {
    const profiles = accountProfiles(preferences.value.accountProfiles).filter(
      (p) => !p.builtin,
    );
    if (!profiles.some((p) => p.id === args.id))
      throw new Error("Unknown account profile.");
    const next =
      name === "account-profile-remove"
        ? profiles.filter((p) => p.id !== args.id)
        : profiles.map((p) =>
            p.id === args.id
              ? { ...p, label: profileLabel(args.label, p.label) }
              : p,
          );
    preferences.save({ accountProfiles: next });
    await request("profiles", { profiles: next, sources: sources() });
    library?.postMessage({ type: "stop" });
    publish();
    return true;
  }
  if (name === "hook-preview")
    return integrations.preview(args.provider, args.remove === true);
  if (name === "hook-apply") {
    const result = await integrations.apply(args.id);
    await refreshConnections();
    return result;
  }
  if (name === "quit") {
    app.quit();
    return true;
  }
  throw new Error("Unknown Ocelin action");
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    void activate(argv);
  });
  app.on("window-all-closed", () => {});
  app.on("activate", () => showWindow("dashboard"));
  app.on("before-quit", () => {
    quitting = true;
    resources.stop();
    updates.stop();
    globalShortcut.unregisterAll();
    taskbarBridge.publish(state(), false);
    nativeTasks.publish(state(), false);
    monitor?.postMessage({ type: "stop" });
    library?.postMessage({ type: "stop" });
    if (project) project.worker.postMessage({ type: "stop" });
    setTimeout(() => {
      monitor?.kill();
      library?.kill();
      project?.worker.kill();
    }, 2000).unref();
    tray?.destroy();
    tray = null;
  });
  app
    .whenReady()
    .then(async () => {
      if (!smokeTest) repairWindowsIdentity(dataDir);
      installMenu(showWindow);
      protocol.handle("ocelin", async (request) => {
        const url = new URL(request.url);
        if (url.hostname !== "app" || request.method !== "GET")
          return new Response("Forbidden", { status: 403 });
        const route = decodeURIComponent(url.pathname);
        if (route.startsWith("/vendor/")) {
          const name = route.slice("/vendor/".length);
          if (
            !["codex-dark.png", "codex-light.png", "claude.svg"].includes(name)
          )
            return new Response("Not found", { status: 404 });
          return net.fetch(
            pathToFileURL(join(__dirname, "renderer", "vendor", name)).href,
          );
        }
        const base = route.startsWith("/ui/")
          ? join(core, "ui")
          : route.startsWith("/desktop/renderer/")
            ? join(__dirname, "renderer")
            : null;
        if (!base) return new Response("Not found", { status: 404 });
        const path = resolve(
          base,
          route.replace(/^\/(ui|desktop\/renderer)\//, ""),
        );
        if (
          relative(base, path).startsWith("..") ||
          isAbsolute(relative(base, path)) ||
          ![".html", ".mjs", ".css", ".svg", ".png"].includes(extname(path))
        )
          return new Response("Forbidden", { status: 403 });
        return net.fetch(pathToFileURL(path).href);
      });
      const { Integrations } = await import(
        pathToFileURL(join(core, "server/monitor/integrations.mjs")).href
      );
      integrations = new Integrations({
        dataDir,
        runtime: process.execPath,
        captureFile: join(core, "hooks", "ocelin-capture.cjs"),
      });
      try {
        hiddenKeys = new Set(
          Object.keys(
            JSON.parse(
              readFileSync(join(dataDir, "library-hidden.json"), "utf8"),
            ),
          ),
        );
      } catch {}
      if (app.isPackaged && !smokeTest) {
        app.setAsDefaultProtocolClient("ocelin");
        app.setJumpList([
          {
            type: "tasks",
            items: [
              {
                type: "task",
                title: "Open Ocelin",
                description: "Codex and Claude sessions",
                program: process.execPath,
                args: "ocelin://dashboard",
                iconPath: process.execPath,
                iconIndex: 0,
              },
            ],
          },
        ]);
      }
      ipcMain.handle("ocelin:state", (event) => {
        if (!trusted(event)) throw new Error("Untrusted sender");
        return state();
      });
      ipcMain.on("ocelin:panel-ready", (event) => {
        const panel = windows.get("tray");
        if (!trusted(event) || panel?.webContents !== event.sender) return;
        panel.ocelinReady = true;
        if (panel.ocelinVisible) presentWindow(panel);
      });
      ipcMain.handle("ocelin:action", (event, name, args) => {
        if (
          !trusted(event) ||
          typeof name !== "string" ||
          (args != null && (typeof args !== "object" || Array.isArray(args))) ||
          JSON.stringify(args || {}).length > 8192
        )
          throw new Error("Invalid request");
        return action(name, args);
      });
      startMonitor();
      resources.start();
      updates.configure(preferences.value.automaticUpdates);
      applySurfaces({
        panelLaunch: process.argv.some(
          (value) => activation(value)?.type === "panel",
        ),
      });
      await refreshConnections();
      globalShortcut.register("CommandOrControl+Alt+O", () =>
        showWindow("tray"),
      );
      if (process.argv.some((value) => activation(value)))
        void activate(process.argv);
      if (
        process.argv.includes("--background") &&
        (preferences.value.tray || preferences.value.bar)
      )
        hideWindow(windows.get("dashboard"));
      const recover = () => {
        for (const w of windows.values()) {
          if (w.ocelinSurface === "tray") {
            w.setBounds(
              panelBounds(screen.getDisplayMatching(w.getBounds()).workArea),
            );
            continue;
          }
          w.setBounds(
            recoverBounds(
              w.getBounds(),
              screen.getAllDisplays(),
              w.getBounds(),
            ),
          );
        }
        placeBar();
      };
      screen.on("display-removed", recover);
      screen.on("display-metrics-changed", recover);
      powerMonitor.on("resume", () => {
        request("refresh").catch(() => {});
        recover();
      });
      if (
        process.argv.includes("--smoke-test") &&
        process.env.OCELIN_DATA_DIR
      ) {
        void require("./smoke.cjs")({
          app,
          windows,
          action,
          activate,
          getState: state,
          getProject: () => project,
          dataDir,
          core,
        });
      }
    })
    .catch((e) => {
      dialog.showErrorBox("Ocelin could not start", e.message);
      app.quit();
    });
}

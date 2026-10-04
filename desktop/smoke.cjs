const assert = require("node:assert/strict");
const {
  writeFileSync,
  mkdirSync,
  renameSync,
  realpathSync,
  readFileSync,
  utimesSync,
} = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync, execFile } = require("node:child_process");
const { promisify } = require("node:util");

module.exports = async function smoke({
  app,
  windows,
  action,
  activate,
  getState,
  getProject,
  dataDir,
  core,
}) {
  const until = async (test, label) => {
    writeFileSync(join(dataDir, "proof", "progress.txt"), label);
    for (let n = 0; n < 150; n++) {
      if (await test()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timed out: ${label}`);
  };
  const output = join(dataDir, "proof");
  mkdirSync(output, { recursive: true });
  const captureScreenshot = async (window, name) => {
    await window.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    writeFileSync(
      join(output, name),
      (await window.webContents.capturePage()).toPNG(),
    );
  };
  const report = {
    version: app.getVersion(),
    packaged: app.isPackaged,
    checks: [],
  };
  const verifyWindowIcon = async (window) => {
    if (process.platform !== "win32") return;
    const handle = window.getNativeWindowHandle();
    const hwnd =
      handle.length === 8 ? handle.readBigUInt64LE() : handle.readUInt32LE();
    await promisify(execFile)(
      join(
        process.env.SystemRoot,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        join(core, "scripts/check-window-icons.ps1"),
        "-WindowHandle",
        String(hwnd),
        "-IconPath",
        require("./lib/branding.cjs").iconPath,
      ],
      { windowsHide: true, timeout: 15000 },
    );
  };
  try {
    const identity = require("./lib/windows-identity.cjs");
    assert.equal(
      require("./lib/branding.cjs").appId,
      `${identity.installedAppId}.tests`,
    );
    if (process.platform === "win32") {
      const programs = join(dataDir, "shortcut-fixture/programs");
      const development = join(dataDir, "shortcut-fixture/desktop");
      mkdirSync(programs, { recursive: true });
      mkdirSync(development, { recursive: true });
      writeFileSync(
        join(development, "package.json"),
        JSON.stringify({ name: "ocelin-desktop" }),
      );
      const shortcut = join(programs, "Electron.lnk");
      const shell = require("electron").shell;
      assert.equal(
        shell.writeShortcutLink(shortcut, "create", {
          target: join(development, "node_modules/electron/dist/electron.exe"),
          appUserModelId: identity.installedAppId,
        }),
        true,
      );
      const original = readFileSync(shortcut);
      const backup = identity.repairLegacyShortcut(
        programs,
        join(dataDir, "shortcut-fixture/backups"),
        (path) => shell.readShortcutLink(path),
      );
      assert.deepEqual(readFileSync(backup), original);
      assert.equal(
        identity.repairLegacyShortcut(
          programs,
          join(dataDir, "shortcut-fixture/backups"),
          (path) => shell.readShortcutLink(path),
        ),
        null,
      );
      report.checks.push(
        "Real Windows shortcut collision repaired with an exact backup; smoke identity stays separate from installed Ocelin",
      );
    }
    const menu = require("electron").Menu.getApplicationMenu();
    assert.equal(app.getName(), "Ocelin");
    assert.ok(menu.getMenuItemById("ocelin-dashboard"));
    assert.ok(menu.getMenuItemById("ocelin-panel"));
    assert.equal(menu.getMenuItemById("ocelin-about").label, "About Ocelin");
    assert.equal(menu.getMenuItemById("ocelin-help").label, "Ocelin help");
    const labels = (items) =>
      items.flatMap((item) => [
        item.label,
        ...labels(item.submenu?.items || []),
      ]);
    assert.equal(
      labels(menu.items).some((label) =>
        /electron|learn more|developer tools/i.test(label),
      ),
      false,
    );
    report.checks.push(
      "Ocelin application identity and native menus replace default framework branding",
    );
    await until(() => getState().sessions.length >= 3, "fixture sessions");
    assert.equal(realpathSync(process.cwd()), realpathSync(dataDir));
    const launchDir = join(dataDir, "..", "widget-launch");
    renameSync(launchDir, `${launchDir}-released`);
    renameSync(`${launchDir}-released`, launchDir);
    report.checks.push(
      "App and helpers release the widget launch directory before monitoring starts",
    );
    const keys = getState().sessions.map((s) => s.key);
    assert.ok(
      keys.some((k) => k.startsWith("codex:")) &&
        keys.some((k) => k.startsWith("claude:")),
    );
    report.checks.push("Codex and concurrent Claude sessions discovered");
    if (process.argv.includes("ocelin://panel")) {
      await until(
        () => windows.get("tray")?.isVisible(),
        "cold-start session panel",
      );
      assert.equal(windows.has("dashboard"), false);
      report.checks.push("Panel URI starts without opening the full dashboard");
    }
    if (process.argv.includes("--background")) {
      const initial = windows.get("dashboard");
      await until(
        () => !initial.webContents.isLoading(),
        "initial dashboard loaded",
      );
      const p = getState().preferences;
      await until(
        () => initial.isVisible() === !(p.tray || p.bar),
        "background visibility",
      );
      assert.equal(initial.ocelinVisible, !(p.tray || p.bar));
      report.checks.push(
        "Background startup preserves the chosen recovery surface",
      );
    }
    const { Integrations } = await import(
      pathToFileURL(join(core, "server/monitor/integrations.mjs")).href
    );
    const integration = new Integrations({
      dataDir,
      runtime: process.execPath,
      captureFile: join(core, "hooks/ocelin-capture.cjs"),
      homes: { claude: join(dataDir, "fixture-provider") },
    });
    const preview = await integration.preview("claude");
    await integration.apply(preview.id);
    const command = preview.after.PermissionRequest[0].hooks[0].command;
    const capture = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        command.split(" ").at(-1),
      ],
      {
        input: JSON.stringify({
          session_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          cwd: getState().sessions.find(
            (s) => s.provider === "claude" && s.sessionId.startsWith("bbbb"),
          ).cwd,
          hook_event_name: "PermissionRequest",
          tool_input: { private: "not persisted" },
        }),
        encoding: "utf8",
        windowsHide: true,
        timeout: 8000,
      },
    );
    assert.equal(capture.status, 0);
    await action("refresh");
    await until(
      () =>
        getState().sessions.some(
          (s) => s.attention === "permission" && s.evidence === "hook",
        ),
      "bundled hook receipt",
    );
    await integration.apply((await integration.preview("claude", true)).id);
    report.checks.push(
      "Packaged runtime captured a redacted hook and selectively removed its fixture configuration",
    );
    await action("show", { surface: "dashboard" });
    const displayWindow = windows.get("dashboard");
    const displayBounds = displayWindow.getBounds();
    displayWindow.setSize(960, 620);
    await until(
      () =>
        displayWindow.webContents.executeJavaScript(
          "!!document.querySelector('#sessions .session') && document.querySelector('#subscriptions').hidden && document.querySelector('#resources').hidden && document.querySelector('.workspace-launcher').hidden",
        ),
      "simple desktop defaults",
    );
    await action("preferences", { firstReturnDismissed: false });
    await until(
      () =>
        displayWindow.webContents.executeJavaScript(
          "!document.getElementById('first-return').hidden",
        ),
      "first return entry",
    );
    await captureScreenshot(displayWindow, "first-return.png");
    for (const provider of ["codex", "claude"]) {
      displayWindow.focus();
      displayWindow.webContents.focus();
      await displayWindow.webContents.executeJavaScript(
        `document.getElementById('return-provider').value = '${provider}'; document.getElementById('return-provider').dispatchEvent(new Event('change')); document.getElementById('return-preview').focus(); void 0`,
      );
      displayWindow.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "Enter",
      });
      displayWindow.webContents.sendInputEvent({
        type: "char",
        keyCode: "\r",
      });
      displayWindow.webContents.sendInputEvent({
        type: "keyUp",
        keyCode: "Enter",
      });
      await until(
        () =>
          displayWindow.webContents.executeJavaScript(
            `!document.getElementById('session-peek').hidden && document.activeElement.id === 'session-peek' && document.getElementById('session-peek').innerText.includes('${provider.toUpperCase()}')`,
          ),
        `${provider} first return keyboard preview`,
      );
      await displayWindow.webContents.executeJavaScript(
        "document.querySelector('#session-peek .peek-close').click(); void 0",
      );
      assert.equal(
        await displayWindow.webContents.executeJavaScript(
          "document.activeElement.id",
        ),
        "return-preview",
      );
      const canOpen = getState().connections[provider]?.nativeOpen;
      assert.equal(
        await displayWindow.webContents.executeJavaScript(
          "document.getElementById('return-open').disabled",
        ),
        !canOpen,
      );
      if (canOpen) {
        await displayWindow.webContents.executeJavaScript(
          "document.getElementById('return-open').click(); void 0",
        );
        await until(
          () =>
            displayWindow.webContents.executeJavaScript(
              "!document.getElementById('return-confirm').disabled",
            ),
          `${provider} dispatch acknowledgement`,
        );
        assert.equal(getState().preferences.firstReturnDismissed, false);
        await displayWindow.webContents.executeJavaScript(
          "document.getElementById('return-retry').click(); void 0",
        );
      }
    }
    await displayWindow.webContents.executeJavaScript(
      "document.getElementById('return-history').click(); void 0",
    );
    await until(
      () =>
        displayWindow.webContents.executeJavaScript(
          "!document.getElementById('library-view').hidden",
        ),
      "first return history route",
    );
    await displayWindow.webContents.executeJavaScript(
      "document.querySelector('[data-view=now]').click(); document.getElementById('return-skip').click(); void 0",
    );
    await until(
      () => getState().preferences.firstReturnDismissed,
      "first return skip persists",
    );
    report.checks.push(
      "First return previews both providers by keyboard, opens History, preserves explicit confirmation after simulated dispatch, and allows persistent skipping; external provider rendering is not established",
    );
    await captureScreenshot(displayWindow, "simple-dashboard.png");
    await action("show", { surface: "tray" });
    const simplePanel = windows.get("tray");
    await until(
      () =>
        simplePanel.webContents.executeJavaScript(
          "!!document.querySelector('#sessions .session') && document.querySelector('#subscriptions').hidden && document.body.dataset.panelOpen === 'true' && document.body.getAnimations().length === 0",
        ),
      "simple session panel",
    );
    await captureScreenshot(simplePanel, "simple-panel.png");
    await action("show", { surface: "dashboard" });
    displayWindow.setBounds(displayBounds);
    await displayWindow.webContents.executeJavaScript(
      "document.getElementById('settings').click(); void 0",
    );
    await displayWindow.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    writeFileSync(
      join(output, "display-settings.png"),
      (await displayWindow.webContents.capturePage()).toPNG(),
    );
    await displayWindow.webContents.executeJavaScript(
      "document.querySelector('[data-pref=showAllowances]').click(); void 0",
    );
    await until(
      () => getState().preferences.showAllowances,
      "display preference saves",
    );
    assert.equal(getState().preferences.showMemory, false);
    await displayWindow.webContents.executeJavaScript(
      "document.getElementById('display-all').click(); document.getElementById('preferences').close(); void 0",
    );
    await until(
      () =>
        getState().preferences.showMemory &&
        getState().preferences.showWorkspace,
      "show all desktop details",
    );
    report.checks.push(
      "Simple desktop defaults hide optional information; settings restore individual sections or all details",
    );
    for (const kind of ["dashboard", "bar", "tray"]) {
      await action("show", { surface: kind });
      const window = windows.get(kind);
      await until(() => !window.webContents.isLoading(), `${kind} loaded`);
      await until(
        async () =>
          window.webContents.executeJavaScript(
            "document.querySelectorAll('#sessions .session').length > 0",
          ),
        `${kind} rows`,
      );
      const secure = await window.webContents.executeJavaScript(
        "typeof require === 'undefined' && typeof process === 'undefined' && typeof window.ocelin.action === 'function'",
      );
      assert.equal(secure, true);
      if (kind !== "bar") {
        await until(
          async () =>
            window.webContents.executeJavaScript(
              "document.querySelector('#subscriptions').textContent.includes('18% left') && document.querySelector('#subscriptions').textContent.includes('72% left') && document.querySelector('#subscriptions').textContent.includes('44% left')",
            ),
          `${kind} subscription allowance`,
        );
        const allowance = await window.webContents.executeJavaScript(
          "({values:[...document.querySelectorAll('#subscriptions progress')].map(p=>p.value),resets:document.querySelector('#subscriptions').textContent.includes('Resets in')})",
        );
        assert.deepEqual(allowance.values, [18, 72, 44]);
        assert.equal(allowance.resets, true);
        report.checks.push(
          `${kind}: Codex and Claude percentage remaining and reset countdowns`,
        );
      }
      await until(
        async () =>
          window.webContents.executeJavaScript(
            "[...document.querySelectorAll('.provider-icon img')].every(i => i.complete && i.naturalWidth > 0)",
          ),
        `${kind} official provider icons`,
      );
      await until(
        async () =>
          window.webContents.executeJavaScript(
            "(document.body.dataset.surface !== 'tray' || document.body.dataset.panelOpen === 'true') && document.body.getAnimations().length === 0",
          ),
        `${kind} entrance finished`,
      );
      const layout = await window.webContents.executeJavaScript(
        "({surface:document.body.dataset.surface,width:innerWidth,scroll:document.documentElement.scrollWidth,limbs:document.querySelector('ocelin-assistant').shadowRoot.querySelectorAll('.clawd-arm,.clawd-leg').length})",
      );
      assert.equal(layout.surface, kind);
      assert.equal(layout.limbs, 4);
      assert.ok(
        layout.scroll <= layout.width,
        `${kind} overflow: ${JSON.stringify(layout)}`,
      );
      writeFileSync(
        join(output, `${kind}.png`),
        (await window.webContents.capturePage()).toPNG(),
      );
      report.checks.push(
        `${kind}: populated, sandboxed, four-limb mascot, no page overflow`,
      );
    }
    const dashboard = windows.get("dashboard");
    assert.equal(
      (await require("electron").net.fetch("ocelin://app/vendor/unknown.svg"))
        .status,
      404,
    );
    await until(
      () => getState().resources?.status === "ready",
      "Windows memory sample",
    );
    assert.ok(
      getState().resources.groups.find((g) => g.provider === "ocelin")
        .memoryBytes > 0,
    );
    const baseline = await dashboard.webContents.executeJavaScript(
      "({filter:document.getElementById('filter').value,rows:document.querySelectorAll('#sessions .session').length,history:document.getElementById('counts').innerText,project:document.querySelector('.project-group').dataset.project})",
    );
    assert.equal(baseline.filter, "active");
    assert.ok(!/Discovered|In history/.test(baseline.history));
    await dashboard.webContents.executeJavaScript(
      "document.querySelector('.project-heading').click()",
    );
    await until(
      async () =>
        dashboard.webContents.executeJavaScript(
          "!document.querySelector('.project-group').open",
        ),
      "project collapsed",
    );
    await action("refresh");
    assert.equal(
      await dashboard.webContents.executeJavaScript(
        "document.querySelector('.project-group').open",
      ),
      false,
    );
    await dashboard.webContents.executeJavaScript(
      "document.querySelector('.project-heading').click()",
    );
    await action("preferences", { historySince: Date.now() });
    await dashboard.webContents.executeJavaScript(
      "document.getElementById('filter').value='all'; document.getElementById('filter').dispatchEvent(new Event('change'))",
    );
    await until(
      async () =>
        dashboard.webContents.executeJavaScript(
          "!document.getElementById('sessions').innerText.includes('Turn finished')",
        ),
      "old history hidden",
    );
    await action("preferences", { historySince: 0 });
    await dashboard.webContents.executeJavaScript(
      "document.getElementById('filter').value='active'; document.getElementById('filter').dispatchEvent(new Event('change'))",
    );
    await action("preferences", {
      bar: true,
      barLayout: "summary",
      barPlacement: "taskbar",
    });
    const bar = windows.get("bar");
    await until(
      async () =>
        bar.webContents.executeJavaScript(
          "document.body.dataset.barLayout==='summary'",
        ),
      "summary tile",
    );
    assert.equal(bar.isMovable(), true);
    assert.equal(
      await bar.webContents.executeJavaScript(
        "document.getElementById('hide').getBoundingClientRect().width > 0",
      ),
      true,
    );
    bar.emit("will-move");
    assert.equal(getState().preferences.barPlacement, "floating");
    await bar.webContents.executeJavaScript(
      "document.getElementById('hide').click()",
    );
    await until(() => !bar.isVisible(), "floating bar dismissed");
    assert.equal(getState().preferences.bar, false);
    await action("preferences", { density: "compact" });
    assert.equal(bar.isVisible(), false);
    await action("preferences", { bar: true });
    await until(() => bar.isVisible(), "floating bar restored");
    bar.close();
    assert.equal(getState().preferences.bar, false);
    await action("preferences", { bar: true });
    await until(() => bar.isVisible(), "closed floating bar restored");
    await action("hide", { surface: "dashboard" });
    assert.equal(dashboard.isVisible(), false);
    await action("hide", { surface: "bar" });
    assert.equal(dashboard.isVisible(), false);
    await action("preferences", { bar: true });
    await until(() => bar.isVisible(), "bar restored with dashboard recovery");
    report.checks.push(
      "Anchored tile is movable; dragging releases its anchor; button and window dismissal persist with recovery",
    );
    writeFileSync(
      join(output, "summary-tile.png"),
      (await bar.webContents.capturePage()).toPNG(),
    );
    await action("preferences", {
      barLayout: "sessions",
      barPlacement: "floating",
    });
    report.checks.push(
      "Live RAM, active-first view, collapse persistence, reversible history cleanup and status tile verified",
    );
    await action("preferences", { motion: "none", tray: false, bar: false });
    await activate(["ocelin://panel"]);
    const drawer = windows.get("tray");
    await until(() => drawer.isVisible(), "drawer opens without a tray icon");
    await action("hide", { surface: "dashboard" });
    assert.equal(drawer.isMovable(), false);
    const area = require("electron").screen.getDisplayMatching(
      drawer.getBounds(),
    ).workArea;
    assert.deepEqual(
      drawer.getBounds(),
      require("./lib/panel.cjs").panelBounds(area),
    );
    const panelState = await drawer.webContents.executeJavaScript(
      "({focus:document.activeElement.id,open:document.body.dataset.panelOpen,animations:document.body.getAnimations().length})",
    );
    writeFileSync(join(output, "panel-state.json"), JSON.stringify(panelState));
    assert.equal(panelState.open, "true");
    assert.equal(panelState.animations, 0);
    assert.equal(panelState.focus, "");
    drawer.focus();
    await until(() => drawer.isFocused(), "drawer focus for hover checks");
    await drawer.webContents.executeJavaScript(`
      document.querySelector('.session-actions summary').dispatchEvent(new PointerEvent('pointerenter'));
      new Promise(resolve => setTimeout(resolve, 500));
    `);
    assert.equal(
      await drawer.webContents.executeJavaScript(
        "document.getElementById('session-peek').hidden",
      ),
      true,
    );
    await drawer.webContents.executeJavaScript(`
      document.querySelector('.session-title').dispatchEvent(new PointerEvent('pointerenter'));
      document.querySelector('.session-title').dispatchEvent(new PointerEvent('pointerleave'));
      new Promise(resolve => setTimeout(resolve, 500));
    `);
    assert.equal(
      await drawer.webContents.executeJavaScript(
        "document.getElementById('session-peek').hidden",
      ),
      true,
    );
    await drawer.webContents.executeJavaScript(
      "document.querySelector('.session-title').dispatchEvent(new PointerEvent('pointerenter'))",
    );
    await until(
      async () =>
        drawer.webContents.executeJavaScript(
          "!document.getElementById('session-peek').hidden && document.getElementById('session-peek').textContent.includes('Latest request')",
        ),
      "deliberate title hover preview",
    );
    await drawer.webContents.executeJavaScript(
      "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
    );
    assert.equal(drawer.isVisible(), true);
    await drawer.webContents.executeJavaScript(
      "document.getElementById('settings').click()",
    );
    await drawer.webContents.executeJavaScript(
      "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.getElementById('preferences').close()",
    );
    assert.equal(drawer.isVisible(), true);
    await drawer.webContents.executeJavaScript(
      "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
    );
    await until(() => !drawer.isVisible(), "Escape dismisses drawer");
    assert.equal(dashboard.isVisible(), false);
    await activate(["ocelin://panel"]);
    await until(() => drawer.isVisible(), "drawer reopens");
    await activate(["ocelin://panel"]);
    assert.equal(windows.get("tray"), drawer);
    assert.equal(drawer.isVisible(), true);
    writeFileSync(
      join(output, "session-panel.png"),
      (await drawer.webContents.capturePage()).toPNG(),
    );
    await action("show", { surface: "dashboard" });
    await until(() => !drawer.isVisible(), "outside focus dismisses drawer");
    await activate(["ocelin://panel"]);
    await drawer.webContents.executeJavaScript(`
      window.__panelFrames = [];
      window.ocelin.onPanelOpen(({visible, duration}) => {
        if (!visible) return;
        const started = performance.now();
        const sample = () => {
          const transform = getComputedStyle(document.body).transform;
          window.__panelFrames.push({ duration, at: performance.now() - started, x: transform === 'none' ? 0 : new DOMMatrix(transform).m41 });
          if (performance.now() - started < duration + 80 || document.body.getAnimations().length) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      void 0;
    `);
    await drawer.webContents.executeJavaScript(
      "document.getElementById('hide').click()",
    );
    await until(() => !drawer.isVisible(), "close button dismisses drawer");
    await action("preferences", { motion: "full" });
    await activate(["ocelin://panel"]);
    await until(
      async () =>
        drawer.webContents.executeJavaScript(
          "window.__panelFrames.at(-1)?.at > window.__panelFrames.at(-1)?.duration + 40 && window.__panelFrames.at(-1)?.x === 0",
        ),
      "visible drawer animation frames",
    );
    const frames = await drawer.webContents.executeJavaScript(
      "window.__panelFrames",
    );
    if (!getState().reducedMotion) {
      assert.ok(frames[0].x > 0);
      assert.ok(
        frames.some(
          (frame) => frame.x > 0 && frame.x < drawer.getBounds().width - 5,
        ),
      );
    }
    assert.equal(frames.at(-1).x, 0);
    writeFileSync(join(output, "panel-animation.json"), JSON.stringify(frames));
    report.checks.push(
      "Drawer animation has intermediate visible positions; brief row/action hover stays quiet and deliberate title hover previews",
    );
    await action("hide", { surface: "tray" });
    await action("preferences", { motion: "system", tray: true, bar: true });
    report.checks.push(
      "Right-edge session panel opens from URI, reuses its window, respects reduced motion and closes with Escape, outside focus or its close button",
    );
    const originalBounds = dashboard.getBounds();
    await action("preferences", { theme: "light" });
    await until(
      async () =>
        dashboard.webContents.executeJavaScript(
          "getComputedStyle(document.querySelector('.provider-on-light')).display !== 'none' && getComputedStyle(document.querySelector('.provider-on-dark')).display === 'none'",
        ),
      "official light-mode Codex icon",
    );
    for (const width of [700, 420, 320]) {
      dashboard.setSize(width, 700);
      await new Promise((r) => setTimeout(r, 150));
      const layout = await dashboard.webContents.executeJavaScript(
        "({width:innerWidth,scroll:document.documentElement.scrollWidth})",
      );
      assert.ok(
        layout.scroll <= layout.width,
        `Dashboard overflow at ${width}: ${JSON.stringify(layout)}`,
      );
    }
    writeFileSync(
      join(output, "dashboard-narrow-light.png"),
      (await dashboard.webContents.capturePage()).toPNG(),
    );
    dashboard.setBounds(originalBounds);
    await action("preferences", { theme: "dark" });
    report.checks.push("Light dashboard fits 320, 420 and 700 pixel windows");
    const rejected = await dashboard.webContents.executeJavaScript(
      "window.ocelin.action('project',{key:'unknown'}).then(()=>false,()=>true)",
    );
    assert.equal(rejected, true);
    report.checks.push("Unknown session target rejected through renderer IPC");
    const libraryPage = await action("library-query", { view: "history" });
    assert.ok(libraryPage.entries.length >= 3);
    const claudeSession = libraryPage.entries.find(
      (s) => s.provider === "claude",
    );
    const peek = await action("session-preview", { key: claudeSession.key });
    assert.ok(peek.request.includes("Windows integration"));
    assert.ok(Array.isArray(peek.diagnostics.findings));
    const fullText = await action("library-query", {
      fullText: true,
      search: "fixture is complete",
    });
    assert.ok(fullText.entries.some((entry) => entry.provider === "claude"));
    assert.equal(
      (await action("library-query", { search: "fixture is complete" })).total,
      0,
    );
    assert.equal(getState().updates.status, "unavailable");
    await assert.rejects(action("update-check"), /signed/);
    report.checks.push(
      "Full transcript search finds later responses; previews carry diagnostics; unsigned builds refuse automatic updates",
    );
    const link = await action("session-open", { key: claudeSession.key });
    assert.equal(
      link.url,
      `claude://resume?session=${claudeSession.sessionId}`,
    );
    await dashboard.webContents.executeJavaScript(
      "document.querySelector('[data-view=history]').click()",
    );
    await until(
      async () =>
        dashboard.webContents.executeJavaScript(
          "document.querySelectorAll('.library-row').length >= 3",
        ),
      "history rows",
    );
    await action("show", { surface: "dashboard" });
    await action("preferences", {
      showAllowances: false,
      showMemory: false,
      showWorkspace: false,
      showSessionDetails: false,
      showHints: false,
    });
    await until(
      () =>
        dashboard.webContents.executeJavaScript(
          "document.querySelector('#subscriptions').hidden && document.querySelector('#resources').hidden && document.querySelector('.workspace-launcher').hidden",
        ),
      "simple history view",
    );
    await dashboard.webContents.executeJavaScript(
      "document.querySelector('.library-row .session-title').focus()",
    );
    await until(
      async () =>
        dashboard.webContents.executeJavaScript(
          "!document.getElementById('session-peek').hidden && document.getElementById('session-peek').textContent.includes('Latest request')",
        ),
      "zero-click transcript preview",
    );
    await captureScreenshot(dashboard, "history-preview.png");
    await action("preferences", {
      showAllowances: true,
      showMemory: true,
      showWorkspace: true,
      showSessionDetails: true,
      showHints: true,
    });
    const hide = await action("library-plan", {
      operation: "hide",
      keys: [claudeSession.key],
    });
    await action("library-apply", { id: hide.id });
    assert.ok(
      (await action("library-query", { view: "archived" })).entries.some(
        (s) => s.key === claudeSession.key && s.hidden,
      ),
    );
    await action("library-apply", {
      id: (
        await action("library-plan", {
          operation: "unhide",
          keys: [claudeSession.key],
        })
      ).id,
    });
    await dashboard.webContents.executeJavaScript(
      "document.querySelector('[data-view=now]').click()",
    );
    report.checks.push(
      "Native URI dispatch, history, hover transcript preview, hide and restore through renderer IPC",
    );
    const selected = getState().sessions.find((s) => s.provider === "codex");
    await action("project", { key: selected.key });
    const project = getProject();
    await until(
      async () =>
        project.window.webContents.executeJavaScript(
          "document.body.innerText.includes('Session') && !document.querySelector('.wizard-overlay')",
        ),
      "project view",
    );
    assert.ok(
      project.window.webContents.getURL().includes("/activity/session"),
    );
    await until(
      async () =>
        project.window.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('select')).some(s=>s.value===${JSON.stringify(selected.key)})`,
        ),
      "selected provider and session",
    );
    const version = await (
      await require("electron").net.fetch(
        `http://127.0.0.1:${project.port}/health`,
      )
    ).json();
    assert.equal(version.nonce, project.nonce);
    report.checks.push(
      "Bundled project backend booted and correct session route opened",
    );
    if (process.platform === "win32") {
      await verifyWindowIcon(project.window);
      project.window.setIcon(
        require("electron").nativeImage.createFromBitmap(
          Buffer.alloc(32 * 32 * 4, 255),
          { width: 32, height: 32 },
        ),
      );
      await assert.rejects(
        verifyWindowIcon(project.window),
        /does not match Ocelin/,
      );
      project.window.hide();
      project.window.showInactive();
      await verifyWindowIcon(project.window);
      report.checks.push(
        "Workspace small and large Windows icons match Ocelin and recover on reopening",
      );
    }
    await project.window.webContents.executeJavaScript(
      "location.hash = '/activity/trace'; void 0",
    );
    await until(
      async () =>
        project.window.webContents.executeJavaScript(
          "document.querySelector('.trace-diagnostics')?.textContent.includes('failed 6 times')",
        ),
      "trace diagnostic evidence",
    );
    await project.window.webContents.executeJavaScript(
      "document.querySelector('.trace-span-row summary').click(); void 0",
    );
    assert.equal(
      await project.window.webContents.executeJavaScript(
        "document.querySelector('.trace-span-row').open && document.querySelector('.trace-inspector').textContent.includes('Call ID: diagnostic-0')",
      ),
      true,
    );
    await new Promise((done) => setTimeout(done, 4500));
    assert.equal(
      await project.window.webContents.executeJavaScript(
        "document.querySelector('.trace-span-row').open",
      ),
      true,
    );
    writeFileSync(
      join(output, "trace-diagnostics.png"),
      (await project.window.webContents.capturePage()).toPNG(),
    );
    report.checks.push(
      "Diagnostic rules detect repeated failures; trace spans expand with call IDs and timing",
    );
    await project.window.webContents.executeJavaScript(
      "location.hash = '/cost'; void 0",
    );
    await until(
      async () =>
        project.window.webContents.executeJavaScript(
          "document.querySelector('.allowances')?.textContent.includes('18% left') && document.querySelector('.allowances')?.textContent.includes('72% left')",
        ),
      "project Cost subscription allowance",
    );
    await captureScreenshot(project.window, "subscription-cost.png");
    report.checks.push(
      "Project Cost view shows the same subscription percentages as the desktop",
    );
    project.window.destroy();
    assert.equal(getProject(), null);
    await dashboard.webContents.executeJavaScript(
      "document.querySelector('#workspace-open').click()",
    );
    await until(
      () => getProject()?.window && !getProject().window.isDestroyed(),
      "workspace launch button",
    );
    await until(
      async () =>
        getProject().window.webContents.executeJavaScript(
          "location.hash === '#/overview' && !!document.querySelector('a[href=\"#/worktrees\"]')",
        ),
      "full workspace overview and navigation",
    );
    assert.equal(getState().preferences.lastProjectPath, selected.cwd);
    const workspace = getProject().window;
    await until(
      () =>
        workspace.webContents.executeJavaScript(
          "document.querySelector('[data-route=worktrees]').hidden",
        ),
      "simple workspace navigation",
    );
    await until(
      () =>
        workspace.webContents.executeJavaScript(
          "!!document.querySelector('.agent-item')",
        ),
      "simple workspace sessions",
    );
    writeFileSync(
      join(output, "simple-workspace.png"),
      (await workspace.webContents.capturePage()).toPNG(),
    );
    await workspace.webContents.executeJavaScript(
      "location.hash = '/config'; void 0",
    );
    await until(
      () =>
        workspace.webContents.executeJavaScript(
          "!!document.querySelector('[data-display=repository]')",
        ),
      "workspace display settings",
    );
    await captureScreenshot(workspace, "workspace-settings.png");
    await workspace.webContents.executeJavaScript(
      "document.querySelector('[data-display=repository]').click(); void 0",
    );
    await until(
      () =>
        workspace.webContents.executeJavaScript(
          "document.querySelector('[data-display=repository]')?.checked",
        ),
      "workspace display save",
    );
    workspace.webContents.reload();
    await until(
      () =>
        workspace.webContents.executeJavaScript(
          "document.querySelector('[data-display=repository]')?.checked",
        ),
      "workspace display persists after reload",
    );
    await workspace.webContents.executeJavaScript(
      "document.querySelector('[data-display=repository]').click(); void 0",
    );
    await until(
      () =>
        workspace.webContents.executeJavaScript(
          "document.querySelector('[data-display=repository]')?.checked === false",
        ),
      "workspace returns to simple",
    );
    report.checks.push(
      "Workspace starts with simple navigation; optional cards persist after reopening and can be hidden again",
    );
    await verifyWindowIcon(getProject().window);
    report.checks.push(
      "Visible Open workspace button opens the original full Overview, Worktrees and Review app",
    );
    const profileHome = join(dataDir, "sample-work-profile");
    mkdirSync(join(profileHome, "sessions"), { recursive: true });
    const { accountProfiles } = require(
      join(core, "server/monitor/profiles.cjs"),
    );
    const extra = accountProfiles([
      { provider: "codex", home: profileHome, label: "Work" },
    ]).find((p) => !p.builtin);
    const cacheFile = join(dataDir, "subscriptions.json");
    const originalCache = JSON.parse(readFileSync(cacheFile, "utf8"));
    writeFileSync(
      cacheFile,
      JSON.stringify({
        ...originalCache,
        schemaVersion: 2,
        profiles: [
          {
            ...originalCache.providers.codex,
            profileId: extra.id,
            profileLabel: "Work",
            accountLabel: "work@example.test",
            windows: [
              {
                id: "codex:primary",
                label: "Weekly",
                remainingPercent: 33,
                resetsAt: Date.now() + 3600000,
                minutes: 10080,
                extra: false,
              },
            ],
          },
        ],
      }),
    );
    const nativeDialog = require("electron").dialog,
      originalPicker = nativeDialog.showOpenDialog;
    nativeDialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [profileHome],
    });
    try {
      await action("account-profile-add", { provider: "codex", label: "Work" });
    } finally {
      nativeDialog.showOpenDialog = originalPicker;
    }
    await until(
      async () =>
        dashboard.webContents.executeJavaScript(
          "document.querySelector('#subscriptions').textContent.includes('work@example.test') && document.querySelector('#subscriptions').textContent.includes('33% left')",
        ),
      "additional account allowance card",
    );
    await action("account-profile-rename", {
      id: extra.id,
      label: "Work laptop",
    });
    assert.equal(
      getState().accountProfiles.find((p) => p.id === extra.id).label,
      "Work laptop",
    );
    writeFileSync(cacheFile, JSON.stringify(originalCache));
    await action("account-profile-remove", { id: extra.id });
    await until(
      async () =>
        dashboard.webContents.executeJavaScript(
          "!document.querySelector('#subscriptions').textContent.includes('work@example.test')",
        ),
      "disconnected allowance removed",
    );
    assert.equal(
      require("node:fs").existsSync(join(profileHome, "sessions")),
      true,
    );
    report.checks.push(
      "Connect, rename and disconnect a second account profile through validated IPC; original provider files preserved",
    );
    const oldSessionFile = join(
      (
        getState().preferences.sources || JSON.parse(process.env.OCELIN_SOURCES)
      ).find((s) => s.provider === "claude").root,
      "doctor-old.jsonl",
    );
    const oldDate = new Date(Date.now() - 120 * 86400000);
    const oldHistory =
      JSON.stringify({
        type: "user",
        sessionId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
        cwd: selected.cwd,
        timestamp: oldDate.toISOString(),
        message: { content: "A saved Doctor fixture" },
      }) + "\n";
    writeFileSync(oldSessionFile, oldHistory);
    utimesSync(oldSessionFile, oldDate, oldDate);
    await action("show", { surface: "tray" });
    const doctorPanel = windows.get("tray");
    await until(
      () => !doctorPanel.webContents.isLoading(),
      "Doctor panel ready",
    );
    await doctorPanel.webContents.executeJavaScript(
      "document.getElementById('doctor').click()",
    );
    await until(
      () =>
        doctorPanel.webContents.executeJavaScript(
          "document.getElementById('doctor-status').textContent.startsWith('Scan complete')",
        ),
      "Doctor scan",
    );
    assert.equal(
      await doctorPanel.webContents.executeJavaScript(
        "document.getElementById('doctor-tidy').disabled",
      ),
      false,
    );
    for (const width of [320, 420]) {
      doctorPanel.setSize(width, 900);
      const fits = await doctorPanel.webContents.executeJavaScript(
        "new Promise(resolve=>requestAnimationFrame(()=>{const d=document.getElementById('doctor-dialog'),b=document.getElementById('doctor');resolve(d.scrollWidth<=d.clientWidth+1 && b.getBoundingClientRect().right<=innerWidth)}))",
      );
      assert.equal(fits, true, `Doctor fits ${width}px`);
    }
    writeFileSync(
      join(output, "doctor-panel.png"),
      (await doctorPanel.webContents.capturePage()).toPNG(),
    );
    await doctorPanel.webContents.executeJavaScript(
      "document.getElementById('doctor-tidy').click()",
    );
    await until(
      () =>
        doctorPanel.webContents.executeJavaScript(
          "document.getElementById('doctor-status').textContent.startsWith('Hidden 1 sessions')",
        ),
      "Doctor safe tidy",
    );
    assert.equal(readFileSync(oldSessionFile, "utf8"), oldHistory);
    assert.ok(
      getState().hiddenKeys.includes(
        "claude:dddddddd-dddd-dddd-dddd-dddddddddddd",
      ),
    );
    await doctorPanel.webContents.executeJavaScript(
      "document.getElementById('doctor-undo').click()",
    );
    await until(
      () =>
        doctorPanel.webContents.executeJavaScript(
          "document.getElementById('doctor-status').textContent.startsWith('Restored 1 sessions')",
        ),
      "Doctor undo",
    );
    await doctorPanel.webContents.executeJavaScript(
      "document.getElementById('doctor-release').click()",
    );
    await until(() => getProject() === null, "Doctor release workspace");
    assert.ok(getState().counts.running > 0);
    await doctorPanel.webContents.executeJavaScript(
      "document.getElementById('doctor-dialog').close()",
    );
    await action("preferences", {
      taskbarDetail: "allowance",
      taskbarAllowance: "lowest",
      taskbarBridge: true,
    });
    const taskbar = JSON.parse(
      readFileSync(join(dataDir, "taskbar-summary.json"), "utf8"),
    );
    assert.match(taskbar.detail, /Codex \d+%.*Claude \d+%/);
    assert.ok(!JSON.stringify(taskbar).includes("@"));
    await action("preferences", { taskbarDetail: "sessions" });
    assert.match(getState().statusSummary.detail, /Codex \d+ · Claude \d+/);
    await action("preferences", {
      taskbarDetail: "allowance",
      taskbarBridge: false,
    });
    report.checks.push(
      "Doctor opens from the panel, fits 320px, tidies and restores old history with originals intact, releases only Ocelin workspace/index, and taskbar exports anonymous quota or session counts",
    );
    for (const combo of [
      { tray: true, bar: false, dashboard: false },
      { tray: false, bar: true, dashboard: false },
      { tray: false, bar: false, dashboard: true },
      { tray: false, bar: false, dashboard: false },
    ]) {
      await action("preferences", combo);
      const p = getState().preferences;
      assert.ok(p.tray || p.bar || p.dashboard);
    }
    report.checks.push("Surface combinations retain a recovery surface");
    if (app.isPackaged) {
      const login = { path: process.execPath, args: ["--background"] };
      const original = app.getLoginItemSettings(login).openAtLogin;
      try {
        await action("preferences", { startup: true });
        assert.equal(app.getLoginItemSettings(login).openAtLogin, true);
        await action("preferences", { startup: false });
        assert.equal(app.getLoginItemSettings(login).openAtLogin, false);
        report.checks.push(
          "Sign-in startup enabled, verified, disabled and restored",
        );
      } finally {
        app.setLoginItemSettings({ ...login, openAtLogin: original });
      }
    }
    if (process.env.OCELIN_MEMORY_SMOKE === "1") {
      await action("preferences", {
        tray: true,
        bar: false,
        dashboard: false,
        taskbarBridge: false,
        nativeTasks: false,
      });
      await until(
        () => [...windows.values()].every((window) => !window.isVisible()),
        "tray-only idle memory",
      );
      await new Promise((done) => setTimeout(done, 65000));
      assert.equal(getState().resources.status, "paused");
      report.idleMemory = {
        mode: "Tray only, no RAM export, after 65 seconds idle",
        workingSetMiB:
          app
            .getAppMetrics()
            .reduce((sum, process) => sum + process.memory.workingSetSize, 0) /
          1024,
        privateMiB:
          app
            .getAppMetrics()
            .reduce((sum, process) => sum + process.memory.privateBytes, 0) /
          1024,
      };
      report.checks.push(
        "Tray-only idle stops the RAM sampler and releases hidden renderers",
      );
    }
    report.metrics = getState().metrics;
    app.getAppMetrics();
    await new Promise((done) => setTimeout(done, 2000));
    report.processes = app.getAppMetrics().map((m) => ({
      type: m.type,
      serviceName: m.serviceName,
      workingSetKB: m.memory.workingSetSize,
      privateKB: m.memory.privateBytes,
      cpuPercent: m.cpu.percentCPUUsage,
    }));
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.error = error.stack;
    const projectWindow = getProject()?.window;
    if (projectWindow && !projectWindow.isDestroyed()) {
      report.projectText = await projectWindow.webContents
        .executeJavaScript("document.body.innerText.slice(-18000)")
        .catch(() => null);
      writeFileSync(
        join(output, "project-failure.png"),
        (await projectWindow.webContents.capturePage()).toPNG(),
      );
    }
    const dashboard = windows.get("dashboard");
    if (dashboard && !dashboard.isDestroyed()) {
      dashboard.show();
      report.ui = await dashboard.webContents
        .executeJavaScript(
          "({error:document.getElementById('error').textContent,peek:document.getElementById('session-peek').textContent,hidden:document.getElementById('session-peek').hidden,dialog:[...document.querySelectorAll('dialog[open]')].map(d=>d.id),focus:document.activeElement?.outerHTML})",
        )
        .catch(() => null);
      writeFileSync(
        join(output, "failure.png"),
        (await dashboard.webContents.capturePage()).toPNG(),
      );
    }
  }
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
  app.once("will-quit", (event) => {
    event.preventDefault();
    setTimeout(() => app.exit(report.ok ? 0 : 1), 2200);
  });
  app.quit();
};

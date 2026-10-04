const { writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { session, shell } = require('electron');

module.exports = async ({ app, windows, action, getState, dataDir }) => {
  const report = { phase: 'warmup-ui', blockedRequests: 0, blockedActions: 0, synthetic: true };
  const save = () => writeFileSync(join(dataDir, 'profile-state.json'), JSON.stringify({ ...report, at: Date.now() }));
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const block = () => { report.blockedActions++; save(); throw new Error('Action disabled during resource profile'); };
  app.setLoginItemSettings = block;
  app.setAsDefaultProtocolClient = block;
  shell.openExternal = block;
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => {
    report.blockedRequests++; save(); callback({ cancel: true });
  });
  try {
    save();
    for (let i = 0; i < 150 && getState().sessions.length < 3; i++) await wait(200);
    if (getState().sessions.length !== 3) throw new Error('Synthetic sessions were not discovered');
    if (!app.isPackaged || app.getVersion() !== '0.7.0-preview.3') throw new Error('Unexpected packaged runtime');
    const dashboard = windows.get('dashboard');
    if (!dashboard || !dashboard.isVisible()) throw new Error('Dashboard is not visible during UI warm-up');
    for (let i = 0; i < 150 && dashboard.webContents.isLoading(); i++) await wait(200);
    const loaded = await dashboard.webContents.executeJavaScript("document.readyState === 'complete' && Boolean(document.querySelector('[data-view=history]'))");
    if (!loaded) throw new Error('Dashboard did not load its expected controls');
    report.dashboardLoaded = true;
    await action('library-query', { limit: 20 });
    report.fixtureSessions = getState().sessions.length;
    report.version = app.getVersion();
    await wait(20000);
    await action('preferences', { tray: true, dashboard: false, bar: false, taskbarBridge: false, nativeTasks: false });
    report.phase = 'warmup-hidden'; save();
    await wait(75000);
    if ([...windows.values()].some(w => !w.isDestroyed())) throw new Error('Hidden renderers were not released');
    if (getState().resources.status !== 'paused') throw new Error('App resource sampler remains active');
    report.phase = 'tray-idle';
    report.idleStartedAt = Date.now();
    report.conditions = { windowsReleased: true, resourceSamplerPaused: true, providerSubscriptions: 'fixture only', sources: 'three synthetic sessions' };
    save();
    while (!existsSync(join(dataDir, 'profile-stop'))) {
      await wait(1000);
      if ([...windows.values()].some(w => !w.isDestroyed()) || getState().resources.status !== 'paused') throw new Error('Idle conditions changed');
      if (report.blockedRequests || report.blockedActions) throw new Error('Unexpected network or external action');
    }
    report.phase = 'complete'; save();
  } catch (error) {
    report.phase = 'failed'; report.error = error.message; save();
  } finally {
    app.quit();
  }
};

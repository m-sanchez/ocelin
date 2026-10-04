import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpus, totalmem, release } from 'node:os';
import { mkdir, readFile, writeFile, readdir, cp, stat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { summarizeSamples } from './resource-profile-model.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args[0] === '--evaluate') {
  const directory = resolve(args[1] || '');
  const samples = JSON.parse(await readFile(join(directory, 'samples.json'), 'utf8'));
  const provenance = JSON.parse(await readFile(join(directory, 'provenance.json'), 'utf8'));
  const collected = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
  const evaluation = {
    ...summarizeSamples(samples, provenance.machine.logicalProcessors, 1800, { driverComplete: collected.driver.phase === 'complete', appExitCode: collected.appExitCode, samplerError: collected.samplerError, collectorError: collected.collectorError }),
    evaluatorSha256: createHash('sha256').update(await readFile(new URL('./resource-profile-model.mjs', import.meta.url))).digest('hex'),
    samplesSha256: createHash('sha256').update(await readFile(join(directory, 'samples.json'))).digest('hex'),
    driver: collected.driver,
    appExitCode: collected.appExitCode,
    samplerError: collected.samplerError,
    collectionSanityRun: collected.sanity,
  };
  await writeFile(join(directory, 'evaluated-summary.json'), JSON.stringify(evaluation, null, 2));
  console.log(JSON.stringify(evaluation, null, 2));
  process.exit(0);
}
const sanity = args.includes('--sanity');
const seconds = sanity ? 15 : 1800;
const source = resolve(args.find(a => !a.startsWith('--')) || join(root, 'desktop/dist/win-unpacked'));
const output = join(root, '.ocelin-smoke', `resource-profile-${Date.now()}`);
const packaged = join(output, 'package');
const extracted = join(output, 'archive-content');
const dataDir = join(output, 'data');
const fixture = join(output, 'fixture');
const sourceRevision = '1e45dde35dd838908c1bd9e35b1603167921c9ca';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = async path => hash(await readFile(path));
const require = createRequire(join(root, 'desktop/package.json'));
const asar = require('@electron/asar');
const manifest = async directory => {
  const result = [];
  const walk = async path => {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const file = join(path, item.name);
      if (item.isSymbolicLink()) throw new Error('Unexpected package symlink');
      if (item.isDirectory()) await walk(file);
      else result.push({ path: relative(directory, file).replaceAll('\\', '/'), bytes: (await stat(file)).size, sha256: await fileHash(file) });
    }
  };
  await walk(directory);
  return result.sort((a, b) => a.path.localeCompare(b.path));
};
assert.equal(process.platform, 'win32', 'Windows process counters are required');
await mkdir(output, { recursive: true });
console.log(`Preparing isolated package: ${output}`);
const originalManifest = await manifest(source);
const originalManifestSha256 = hash(JSON.stringify(originalManifest.map(({ path, sha256 }) => ({ path, sha256 }))));
assert.equal(originalManifestSha256, 'd20c2cf16c6f3ad48b4152b624e256a36ec256a39709970aa2896f5b00e20635', 'Package files differ from the verified public preview.3 installer payload');
await cp(source, packaged, { recursive: true, errorOnExist: true });
const archive = join(packaged, 'resources/app.asar');
asar.extractAll(archive, extracted);
const originalContent = await manifest(extracted);
assert.equal(JSON.parse(await readFile(join(extracted, 'package.json'), 'utf8')).version, '0.7.0-preview.3');
const oldDriver = await readFile(join(extracted, 'smoke.cjs'));
await writeFile(join(output, 'original-smoke.cjs'), oldDriver);
await cp(join(root, 'scripts/resource-profile-driver.cjs'), join(extracted, 'smoke.cjs'));
const alteredContent = await manifest(extracted);
const contentChanges = alteredContent.filter((item, i) => item.sha256 !== originalContent[i]?.sha256 || item.path !== originalContent[i]?.path);
assert.deepEqual(contentChanges.map(item => item.path), ['smoke.cjs']);
await asar.createPackageWithOptions(extracted, archive, { unpack: '**/{verify-update,resources,stop-processes}.ps1' });
const instrumentedManifest = await manifest(packaged);
const packageChanges = instrumentedManifest.filter((item, i) => item.sha256 !== originalManifest[i]?.sha256 || item.path !== originalManifest[i]?.path);
assert.deepEqual(packageChanges.map(item => item.path), ['resources/app.asar']);
const executable = join(packaged, 'Ocelin.exe');
const paths = { codex: join(fixture, 'codex/sessions'), claude: join(fixture, 'claude/projects'), checkout: join(fixture, 'workspace') };
for (const path of [dataDir, ...Object.values(paths)]) await mkdir(path, { recursive: true });
await writeFile(join(paths.checkout, 'README.md'), '# Synthetic resource profile\n');
const timestamp = new Date().toISOString();
await writeFile(join(paths.codex, 'synthetic.jsonl'), [
  { type: 'session_meta', timestamp, payload: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', cwd: paths.checkout } },
  { type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'Synthetic completed profile fixture' } },
  { type: 'event_msg', timestamp, payload: { type: 'task_complete' } },
].map(JSON.stringify).join('\n') + '\n');
for (const id of ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cccccccc-cccc-cccc-cccc-cccccccccccc']) {
  await writeFile(join(paths.claude, `${id}.jsonl`), [
    { type: 'user', timestamp, sessionId: id, cwd: paths.checkout, message: { content: [{ type: 'text', text: 'Synthetic completed resource profile' }] } },
    { type: 'assistant', timestamp, sessionId: id, cwd: paths.checkout, message: { content: [{ type: 'text', text: 'Completed synthetic fixture' }], stop_reason: 'end_turn' } },
  ].map(JSON.stringify).join('\n') + '\n');
}
await writeFile(join(dataDir, 'preferences.json'), JSON.stringify({ tray: true, dashboard: true, bar: false, startup: false, automaticUpdates: false, taskbarBridge: false, nativeTasks: false, accountProfiles: [], quiet: true, firstReturnDismissed: true }));
const provenance = {
  release: 'v0.7.0-preview.3', sourceRevision, instrumentedTestDriver: true,
  command: `node scripts/desktop-resource-profile.mjs desktop/dist/win-unpacked${sanity ? ' --sanity' : ''}`,
  requiredScoredSeconds: seconds, targetEvaluationRequiresSeconds: 1800,
  phases: [{ name: 'warmup-ui', scored: false, minimumSeconds: 20, workload: 'Three completed synthetic sessions; one library query; dashboard visible' }, { name: 'warmup-hidden', scored: false, minimumSeconds: 75, workload: 'Hide dashboard; allow renderer and library idle release' }, { name: 'tray-idle', scored: true, minimumSeconds: seconds, workload: 'Tray only; library closed; fixed synthetic sources; subscription reads use fixture mode' }],
  machine: { platform: process.platform, osRelease: release(), architecture: process.arch, logicalProcessors: cpus().length, cpuModel: cpus()[0].model, totalMemoryBytes: totalmem() },
  originalArchiveSha256: originalManifest.find(f => f.path === 'resources/app.asar').sha256,
  originalManifestSha256,
  publicInstallerSha256: 'ebc2f83d28b7f5f1b4705f0f4b9284585f67160ed8618347c2a49b72026aa028',
  instrumentedArchiveSha256: await fileHash(archive), executableSha256: await fileHash(executable),
  originalDriverSha256: hash(oldDriver), instrumentedDriverSha256: await fileHash(join(extracted, 'smoke.cjs')),
  changedArchiveEntries: ['smoke.cjs'], changedPackageFiles: ['resources/app.asar'],
  measurementFiles: await Promise.all(['scripts/desktop-resource-profile.mjs', 'scripts/resource-profile-driver.cjs', 'scripts/resource-profile-model.mjs', 'scripts/resource-profile-sampler.ps1'].map(async path => ({ path, sha256: await fileHash(join(root, path)) }))),
};
await writeFile(join(output, 'provenance.json'), JSON.stringify(provenance, null, 2));
await writeFile(join(output, 'unchanged-package-manifest.json'), JSON.stringify(originalManifest.filter(f => f.path !== 'resources/app.asar'), null, 2));
await writeFile(join(output, 'unchanged-archive-manifest.json'), JSON.stringify(originalContent.filter(f => f.path !== 'smoke.cjs'), null, 2));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|PATH|PATHEXT|TEMP|TMP|COMSPEC|LOCALAPPDATA|APPDATA|USERPROFILE|USERNAME|USERDOMAIN|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|ALLUSERSPROFILE|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|SESSIONNAME|OS)$/i.test(key)));
Object.assign(env, { OCELIN_DATA_DIR: dataDir, OCELIN_SOURCES: JSON.stringify([{ provider: 'codex', root: paths.codex }, { provider: 'claude', root: paths.claude }]), CODEX_HOME: join(fixture, 'codex'), CLAUDE_CONFIG_DIR: join(fixture, 'claude'), OCELIN_SMOKE_TEST: '1' });
const app = spawn(executable, ['--smoke-test', '--disable-background-networking', '--proxy-server=127.0.0.1:9', '--proxy-bypass-list=<-loopback>'], { cwd: fixture, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let appError = '';
let appFinished = false;
app.stderr.on('data', chunk => { appError = (appError + chunk).slice(-8000); });
app.on('error', error => { appError = error.message; });
const appExit = new Promise(resolve => {
  app.on('error', () => { appFinished = true; resolve(null); });
  app.on('exit', code => { appFinished = true; resolve(code); });
});
const ps = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const sampler = spawn(ps, ['-NoProfile', '-NonInteractive', '-File', join(root, 'scripts/resource-profile-sampler.ps1'), '-OwnerProcessId', String(app.pid), '-ExpectedExecutable', executable], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let buffer = '', samplerError = '', collectorError = null, chain = Promise.resolve(), scoredStarted = null, stopRequested = false, samplerStopping = false;
const samples = [];
sampler.stderr.on('data', chunk => { samplerError = (samplerError + chunk).slice(-4000); });
const stopCollection = async message => {
  collectorError ||= message;
  await writeFile(join(dataDir, 'profile-stop'), 'collector failure').catch(() => {});
};
sampler.on('error', error => { samplerError = error.message; void stopCollection('Sampler could not start'); });
const samplerExit = new Promise(resolve => sampler.on('close', (code, signal) => {
  const intentional = samplerStopping || appFinished;
  if (!intentional) {
    samplerError ||= 'Sampler stopped before the app completed';
    void stopCollection(samplerError);
  }
  resolve({ code, signal, intentional });
}));
const readState = async () => JSON.parse(await readFile(join(dataDir, 'profile-state.json'), 'utf8').catch(() => '{"phase":"starting"}'));
sampler.stdout.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    chain = chain.then(async () => {
      const sample = JSON.parse(line);
      const state = await readState();
      sample.phase = state.phase;
      if (!sample.processes.some(p => p.pid === app.pid)) sample.errors.push('Root absent from snapshot');
      samples.push(sample);
      await writeFile(join(output, 'samples.json'), JSON.stringify(samples));
      if (sample.phase === 'tray-idle') {
        if (scoredStarted == null) { scoredStarted = sample.sampledAt; console.log(`Scored tray-only profile started: ${new Date(scoredStarted).toISOString()}`); }
        if (sample.sampledAt - scoredStarted >= seconds * 1000 && !stopRequested) { stopRequested = true; await writeFile(join(dataDir, 'profile-stop'), 'complete'); }
      }
    }).catch(error => stopCollection(error.message));
  }
});
const deadline = setTimeout(() => { collectorError = 'Collection deadline exceeded'; app.kill(); }, (seconds + 240) * 1000);
const code = await appExit;
clearTimeout(deadline);
samplerStopping = true;
sampler.kill();
const samplerResult = await samplerExit;
await chain;
const state = await readState();
const summary = { ...summarizeSamples(samples, cpus().length, 1800, { driverComplete: state.phase === 'complete', appExitCode: code, samplerError: samplerError || null, collectorError }), sanity, appExitCode: code, driver: state, samplerError: samplerError || null, samplerExit: samplerResult, collectorError, runtimeFailure: state.phase !== 'complete' ? appError : null };
await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ output, ...summary }, null, 2));
process.exitCode = state.phase === 'complete' && code === 0 && !samplerError && !collectorError ? 0 : 1;

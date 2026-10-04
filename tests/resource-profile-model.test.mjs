import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuDelta, summarizeSamples } from '../scripts/resource-profile-model.mjs';

const row = (pid, started, cpuSeconds, startedAt = 0) => ({ pid, started, startedAt, cpuSeconds, privateWorkingBytes: 100 * 1048576, workingBytes: 120 * 1048576 });
const sample = (sampledAt, processes, errors = []) => ({ sampledAt, processes, errors, phase: 'tray-idle' });
const completed = { driverComplete: true, appExitCode: 0, samplerError: null };

test('normalizes CPU by measured wall time and logical processor count', () => {
  const result = cpuDelta(sample(0, [row(1, 'a', 1)]), sample(5000, [row(1, 'a', 1.1)]), 4);
  assert.ok(Math.abs(result.wholeMachinePercent - 0.5) < 1e-10);
  assert.equal(result.incomplete, false);
});
test('does not subtract across PID reuse and marks missing exit CPU', () => {
  const result = cpuDelta(sample(1000, [row(1, 'a', 12)]), sample(6000, [row(1, 'b', 0.1, 2000)]), 4);
  assert.equal(result.cpuSeconds, 0.1);
  assert.equal(result.incomplete, true);
  assert.deepEqual(result.departed, ['1:a']);
});
test('includes a child born within the interval and detects missing counters', () => {
  const before = sample(1000, [row(1, 'a', 1)]);
  const after = sample(6000, [row(1, 'a', 1), row(2, 'b', 0.2, 3000)]);
  assert.equal(cpuDelta(before, after, 4).cpuSeconds, 0.2);
  assert.equal(cpuDelta(before, after, 4).incomplete, false);
  after.processes[1].cpuSeconds = null;
  assert.equal(cpuDelta(before, after, 4).incomplete, true);
});
test('short or missing profiles remain inconclusive', () => {
  assert.equal(summarizeSamples([sample(0, [row(1, 'a', 0)]), sample(5000, [row(1, 'a', 0)])], 4).complete, false);
  const samples = Array.from({ length: 361 }, (_, i) => sample(i * 5000, [row(1, 'a', 0)]));
  const passing = summarizeSamples(samples, 4, 1800, completed);
  assert.equal(passing.targets.privateWorkingMiB.result, 'passed');
  samples[100].errors.push('unavailable');
  assert.equal(summarizeSamples(samples, 4).targets.wholeMachineCpuPercent.result, 'inconclusive');
});
test('memory threshold failure remains a valid completed measurement', () => {
  const samples = Array.from({ length: 361 }, (_, i) => sample(i * 5000, [{ ...row(1, 'a', i * 0.001), privateWorkingBytes: 151 * 1048576 }]));
  const result = summarizeSamples(samples, 4, 1800, completed);
  assert.equal(result.complete, true);
  assert.equal(result.targets.privateWorkingMiB.result, 'failed');
  assert.equal(result.targets.wholeMachineCpuPercent.result, 'inconclusive');
});
test('driver failure and late sampler errors invalidate otherwise complete samples', () => {
  const samples = Array.from({ length: 361 }, (_, i) => sample(i * 5000, [row(1, 'a', 0)]));
  for (const run of [{ ...completed, driverComplete: false }, { ...completed, appExitCode: 1 }, { ...completed, samplerError: 'late sampler failure' }, { ...completed, collectorError: 'invalid sample' }, {}]) {
    const result = summarizeSamples(samples, 4, 1800, run);
    assert.equal(result.samplingComplete, true);
    assert.equal(result.complete, false);
    assert.equal(result.targets.privateWorkingMiB.result, 'inconclusive');
  }
});
test('an empty observed tree cannot pass as zero resource use', () => {
  const samples = Array.from({ length: 361 }, (_, i) => sample(i * 5000, []));
  const result = summarizeSamples(samples, 4, 1800, completed);
  assert.equal(result.emptyTreeSamples, 361);
  assert.equal(result.complete, false);
  assert.equal(result.targets.privateWorkingMiB.result, 'inconclusive');
});

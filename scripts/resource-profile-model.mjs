export function cpuDelta(previous, current, logicalProcessors) {
  if (!previous) return null;
  const seconds = (current.sampledAt - previous.sampledAt) / 1000;
  if (!(seconds > 0) || !(logicalProcessors > 0)) throw new Error('Invalid sample interval');
  const prior = new Map(previous.processes.map(p => [`${p.pid}:${p.started}`, p]));
  const present = new Set(current.processes.map(p => `${p.pid}:${p.started}`));
  let cpuSeconds = 0;
  let incomplete = Boolean(previous.errors.length || current.errors.length);
  for (const p of current.processes) {
    const old = prior.get(`${p.pid}:${p.started}`);
    if (p.cpuSeconds == null || (old && old.cpuSeconds == null)) { incomplete = true; continue; }
    if (old) {
      const delta = p.cpuSeconds - old.cpuSeconds;
      if (delta < 0) incomplete = true;
      else cpuSeconds += delta;
    } else if (p.startedAt >= previous.sampledAt) cpuSeconds += p.cpuSeconds;
    else incomplete = true;
  }
  const departed = [...prior.keys()].filter(key => !present.has(key));
  if (departed.length) incomplete = true;
  return { seconds, cpuSeconds, wholeMachinePercent: cpuSeconds / seconds / logicalProcessors * 100, incomplete, departed };
}

export function summarizeSamples(samples, logicalProcessors, requiredSeconds = 1800, run = {}) {
  const scored = samples.filter(s => s.phase === 'tray-idle');
  const values = scored.map(s => s.processes.reduce((sum, p) => sum + (p.privateWorkingBytes ?? 0), 0) / 1048576);
  const working = scored.map(s => s.processes.reduce((sum, p) => sum + (p.workingBytes ?? 0), 0) / 1048576);
  const intervals = scored.slice(1).map((s, i) => cpuDelta(scored[i], s, logicalProcessors));
  const seconds = intervals.reduce((sum, i) => sum + i.seconds, 0);
  const cpuSeconds = intervals.reduce((sum, i) => sum + i.cpuSeconds, 0);
  const errors = scored.flatMap(s => s.errors);
  const emptyTreeSamples = scored.filter(s => !s.processes.length).length;
  const missingCounters = scored.some(s => s.processes.some(p => p.privateWorkingBytes == null || p.workingBytes == null));
  const incompleteIntervals = intervals.filter(i => i.incomplete).length;
  const longGaps = intervals.filter(i => i.seconds > 15).length;
  const samplingComplete = seconds >= requiredSeconds && !errors.length && !emptyTreeSamples && !missingCounters && !incompleteIntervals && !longGaps;
  const runComplete = run.driverComplete === true && run.appExitCode === 0 && run.samplerError == null && run.collectorError == null;
  const complete = samplingComplete && runComplete;
  const stats = items => items.length ? { minimum: Math.min(...items), maximum: Math.max(...items), mean: items.reduce((a, b) => a + b, 0) / items.length } : null;
  const meanCpu = seconds ? cpuSeconds / seconds / logicalProcessors * 100 : null;
  return {
    phase: 'tray-idle', sampleCount: scored.length, elapsedSeconds: seconds, requiredSeconds,
    privateWorkingMiB: stats(values), workingMiB: stats(working), observedCpuSeconds: cpuSeconds,
    observedWholeMachineCpuPercent: meanCpu, incompleteIntervals, longGaps, counterErrors: errors.length, emptyTreeSamples, missingCounters, samplingComplete, runComplete, complete,
    cpuCoverage: 'Lower bound from sampled process identities; children born and exited between snapshots are not observed',
    targets: {
      privateWorkingMiB: { limit: 150, statistic: 'maximum sampled process-tree private working set', result: !complete ? 'inconclusive' : Math.max(...values) <= 150 ? 'passed' : 'failed' },
      wholeMachineCpuPercent: { limit: 0.5, statistic: 'observed process CPU delta / wall time / logical processors', result: complete && meanCpu >= 0.5 ? 'failed' : 'inconclusive', reason: 'Complete process-lifetime CPU accounting is not implemented' },
    },
  };
}

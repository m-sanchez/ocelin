import {
  longRunningRule,
  noActivityRule,
  repeatedToolRule,
  repeatedErrorRule,
  possibleLoopRule,
} from "./diagnostic-rules.mjs";

const defaults = Object.freeze({
  slowMs: 300000,
  quietMs: 120000,
  repeats: 5,
  errors: 3,
  cycles: 3,
});

export function diagnoseTrace(
  trace,
  {
    now = Date.now(),
    sessionLive = false,
    waiting = false,
    thresholds = {},
  } = {},
) {
  const limits = Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [
      key,
      Number.isFinite(thresholds[key]) && thresholds[key] >= 1
        ? thresholds[key]
        : fallback,
    ]),
  );
  const findings = [];
  const upstreamLimits = {
    longRunningMs: limits.slowMs,
    noActivityMs: limits.quietMs,
    repeatedToolCount: limits.repeats,
    repeatedErrorCount: limits.errors,
    loopRepeatCount: limits.cycles,
  };
  const inputFor = (turn, spans, duration = null) => ({
    now,
    run: {
      id: turn.startTs,
      startedAt: Date.parse(turn.startTs),
      duration,
      status: sessionLive && turn.open && !waiting ? "running" : "success",
    },
    spans: spans.map((span) => ({
      type: "tool",
      name: span.tool,
      startedAt: Date.parse(span.startTs),
      endedAt: span.endTs ? Date.parse(span.endTs) : null,
    })),
    logs: [{ timestamp: Date.parse(turn.lastActivityAt || turn.startTs) }],
    errors: spans
      .filter((span) => span.ok === false)
      .map((span) => ({
        type: span.tool,
        message: span.errorSignature || "failure",
      })),
  });
  const errorGroups = new Map();
  const add = (turn, type, message, spans = [], severity = "warning") => {
    findings.push({
      id: `${turn.startTs}:${type}:${spans[0]?.id || "turn"}`,
      type,
      severity,
      message,
      turn: turn.index,
      startTs: turn.startTs,
      spanIds: spans.map((span) => span.id).filter(Boolean),
      evidence: spans.map(({ id, tool, startTs, durMs, ok }) => ({
        id,
        tool,
        startTs,
        durMs,
        ok,
      })),
    });
  };
  for (const turn of trace.turns || []) {
    const spans = (turn.spans || []).filter((span) => !span.wait);
    const humanWait =
      waiting || (turn.spans || []).some((span) => span.wait && span.running);
    const waitMs = (turn.spans || [])
      .filter((span) => span.wait)
      .reduce((sum, span) => sum + (span.durMs || 0), 0);
    const duration = Number.isFinite(turn.durMs)
      ? Math.max(0, turn.durMs - waitMs)
      : null;
    if (
      !humanWait &&
      duration !== null &&
      longRunningRule(inputFor(turn, spans, duration), upstreamLimits).length
    )
      add(
        turn,
        "long_running",
        `Turn has ${Math.round(duration / 60000)} minutes of elapsed time excluding recorded human waits.`,
      );
    if (sessionLive && turn.open && !humanWait) {
      const last = Math.max(
        Date.parse(turn.startTs),
        ...spans.map((span) => Date.parse(span.endTs || span.startTs)),
        Date.parse(turn.lastActivityAt || turn.startTs),
      );
      if (
        Number.isFinite(last) &&
        noActivityRule(inputFor(turn, spans, duration), upstreamLimits).length
      )
        add(
          turn,
          "no_activity",
          `No recorded activity for ${Math.floor((now - last) / 60000)} minutes. A tool may still be working.`,
          spans.slice(-1),
        );
    }
    const calls = new Map();
    for (const span of spans) {
      const signature = `${span.tool}\u0000${span.summary || ""}`;
      const group = calls.get(signature) || [];
      group.push(span);
      calls.set(signature, group);
      if (span.ok === false) {
        const key = `${span.tool}\u0000${span.errorSignature || "failure"}`;
        const errors = errorGroups.get(key) || {
          tool: span.tool,
          count: 0,
          occurrences: [],
        };
        errors.count++;
        errors.occurrences.push({
          turn: turn.index,
          spanId: span.id,
          startTs: span.startTs,
        });
        errorGroups.set(key, errors);
      }
    }
    for (const group of calls.values()) {
      if (repeatedToolRule(inputFor(turn, group), upstreamLimits).length)
        add(
          turn,
          "repeated_tool",
          `${group[0].tool} was called ${group.length} times with the same displayed arguments. Check whether it is making progress.`,
          group,
        );
      const failures = group.filter((span) => span.ok === false);
      if (repeatedErrorRule(inputFor(turn, failures), upstreamLimits).length)
        add(
          turn,
          "repeated_error",
          `${group[0].tool} failed ${failures.length} times for the same displayed arguments.`,
          failures,
          "critical",
        );
    }
    const sequence = spans.map(
      (span) => `${span.tool}\u0000${span.summary || ""}`,
    );
    for (let width = 1; width <= 3; width++) {
      const count = width * limits.cycles;
      if (sequence.length < count) continue;
      const tail = sequence.slice(-count);
      const loopInput = inputFor(turn, spans.slice(-count));
      loopInput.spans.forEach((span, index) => {
        span.name = tail[index];
      });
      if (
        tail.every((value, index) => value === tail[index % width]) &&
        possibleLoopRule(loopInput, upstreamLimits).length
      ) {
        add(
          turn,
          "possible_loop",
          `The last ${count} calls repeat a ${width}-step pattern ${limits.cycles} times. This may be intentional.`,
          spans.slice(-count),
        );
        break;
      }
    }
  }
  return {
    findings: findings.slice(-100),
    errors: [...errorGroups.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 50),
    partial: Boolean(
      trace.truncated || trace.turns?.some((turn) => turn.spansDropped),
    ),
    thresholds: limits,
  };
}

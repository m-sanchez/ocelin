function remainingAllowance(subscriptions, provider, scope, now = Date.now()) {
  const profiles = [
    subscriptions?.[provider],
    ...(subscriptions?.profiles || []).filter((p) => p.provider === provider),
  ].filter(Boolean);
  const accounts = new Map();
  const observed = (subscriptions?.observedAccounts || []).filter(
    (a) => a.provider === provider,
  );
  const identified = profiles.some((p) => p.accountKey) || observed.length > 0;
  let unidentified = 0;
  for (const profile of profiles) {
    if (!profile.accountKey && (identified || profiles.length > 1)) {
      unidentified++;
      continue;
    }
    const key = profile.accountKey || "unidentified";
    const previous = accounts.get(key);
    if (!previous || (profile.sampledAt || 0) > (previous.sampledAt || 0))
      accounts.set(key, profile);
  }
  for (const account of observed)
    if (!accounts.has(account.key)) accounts.set(account.key, null);
  const values = [];
  let incomplete = unidentified > 0;
  for (const profile of accounts.values()) {
    if (!profile || (!profile.accountKey && accounts.size > 1)) {
      incomplete = true;
      continue;
    }
    const fresh =
      profile.status === "ready" &&
      Number.isFinite(profile.sampledAt) &&
      now >= profile.sampledAt &&
      now - profile.sampledAt <= 300000;
    const windows = (profile.windows || []).filter(
      (w) =>
        !w.extra &&
        (scope === "weekly"
          ? w.minutes === 10080
          : scope === "five-hour"
            ? w.minutes === 300
            : true),
    );
    const valid = windows.filter(
      (w) =>
        fresh &&
        Number.isFinite(w.remainingPercent) &&
        w.remainingPercent >= 0 &&
        w.remainingPercent <= 100 &&
        (w.resetsAt == null || w.resetsAt > now),
    );
    if (!valid.length || valid.length !== windows.length) incomplete = true;
    if (valid.length)
      values.push(Math.min(...valid.map((w) => w.remainingPercent)));
  }
  return {
    remainingPercent: values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : null,
    incomplete,
    accountCount: accounts.size,
    availableCount: values.length,
  };
}
function allowanceTotals(subscriptions, now = Date.now()) {
  return Object.fromEntries(
    ["lowest", "weekly", "five-hour"].map((scope) => [
      scope,
      Object.fromEntries(
        ["codex", "claude"].map((provider) => [
          provider,
          remainingAllowance(subscriptions, provider, scope, now),
        ]),
      ),
    ]),
  );
}
function allowanceSampledAt(subscriptions, now = Date.now()) {
  const times = [
    subscriptions?.codex,
    subscriptions?.claude,
    ...(subscriptions?.profiles || []),
  ]
    .filter((p) => p?.status === "ready")
    .map((p) => p?.sampledAt)
    .filter(
      (time) => Number.isFinite(time) && time <= now && now - time <= 300000,
    );
  return times.length ? Math.min(...times) : 0;
}
module.exports = { remainingAllowance, allowanceTotals, allowanceSampledAt };

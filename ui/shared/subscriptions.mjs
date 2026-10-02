const node = (tag, cls, text) => {
  const element = document.createElement(tag);
  if (cls) element.className = cls;
  if (text != null) element.textContent = text;
  return element;
};
export function allowanceDisplay(provider, entry, now = Date.now()) {
  const stale =
    !provider?.sampledAt ||
    now - provider.sampledAt > 300000 ||
    provider.sampledAt > now;
  const expired = entry?.resetsAt != null && entry.resetsAt <= now;
  const known =
    typeof entry?.remainingPercent === "number" &&
    Number.isFinite(entry.remainingPercent) &&
    entry.remainingPercent >= 0 &&
    entry.remainingPercent <= 100;
  const value =
    known && !stale && !expired && provider?.status === "ready"
      ? entry.remainingPercent
      : null;
  let resetText = "Reset time not reported";
  if (expired) resetText = "Reset reached · awaiting new reading";
  else if (entry?.resetsAt) {
    const mins = Math.max(1, Math.ceil((entry.resetsAt - now) / 60000));
    const days = Math.floor(mins / 1440),
      hours = Math.floor((mins % 1440) / 60),
      minutes = mins % 60;
    resetText = `Resets in ${days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`}`;
  }
  return {
    value,
    stale,
    text:
      value == null
        ? "Unavailable"
        : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}% left`,
    resetText,
  };
}
export function subscriptionView(
  providers,
  { providerIcon, now = Date.now() } = {},
) {
  const section = node("section", "allowances");
  section.setAttribute("aria-label", "Subscription allowance remaining");
  const heading = node("div", "allowance-heading");
  heading.append(
    node("h2", "", "Subscription allowance"),
    node(
      "span",
      "allowance-muted",
      "Combined % remaining · average per account",
    ),
  );
  section.append(heading);
  const cards = node("div", "allowance-cards");
  const values = [
    providers?.codex || { provider: "codex" },
    providers?.claude || { provider: "claude" },
    ...(Array.isArray(providers?.profiles) ? providers.profiles : []),
  ];
  const totals = node("div", "allowance-cards");
  for (const provider of ["codex", "claude"]) {
    const total = providers?.totals?.lowest?.[provider];
    if (!total) continue;
    const card = node("article", "allowance-card");
    const fresh =
      providers.totalsAt <= now && now - providers.totalsAt <= 300000;
    card.append(
      node("strong", "", provider === "codex" ? "Codex" : "Claude"),
      node(
        "p",
        "allowance-total",
        fresh && total.remainingPercent != null
          ? `${total.remainingPercent.toLocaleString(undefined, { maximumFractionDigits: 1 })}% left${total.incomplete ? "*" : ""}`
          : "Unavailable",
      ),
      node(
        "span",
        "allowance-muted",
        `${fresh ? total.availableCount : 0} of ${total.accountCount} accounts reporting`,
      ),
    );
    totals.append(card);
  }
  if (totals.children.length) section.append(totals);
  const connected = new Set(
    values.map((value) => value.accountKey).filter(Boolean),
  );
  const observed = (providers?.observedAccounts || []).filter(
    (account) => !connected.has(account.key),
  );
  for (const value of values) {
    const provider = value.provider;
    const card = node("article", "allowance-card");
    card.dataset.profile = value.profileId || `${provider}-default`;
    const header = node("div", "allowance-provider");
    if (providerIcon) header.append(providerIcon(provider));
    header.append(
      node("strong", "", provider === "codex" ? "Codex" : "Claude"),
    );
    if (value?.plan) header.append(node("span", "allowance-plan", value.plan));
    card.append(header);
    const clients = providers?.observedAccounts?.find(
      (a) => a.key === value.accountKey,
    )?.clients;
    if (clients?.length)
      card.append(
        node(
          "p",
          "allowance-muted",
          `Seen in ${clients.map((c) => (c === "cli" ? "CLI" : c === "desktop" ? "Desktop" : c)).join(" / ")}`,
        ),
      );
    if (value.profileLabel || value.accountLabel) {
      const account = node("div", "allowance-account");
      account.append(
        node("strong", "", value.profileLabel || "Default"),
        node(
          "span",
          "allowance-muted",
          value.accountLabel || "Account identity unavailable",
        ),
      );
      card.append(account);
    }
    const windows = Array.isArray(value?.windows)
      ? value.windows.slice(0, 12)
      : [];
    const extras = node("details", "allowance-extra");
    extras.append(node("summary", "", "Other model allowances"));
    for (const entry of windows) {
      const display = allowanceDisplay(value, entry, now);
      const row = node("div", "allowance-window");
      const title = node("div", "allowance-line");
      title.append(
        node("span", "", entry.label),
        node("strong", "", display.text),
      );
      row.append(title);
      if (display.value != null) {
        const progress = node("progress", "");
        progress.max = 100;
        progress.value = display.value;
        progress.setAttribute(
          "aria-label",
          `${provider} ${entry.label}: ${display.text}`,
        );
        progress.dataset.tone =
          display.value <= 10 ? "low" : display.value <= 25 ? "medium" : "good";
        row.append(progress);
      }
      const countdown = node(
        "span",
        "allowance-muted allowance-reset",
        display.resetText,
      );
      if (entry.resetsAt)
        countdown.title = new Date(entry.resetsAt).toLocaleString();
      row.append(countdown);
      (entry.extra ? extras : card).append(row);
    }
    if (extras.children.length > 1) card.append(extras);
    if (!windows.length)
      card.append(
        node(
          "p",
          "allowance-muted",
          value?.message ||
            "Open Ocelin desktop to connect subscription usage.",
        ),
      );
    const sampled = value?.sampledAt;
    const stale = sampled && (now - sampled > 300000 || sampled > now);
    const stamp = sampled
      ? `${stale ? "Reading out of date" : "Updated " + new Date(sampled).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "No reading yet";
    card.append(
      node(
        "div",
        "allowance-source",
        `${value?.source || (provider === "codex" ? "Codex sign-in" : "Claude Code sign-in")} · ${stamp}`,
      ),
    );
    cards.append(card);
  }
  for (const account of observed) {
    const card = node("article", "allowance-card");
    card.append(
      node(
        "strong",
        "",
        `${account.provider === "codex" ? "Codex" : "Claude"} · ${account.label}`,
      ),
      node(
        "p",
        "allowance-muted",
        `${account.clients?.map((c) => (c === "cli" ? "CLI" : c === "desktop" ? "Desktop" : c)).join(" / ") || "Saved sessions"} · allowance unavailable`,
      ),
      node(
        "p",
        "allowance-muted",
        "Connect this account's signed-in profile in Settings to read its allowance.",
      ),
    );
    cards.append(card);
  }
  const details = node("details", "allowance-details");
  details.append(node("summary", "", "Account details"), cards);
  section.append(details);
  section.append(
    node(
      "p",
      "allowance-muted",
      "Accounts weighted equally. * Some accounts or profiles have no current reading.",
    ),
  );
  if (values.length > 2)
    section.append(
      node(
        "p",
        "allowance-muted",
        "Profiles using the same account share its limits. Percentages are never added together.",
      ),
    );
  return section;
}

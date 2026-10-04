export function firstReturnModel(state, provider) {
  const name = provider === "codex" ? "Codex" : "Claude";
  const sources = (state.diagnostics || []).filter(
    (s) => s.provider === provider,
  );
  const candidate = (state.sessions || [])
    .filter(
      (s) =>
        s.provider === provider &&
        !state.hiddenKeys?.includes(s.key) &&
        !s.subagent &&
        !s.parentId,
    )
    .sort((a, b) => b.lastTs - a.lastTs || a.key.localeCompare(b.key))[0];
  const detected = Boolean(state.connections?.[provider]?.nativeOpen);
  const scanning = !state.sampledAt || !sources.length;
  let detail = scanning
    ? "Looking for saved conversations."
    : "No recent conversations found. Browse History for older sessions.";
  if (sources.length && sources.every((s) => s.status !== "available"))
    detail =
      "Transcript folders are unavailable. Check your source folders and account profiles in Settings.";
  if (candidate?.readOnlySource)
    detail =
      "This source supports previews. Open the conversation on its original computer.";
  else if (candidate && !detected)
    detail = `You can preview this conversation. Install or open the ${name} desktop app to enable native opening.`;
  else if (candidate)
    detail = `Check the preview, then open the conversation in ${name} using its current sign-in.`;
  return {
    name,
    candidate,
    detected,
    scanning,
    detail,
    canOpen: Boolean(candidate && detected && !candidate.readOnlySource),
  };
}

export function initFirstReturn({ action, preview, browse, settings }) {
  const $ = (id) => document.getElementById(id);
  let state;
  let pending;
  let chosen = false;
  const update = (value) => {
    state = value;
    $("first-return").hidden = value.preferences.firstReturnDismissed;
    if (!chosen && !pending) {
      const recent = [...(value.sessions || [])]
        .filter(
          (s) =>
            !value.hiddenKeys?.includes(s.key) && !s.subagent && !s.parentId,
        )
        .sort((a, b) => b.lastTs - a.lastTs);
      if (recent[0]) $("return-provider").value = recent[0].provider;
    }
    const model =
      pending?.model || firstReturnModel(value, $("return-provider").value);
    $("return-status").textContent =
      `${model.name}: ${model.detected ? "desktop app detected" : model.scanning ? "checking local sources" : "desktop app not detected"}`;
    $("return-title").textContent =
      model.candidate?.displayTitle ||
      model.candidate?.title ||
      (model.scanning ? "Discovering sessions" : "Find a saved conversation");
    $("return-project").textContent = model.candidate?.cwd || "";
    $("return-detail").textContent = pending
      ? pending.dispatched
        ? `Opening was requested for ${pending.title}. Check that this is the intended conversation in ${pending.name}.`
        : `Requesting ${pending.name} to open this conversation.`
      : model.detail;
    $("return-preview").disabled = !model.candidate || Boolean(pending);
    $("return-open").disabled = !model.canOpen || Boolean(pending);
    $("return-open").textContent =
      model.candidate?.nativeArchived && $("return-provider").value === "claude"
        ? "Restore and open in Claude"
        : `Open in ${model.name}`;
    $("return-confirm").hidden = !pending;
    $("return-confirm").disabled = !pending?.dispatched;
    $("return-retry").hidden = !pending;
    $("return-provider").disabled = Boolean(pending);
  };
  $("return-provider").addEventListener("change", () => {
    chosen = true;
    update(state);
  });
  $("return-preview").addEventListener("click", () => {
    const { candidate } = firstReturnModel(state, $("return-provider").value);
    if (candidate) preview(candidate, { focus: true });
  });
  $("return-open").addEventListener("click", async () => {
    const model = firstReturnModel(state, $("return-provider").value);
    if (!model.canOpen || pending) return;
    const request = {
      title: model.candidate.displayTitle || model.candidate.title,
      name: model.name,
      model,
      dispatched: false,
    };
    pending = request;
    update(state);
    const result = await action("session-open", { key: model.candidate.key });
    if (pending !== request) return;
    if (!result) pending = null;
    else pending.dispatched = true;
    update(state);
  });
  $("return-confirm").addEventListener("click", () =>
    action("preferences", { firstReturnDismissed: true }),
  );
  $("return-retry").addEventListener("click", () => {
    pending = null;
    chosen = true;
    update(state);
    browse();
  });
  $("return-skip").addEventListener("click", () =>
    action("preferences", { firstReturnDismissed: true }),
  );
  $("return-history").addEventListener("click", () => {
    chosen = true;
    browse();
  });
  $("return-settings").addEventListener("click", settings);
  $("return-reopen").addEventListener("click", async () => {
    pending = null;
    await action("preferences", { firstReturnDismissed: false });
    $("preferences").close();
    $("return-provider").focus();
  });
  return update;
}

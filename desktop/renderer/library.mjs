import { providerIcon } from "./icons.mjs";
import { memory } from "./session-model.mjs";
import { sessionIdentityText } from "../../ui/shared/session-identity.mjs";

const $ = (id) => document.getElementById(id);
const fileSize = (bytes) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 ** 2
      ? `${Math.ceil(bytes / 1024)} KB`
      : memory(bytes);
function element(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
function button(text, fn, cls = "") {
  const node = element("button", cls, text);
  node.type = "button";
  node.addEventListener("click", fn);
  return node;
}
let api,
  refreshNow,
  page,
  view = "now",
  sequence = 0,
  previewSequence = 0,
  hoverTimer,
  closeTimer,
  pendingPlan;
const selected = new Set();
const previewCache = new Map();
export function libraryView() {
  return view;
}
export function closePreview() {
  previewSequence++;
  clearTimeout(hoverTimer);
  $("session-peek").hidden = true;
}
export function attachPreview(row, session) {
  const title = row.querySelector(".session-title");
  const show = (delay) => {
    clearTimeout(closeTimer);
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => void peek(session), delay);
  };
  title.addEventListener("pointerenter", () => show(450));
  title.addEventListener("focusin", () => {
    if (title.matches(":focus-visible")) show(180);
  });
  title.addEventListener("pointerdown", closePreview);
  title.addEventListener("pointerleave", () => {
    clearTimeout(hoverTimer);
    closeTimer = setTimeout(closePreview, 250);
  });
  row.addEventListener("focusout", (e) => {
    if (
      !row.contains(e.relatedTarget) &&
      !$("session-peek").contains(e.relatedTarget)
    )
      closeTimer = setTimeout(closePreview, 250);
  });
}
async function peek(session) {
  if (document.hidden || document.querySelector("dialog[open]")) return;
  const serial = ++previewSequence;
  const panel = $("session-peek");
  panel.hidden = false;
  panel.replaceChildren(
    element("p", "eyebrow", "CONVERSATION PREVIEW"),
    element("h2", "", session.displayTitle || session.title),
    element("p", "muted", "Reading recent activity…"),
  );
  const cached = previewCache.get(session.key);
  const value =
    cached && Date.now() - cached.at < 15000
      ? cached.value
      : await api("session-preview", { key: session.key });
  if (serial !== previewSequence || !value) {
    if (!value && serial === previewSequence) closePreview();
    return;
  }
  previewCache.set(session.key, { value, at: Date.now() });
  if (previewCache.size > 100)
    previewCache.delete(previewCache.keys().next().value);
  const heading = element("div", "peek-heading");
  heading.append(
    providerIcon(value.provider),
    element("span", "eyebrow", value.provider === "codex" ? "CODEX" : "CLAUDE"),
    button("×", closePreview, "peek-close"),
  );
  const title = element("h2", "", value.displayTitle);
  const project = element(
    "p",
    "peek-project",
    `${value.cwd || "No saved workspace"}${value.workspaceExists ? "" : " · folder unavailable"}`,
  );
  panel.replaceChildren(heading, title, project);
  panel.append(element("p", "muted", sessionIdentityText(value)));
  if (value.profiles?.length)
    panel.append(
      element(
        "p",
        "muted",
        `Source profile: ${value.profiles.map((p) => p.label).join(" · ")}`,
      ),
    );
  if (value.previewWarning)
    panel.append(element("p", "muted", value.previewWarning));
  for (const [label, text] of [
    ["Latest request", value.request],
    ["Latest response", value.response],
  ]) {
    panel.append(
      element("h3", "eyebrow", label),
      element(
        "p",
        "peek-text",
        text || "No text in the recent transcript window.",
      ),
    );
  }
  if (value.activity?.length) {
    panel.append(element("h3", "eyebrow", "Recent tools"));
    for (const tool of value.activity)
      panel.append(
        element(
          "p",
          "peek-tool",
          `${tool.result ? (tool.result.ok ? "✓" : "!") : "·"} ${tool.tool} ${tool.summary || ""}`,
        ),
      );
  }
  if (value.diagnostics?.findings.length) {
    panel.append(element("h3", "eyebrow", "Worth checking"));
    for (const finding of value.diagnostics.findings.slice(-5))
      panel.append(
        element(
          "p",
          "peek-tool",
          `Turn ${finding.turn + 1}: ${finding.message}`,
        ),
      );
    panel.append(
      element(
        "p",
        "muted",
        "Heuristics from recent transcript history; session status is unchanged.",
      ),
    );
  }
  panel.append(
    element(
      "p",
      "muted",
      `${new Date(value.lastTs).toLocaleString()} · ${fileSize(value.bytes)} transcript${value.model ? ` · ${value.model}` : ""}`,
    ),
  );
  if (value.readOnlySource)
    panel.append(
      element(
        "p",
        "muted",
        "Read-only source. Continue this conversation on its original host.",
      ),
    );
  else
    panel.append(
      button(
        `${value.provider === "claude" && value.nativeArchived ? "Restore and open" : "Open"} in ${value.provider === "codex" ? "Codex" : "Claude"}`,
        () => api("session-open", { key: value.key }),
        "primary",
      ),
    );
}
export { peek as previewSession };
export async function showLibrary(next) {
  view = next;
  closePreview();
  selected.clear();
  for (const tab of document.querySelectorAll("[data-view]"))
    tab.setAttribute("aria-selected", String(tab.dataset.view === view));
  $("live-view").hidden = view !== "now";
  $("library-view").hidden = view === "now";
  if (view === "now") refreshNow();
  else await query();
}
async function query(offset = 0, continueSearch = false) {
  const serial = ++sequence;
  $("library-more").disabled = true;
  $("library-status").textContent = "Loading your session library…";
  const result = await api("library-query", {
    view,
    search: $("library-search").value,
    provider: $("library-provider").value,
    olderDays: Number($("library-age").value),
    missingWorkspace: $("library-missing").checked,
    fullText: $("library-fulltext").checked,
    continueSearch,
    offset,
  });
  if (serial !== sequence) return;
  $("library-more").disabled = false;
  if (!result) {
    $("library-status").textContent =
      "Could not load the library. Change a filter to retry.";
    return;
  }
  if (offset && page?.generation !== result.generation) {
    selected.clear();
    return query();
  }
  page = result;
  $("library-search-more").hidden = !result.searchProgress?.more;
  if (!offset) $("library-rows").replaceChildren();
  for (const session of result.entries) {
    if (
      offset &&
      [...$("library-rows").children].some(
        (row) => row.dataset.key === session.key,
      )
    )
      continue;
    const row = element("article", "library-row");
    row.dataset.key = session.key;
    const check = element("input");
    check.type = "checkbox";
    check.checked = selected.has(session.key);
    check.setAttribute("aria-label", `Select ${session.displayTitle}`);
    check.addEventListener("change", () => {
      check.checked ? selected.add(session.key) : selected.delete(session.key);
      selection();
    });
    const title = button(
      session.displayTitle,
      () =>
        session.readOnlySource
          ? peek(session)
          : api("session-open", { key: session.key }),
      "session-title",
    );
    if (session.provider === "claude" && session.nativeArchived)
      title.setAttribute(
        "aria-label",
        `Restore and open in Claude: ${session.displayTitle}`,
      );
    const info = element("div", "library-name");
    info.append(
      title,
      element("span", "muted", sessionIdentityText(session)),
      element(
        "span",
        "muted",
        `${session.title}${session.profiles?.length ? ` · ${session.profiles.map((p) => p.label).join(" / ")}` : ""}${session.workspaceExists ? "" : " · missing folder"}${session.archiveScope ? ` · ${session.archiveScope}` : ""}${session.provider === "claude" && session.nativeArchived ? " · opening restores it" : ""}`,
      ),
    );
    const age = element(
      "time",
      "age",
      new Date(session.lastTs).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "2-digit",
      }),
    );
    age.title = new Date(session.lastTs).toLocaleString();
    const size = element("span", "library-size", fileSize(session.bytes));
    const more = element("details", "session-actions");
    const label = element("summary", "action-menu", "⋯");
    label.setAttribute("aria-label", `Actions for ${session.displayTitle}`);
    const actions = element("div", "action-panel");
    actions.append(
      button(session.hidden ? "Show in Ocelin" : "Hide in Ocelin", () =>
        plan(session.hidden ? "unhide" : "hide", [session.key]),
      ),
    );
    if (session.provider === "codex" && !session.readOnlySource)
      actions.append(
        button(
          session.nativeArchived ? "Restore in Codex" : "Archive in Codex",
          () =>
            plan(session.nativeArchived ? "unarchive" : "archive", [
              session.key,
            ]),
        ),
      );
    more.append(label, actions);
    row.append(check, providerIcon(session.provider), info, size, age, more);
    attachPreview(row, session);
    $("library-rows").append(row);
  }
  if (!result.total)
    $("library-rows").append(
      element("p", "empty", "No saved conversations match these filters."),
    );
  $("library-more").hidden = result.next == null;
  $("library-status").textContent =
    `${result.total.toLocaleString()} conversations · ${result.indexed.toLocaleString()} indexed · hover to preview, click to open${result.diagnostics.some((d) => d.capped) ? " · source limit reached" : ""}`;
  if (result.searchProgress) {
    const progress = result.searchProgress;
    $("library-status").textContent +=
      ` · searched ${progress.scanned}/${progress.total} transcripts${progress.partial ? ` · ${progress.partial} unreadable or partially searched` : ""}`;
  }
  selection();
}
function selection() {
  $("selection-count").textContent = `${selected.size} selected`;
  for (const b of document.querySelectorAll("[data-bulk]"))
    b.disabled = !selected.size;
}
async function plan(operation, keys = [...selected]) {
  closePreview();
  pendingPlan = await api("library-plan", { operation, keys });
  if (!pendingPlan) return;
  $("cleanup-title").textContent =
    `${operation === "hide" ? "Hide" : operation === "unhide" ? "Show" : operation === "archive" ? "Archive" : "Restore"} ${pendingPlan.count} ${pendingPlan.count === 1 ? "conversation" : "conversations"}`;
  $("cleanup-scope").textContent =
    `${pendingPlan.scope} · keeps the original files · no disk space freed`;
  $("cleanup-note").textContent = pendingPlan.note;
  $("cleanup-items").replaceChildren(
    ...pendingPlan.entries.map((e) =>
      element("li", "", `${e.provider} · ${e.displayTitle}`),
    ),
  );
  $("cleanup-result").textContent = "";
  $("cleanup-apply").disabled = false;
  $("cleanup-dialog").showModal();
}
export function initLibrary(action, renderNow) {
  api = action;
  refreshNow = renderNow;
  for (const tab of document.querySelectorAll("[data-view]"))
    tab.addEventListener("click", () => showLibrary(tab.dataset.view));
  let searchTimer;
  $("library-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      selected.clear();
      void query();
    }, 180);
  });
  for (const id of [
    "library-provider",
    "library-age",
    "library-missing",
    "library-fulltext",
  ])
    $(id).addEventListener("change", () => {
      selected.clear();
      void query();
    });
  $("library-more").addEventListener("click", () => query(page.next));
  $("library-search-more").addEventListener("click", () => query(0, true));
  $("select-page").addEventListener("click", () => {
    for (const row of $("library-rows").querySelectorAll(".library-row")) {
      if (selected.size >= 100) break;
      selected.add(row.dataset.key);
      row.querySelector("input").checked = true;
    }
    selection();
  });
  $("clear-selection").addEventListener("click", () => {
    selected.clear();
    for (const c of $("library-rows").querySelectorAll("input"))
      c.checked = false;
    selection();
  });
  for (const b of document.querySelectorAll("[data-bulk]"))
    b.addEventListener("click", () => plan(b.dataset.bulk));
  $("cleanup-apply").addEventListener("click", async () => {
    $("cleanup-apply").disabled = true;
    const result = await api("library-apply", { id: pendingPlan.id });
    if (!result) {
      $("cleanup-result").textContent =
        "Nothing further will be changed. Close and review a fresh preview.";
      return;
    }
    const failed = result.results.filter((r) => !r.ok);
    $("cleanup-result").textContent = failed.length
      ? failed.map((r) => r.error).join("\n")
      : "Done. You can reverse this from History or Archived.";
    selected.clear();
    previewCache.clear();
    await query();
  });
  $("session-peek").addEventListener("pointerenter", () =>
    clearTimeout(closeTimer),
  );
  $("session-peek").addEventListener("pointerleave", () => {
    closeTimer = setTimeout(closePreview, 250);
  });
  $("session-peek").addEventListener("focusin", () => clearTimeout(closeTimer));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePreview();
  });
  selection();
}

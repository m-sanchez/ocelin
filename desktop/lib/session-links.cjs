const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
function sessionLink(session) {
  if (session?.readOnlySource)
    throw new Error(
      "Open this conversation on its source host. Imported and WSL sources are read-only.",
    );
  if (!session || !idPattern.test(session.sessionId))
    throw new Error("Invalid conversation ID");
  if (session.provider === "codex")
    return `codex://threads/${session.sessionId}`;
  if (session.provider === "claude")
    return `claude://resume?session=${session.sessionId}`;
  throw new Error("Unknown conversation provider");
}
function activation(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "ocelin:" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      return null;
    if (url.hostname === "dashboard" && ["", "/"].includes(url.pathname))
      return { type: "dashboard" };
    if (url.hostname === "panel" && ["", "/"].includes(url.pathname))
      return { type: "panel" };
    const match = url.pathname.match(
      /^\/(codex|claude)\/([a-zA-Z0-9_-]{1,128})$/,
    );
    if (url.hostname === "session" && match)
      return { type: "session", key: `${match[1]}:${match[2]}` };
  } catch {}
  return null;
}
function activationUri(session) {
  sessionLink(session);
  return `ocelin://session/${session.provider}/${session.sessionId}`;
}
module.exports = { sessionLink, activation, activationUri };

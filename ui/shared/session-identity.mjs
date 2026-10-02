const names = {
  cli: "CLI",
  desktop: "Desktop",
  ide: "IDE",
  exec: "Exec",
  "app-server": "App server",
};
export function sessionIdentityText(session) {
  const clients = (session.identity?.clients || [])
    .map((client) => names[client])
    .filter(Boolean);
  const accounts = (session.identity?.accounts || []).map(
    (account) => account.label,
  );
  return `${clients.length ? clients.join(" / ") : "Client unknown"} · ${accounts.length ? accounts.join(" / ") : "Account unknown"}`;
}

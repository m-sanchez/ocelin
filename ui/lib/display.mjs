export const displayOptions = {
  metrics: "Summary numbers and activity charts",
  runs: "Runs and background jobs",
  repository: "Git, reviews and delivery cards",
  health: "System health and resource details",
  activity: "Recent activity and event feed",
  advancedNavigation: "Advanced workspace navigation",
};
export const simpleDisplay = Object.fromEntries(
  Object.keys(displayOptions).map((key) => [key, false]),
);
export function normalizeDisplay(value = {}, previous = simpleDisplay) {
  return Object.fromEntries(
    Object.keys(displayOptions).map((key) => [
      key,
      typeof value?.[key] === "boolean" ? value[key] : previous[key],
    ]),
  );
}

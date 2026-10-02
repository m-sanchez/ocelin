import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { displayOptions, normalizeDisplay } from "../../ui/lib/display.mjs";

export function readDisplay(file) {
  try {
    return normalizeDisplay(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return normalizeDisplay();
  }
}
export function saveDisplay(file, patch) {
  if (
    !patch ||
    Array.isArray(patch) ||
    typeof patch !== "object" ||
    Object.entries(patch).some(
      ([key, value]) =>
        !Object.hasOwn(displayOptions, key) || typeof value !== "boolean",
    )
  )
    throw new Error(
      "Choose supported display options with true or false values",
    );
  const value = normalizeDisplay(patch, readDisplay(file));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return value;
}

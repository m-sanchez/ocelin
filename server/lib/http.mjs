// @ts-check
/**
 * HTTP/SSE primitives for the panel service. Pure transport concerns only:
 * JSON/file responses, a hardened static-file resolver, HTML escaping, and the
 * SSE client registry. No adapter or repository knowledge lives here.
 */
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

// Same policy for every document/script response. 'unsafe-inline' is required
// only for the bootstrap style/script tags; everything else is same-origin.
export const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
  "connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/**
 * Log a caught error server-side without returning its text to a client, so an
 * error response can never leak a stack trace or an absolute path.
 */
export function logServerError(context, error) {
  try {
    console.error(
      `[ocelin] ${context}:`,
      error?.stack ?? error?.message ?? error,
    );
  } catch {
    /* logging must never throw into the response path */
  }
}

/** Escape a string for safe interpolation into HTML/log views. */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;",
  );
}

export function sendJson(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(status, {
    "content-type": CONTENT_TYPES[".json"],
    "content-length": Buffer.byteLength(body),
    "content-security-policy": CSP,
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  response.end(body);
}

export function sendText(
  response,
  status,
  text,
  contentType = "text/plain; charset=utf-8",
) {
  const body = String(text);
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    ...SECURITY_HEADERS,
  });
  response.end(body);
}

/**
 * Serve a single file that is guaranteed to live under `rootDir`. The requested
 * relative path is normalised and rejected if it escapes the root, so the
 * repository is never exposed as static content.
 */
export async function sendStaticFile(response, rootDir, relativePath) {
  const safeRelative = normalize(relativePath).replace(/^([/\\])+/, "");
  const absolute = resolve(rootDir, safeRelative);
  const rootResolved = resolve(rootDir);
  if (absolute !== rootResolved && !absolute.startsWith(rootResolved + sep)) {
    sendJson(response, 403, { error: "Path outside the static root" });
    return;
  }
  const type = CONTENT_TYPES[extname(absolute).toLowerCase()];
  if (!type) {
    sendJson(response, 403, { error: "Unsupported file type" });
    return;
  }
  try {
    const body = await readFile(absolute);
    response.writeHead(200, {
      "content-type": type,
      "content-length": body.length,
      "content-security-policy": CSP,
      ...SECURITY_HEADERS,
    });
    response.end(body);
  } catch (error) {
    const notFound = error?.code === "ENOENT";
    logServerError("static file read failed", error);
    sendJson(response, notFound ? 404 : 500, {
      error: notFound ? "Not found" : "Could not read the requested file",
    });
  }
}

/** Serve an exact file path (already validated by the caller) with a content type. */
export async function sendExactFile(response, absolutePath, contentType) {
  try {
    const body = await readFile(absolutePath);
    response.writeHead(200, {
      "content-type": contentType,
      "content-length": body.length,
      "content-security-policy": CSP,
      ...SECURITY_HEADERS,
    });
    response.end(body);
  } catch (error) {
    const notFound = error?.code === "ENOENT";
    logServerError("exact file read failed", error);
    sendJson(response, notFound ? 404 : 500, {
      error: notFound ? "Not found" : "Could not read the requested file",
    });
  }
}

export { CONTENT_TYPES, join };

/**
 * SSE hub: tracks connected clients and broadcasts named events. Bounded, a
 * dead socket is dropped on write failure so the set never leaks.
 */
export class EventHub {
  constructor() {
    /** @type {Set<import('node:http').ServerResponse>} */
    this.clients = new Set();
  }

  add(response) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-content-type-options": "nosniff",
    });
    response.write("retry: 3000\n\n");
    this.clients.add(response);
    return () => this.clients.delete(response);
  }

  broadcast(event, payload) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of [...this.clients]) {
      try {
        client.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  closeAll() {
    for (const client of [...this.clients]) {
      try {
        client.end();
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
  }
}

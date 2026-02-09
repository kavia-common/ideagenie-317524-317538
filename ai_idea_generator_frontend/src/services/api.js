const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Attempt to parse JSON; if it fails, return text (useful for error bodies).
 */
async function safeParseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Build an absolute URL for API calls.
 * CRA proxy can be used in development by setting REACT_APP_API_BASE_URL to empty and using /api,
 * but in this project we default to same-origin "/".
 */
function getApiBaseUrl() {
  return (process.env.REACT_APP_API_BASE_URL || "").replace(/\/+$/, "");
}

/**
 * @param {string} path
 */
function buildUrl(path) {
  const base = getApiBaseUrl();
  if (!base) return path; // same-origin
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

/**
 * Make an HTTP request with timeout + JSON handling.
 * @param {string} path
 * @param {RequestInit & { timeoutMs?: number }} options
 */
async function request(path, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(buildUrl(path), {
      ...fetchOptions,
      headers: {
        Accept: "application/json",
        ...(fetchOptions.body ? { "Content-Type": "application/json" } : {}),
        ...(fetchOptions.headers || {}),
      },
      signal: controller.signal,
    });

    const body = await safeParseBody(res);

    if (!res.ok) {
      const message =
        (body && typeof body === "object" && (body.detail || body.message)) ||
        (typeof body === "string" ? body : null) ||
        `Request failed with status ${res.status}`;
      const err = new Error(message);
      err.status = res.status;
      err.body = body;
      throw err;
    }

    return body;
  } catch (e) {
    if (e?.name === "AbortError") {
      throw new Error("Request timed out. Please try again.");
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// PUBLIC_INTERFACE
export async function healthCheck() {
  /** Health check endpoint. */
  return request("/", { method: "GET" });
}

/**
 * NOTE: Backend OpenAPI currently only exposes "/" in the downloaded spec.
 * We implement the expected endpoints for the AI idea generator work item.
 * If backend routes differ, update these paths to match /openapi.json.
 */

// PUBLIC_INTERFACE
export async function generateIdeas({ topic, tone, count }) {
  /** Generate ideas for a topic/question. */
  return request("/api/generate", {
    method: "POST",
    body: JSON.stringify({ topic, tone, count }),
  });
}

// PUBLIC_INTERFACE
export async function saveIdea({ topic, idea }) {
  /** Save a generated idea. */
  return request("/api/ideas", {
    method: "POST",
    body: JSON.stringify({ topic, idea }),
  });
}

// PUBLIC_INTERFACE
export async function listSavedIdeas() {
  /** List previously saved ideas. */
  return request("/api/ideas", { method: "GET" });
}

// PUBLIC_INTERFACE
export async function shareIdea({ ideaId }) {
  /** Create a share link/token for an idea. */
  return request(`/api/ideas/${encodeURIComponent(ideaId)}/share`, {
    method: "POST",
  });
}

// PUBLIC_INTERFACE
export async function exportIdea({ ideaId, format }) {
  /** Export an idea in a given format. Returns either JSON or text depending on backend. */
  return request(`/api/ideas/${encodeURIComponent(ideaId)}/export`, {
    method: "POST",
    body: JSON.stringify({ format }),
  });
}

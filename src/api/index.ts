import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Fastify from "fastify";
import { z } from "zod";
import { createSessionCookie, clearSessionCookie, isAuthenticated } from "./auth.js";

const app = Fastify({ logger: true });

const internalPort = Number(process.env.INTERNAL_API_PORT ?? 8787);
const publicPort = Number(process.env.PUBLIC_API_PORT ?? 8080);
const accessToken = process.env.ADMIRAL_ACCESS_TOKEN ?? "";
const sessionSecret = process.env.SESSION_SECRET ?? "change-me";
const sessionTtlSeconds = Number(process.env.SESSION_TTL_SECONDS ?? 60 * 60 * 12);

// Refuse to start with the default secret in production.
if ((sessionSecret === "change-me" || sessionSecret === "") && process.env.NODE_ENV === "production") {
  console.error("FATAL: SESSION_SECRET must be set to a strong secret in production. Refusing to start.");
  process.exit(1);
} else if (sessionSecret === "change-me" || sessionSecret === "") {
  console.warn("WARNING: SESSION_SECRET is using the default value. Set a strong secret before deploying.");
}

// Simple in-memory login rate limiter: max 5 failed attempts per IP per 5 minutes.
const LOGIN_RATE_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_RATE_MAX_FAILURES = 5;
const loginFailures = new Map<string, number[]>();

function isLoginRateLimited(ip: string): boolean {
  const now = Date.now();
  const attempts = (loginFailures.get(ip) ?? []).filter((t) => now - t < LOGIN_RATE_WINDOW_MS);
  loginFailures.set(ip, attempts);
  return attempts.length >= LOGIN_RATE_MAX_FAILURES;
}

function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const attempts = (loginFailures.get(ip) ?? []).filter((t) => now - t < LOGIN_RATE_WINDOW_MS);
  attempts.push(now);
  loginFailures.set(ip, attempts);
}

function clearLoginFailures(ip: string): void {
  loginFailures.delete(ip);
}

// Defense-in-depth: check Origin/Referer matches our domain on state-changing routes.
const mutatingPaths = new Set(["/login", "/override", "/heartbeat", "/logout", "/day-override", "/day-override-delete"]);
const allowedHost = process.env.ADMIRAL_DOMAIN ?? "";

function originAllowed(request: { headers: Record<string, string | string[] | undefined>; ip: string }): boolean {
  if (!allowedHost) return true; // not configured, skip check
  const origin = request.headers["origin"];
  const referer = request.headers["referer"];
  const check = (origin ?? referer ?? "") as string;
  if (!check) return true; // same-origin requests without header (e.g. curl) — allow
  try {
    const { host } = new URL(check);
    return host === allowedHost;
  } catch {
    return false;
  }
}

const loginSchema = z.object({ token: z.string().min(1) });
const heartbeatSchema = z.object({ device_id: z.string().min(1) });
const overrideSchema = z.object({ action: z.enum(["force_join", "force_leave", "standdown_on", "standdown_off", "standdown_session", "standdown_session_cancel"]) });
const dayOverrideSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  op: z.enum(["cancel", "swap", "add"]),
  courseId: z.string().min(1).optional(),
  a: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  b: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional()
});
const dayOverrideDeleteSchema = z.object({ id: z.number().int().positive() });

const publicFiles: Record<string, string> = {
  "/": resolve("web/index.html"),
  "/app.js": resolve("web/app.js"),
  "/today": resolve("web/today.html"),
  "/today.js": resolve("web/today.js"),
  "/participant-stats": resolve("web/participant-stats.html"),
  "/participant-stats.js": resolve("web/participant-stats.js"),
  "/manifest.json": resolve("web/manifest.json"),
  "/sw.js": resolve("web/sw.js")
};

app.addHook("onRequest", async (request, reply) => {
  const path = request.url.split("?")[0] ?? "/";
  const isPublicRoute = path in publicFiles || path === "/login" || path === "/health" || path === "/logout";
  if (isPublicRoute) return;

  const authOk = isAuthenticated(request.headers.cookie, sessionSecret);
  if (!authOk) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

app.addHook("onRequest", async (request, reply) => {
  const path = request.url.split("?")[0] ?? "/";
  if (request.method === "POST" && mutatingPaths.has(path)) {
    if (!originAllowed(request as any)) {
      return reply.code(403).send({ error: "Forbidden: origin mismatch" });
    }
  }
});

for (const [routePath, filePath] of Object.entries(publicFiles)) {
  app.get(routePath, async (_request, reply) => {
    const content = await readFile(filePath, "utf8");
    if (routePath.endsWith(".json")) reply.type("application/json");
    if (routePath.endsWith(".js")) reply.type("application/javascript");
    // Check the file (not the route) so extensionless page routes like
    // /participant-stats are still served as HTML.
    if (filePath.endsWith(".html")) reply.type("text/html");
    return reply.send(content);
  });
}

app.post("/login", async (request, reply) => {
  const ip = request.ip;
  if (isLoginRateLimited(ip)) {
    return reply.code(429).send({ error: "Too many login attempts. Please wait a few minutes." });
  }

  const body = loginSchema.parse(request.body);
  if (!accessToken || body.token !== accessToken) {
    recordLoginFailure(ip);
    return reply.code(401).send({ error: "Invalid token" });
  }

  clearLoginFailures(ip);
  reply.header("Set-Cookie", createSessionCookie(sessionSecret, sessionTtlSeconds));
  return { ok: true };
});

app.post("/logout", async (_request, reply) => {
  reply.header("Set-Cookie", clearSessionCookie());
  return { ok: true };
});

app.get("/health", async (request, reply) => {
  // Proxy the worker's liveness check: this is the endpoint the watchdog and
  // any external monitor should hit. It returns 503 if the worker is alive but
  // the engine has stopped ticking (e.g. a hung tick), which Docker's
  // healthcheck / autoheal can use to restart a wedged container.
  try {
    const res = await fetch(`http://127.0.0.1:${internalPort}/internal/health`, {
      signal: AbortSignal.timeout(5_000)
    });
    const body = await res.json().catch(() => ({ ok: false, service: "worker", ts: new Date().toISOString() }));
    return reply.code(res.status).send(body);
  } catch {
    return reply.code(503).send({ ok: false, service: "worker", error: "worker unreachable", ts: new Date().toISOString() });
  }
});

app.get("/status", async () => {
  const res = await fetch(`http://127.0.0.1:${internalPort}/internal/status`, {
    signal: AbortSignal.timeout(5_000)
  });
  return res.json();
});

app.get("/history", async (request) => {
  const queryIndex = request.url.indexOf("?");
  const query = queryIndex >= 0 ? request.url.slice(queryIndex) : "";
  const res = await fetch(`http://127.0.0.1:${internalPort}/internal/history${query}`, {
    signal: AbortSignal.timeout(5_000)
  });
  return res.json();
});

app.get("/participant-samples", async (request) => {
  const queryIndex = request.url.indexOf("?");
  const query = queryIndex >= 0 ? request.url.slice(queryIndex) : "";
  const res = await fetch(`http://127.0.0.1:${internalPort}/internal/participant-samples${query}`, {
    signal: AbortSignal.timeout(5_000)
  });
  return res.json();
});

app.get("/day-overrides", async (request, reply) => {
  try {
    const query = new URL(request.url, "http://localhost").searchParams;
    const date = query.get("date");
    if (date != null) {
      dayOverrideSchema.pick({ date: true }).parse({ date });
    }
    const querySuffix = date ? `?date=${encodeURIComponent(date)}` : "";
    const res = await fetch(`http://127.0.0.1:${internalPort}/internal/day-overrides${querySuffix}`, {
      signal: AbortSignal.timeout(5_000)
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: "Internal day-overrides proxy failed" }));
      return reply.code(502).send(body);
    }
    return res.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(400).send({ error: message });
  }
});

app.post("/heartbeat", async (request, reply) => {
  const body = heartbeatSchema.parse(request.body);
  const res = await fetch(`http://127.0.0.1:${internalPort}/internal/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000)
  });

  if (!res.ok) {
    return reply.code(502).send({ error: "Internal heartbeat proxy failed" });
  }

  return { ok: true };
});

app.post("/override", async (request, reply) => {
  const body = overrideSchema.parse(request.body);
  const res = await fetch(`http://127.0.0.1:${internalPort}/internal/override`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000)
  });

  if (!res.ok) {
    return reply.code(502).send({ error: "Internal override proxy failed" });
  }

  return { ok: true };
});

app.post("/day-override", async (request, reply) => {
  const body = dayOverrideSchema.parse(request.body);
  const res = await fetch(`http://127.0.0.1:${internalPort}/internal/day-override`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000)
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    return reply.code(res.status === 400 ? 400 : 502).send(payload.error ? payload : { error: "Internal day-override proxy failed" });
  }

  return payload;
});

app.post("/day-override-delete", async (request, reply) => {
  const body = dayOverrideDeleteSchema.parse(request.body);
  const res = await fetch(`http://127.0.0.1:${internalPort}/internal/day-override-delete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000)
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    return reply.code(res.status === 404 ? 404 : 502).send(payload.error ? payload : { error: "Internal day-override-delete proxy failed" });
  }

  return payload;
});

app.get("/events", async (request, reply) => {
  const abortController = new AbortController();
  const onClientClose = (): void => {
    abortController.abort();
  };
  request.raw.on("close", onClientClose);

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${internalPort}/internal/events`, {
      signal: abortController.signal
    });
  } catch (error) {
    request.raw.off("close", onClientClose);

    if (abortController.signal.aborted) {
      // Client disconnected before upstream SSE connected.
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    return reply.code(502).send({ error: `Unable to connect internal events stream: ${message}` });
  }

  if (!res.ok || !res.body) {
    request.raw.off("close", onClientClose);
    return reply.code(502).send({ error: "Unable to open internal events stream" });
  }

  reply.hijack();
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  reply.raw.flushHeaders?.();

  try {
    for await (const chunk of res.body as any) {
      if (reply.raw.destroyed || reply.raw.writableEnded) break;
      reply.raw.write(chunk);
    }
  } catch (error) {
    const isAbort = abortController.signal.aborted;
    if (!isAbort) {
      const message = error instanceof Error ? error.message : String(error);
      request.log.warn({ err: error }, `SSE proxy stream error: ${message}`);
    }
  } finally {
    request.raw.off("close", onClientClose);
    abortController.abort();
    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      reply.raw.end();
    }
  }

  return;
});

await app.listen({ port: publicPort, host: "0.0.0.0" });
console.log(`Admiral public API started on ${publicPort}`);

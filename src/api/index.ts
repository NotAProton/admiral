import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Fastify from "fastify";
import { z } from "zod";
import { createSessionCookie, isAuthenticated } from "./auth.js";

const app = Fastify({ logger: true });

const internalPort = Number(process.env.INTERNAL_API_PORT ?? 8787);
const publicPort = Number(process.env.PUBLIC_API_PORT ?? 8080);
const accessToken = process.env.ADMIRAL_ACCESS_TOKEN ?? "";
const sessionSecret = process.env.SESSION_SECRET ?? "change-me";
const sessionTtlSeconds = Number(process.env.SESSION_TTL_SECONDS ?? 60 * 60 * 12);

const loginSchema = z.object({ token: z.string().min(1) });
const heartbeatSchema = z.object({ device_id: z.string().min(1) });
const overrideSchema = z.object({ action: z.enum(["force_join", "force_leave", "standdown_on", "standdown_off"]) });

const publicFiles: Record<string, string> = {
  "/": resolve("web/index.html"),
  "/app.js": resolve("web/app.js"),
  "/manifest.json": resolve("web/manifest.json"),
  "/sw.js": resolve("web/sw.js")
};

app.addHook("onRequest", async (request, reply) => {
  const path = request.url.split("?")[0] ?? "/";
  const isPublicRoute = path in publicFiles || path === "/login" || path === "/health";
  if (isPublicRoute) return;

  const authOk = isAuthenticated(request.headers.cookie, sessionSecret);
  if (!authOk) {
    reply.code(401).send({ error: "Unauthorized" });
  }
});

for (const [routePath, filePath] of Object.entries(publicFiles)) {
  app.get(routePath, async (_request, reply) => {
    const content = await readFile(filePath, "utf8");
    if (routePath.endsWith(".json")) reply.type("application/json");
    if (routePath.endsWith(".js")) reply.type("application/javascript");
    if (routePath.endsWith(".html") || routePath === "/") reply.type("text/html");
    return reply.send(content);
  });
}

app.post("/login", async (request, reply) => {
  const body = loginSchema.parse(request.body);
  if (!accessToken || body.token !== accessToken) {
    return reply.code(401).send({ error: "Invalid token" });
  }

  reply.header("Set-Cookie", createSessionCookie(sessionSecret, sessionTtlSeconds));
  return { ok: true };
});

app.get("/health", async () => {
  return { ok: true, service: "api", ts: new Date().toISOString() };
});

app.get("/status", async () => {
  const res = await fetch(`http://127.0.0.1:${internalPort}/internal/status`);
  return res.json();
});

app.post("/heartbeat", async (request, reply) => {
  const body = heartbeatSchema.parse(request.body);
  const res = await fetch(`http://127.0.0.1:${internalPort}/internal/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
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
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    return reply.code(502).send({ error: "Internal override proxy failed" });
  }

  return { ok: true };
});

app.get("/events", async (request, reply) => {
  const abortController = new AbortController();
  request.raw.on("close", () => abortController.abort());

  const res = await fetch(`http://127.0.0.1:${internalPort}/internal/events`, {
    signal: abortController.signal
  });

  if (!res.ok || !res.body) {
    return reply.code(502).send({ error: "Unable to open internal events stream" });
  }

  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  reply.raw.flushHeaders?.();

  for await (const chunk of res.body as any) {
    reply.raw.write(chunk);
  }

  reply.raw.end();
  return reply;
});

await app.listen({ port: publicPort, host: "0.0.0.0" });
console.log(`Admiral public API started on ${publicPort}`);

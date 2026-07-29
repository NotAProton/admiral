import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { HeartbeatPayload, OverrideAction, StatusResponse } from "../shared/types.js";
import { AdmiralEngine } from "./engine.js";

const heartbeatSchema = z.object({
  device_id: z.string().min(1)
});

const overrideSchema = z.object({
  action: z.enum(["force_join", "force_leave", "standdown_on", "standdown_off", "standdown_session", "standdown_session_cancel"])
});

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional()
});

function writeSse(reply: FastifyReply, event: string, payload: StatusResponse): void {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function startInternalApi(engine: AdmiralEngine, port: number): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  app.get("/internal/health", async (request, reply) => {
    const alive = engine.isAlive();
    const body = {
      ok: alive,
      service: "worker",
      alive,
      lastTickMs: engine.getLastTickMs(),
      lastTickAgeSeconds: Math.round((Date.now() - engine.getLastTickMs()) / 1000),
      ts: new Date().toISOString()
    };
    if (!alive) {
      return reply.code(503).send(body);
    }
    return body;
  });

  app.get("/internal/status", async () => {
    return engine.getStatus();
  });

  app.get(
    "/internal/history",
    async (request: FastifyRequest<{ Querystring: { limit?: string; before?: string } }>) => {
      const query = historyQuerySchema.parse(request.query ?? {});
      return { events: engine.getHistory(query.limit, query.before) };
    }
  );

  app.post("/internal/heartbeat", async (request: FastifyRequest<{ Body: HeartbeatPayload }>) => {
    const body = heartbeatSchema.parse(request.body);
    engine.recordHeartbeat(body.device_id);
    return { ok: true };
  });

  app.post("/internal/override", async (request: FastifyRequest<{ Body: { action: OverrideAction } }>) => {
    const body = overrideSchema.parse(request.body);
    engine.applyOverride(body.action);
    return { ok: true };
  });

  app.get("/internal/events", async (request, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.flushHeaders?.();

    writeSse(reply, "status", engine.getStatus());

    const unsubscribe = engine.subscribe((status) => {
      writeSse(reply, "status", status);
    });

    request.raw.on("close", () => {
      unsubscribe();
      reply.raw.end();
    });

    return reply;
  });

  await app.listen({ port, host: "127.0.0.1" });
  return app;
}

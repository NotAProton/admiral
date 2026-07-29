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

function writeSse(reply: FastifyReply, event: string, payload: StatusResponse): void {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function startInternalApi(engine: AdmiralEngine, port: number): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  app.get("/internal/health", async () => {
    return { ok: true, service: "worker", ts: new Date().toISOString() };
  });

  app.get("/internal/status", async () => {
    return engine.getStatus();
  });

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

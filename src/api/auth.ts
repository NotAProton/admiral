import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "admiral_session";

type SessionPayload = {
  exp: number;
};

function toBase64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSessionCookie(secret: string, ttlSeconds: number): string {
  const payload: SessionPayload = {
    exp: Math.floor(Date.now() / 1000) + ttlSeconds
  };

  const payloadEncoded = toBase64Url(JSON.stringify(payload));
  const signature = sign(payloadEncoded, secret);
  const value = `${payloadEncoded}.${signature}`;

  const secure = process.env.COOKIE_SECURE === "false" ? "" : "Secure; ";
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; ${secure}Max-Age=${ttlSeconds}`;
}

export function clearSessionCookie(): string {
  const secure = process.env.COOKIE_SECURE === "false" ? "" : "Secure; ";
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; ${secure}Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};

  const out: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    out[key] = value;
  }
  return out;
}

export function isAuthenticated(cookieHeader: string | undefined, secret: string): boolean {
  const cookies = parseCookies(cookieHeader);
  const token = cookies[COOKIE_NAME];
  if (!token) return false;

  const [payloadEncoded, signature] = token.split(".");
  if (!payloadEncoded || !signature) return false;

  const expected = sign(payloadEncoded, secret);
  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);

  if (signatureBuf.length !== expectedBuf.length) return false;
  if (!timingSafeEqual(signatureBuf, expectedBuf)) return false;

  const payloadRaw = Buffer.from(payloadEncoded, "base64url").toString("utf8");
  const payload = JSON.parse(payloadRaw) as SessionPayload;
  return payload.exp > Math.floor(Date.now() / 1000);
}

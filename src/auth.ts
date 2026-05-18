/**
 * Simple HTTP Basic Auth for pi-web.
 *
 * Credentials can be configured via (in order of precedence):
 *   1. CLI arguments  --username / --password
 *   2. Environment variables  PI_WEB_USERNAME / PI_WEB_PASSWORD
 *   3. CLI-generated credentials saved under ~/.pi/agent
 *
 * If this module is used without the CLI, the fallback password is generated
 * randomly at process startup instead of being a public shared secret.
 *
 * To disable auth, set PI_WEB_NO_AUTH=1 or pass --no-auth.
 */

import type { Context, MiddlewareHandler } from "hono";
import { randomBytes, timingSafeEqual } from "node:crypto";

const DEFAULT_USERNAME = "piweb";
const DEFAULT_PASSWORD = randomBytes(18).toString("base64url");

let _username = DEFAULT_USERNAME;
let _password = DEFAULT_PASSWORD;
let _enabled = true;

const AUTH_COOKIE_NAME = "pi_web_auth";
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_FAILURES = 20;
const failureBuckets = new Map<string, { count: number; resetAt: number }>();

export interface AuthConfig {
  username: string;
  password: string;
  enabled: boolean;
}

export function configureAuth(opts: Partial<AuthConfig>): void {
  if (opts.username !== undefined) _username = opts.username;
  if (opts.password !== undefined) _password = opts.password;
  if (opts.enabled !== undefined) _enabled = opts.enabled;
}

export function getAuthConfig(): AuthConfig {
  return { username: _username, password: _password, enabled: _enabled };
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function clientKey(c: Context, username?: string): string {
  // Only trust proxy-supplied client IP headers when explicitly enabled;
  // otherwise direct internet clients could spoof X-Forwarded-For to evade throttling.
  const trustProxy = process.env.PI_WEB_TRUST_PROXY === "1";
  const forwarded = trustProxy
    ? c.req.header("cf-connecting-ip")
      || c.req.header("x-real-ip")
      || c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      || "local"
    : "local";
  return `${forwarded}:${username || "unknown"}`;
}

function isRateLimited(key: string): boolean {
  const bucket = failureBuckets.get(key);
  if (!bucket) return false;
  if (Date.now() > bucket.resetAt) {
    failureBuckets.delete(key);
    return false;
  }
  return bucket.count >= RATE_LIMIT_MAX_FAILURES;
}

function recordAuthFailure(key: string): void {
  const now = Date.now();
  const bucket = failureBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    failureBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return;
  }
  bucket.count += 1;
}

function clearAuthFailures(key: string): void {
  failureBuckets.delete(key);
}

function encodeCookieValue(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`, "utf8").toString("base64url");
}

function decodeCredentialValue(value: string): { username: string; password: string } | null {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const colonIdx = decoded.indexOf(":");
    if (colonIdx === -1) return null;
    return { username: decoded.slice(0, colonIdx), password: decoded.slice(colonIdx + 1) };
  } catch {
    return null;
  }
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return rawValue.join("=") || "";
  }
  return null;
}

function parseBasicAuthHeader(authHeader: string | undefined): { username: string; password: string } | null {
  if (!authHeader || !authHeader.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(authHeader.slice("Basic ".length), "base64").toString("utf8");
    const colonIdx = decoded.indexOf(":");
    if (colonIdx === -1) return null;
    return { username: decoded.slice(0, colonIdx), password: decoded.slice(colonIdx + 1) };
  } catch {
    return null;
  }
}

export function credentialsValid(username: string, password: string): boolean {
  return safeEqual(username, _username) && safeEqual(password, _password);
}

export function authenticateRequest(c: Context): boolean {
  if (!_enabled) return true;

  const basicCreds = parseBasicAuthHeader(c.req.header("Authorization"));
  const cookieCreds = decodeCredentialValue(parseCookie(c.req.header("Cookie"), AUTH_COOKIE_NAME) || "");
  const creds = basicCreds || cookieCreds;
  if (!creds) return false;

  const key = clientKey(c, creds.username);
  if (isRateLimited(key)) return false;
  if (!credentialsValid(creds.username, creds.password)) {
    recordAuthFailure(key);
    return false;
  }

  clearAuthFailures(key);
  return true;
}

export function authCookieHeader(username: string, password: string, maxAgeSeconds = 60 * 60 * 24 * 30, secureCookie = false): string {
  const secure = secureCookie || process.env.PI_WEB_COOKIE_SECURE === "1" ? "; Secure" : "";
  return `${AUTH_COOKIE_NAME}=${encodeCookieValue(username, password)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

export function clearAuthCookieHeader(): string {
  return `${AUTH_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/**
 * Hono middleware that checks Basic Auth on /api/* routes,
 * except for /api/auth/* and /api/health (unauthenticated).
 */
export function authMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    if (!_enabled) {
      // Auth is disabled — allow all
      return next();
    }

    const url = new URL(c.req.url);
    const path = url.pathname;

    // Allow unauthenticated access to auth endpoints and health check
    if (path.startsWith("/api/auth/") || path === "/api/health") {
      return next();
    }

    // Only protect /api/* routes
    if (!path.startsWith("/api/")) {
      return next();
    }

    if (!authenticateRequest(c)) {
      // No WWW-Authenticate header — in iOS PWA, that header triggers a native Basic Auth
      // dialog that interferes with the React login page. The frontend handles 401
      // responses programmatically via fetchApi().
      return c.json({ error: "Authentication required" }, 401);
    }

    await next();
  };
}

/**
 * Register auth-related routes (unprotected).
 */
export function registerAuthRoutes(app: import("hono").Hono): void {
  // Login endpoint: validate username/password
  app.post("/api/auth/login", async (c) => {
    if (!_enabled) {
      return c.json({ status: "ok", auth: false, message: "Authentication is disabled" });
    }

    const { username, password } = await c.req.json();
    if (!username || !password) {
      return c.json({ error: "username and password required" }, 400);
    }

    const key = clientKey(c, username);
    if (isRateLimited(key)) {
      return c.json({ error: "Too many failed login attempts. Try again later." }, 429);
    }

    if (!credentialsValid(username, password)) {
      recordAuthFailure(key);
      return c.json({ error: "Invalid credentials" }, 401);
    }

    clearAuthFailures(key);
    const secureCookie = c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:";
    c.header("Set-Cookie", authCookieHeader(username, password, undefined, secureCookie));
    return c.json({ status: "ok", auth: true });
  });

  app.post("/api/auth/logout", async (c) => {
    c.header("Set-Cookie", clearAuthCookieHeader());
    return c.json({ status: "ok" });
  });

  app.get("/api/auth/session", async (c) => {
    if (!_enabled) return c.json({ authenticated: true, auth: false });
    return c.json({ authenticated: authenticateRequest(c), auth: true });
  });

  // Check if auth is enabled
  app.get("/api/auth/status", async (c) => {
    return c.json({ enabled: _enabled });
  });
}

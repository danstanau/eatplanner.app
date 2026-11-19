import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import express, { type Request } from "express";
import { fileURLToPath } from "node:url";

export interface AuthConfig {
  username: string;
  passwordHash: string;
  publicOrigin: string;
}

function derivePassword(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key));
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 6 || password.length > 1024) throw new Error("Use a password between 6 and 1024 characters.");
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${(await derivePassword(password, salt)).toString("hex")}`;
}

export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const username = env.HOUSEHOLD_USERNAME?.trim();
  const passwordHash = env.HOUSEHOLD_PASSWORD_HASH;
  const publicOrigin = env.APP_ORIGIN;
  if (!username || !passwordHash || !publicOrigin) {
    throw new Error("Household login is required. Run npm run auth:setup or set HOUSEHOLD_USERNAME, HOUSEHOLD_PASSWORD_HASH and APP_ORIGIN.");
  }
  if (username.length > 200 || /[\r\n]/.test(username)) throw new Error("HOUSEHOLD_USERNAME must be 1 to 200 characters on one line.");
  if (!/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(passwordHash)) {
    throw new Error("HOUSEHOLD_PASSWORD_HASH is invalid. Generate it with npm run auth:setup.");
  }
  const url = new URL(publicOrigin);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("APP_ORIGIN must be an HTTP(S) origin without a path, credentials, query or fragment.");
  }
  if (env.NODE_ENV === "production" && url.protocol !== "https:") throw new Error("APP_ORIGIN must use HTTPS in production.");
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("APP_ORIGIN must use HTTPS except for local development on localhost or loopback.");
  }
  return { username, passwordHash, publicOrigin: url.origin };
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export function householdAuth(config?: AuthConfig) {
  const router = express.Router();
  const sessions = new Map<string, number>();
  const attempts = new Map<string, { count: number; expires: number }>();
  const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
  const attemptWindow = 15 * 60 * 1000;
  const secure = config?.publicOrigin.startsWith("https:") ?? false;
  const cookieName = secure ? "__Host-eatplanner_session" : "eatplanner_session";
  const cookieOptions = { httpOnly: true, secure, sameSite: "strict" as const, path: "/" };

  function sessionKey(request: Request) {
    const token = request.headers.cookie?.split(";").map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? digest(token).toString("hex") : undefined;
  }
  function authenticated(request: Request) {
    const key = sessionKey(request);
    return key !== undefined && (sessions.get(key) ?? 0) > Date.now();
  }
  router.use((request, response, next) => {
    response.set("Cache-Control", "no-store");
    const now = Date.now();
    for (const [key, expires] of sessions) if (expires <= now) sessions.delete(key);
    for (const [key, attempt] of attempts) if (attempt.expires <= now) attempts.delete(key);
    if (config && secure) response.set("Strict-Transport-Security", "max-age=31536000");
    if (config && !["GET", "HEAD"].includes(request.method)) {
      if (request.get("origin") !== config.publicOrigin || request.get("sec-fetch-site") === "cross-site") {
        response.status(403).json({ error: `This request must come from ${config.publicOrigin}. Open that address, or update APP_ORIGIN and restart the server.` });
        return;
      }
    }
    next();
  });
  router.get("/api/auth/session", (request, response) => {
    response.json({ enabled: Boolean(config), authenticated: !config || authenticated(request) });
  });
  router.post("/api/auth/login", express.json({ limit: "4kb" }), async (request, response) => {
    if (!config) {
      response.status(404).json({ error: "Household login is not enabled." });
      return;
    }
    const address = request.socket.remoteAddress ?? "unknown";
    const attempt = attempts.get(address) ?? { count: 0, expires: Date.now() + attemptWindow };
    if (attempt.count >= 10 || (attempts.size >= 1024 && !attempts.has(address))) {
      response.set("Retry-After", String(Math.max(1, Math.ceil((attempt.expires - Date.now()) / 1000))));
      response.status(429).json({ error: "Too many login attempts. Please try again in 15 minutes." });
      return;
    }
    attempt.count++;
    attempts.set(address, attempt);
    const { username, password } = request.body ?? {};
    if (typeof username !== "string" || username.length > 200 || typeof password !== "string" || password.length > 1024) {
      response.status(400).json({ error: "Enter your household username and password." });
      return;
    }
    const [, salt, expected] = config.passwordHash.split("$");
    const key = await derivePassword(password, salt);
    if (!timingSafeEqual(key, Buffer.from(expected, "hex")) || !timingSafeEqual(digest(username), digest(config.username))) {
      response.status(401).json({ error: "Incorrect username or password." });
      return;
    }
    const previous = sessionKey(request);
    if (previous) sessions.delete(previous);
    if (sessions.size >= 100) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    const token = randomBytes(32).toString("base64url");
    sessions.set(digest(token).toString("hex"), Date.now() + sessionLifetime);
    response.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionLifetime });
    response.json({ authenticated: true });
  });
  router.post("/api/auth/logout", (request, response) => {
    const key = sessionKey(request);
    if (key) sessions.delete(key);
    response.clearCookie(cookieName, cookieOptions);
    response.json({ authenticated: false });
  });
  router.get("/login", (request, response) => {
    if (config && !secure) {
      const origin = new URL(config.publicOrigin);
      const loopback = ["localhost", "127.0.0.1", "[::1]"];
      if (loopback.includes(origin.hostname) && loopback.includes(request.hostname) && request.get("host") !== origin.host) {
        response.redirect(`${config.publicOrigin}${request.originalUrl}`);
        return;
      }
    }
    if (!config || authenticated(request)) { response.redirect("/"); return; }
    response.sendFile(fileURLToPath(new URL("../public/login.html", import.meta.url)));
  });
  router.use((request, response, next) => {
    const publicFiles = ["/login.js", "/login.css", "/login-preview.svg", "/base.css", "/fonts/bricolage-grotesque.woff2", "/favicon.svg", "/apple-touch-icon.png"];
    if (!config || authenticated(request) || publicFiles.includes(request.path)) { next(); return; }
    if (request.path.startsWith("/api/")) {
      response.status(401).json({ error: "Please sign in to your household." });
    } else {
      response.redirect(`/login?next=${encodeURIComponent(request.originalUrl)}`);
    }
  });
  return router;
}

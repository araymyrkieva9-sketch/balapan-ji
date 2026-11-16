// Балапан ЖИ — Cloudflare Worker: тіркелу/кіру, профиль, ЖИ проксиі.
// Статикалық бет (public/) Workers Static Assets арқылы беріледі.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";
const SESSION_DAYS = 30;
const PBKDF2_ITER = 100000;
const PROFILE_FIELDS = ["name", "role", "org", "city", "email"];

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
const err = (code, message, status) => json({ error: { code, message } }, status);

const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const randomToken = () => {
  const a = crypto.getRandomValues(new Uint8Array(32));
  return [...a].map((x) => x.toString(16).padStart(2, "0")).join("");
};
async function sha256hex(s) {
  const h = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function hashPassword(password, saltB64) {
  const salt = saltB64 ? fromB64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITER }, key, 256);
  return { salt: b64(salt), hash: b64(bits) };
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const normEmail = (e) => String(e || "").trim().toLowerCase().slice(0, 120);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const isAdmin = (env, email) =>
  String(env.ADMIN_EMAILS || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
    .includes(email);

function cookieFor(token, maxAge) {
  return `bsid=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function readCookie(req, name) {
  const c = req.headers.get("cookie") || "";
  const m = c.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : null;
}

async function createSession(env, userId) {
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created, expires) VALUES (?, ?, ?, ?)")
    .bind(await sha256hex(token), userId, now, now + SESSION_DAYS * 864e5)
    .run();
  return token;
}
async function currentUser(req, env) {
  const token = readCookie(req, "bsid");
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?"
  )
    .bind(await sha256hex(token), Date.now())
    .first();
  return row || null;
}

async function readBody(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

// Қарапайым қорғаныс: бір IP-ден сағатына тым көп кіру әрекетін шектеу.
async function tooManyAttempts(env, req, kind, limit) {
  const ip = req.headers.get("cf-connecting-ip") || "x";
  const bucket = `${kind}:${ip}:${Math.floor(Date.now() / 36e5)}`;
  const row = await env.DB.prepare(
    "INSERT INTO counters (k, n) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n"
  )
    .bind(bucket)
    .first();
  return row.n > limit;
}

async function register(req, env) {
  if (await tooManyAttempts(env, req, "reg", 20)) return err("rate_limited", "Тым көп әрекет. Біраз күтіңіз.", 429);
  const b = await readBody(req);
  const email = normEmail(b.email);
  const password = String(b.password || "");
  if (!validEmail(email)) return err("bad_email", "Email дұрыс емес.", 400);
  if (password.length < 6 || password.length > 200) return err("bad_password", "Құпиясөз кемінде 6 таңба болсын.", 400);
  const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (exists) return err("email_taken", "Бұл email тіркелген. «Кіру» батырмасын басыңыз.", 409);
  const { salt, hash } = await hashPassword(password);
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, email, pass_hash, pass_salt, created) VALUES (?, ?, ?, ?, ?)")
    .bind(id, email, hash, salt, Date.now())
    .run();
  const token = await createSession(env, id);
  return json({ id, email, owner: isAdmin(env, email) }, 200, { "set-cookie": cookieFor(token, SESSION_DAYS * 86400) });
}

async function login(req, env) {
  if (await tooManyAttempts(env, req, "login", 30)) return err("rate_limited", "Тым көп әрекет. Біраз күтіңіз.", 429);
  const b = await readBody(req);
  const email = normEmail(b.email);
  const password = String(b.password || "");
  const u = await env.DB.prepare("SELECT id, email, pass_hash, pass_salt FROM users WHERE email = ?").bind(email).first();
  if (!u) return err("bad_login", "Email немесе құпиясөз қате.", 401);
  const { hash } = await hashPassword(password, u.pass_salt);
  if (!safeEqual(hash, u.pass_hash)) return err("bad_login", "Email немесе құпиясөз қате.", 401);
  const token = await createSession(env, u.id);
  return json({ id: u.id, email: u.email, owner: isAdmin(env, u.email) }, 200, {
    "set-cookie": cookieFor(token, SESSION_DAYS * 86400),
  });
}

async function logout(req, env) {
  const token = readCookie(req, "bsid");
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256hex(token)).run();
  return json({ ok: true }, 200, { "set-cookie": cookieFor("", 0) });
}

function cleanProfile(b) {
  const p = {};
  for (const k of PROFILE_FIELDS) p[k] = String(b[k] ?? "").trim().slice(0, 120);
  p.ts = Number(b.ts) || Date.now();
  p.updated = Date.now();
  return p;
}

async function getProfile(env, user) {
  const r = await env.DB.prepare("SELECT data FROM profiles WHERE user_id = ?").bind(user.id).first();
  return json({ profile: r ? JSON.parse(r.data) : null });
}
async function putProfile(req, env, user) {
  const p = cleanProfile(await readBody(req));
  if (!p.name) return err("bad_profile", "Аты-жөніңізді жазыңыз.", 400);
  const old = await env.DB.prepare("SELECT data FROM profiles WHERE user_id = ?").bind(user.id).first();
  if (old) {
    const o = JSON.parse(old.data);
    p.ts = o.ts || p.ts;
    // Тіркелгеннен кейін мамандықты тек сайт иесі өзгерте алады.
    if (!isAdmin(env, user.email) && o.role) p.role = o.role;
  }
  await env.DB.prepare(
    "INSERT INTO profiles (user_id, data, ts) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data"
  )
    .bind(user.id, JSON.stringify(p), p.ts)
    .run();
  return json({ profile: p });
}
async function deleteProfile(env, user) {
  await env.DB.prepare("DELETE FROM profiles WHERE user_id = ?").bind(user.id).run();
  return json({ ok: true });
}
async function listMembers(env, user) {
  if (!isAdmin(env, user.email)) return err("permission_denied", "Тек сайт иесіне.", 403);
  const { results } = await env.DB.prepare(
    "SELECT p.data, u.email AS acct FROM profiles p JOIN users u ON u.id = p.user_id ORDER BY p.ts DESC LIMIT 1000"
  ).all();
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
  return json({
    members: results.map((r) => {
      const d = JSON.parse(r.data);
      if (!d.email) d.email = r.acct;
      return d;
    }),
    accounts: total.n,
  });
}

// ЖИ: бір пайдаланушыға күніне шектеулі сұраныс, жауап мәтін ағыны ретінде.
async function ai(req, env, ctx, user) {
  if (!env.ANTHROPIC_API_KEY) return err("not_configured", "ЖИ кілті әлі қосылмаған.", 503);
  const b = await readBody(req);
  const prompt = String(b.prompt || "").slice(0, 60000);
  if (!prompt.trim()) return err("bad_request", "Сұраныс бос.", 400);
  const limit = Number(env.AI_DAILY_LIMIT || 60);
  const day = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    "INSERT INTO counters (k, n) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n"
  )
    .bind(`ai:${user.id}:${day}`)
    .first();
  if (row.n > limit && !isAdmin(env, user.email))
    return err("rate_limited", `Бүгінгі ЖИ лимиті (${limit} сұраныс) бітті. Ертең қайта көріңіз.`, 429);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}) });
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  const run = async () => {
    try {
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 32000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages: [{ role: "user", content: prompt }],
      });
      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          await writer.write(enc.encode(ev.delta.text));
        }
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === "refusal") {
        await writer.write(enc.encode("\n\n[[ERR:refusal]]"));
      }
    } catch (e) {
      console.error("AI error", e && e.status, e && e.message);
      const code = e && e.status === 429 ? "rate_limited" : "failed";
      await writer.write(enc.encode(`\n\n[[ERR:${code}]]`)).catch(() => {});
    } finally {
      await writer.close().catch(() => {});
    }
  };
  ctx.waitUntil(run());
  return new Response(readable, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}

// Кестелерді бірінші сұраныста өзі жасайды (бөлек қадам керек емес).
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, created INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)",
  "CREATE TABLE IF NOT EXISTS profiles (user_id TEXT PRIMARY KEY, data TEXT NOT NULL, ts INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL)",
];
let schemaReady = null;
const ensureSchema = (env) =>
  (schemaReady ||= env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q))).catch((e) => {
    schemaReady = null;
    throw e;
  }));

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (!p.startsWith("/api/")) return env.ASSETS.fetch(req);
    await ensureSchema(env);

    // CSRF қорғанысы: POST/PUT/DELETE тек осы сайттан.
    if (req.method !== "GET") {
      const origin = req.headers.get("origin");
      if (origin && origin !== url.origin) return err("forbidden", "Рұқсат жоқ.", 403);
    }

    try {
      if (p === "/api/register" && req.method === "POST") return await register(req, env);
      if (p === "/api/login" && req.method === "POST") return await login(req, env);
      if (p === "/api/logout" && req.method === "POST") return await logout(req, env);

      const user = await currentUser(req, env);
      if (p === "/api/me") {
        return json(user ? { user: { id: user.id, email: user.email, owner: isAdmin(env, user.email) } } : { user: null });
      }
      if (!user) return err("unauthorized", "Алдымен кіріңіз.", 401);

      if (p === "/api/profile" && req.method === "GET") return await getProfile(env, user);
      if (p === "/api/profile" && req.method === "PUT") return await putProfile(req, env, user);
      if (p === "/api/profile" && req.method === "DELETE") return await deleteProfile(env, user);
      if (p === "/api/members" && req.method === "GET") return await listMembers(env, user);
      if (p === "/api/ai" && req.method === "POST") return await ai(req, env, ctx, user);
      return err("not_found", "Табылмады.", 404);
    } catch (e) {
      console.error(e);
      return err("server", "Сервер қатесі.", 500);
    }
  },
};

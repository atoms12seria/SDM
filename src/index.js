const encoder = new TextEncoder();
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const now = () => Math.floor(Date.now() / 1000);
const id = () => crypto.randomUUID();
const randomToken = (bytes = 32) => {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map(x => x.toString(16).padStart(2, "0")).join("");
};
const sha256 = async value => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
};
const passwordHash = async password => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(bits)));
  return `pbkdf2$100000$${btoa(String.fromCharCode(...salt))}$${b64}`;
};
const verifyPassword = async (password, stored) => {
  const [kind, rounds, salt64, expected] = (stored || "").split("$");
  if (kind !== "pbkdf2" || !rounds || !salt64 || !expected) return false;
  const salt = Uint8Array.from(atob(salt64), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: Number(rounds), hash: "SHA-256" }, key, 256);
  const actual = btoa(String.fromCharCode(...new Uint8Array(bits)));
  return actual === expected;
};
const cookie = token => `sid=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 14}`;
const clearCookie = "sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
const getCookie = (request, name) => {
  const raw = request.headers.get("Cookie") || "";
  return raw.split(";").map(v => v.trim()).find(v => v.startsWith(name + "="))?.slice(name.length + 1);
};
const body = async request => {
  try { return await request.json(); } catch { return {}; }
};
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || "");
const sameOrigin = (request, env) => {
  const origin = request.headers.get("Origin");
  return !origin || origin === env.APP_ORIGIN || origin === new URL(request.url).origin;
};
async function currentUser(request, env) {
  const token = getCookie(request, "sid");
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT u.id,u.email,u.display_name,u.role,u.email_verified_at
     FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=? AND s.expires_at>?`
  ).bind(tokenHash, now()).first();
  return row || null;
}
async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user || !user.email_verified_at) throw new Error("ログインしてください。");
  return user;
}
async function requireAdmin(request, env, user) {
  if (user.role !== "admin") throw new Error("管理者権限が必要です。");
  const deviceId = request.headers.get("X-Device-Id") || "";
  if (!deviceId) throw new Error("管理者端末の確認が必要です。");
  const device = await env.DB.prepare(
    "SELECT id FROM devices WHERE id=? AND user_id=? AND approved=1"
  ).bind(deviceId, user.id).first();
  if (!device) throw new Error("この端末は管理者端末として登録されていません。");
  await env.DB.prepare("UPDATE devices SET last_seen_at=CURRENT_TIMESTAMP WHERE id=?").bind(deviceId).run();
  return device;
}

async function sendVerificationEmail(env, email, token) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !env.APP_ORIGIN) {
    throw new Error("メール送信設定が未完了です。");
  }

  const link = `${env.APP_ORIGIN}/?verify=${encodeURIComponent(token)}`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [email],
      subject: "メールアドレスの確認",
      html: `<p>アカウント登録ありがとうございます。</p><p><a href="${link}">メールアドレスを確認する</a></p><p>このリンクは30分で無効になります。</p>`,
      text: `メールアドレスを確認してください: ${link}`
    })
  });

  const result = await response.json().catch(() => null);

  if (!response.ok) {
    const detail = result?.message || result?.error || "詳細不明";
    throw new Error(`Resend送信失敗（HTTP ${response.status}）：${detail}`);
  }
}

async function canReadRequest(env, requestId, user) {
  const row = await env.DB.prepare("SELECT id,user_id FROM requests WHERE id=?").bind(requestId).first();
  if (!row) return null;
  if (user.role === "admin") return row;
  return row.user_id === user.id ? row : null;
}
async function broadcast(env, requestId, payload) {
  const stub = env.CHAT_ROOMS.get(env.CHAT_ROOMS.idFromName(requestId));
  await stub.fetch("https://chat.internal/broadcast", {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-secret": env.INTERNAL_SECRET || "" },
    body: JSON.stringify(payload)
  });
}
function errorResponse(error) {
  const message = error?.message || "処理に失敗しました。";
  const status = message.includes("ログイン") ? 401 :
    (message.includes("権限") || message.includes("端末") ? 403 : 400);
  return json({ error: message }, status);
}

export class ChatRoom {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/connect") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/broadcast" && request.method === "POST") {
      if ((request.headers.get("x-internal-secret") || "") !== (this.env.INTERNAL_SECRET || "")) {
        return new Response("Forbidden", { status: 403 });
      }
      const payload = await request.json();
      const data = JSON.stringify(payload);
      for (const ws of this.state.getWebSockets()) {
        try { ws.send(data); } catch {}
      }
      return new Response("ok");
    }
    return new Response("Not found", { status: 404 });
  }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (["POST","PUT","PATCH","DELETE"].includes(request.method) && !sameOrigin(request, env)) {
        return json({ error: "不正なリクエストです。" }, 403);
      }
      try {
        if (url.pathname === "/api/auth/register" && request.method === "POST") {
          const data = await body(request);
          const email = String(data.email || "").trim().toLowerCase();
          const name = String(data.name || "").trim().slice(0, 40);
          const password = String(data.password || "");
          if (!validEmail(email) || !name || password.length < 12 || password.length > 128) {
            return json({ error: "メールアドレス・名前を確認し、パスワードは12文字以上にしてください。" }, 400);
          }
          const exists = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
          if (exists) return json({ error: "このメールアドレスは登録済みです。" }, 409);
          const userId = id();
          const hash = await passwordHash(password);
          const role = email === String(env.ADMIN_EMAIL || "").toLowerCase() ? "admin" : "user";
          await env.DB.prepare(
            "INSERT INTO users(id,email,display_name,password_hash,role) VALUES(?,?,?,?,?)"
          ).bind(userId, email, name, hash, role).run();
          const token = randomToken();
          await env.DB.prepare("INSERT INTO email_verifications(token_hash,user_id,expires_at) VALUES(?,?,?)")
            .bind(await sha256(token), userId, now() + 1800).run();
          try { await sendVerificationEmail(env, email, token); }
          catch (e) {
            await env.DB.prepare("DELETE FROM users WHERE id=?").bind(userId).run();
            throw e;
          }
          return json({ ok: true, message: "確認メールを送信しました。メール内のリンクを開いてください。" }, 201);
        }

        if (url.pathname === "/api/auth/verify" && request.method === "POST") {
          const { token } = await body(request);
          const tokenHash = await sha256(String(token || ""));
          const record = await env.DB.prepare("SELECT user_id FROM email_verifications WHERE token_hash=? AND expires_at>?")
            .bind(tokenHash, now()).first();
          if (!record) return json({ error: "確認リンクが無効または期限切れです。" }, 400);
          await env.DB.batch([
            env.DB.prepare("UPDATE users SET email_verified_at=CURRENT_TIMESTAMP WHERE id=?").bind(record.user_id),
            env.DB.prepare("DELETE FROM email_verifications WHERE token_hash=?").bind(tokenHash)
          ]);
          return json({ ok: true, message: "メールアドレスを確認しました。ログインできます。" });
        }

        if (url.pathname === "/api/auth/login" && request.method === "POST") {
          const data = await body(request);
          const email = String(data.email || "").trim().toLowerCase();
          const user = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
          if (!user || !(await verifyPassword(String(data.password || ""), user.password_hash))) {
            return json({ error: "メールアドレスまたはパスワードが違います。" }, 401);
          }
          if (!user.email_verified_at) return json({ error: "先にメールアドレスを確認してください。" }, 403);
          const session = randomToken();
          const days = Math.max(1, Math.min(30, Number(env.SESSION_DAYS || 14)));
          await env.DB.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
            .bind(await sha256(session), user.id, now() + days * 86400).run();
          return new Response(JSON.stringify({
            ok: true, user: { id: user.id, email: user.email, name: user.display_name, role: user.role }
          }), { headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": cookie(session) } });
        }

        if (url.pathname === "/api/auth/logout" && request.method === "POST") {
          const token = getCookie(request, "sid");
          if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
          return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": clearCookie } });
        }

        if (url.pathname === "/api/me" && request.method === "GET") {
          const user = await currentUser(request, env);
          if (!user) return json({ user: null });
          return json({ user: { id: user.id, email: user.email, name: user.display_name, role: user.role } });
        }

        if (url.pathname === "/api/device/register" && request.method === "POST") {
          const user = await requireUser(request, env);
          if (user.role !== "admin") return json({ error: "管理者専用です。" }, 403);
          const data = await body(request);
          const deviceId = String(data.deviceId || "");
          const code = String(data.code || "");
          if (!/^[a-zA-Z0-9-]{20,100}$/.test(deviceId) || !env.ADMIN_DEVICE_ENROLL_CODE ||
              code !== env.ADMIN_DEVICE_ENROLL_CODE) return json({ error: "登録コードまたは端末情報が正しくありません。" }, 403);
          await env.DB.prepare(
            "INSERT INTO devices(id,user_id,label,approved) VALUES(?,?,?,1) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,label=excluded.label,approved=1"
          ).bind(deviceId, user.id, String(data.label || "管理者端末").slice(0, 60)).run();
          return json({ ok: true, message: "この端末を管理者端末として登録しました。" });
        }

        if (url.pathname === "/api/requests" && request.method === "POST") {
          const user = await requireUser(request, env);
          const data = await body(request);
          const title = String(data.title || "").trim().slice(0, 100);
          const category = String(data.category || "サイト修正").slice(0, 40);
          const content = String(data.body || "").trim().slice(0, 5000);
          if (!title || !content) return json({ error: "タイトルと依頼内容を入力してください。" }, 400);
          const requestId = id();
          await env.DB.prepare("INSERT INTO requests(id,user_id,title,category,body) VALUES(?,?,?,?,?)")
            .bind(requestId, user.id, title, category, content).run();
          await env.DB.prepare("INSERT INTO messages(id,request_id,sender_id,body) VALUES(?,?,?,?)")
            .bind(id(), requestId, user.id, `依頼を送信しました。\n${content}`).run();
          return json({ ok: true, requestId }, 201);
        }

        if (url.pathname === "/api/requests" && request.method === "GET") {
          const user = await requireUser(request, env);
          if (user.role === "admin") await requireAdmin(request, env, user);
          const rows = user.role === "admin"
            ? await env.DB.prepare("SELECT r.*,u.display_name AS user_name,u.email AS user_email FROM requests r JOIN users u ON u.id=r.user_id ORDER BY r.updated_at DESC").all()
            : await env.DB.prepare("SELECT * FROM requests WHERE user_id=? ORDER BY updated_at DESC").bind(user.id).all();
          return json({ requests: rows.results || [] });
        }

        if (url.pathname.startsWith("/api/requests/") && url.pathname.endsWith("/messages") && request.method === "GET") {
          const user = await requireUser(request, env);
          const requestId = url.pathname.split("/")[3];
          const access = await canReadRequest(env, requestId, user);
          if (!access) return json({ error: "この依頼を閲覧する権限がありません。" }, 403);
          const rows = await env.DB.prepare(
            "SELECT m.id,m.body,m.created_at,m.sender_id,u.display_name AS sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.request_id=? ORDER BY m.created_at ASC LIMIT 300"
          ).bind(requestId).all();
          return json({ messages: rows.results || [] });
        }

        if (url.pathname === "/api/messages" && request.method === "POST") {
          const user = await requireUser(request, env);
          const data = await body(request);
          const requestId = String(data.requestId || "");
          const content = String(data.body || "").trim().slice(0, 3000);
          const access = await canReadRequest(env, requestId, user);
          if (!access) return json({ error: "この依頼に送信する権限がありません。" }, 403);
          if (!content) return json({ error: "メッセージを入力してください。" }, 400);
          const message = { id: id(), request_id: requestId, sender_id: user.id, sender_name: user.display_name, body: content, created_at: new Date().toISOString() };
          await env.DB.prepare("INSERT INTO messages(id,request_id,sender_id,body) VALUES(?,?,?,?)")
            .bind(message.id, requestId, user.id, content).run();
          await env.DB.prepare("UPDATE requests SET updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(requestId).run();
          await broadcast(env, requestId, { type: "message", message });
          return json({ ok: true, message }, 201);
        }

        if (url.pathname === "/api/admin/status" && request.method === "PATCH") {
          const user = await requireUser(request, env);
          await requireAdmin(request, env, user);
          const data = await body(request);
          if (!["受付","対応中","完了","却下"].includes(data.status)) return json({ error: "状態が不正です。" }, 400);
          await env.DB.prepare("UPDATE requests SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
            .bind(data.status, String(data.requestId || "")).run();
          return json({ ok: true });
        }

        if (url.pathname === "/api/chat/socket" && request.method === "GET") {
          const user = await requireUser(request, env);
          const requestId = url.searchParams.get("requestId") || "";
          const access = await canReadRequest(env, requestId, user);
          if (!access) return json({ error: "このチャットを閲覧する権限がありません。" }, 403);
          if (user.role === "admin") await requireAdmin(request, env, user);
          const stub = env.CHAT_ROOMS.get(env.CHAT_ROOMS.idFromName(requestId));
          const headers = new Headers(request.headers);
          headers.set("X-Verified-User", user.id);
          headers.set("X-Request-Id", requestId);
          return stub.fetch(new Request("https://chat.internal/connect", { headers }));
        }
        return json({ error: "Not found" }, 404);
      } catch (error) {
        return errorResponse(error);
      }
    }
    return env.ASSETS.fetch(request);
  }
};

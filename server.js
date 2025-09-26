// server.js — ArabChat Pro + Admin Dashboard (roles + unban)
// تشغيل: npm install && npm start
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
let geoip; try { geoip = require("geoip-lite"); } catch { geoip = null; }

const app = express();
app.set("trust proxy", true);
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.ORIGIN || "*", methods: ["GET","POST"] } });

const PORT = process.env.PORT || 10000;
const ADMIN_USER = process.env.ADMIN_USER || "ArabAdmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "az77@";

/* =================== Data =================== */
const users = new Map();         // socket.id -> user {id,nick,ip,country,roleFlags}
const byNick = new Map();        // nick -> socket.id
const bans = new Set();          // Set<ip>
const mutes = new Set();         // Set<ip>
const stars = new Set();         // Set<nick>
const delegates = new Set();     // Set<nick>
const lastSeenByIP = new Map();  // ip -> ts
const history = [];              // last 200 events
// أدوار قابلة للتعديل من لوحة التحكم
// rolesByNick: { nick: "admin" | "mod" }
const rolesByNick = Object.create(null);

function pushHistory(evt){ history.push(evt); if (history.length > 200) history.shift(); }
function sanitizeNick(n){ if (!n || typeof n !== "string") n = ""; return /^[A-Za-z0-9_]{3,20}$/.test(n) ? n : "Guest" + Math.floor(Math.random()*9000+1000); }
function ensureUniqueNick(clean){ if (!byNick.has(clean)) return clean; let i=2; while (byNick.has(`${clean}_${i}`)) i++; return `${clean}_${i}`; }
function countryFromIP(ip){ try{ return geoip?.lookup(ip)?.country || "??"; } catch { return "??"; } }
function canShowJoinLeave(ip){ const now=Date.now(); const last=lastSeenByIP.get(ip)||0; lastSeenByIP.set(ip, now); return (now-last) > 5*60*1000; }
function roleOfNick(nick){
  if (nick === ADMIN_USER) return "admin";
  return rolesByNick[nick] || null;
}
function flagsForRole(role){ return {
  isAdmin: role === "admin",
  isMod: role === "mod"
};}
function canDo(user, action){
  // user: {roleFlags: {isAdmin,isMod}}
  if (user?.roleFlags?.isAdmin) return true;
  if (user?.roleFlags?.isMod){
    const allow = ["star","unstar","mute","unmute","kick","whois"];
    return allow.includes(action);
  }
  return false;
}
function broadcastUsers(){
  const list = [...users.values()].map(u => ({
    nick: u.nick,
    country: u.country,
    admin: !!u.roleFlags?.isAdmin,
    star: stars.has(u.nick),
    delegate: delegates.has(u.nick),
    mod: !!u.roleFlags?.isMod
  }));
  io.emit("users", list);
}

/* =================== Web pages =================== */
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

/* ---------- Admin Dashboard (HTML) ---------- */
function requireAdminKey(req, res, next){
  const key = req.query.key || req.headers["x-admin-key"];
  if (key && key === ADMIN_PASS) return next();
  res.status(401).send("Unauthorized");
}

app.get("/admin", requireAdminKey, (req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html lang="ar" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>لوحة تحكم الشات</title>
<style>
  body{background:#0d0f13;color:#e9edf5;font-family:system-ui,-apple-system,Segoe UI,Roboto,"Noto Sans",Tahoma,sans-serif;margin:0}
  .wrap{max-width:1000px;margin:0 auto;padding:16px}
  h1{margin:10px 0 14px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
  .card{background:#151923;border:1px solid #212837;border-radius:12px;padding:12px}
  input,select,button{background:#0f131c;border:1px solid #212837;color:#e9edf5;border-radius:10px;padding:10px 12px;font-size:14px}
  .btn{background:#3aa0ff;border:none;font-weight:700}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{border-bottom:1px solid #212837;padding:6px 8px}
  .pill{font-size:12px;background:#0f131c;border:1px solid #212837;border-radius:999px;padding:3px 8px}
  .muted{color:#6f7a8a}
  .ok{color:#19c37d}.warn{color:#ffcc00}.err{color:#ff5c5c}
</style>
</head><body><div class="wrap">
  <h1>لوحة تحكم الشات</h1>
  <div class="grid">
    <div class="card">
      <h3>الأدوار (Admins / Mods)</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">
        <input id="roleNick" placeholder="Nick (A-Z0-9_)">
        <select id="roleType"><option value="mod">mod</option><option value="admin">admin</option><option value="none">remove</option></select>
        <button class="btn" onclick="saveRole()">حفظ</button>
      </div>
      <div class="muted" style="font-size:12px">تنبيه: الأدوار في الذاكرة. يمكن جعلها دائمة بحفظ JSON (أخبرني لو تبي).</div>
      <div id="rolesList" style="margin-top:10px"></div>
    </div>

    <div class="card">
      <h3>الحظر (Bans)</h3>
      <div style="display:flex;gap:8px;margin:8px 0">
        <input id="unbanIp" placeholder="IP لفك الحظر">
        <button class="btn" onclick="unban()">فك حظر</button>
      </div>
      <div id="bansBox"></div>
    </div>

    <div class="card">
      <h3>المتواجدون الآن</h3>
      <div id="onlineBox"></div>
    </div>
  </div>
</div>
<script>
  const KEY = new URLSearchParams(location.search).get("key");
  if (!KEY) { alert("لا يوجد مفتاح key في الرابط"); }

  async function api(path, opts={}){
    const u = path + (path.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(KEY);
    const res = await fetch(u, { headers:{ "x-admin-key": KEY, "content-type":"application/json" }, ...opts });
    if (!res.ok){ const t = await res.text(); throw new Error(t || res.statusText); }
    return res.json();
  }
  async function refresh(){
    const s = await api("/api/admin/state");
    // roles
    const roles = s.rolesByNick || {};
    const roleEntries = Object.entries(roles).sort((a,b)=>a[0].localeCompare(b[0]));
    document.getElementById("rolesList").innerHTML =
      roleEntries.length ? ('<table><tr><th>Nick</th><th>Role</th></tr>' +
      roleEntries.map(([n,r])=>\`<tr><td>\${n}</td><td><span class="pill">\${r}</span></td></tr>\`).join("") + '</table>') :
      '<div class="muted">لا يوجد أدوار مضافة.</div>';

    // bans
    const bans = s.bans || [];
    document.getElementById("bansBox").innerHTML =
      bans.length ? ('<table><tr><th>IP</th></tr>' + bans.map(ip=>\`<tr><td>\${ip}</td></tr>\`).join("") + '</table>')
                  : '<div class="muted">لا يوجد IP محظور.</div>';

    // online
    const on = s.online || [];
    document.getElementById("onlineBox").innerHTML =
      on.length ? ('<table><tr><th>Nick</th><th>Country</th><th>Role</th></tr>' +
        on.map(u=>\`<tr><td>\${u.nick}</td><td>\${u.country||"??"}</td><td>\${u.role||"-"}</td></tr>\`).join("") + '</table>')
        : '<div class="muted">لا يوجد أحد متصل.</div>';
  }
  async function saveRole(){
    const nick = document.getElementById("roleNick").value.trim();
    const role = document.getElementById("roleType").value;
    if (!nick) return alert("أدخل Nick");
    await api("/api/admin/roles", { method:"POST", body: JSON.stringify({ nick, role }) });
    alert("تم الحفظ"); refresh();
  }
  async function unban(){
    const ip = document.getElementById("unbanIp").value.trim();
    if (!ip) return alert("أدخل IP");
    await api("/api/unban", { method:"POST", body: JSON.stringify({ ip }) });
    alert("تم فك الحظر"); refresh();
  }
  refresh();
</script>
</body></html>`);
});

/* ---------- Admin API ---------- */
app.get("/api/admin/state", requireAdminKey, (_req, res) => {
  const online = [...users.values()].map(u => ({
    nick: u.nick, country: u.country, role: u.roleFlags?.isAdmin ? "admin" : (u.roleFlags?.isMod ? "mod" : null)
  }));
  res.json({
    rolesByNick,
    bans: [...bans],
    online
  });
});

app.post("/api/admin/roles", requireAdminKey, (req, res) => {
  const { nick, role } = req.body || {};
  const clean = sanitizeNick(nick);
  if (!clean) return res.status(400).json({ ok:false, error:"bad nick" });
  if (role === "admin" || role === "mod") {
    rolesByNick[clean] = role;
  } else {
    delete rolesByNick[clean];
  }
  // حدّث المتصل الآن إن وجد
  const sid = byNick.get(clean);
  if (sid){
    const u = users.get(sid);
    u.roleFlags = flagsForRole(roleOfNick(u.nick));
    users.set(sid, u);
    broadcastUsers();
  }
  res.json({ ok:true, rolesByNick });
});

app.get("/api/bans", requireAdminKey, (_req,res)=> res.json({ bans: [...bans] }));
app.post("/api/unban", requireAdminKey, (req,res)=> {
  const ip = String(req.body?.ip||"").trim();
  if (!ip) return res.status(400).json({ ok:false, error:"ip required" });
  bans.delete(ip);
  res.json({ ok:true });
});

/* =================== Socket.IO =================== */
io.on("connection", socket => {
  const raw = (socket.handshake.headers["x-forwarded-for"] || socket.handshake.address || "").toString();
  const ip = raw.split(",")[0].trim();

  if (bans.has(ip)) { socket.emit("banned", "🚫 محظور من الدخول"); return socket.disconnect(); }

  socket.on("login", ({ nick, admin, adminNick, pass }, ack) => {
    const nickRaw = sanitizeNick(nick);
    const adminNameRaw = sanitizeNick(adminNick || nick);
    const wantsAdminByPass = !!(admin && pass && adminNameRaw === ADMIN_USER && pass === ADMIN_PASS);

    // عرض الاسم
    let displayNick = ensureUniqueNick(nickRaw);

    // لو أدمن صحيح: خذ الاسم الرسمي حتى لو محجوز
    if (wantsAdminByPass && displayNick !== ADMIN_USER) {
      const oldId = byNick.get(ADMIN_USER);
      if (oldId) {
        const oldUser = users.get(oldId);
        io.to(oldId).emit("kicked", "تم استرجاع اسم الأدمن");
        io.sockets.sockets.get(oldId)?.disconnect(true);
        users.delete(oldId);
        byNick.delete(ADMIN_USER);
      }
      displayNick = ADMIN_USER;
      rolesByNick[ADMIN_USER] = "admin"; // ضمّن أن اسمه أدمن
    }

    const role = wantsAdminByPass ? "admin" : roleOfNick(displayNick);
    const country = countryFromIP(ip);
    const user = {
      id: socket.id, nick: displayNick, ip, country,
      roleFlags: flagsForRole(role)
    };
    users.set(socket.id, user);
    byNick.set(displayNick, socket.id);

    // أعط التاريخ
    socket.emit("history", history);

    if (canShowJoinLeave(ip)) {
      pushHistory({ type:"system", text:`✅ ${displayNick} دخل الغرفة [${country}]` });
      io.emit("system", `✅ ${displayNick} دخل الغرفة [${country}]`);
    }
    if (user.roleFlags.isAdmin) {
      pushHistory({ type:"system", text:`ChanServ ${displayNick} تم توكيل` });
      io.emit("system", `ChanServ ${displayNick} تم توكيل`);
    }

    broadcastUsers();
    if (typeof ack === "function") ack({ ok:true, user: { nick:user.nick, admin:user.roleFlags.isAdmin } });
  });

  socket.on("msg", text => {
    const u = users.get(socket.id); if (!u) return;
    if (mutes.has(u.ip)) return;
    const evt = { type:"msg", nick:u.nick, country:u.country, text:String(text||"").slice(0,2000) };
    pushHistory(evt); io.emit("msg", evt);
  });

  socket.on("pm", ({ to, text }) => {
    const u = users.get(socket.id); if (!u) return;
    const toId = byNick.get(to); if (!toId) return;
    const evt = { type:"pm", from:u.nick, to, text:String(text||"").slice(0,2000) };
    io.to(toId).emit("pm", evt); socket.emit("pm", evt);
  });

  socket.on("admin:action", ({ action, target }) => {
    const u = users.get(socket.id);
    if (!canDo(u, action)) return;

    const targetId = byNick.get(target);
    const t = targetId ? users.get(targetId) : null;

    switch (action) {
      case "star": stars.add(target); break;
      case "unstar": stars.delete(target); break;
      case "delegate": delegates.add(target); break;
      case "undelegate": delegates.delete(target); break;
      case "mute": if (t) mutes.add(t.ip); break;
      case "unmute": if (t) mutes.delete(t.ip); break;
      case "kick":
        if (t) { io.to(t.id).emit("kicked", "تم طردك"); io.sockets.sockets.get(t.id)?.disconnect(true); }
        break;
      case "ban":
        if (t) { bans.add(t.ip); io.to(t.id).emit("banned", "🚫 محظور"); io.sockets.sockets.get(t.id)?.disconnect(true); }
        break;
      case "unban":
        bans.delete(target); // target = IP
        break;
      case "clear":
        if (!u?.roleFlags?.isAdmin) return; // مسح السجل للأدمن فقط
        history.length = 0; io.emit("clear");
        pushHistory({ type:"system", text:"🧹 تم مسح السجل بواسطة المشرف" });
        io.emit("system", "🧹 تم مسح السجل بواسطة المشرف");
        break;
      default:
        return;
    }
    broadcastUsers();
  });

  socket.on("whois", (nick) => {
    const me = users.get(socket.id);
    const targetId = byNick.get(nick);
    const t = targetId ? users.get(targetId) : null;
    if (!t) return socket.emit("whois", { found:false });

    // إظهار IP للأدمن فقط
    socket.emit("whois", {
      found:true, nick:t.nick, country:t.country,
      ip: me?.roleFlags?.isAdmin ? t.ip : undefined
    });
  });

  socket.on("disconnect", () => {
    const u = users.get(socket.id);
    if (!u) return;
    users.delete(socket.id);
    byNick.delete(u.nick);
    if (canShowJoinLeave(u.ip)) {
      pushHistory({ type:"system", text:`❌ ${u.nick} خرج` });
      io.emit("system", `❌ ${u.nick} خرج`);
    }
    broadcastUsers();
  });
});

server.listen(PORT, () => console.log(`ArabChat Pro running on http://localhost:${PORT}`));

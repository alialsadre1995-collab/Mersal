// server.js — ArabChat Pro (fixed)
// تشغيل: npm install && npm start
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
let geoip;
try { geoip = require("geoip-lite"); } catch { geoip = null; }

const app = express();
app.set("trust proxy", true); // ضروري خلف Render/Proxy لأخذ IP صحيح

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.ORIGIN || "*", methods: ["GET","POST"] }
});

const PORT = process.env.PORT || 10000;
const ADMIN_USER = process.env.ADMIN_USER || "ArabAdmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "az77@";

// ===== ذاكرة مؤقتة =====
const users = new Map();        // socket.id -> user
const byNick = new Map();       // nick -> socket.id
const bans = new Set();         // ip
const mutes = new Set();        // ip
const stars = new Set();        // nick
const delegates = new Set();    // nick (~)
const lastSeenByIP = new Map(); // ip -> timestamp
const history = [];             // آخر 200 رسالة

function pushHistory(evt){
  history.push(evt);
  if (history.length > 200) history.shift();
}
function sanitizeNick(nick){
  if (!nick || typeof nick !== "string") nick = "";
  if (!/^[A-Za-z0-9_]{3,20}$/.test(nick)) {
    return "Guest" + Math.floor(Math.random()*9000+1000);
  }
  return nick;
}
function ensureUniqueNick(clean){
  if (!byNick.has(clean)) return clean;
  let i = 2;
  while (byNick.has(`${clean}_${i}`)) i++;
  return `${clean}_${i}`;
}
function countryFromIP(ip){
  try {
    const g = geoip?.lookup(ip);
    return g?.country || "??";
  } catch { return "??"; }
}
function canShowJoinLeave(ip){
  const now = Date.now();
  const last = lastSeenByIP.get(ip) || 0;
  lastSeenByIP.set(ip, now);
  return (now - last) > 5*60*1000; // 5 دقائق
}
function broadcastUsers(){
  const list = [...users.values()].map(u => ({
    nick: u.nick,
    country: u.country,
    admin: u.admin,
    star: stars.has(u.nick),
    delegate: delegates.has(u.nick)
  }));
  io.emit("users", list);
}

// صفحة العميل
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ===== Socket =====
io.on("connection", socket => {
  const raw = (socket.handshake.headers["x-forwarded-for"] || socket.handshake.address || "").toString();
  const ip = raw.split(",")[0].trim();

  if (bans.has(ip)) {
    socket.emit("banned", "🚫 محظور من الدخول");
    return socket.disconnect();
  }

  // تسجيل الدخول مع ACK لإرجاع حالة الأدمن للواجهة
  socket.on("login", ({ nick, admin, pass }, ack) => {
    let clean = sanitizeNick(nick);
    clean = ensureUniqueNick(clean); // منع نكّين متماثلين
    const isAdmin = !!(admin && (clean === ADMIN_USER) && (pass === ADMIN_PASS));

    const country = countryFromIP(ip);
    const user = { id: socket.id, nick: clean, ip, country, admin: isAdmin };
    users.set(socket.id, user);
    byNick.set(clean, socket.id);

    // التاريخ للمستخدم الجديد
    socket.emit("history", history);

    if (canShowJoinLeave(ip)) {
      pushHistory({ type: "system", text: `✅ ${clean} دخل الغرفة [${country}]` });
      io.emit("system", `✅ ${clean} دخل الغرفة [${country}]`);
    }

    if (user.admin) {
      pushHistory({ type: "system", text: `ChanServ ${clean} تم توكيل` });
      io.emit("system", `ChanServ ${clean} تم توكيل`);
    }

    broadcastUsers();

    if (typeof ack === "function") {
      ack({ ok: true, user: { nick: user.nick, admin: user.admin } });
    }
  });

  socket.on("msg", text => {
    const u = users.get(socket.id);
    if (!u) return;
    if (mutes.has(u.ip)) return; // مكتوم

    const evt = {
      type: "msg",
      nick: u.nick,
      country: u.country,
      text: String(text || "").slice(0, 2000)
    };
    pushHistory(evt);
    io.emit("msg", evt);
  });

  socket.on("pm", ({ to, text }) => {
    const u = users.get(socket.id);
    if (!u) return;
    const toId = byNick.get(to);
    if (!toId) return;
    const evt = { type: "pm", from: u.nick, to, text: String(text || "").slice(0, 2000) };
    io.to(toId).emit("pm", evt);
    socket.emit("pm", evt); // نسخة للمرسل
  });

  // إجراءات المشرف
  socket.on("admin:action", ({ action, target }) => {
    const u = users.get(socket.id);
    if (!u?.admin) return;

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
        bans.delete(target); // target هنا IP قادم من واجهة whois
        break;
      case "clear":
        history.length = 0;
        io.emit("clear");
        pushHistory({ type: "system", text: "🧹 تم مسح السجل بواسطة المشرف" });
        io.emit("system", "🧹 تم مسح السجل بواسطة المشرف");
        break;
      default: return;
    }
    broadcastUsers();
  });

  socket.on("whois", (nick) => {
    const meIsAdmin = users.get(socket.id)?.admin;
    const targetId = byNick.get(nick);
    const t = targetId ? users.get(targetId) : null;
    if (!t) return socket.emit("whois", { found: false });

    socket.emit("whois", {
      found: true,
      nick: t.nick,
      country: t.country,
      ip: meIsAdmin ? t.ip : undefined
    });
  });

  socket.on("disconnect", () => {
    const u = users.get(socket.id);
    if (!u) return;
    users.delete(socket.id);
    byNick.delete(u.nick);

    if (canShowJoinLeave(u.ip)) {
      pushHistory({ type: "system", text: `❌ ${u.nick} خرج` });
      io.emit("system", `❌ ${u.nick} خرج`);
    }
    broadcastUsers();
  });
});

server.listen(PORT, () => console.log(`ArabChat Pro running on http://localhost:${PORT}`));

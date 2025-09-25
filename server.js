// server.js — ArabChat Pro (إصلاح الأدمن + تحسينات الموبايل)
// تشغيل: npm install && npm start
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
let geoip;
try { geoip = require("geoip-lite"); } catch { geoip = null; }

const app = express();
app.set("trust proxy", true); // خلف Render/Proxy

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.ORIGIN || "*", methods: ["GET","POST"] }
});

const PORT = process.env.PORT || 10000;
const ADMIN_USER = process.env.ADMIN_USER || "ArabAdmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "az77@";

// ====== ذاكرة مؤقتة ======
const users = new Map();         // socket.id -> user
const byNick = new Map();        // nick -> socket.id
const bans = new Set();          // ip
const mutes = new Set();         // ip
const stars = new Set();         // nick
const delegates = new Set();     // nick (~)
const lastSeenByIP = new Map();  // ip -> timestamp
const history = [];              // آخر 200 رسالة

function pushHistory(evt){ history.push(evt); if (history.length > 200) history.shift(); }
function sanitizeNick(n){
  if (!n || typeof n !== "string") n = "";
  return /^[A-Za-z0-9_]{3,20}$/.test(n) ? n : "Guest" + Math.floor(Math.random()*9000+1000);
}
function ensureUniqueNick(clean){
  if (!byNick.has(clean)) return clean;
  let i = 2;
  while (byNick.has(`${clean}_${i}`)) i++;
  return `${clean}_${i}`;
}
function countryFromIP(ip){ try { return geoip?.lookup(ip)?.country || "??"; } catch { return "??"; } }
function canShowJoinLeave(ip){
  const now = Date.now(); const last = lastSeenByIP.get(ip) || 0;
  lastSeenByIP.set(ip, now);
  return (now - last) > 5*60*1000; // 5 دقائق
}
function broadcastUsers(){
  const list = [...users.values()].map(u => ({
    nick: u.nick, country: u.country, admin: u.admin,
    star: stars.has(u.nick), delegate: delegates.has(u.nick)
  }));
  io.emit("users", list);
}

// صفحة العميل
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

// Socket.IO
io.on("connection", socket => {
  const raw = (socket.handshake.headers["x-forwarded-for"] || socket.handshake.address || "").toString();
  const ip = raw.split(",")[0].trim();

  if (bans.has(ip)) { socket.emit("banned", "🚫 محظور من الدخول"); return socket.disconnect(); }

  // تسجيل الدخول (يدعم adminNick) + ACK
  socket.on("login", ({ nick, admin, adminNick, pass }, ack) => {
    const nickRaw = sanitizeNick(nick);
    const adminNameRaw = sanitizeNick(adminNick || nick);
    const willBeAdmin = !!(admin && adminNameRaw === ADMIN_USER && pass === ADMIN_PASS);

    // اسم العرض النهائي
    let displayNick = ensureUniqueNick(nickRaw);

    // لو الأدمن صحيح، خُذ الاسم الرسمي حتى لو محجوز
    if (willBeAdmin && displayNick !== ADMIN_USER) {
      const oldId = byNick.get(ADMIN_USER);
      if (oldId) {
        const oldUser = users.get(oldId);
        io.to(oldId).emit("kicked", "تم استرجاع اسم الأدمن");
        io.sockets.sockets.get(oldId)?.disconnect(true);
        users.delete(oldId);
        byNick.delete(ADMIN_USER);
      }
      displayNick = ADMIN_USER;
    }

    const country = countryFromIP(ip);
    const user = { id: socket.id, nick: displayNick, ip, country, admin: willBeAdmin };
    users.set(socket.id, user);
    byNick.set(displayNick, socket.id);

    // أعطِ التاريخ
    socket.emit("history", history);

    if (canShowJoinLeave(ip)) {
      pushHistory({ type:"system", text:`✅ ${displayNick} دخل الغرفة [${country}]` });
      io.emit("system", `✅ ${displayNick} دخل الغرفة [${country}]`);
    }
    if (user.admin) {
      pushHistory({ type:"system", text:`ChanServ ${displayNick} تم توكيل` });
      io.emit("system", `ChanServ ${displayNick} تم توكيل`);
    }

    broadcastUsers();

    if (typeof ack === "function") ack({ ok:true, user:{ nick:user.nick, admin:user.admin } });
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

  // إجراءات المشرف
  socket.on("admin:action", ({ action, target }) => {
    const u = users.get(socket.id); if (!u?.admin) return;

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
        bans.delete(target); // target = IP من whois
        break;
      case "clear":
        history.length = 0; io.emit("clear");
        pushHistory({ type:"system", text:"🧹 تم مسح السجل بواسطة المشرف" });
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
    if (!t) return socket.emit("whois", { found:false });

    socket.emit("whois", { found:true, nick:t.nick, country:t.country, ip: meIsAdmin ? t.ip : undefined });
  });

  socket.on("disconnect", () => {
    const u = users.get(socket.id); if (!u) return;
    users.delete(socket.id); byNick.delete(u.nick);
    if (canShowJoinLeave(u.ip)) {
      pushHistory({ type:"system", text:`❌ ${u.nick} خرج` });
      io.emit("system", `❌ ${u.nick} خرج`);
    }
    broadcastUsers();
  });
});

server.listen(PORT, () => console.log(`ArabChat Pro running on http://localhost:${PORT}`));

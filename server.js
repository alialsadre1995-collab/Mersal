// ArabChat Pro Dark – server
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 10000;
const ADMIN_USER = process.env.ADMIN_USER || "ArabAdmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "az77@";

// الذاكرة
let users = {}; // socket.id -> {name, role, ip, country, star, delegate, muted}
let bannedIPs = new Set();
let lastPresenceByIP = new Map(); // anti-spam presence (5min)
let chatHistory = []; // آخر 120 رسالة

app.use(express.static("public"));

// أدوات مساعدة
const now = () => Date.now();
const clampHistory = () => { if (chatHistory.length > 120) chatHistory.splice(0, chatHistory.length - 120); };
const toList = () => Object.values(users).map(u => ({
  name: u.name, role: u.role, country: u.country, star: u.star, delegate: u.delegate
}));
const isAdmin = (sid) => users[sid]?.role === "admin";
const nickOK = (n) => /^[A-Za-z0-9_]{3,20}$/.test(n || "");

// جلب علم الدولة من الخادم (أدق لأن Render يمرّر IP الحقيقي بالهيدر)
async function getFlagByIP(ip) {
  try {
    const r = await axios.get(`https://ipwho.is/${ip}`);
    if (r.data?.success && r.data?.flag?.emoji) return r.data.flag.emoji;
  } catch {}
  return "🏳️";
}

io.on("connection", (socket) => {
  const ip = socket.handshake.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
             socket.handshake.address || "0.0.0.0";

  if (bannedIPs.has(ip)) {
    socket.emit("banned");
    return socket.disconnect(true);
  }

  socket.on("join", async ({ name, pass }) => {
    // التحقق من الاسم
    if (!nickOK(name)) {
      // إن لم يكن إنجليزيًا أو الطول غير صحيح → تحويل إلى ضيف
      name = "Guest" + Math.floor(Math.random() * 9999);
    }

    // منع التكرار: لو موجود نفس الاسم نضيف لاحقة
    const taken = Object.values(users).some(u => u.name.toLowerCase() === name.toLowerCase());
    if (taken) name = name + "_" + Math.floor(Math.random() * 99);

    const role = (name === ADMIN_USER && pass === ADMIN_PASS) ? "admin" : "user";
    const country = await getFlagByIP(ip);

    users[socket.id] = { name, role, ip, country, star: false, delegate: false, muted: false };

    // إرسال السجل للمستخدم + تحديث المتواجدين للجميع
    socket.emit("history", chatHistory);
    io.emit("updateUsers", toList());

    // قمع رسائل الدخول/الخروج إن كانت خلال 5 دقائق من نفس الـ IP
    const last = lastPresenceByIP.get(ip) || 0;
    if (now() - last > 5 * 60 * 1000) {
      io.emit("message", { from: "النظام", text: `${name} انضم`, type: "info", ts: now() });
      lastPresenceByIP.set(ip, now());
    }

    // مناداة واجهة العميل لمعرفة دوري
    socket.emit("role", role);
  });

  // رسالة عامة
  socket.on("chat", (text) => {
    const u = users[socket.id];
    if (!u || u.muted) return;
    const msg = {
      from: u.name,
      country: u.country,
      text: ("" + text).slice(0, 800),
      type: "chat",
      color: (u.role === "admin" || u.delegate) ? "var(--c-admin)" : "var(--c-user)",
      star: !!u.star,
      delegate: !!u.delegate,
      ts: now()
    };
    chatHistory.push(msg); clampHistory();
    io.emit("message", msg);
  });

  // كتابة خاصة
  socket.on("private", ({ to, text }) => {
    const s = users[socket.id];
    if (!s) return;
    const pair = Object.entries(users).find(([id, u]) => u.name === to);
    if (!pair) return;
    const [toId, tgt] = pair;
    const payload = { from: s.name, to: tgt.name, text: ("" + text).slice(0, 800), ts: now() };
    io.to(toId).emit("private", payload);
    socket.emit("private", payload); // يظهر للطرفين
  });

  // معلومات مستخدم (whois)
  socket.on("whois", ({ target }) => {
    const req = users[socket.id];
    if (!req) return;
    const pair = Object.values(users).find(u => u.name === target);
    if (!pair) return;
    const data = {
      name: pair.name,
      country: pair.country,
      // إخفاء IP لغير المشرف
      ip: isAdmin(socket.id) ? pair.ip : undefined
    };
    socket.emit("whoisResult", data);
  });

  // إجراءات الإدارة من القائمة
  socket.on("adminAction", ({ action, target }) => {
    if (!isAdmin(socket.id)) return;
    const entry = Object.entries(users).find(([id, u]) => u.name === target);
    if (!entry) return;
    const [tid, t] = entry;

    const say = (txt) => io.emit("message", { from: "النظام", text: txt, type: "info", ts: now() });

    if (action === "ban") {
      bannedIPs.add(t.ip);
      io.to(tid).emit("banned");
      io.sockets.sockets.get(tid)?.disconnect(true);
      say(`${t.name} تم حظره`);
    } else if (action === "kick") {
      io.to(tid).emit("kicked");
      io.sockets.sockets.get(tid)?.disconnect(true);
      say(`${t.name} تم طرده`);
    } else if (action === "mute") {
      t.muted = true; say(`${t.name} تم كتمه`);
    } else if (action === "unmute") {
      t.muted = false; say(`${t.name} فُك كتمه`);
    } else if (action === "delegate") {
      t.delegate = true; say(`ChanServ ${t.name} تم توكيل`);
    } else if (action === "undelegate") {
      t.delegate = false; say(`${t.name} أزيل التوكيل عنه`);
    } else if (action === "star") {
      t.star = true; say(`${t.name} حصل على 🌟`);
    } else if (action === "unstar") {
      t.star = false; say(`${t.name} أزيلت النجمة عنه`);
    } else if (action === "clear") {
      chatHistory = []; io.emit("clearChat");
    }
    io.emit("updateUsers", toList());
  });

  // فصل
  socket.on("disconnect", () => {
    const u = users[socket.id];
    if (!u) return;
    const ip = u.ip;
    delete users[socket.id];
    io.emit("updateUsers", toList());
    const last = lastPresenceByIP.get(ip) || 0;
    if (now() - last > 5 * 60 * 1000) {
      io.emit("message", { from: "النظام", text: `${u.name} خرج`, type: "info", ts: now() });
      lastPresenceByIP.set(ip, now());
    }
  });
});

server.listen(PORT, () => console.log(`ArabChat Pro running on http://localhost:${PORT}`));

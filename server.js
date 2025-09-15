// ArabChat (Merged) — server + single page
// CommonJS (يعمل على Render بدون إعدادات خاصة)
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;
const ADMIN_USER = process.env.ADMIN_USER || "ArabAdmin";
const ADMIN_PASS = process.env.ADMIN_PASS || "az77@";
const ROOM = "#الوطن_العربي";

// ===== ذاكرة بسيطة =====
const users = new Map();      // sid -> {name, role, ip, country, star, op, muted}
const nameToId = new Map();   // name -> sid
const bannedIPs = new Set();  // ip strings
const lastPresenceByIP = new Map(); // ip -> timestamp (قمع دخول/خروج 5 دقائق)
let history = [];             // آخر 200 رسالة
const MAX_HISTORY = 200;

const now = () => Date.now();
const nickOK = (n) => /^[A-Za-z0-9_]{3,20}$/.test(n || "");
const toPublic = (u)=> ({ name:u.name, role:u.role, country:u.country, star:!!u.star, op:!!u.op });

function addHistory(m){ history.push(m); if(history.length>MAX_HISTORY) history.shift(); }

async function getFlag(ip){
  try{
    const r = await axios.get(`https://ipwho.is/${ip}`);
    if (r.data?.success && r.data?.flag?.emoji) return r.data.flag.emoji;
  }catch{}
  return "🏳️";
}

// صفحة واحدة (HTML + CSS + JS)
app.get("/", (_req,res)=>{
  res.setHeader("content-type","text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<title>ArabChat</title>
<style>
:root{--bg:#000;--card:#0f0f10;--bar:#0e0e12;--fg:#e8e8e8;--muted:#9aa4b2;--gold:#ffcc66;--acc:#32c864}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Arial;background:var(--bg);color:var(--fg);overscroll-behavior-y:none}
.hidden{display:none}
/* login */
#login{padding:32px 16px env(safe-area-inset-bottom);max-width:520px;margin:0 auto}
#login h1{text-align:center;margin:16px 0 24px}
.card{background:var(--card);padding:16px;border-radius:12px;display:grid;gap:10px}
.card input{padding:12px;border:1px solid #222;border-radius:10px;background:#111;color:#fff;font-size:16px}
.card button{padding:12px;border:0;border-radius:10px;background:var(--acc);color:#000;font-weight:700}
.hint{opacity:.7;text-align:center}
.adminBox summary{cursor:pointer;margin:6px 0}
/* chat layout */
#chat{height:100dvh;display:grid;grid-template-rows:auto 1fr auto}
.topbar{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;padding:12px 12px calc(12px + env(safe-area-inset-top));background:var(--bar);border-bottom:1px solid #1a1a1a}
.title{font-weight:700}
.icon{background:#1a1a1a;color:#fff;border:0;border-radius:8px;padding:8px 10px;cursor:pointer}
#messages{padding:12px;overflow:auto;scroll-behavior:smooth}
.msg{margin:6px 0;line-height:1.35}
.meta{display:inline-flex;gap:6px;align-items:center;margin-inline-end:6px}
.name{font-weight:700;direction:ltr} /* الاسم من اليسار */
.badge{font-size:12px;opacity:.85}
.info{color:#8dd3ff;text-align:center}
/* composer */
.inputBar{display:flex;gap:8px;align-items:center;padding:8px 12px calc(8px + env(safe-area-inset-bottom));background:var(--bar);border-top:1px solid #1a1a1a;position:sticky;bottom:0}
.inputBar input{flex:1;padding:12px;border-radius:12px;border:1px solid #222;background:#111;color:#fff;font-size:16px}
.inputBar button{padding:12px 14px;border:0;border-radius:12px;background:var(--acc);color:#000;font-weight:700}
/* users sheet */
.sheet{position:fixed;inset:auto 0 0 0;background:rgba(0,0,0,.92);backdrop-filter:blur(6px);border-top:1px solid #1a1a1a;max-height:80%;display:flex;flex-direction:column;z-index:50}
.sheet.hidden{display:none}
.sheet header{display:flex;justify-content:space-between;align-items:center;padding:12px;background:#0b0b0d}
#usersList{padding:10px;overflow:auto}
.userRow{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-radius:10px;background:#111;margin-bottom:8px}
.userRow .nick{direction:ltr}
/* PM sheet */
.pmLog{padding:10px;height:40vh;overflow:auto}
.pmInput{display:flex;gap:8px;padding:10px}
.pmInput input{flex:1;padding:10px;border-radius:10px;border:1px solid #222;background:#111;color:#fff}
.pmInput button{padding:10px 14px;border:0;border-radius:10px;background:var(--acc);color:#000;font-weight:700}
/* context menu */
.ctx{position:fixed;background:#111;border:1px solid #222;border-radius:10px;padding:6px;min-width:210px;box-shadow:0 10px 30px rgba(0,0,0,.5);z-index:60}
.ctx.hidden{display:none}
.ctx button{display:block;width:100%;text-align:right;background:transparent;color:#fff;border:0;padding:10px;border-radius:8px;cursor:pointer}
.ctx button:hover{background:#1b1b1b}
</style>
</head>
<body>
  <!-- LOGIN -->
  <section id="login">
    <h1>شات الوطن العربي</h1>
    <div class="card">
      <label>الاسم (إنجليزي فقط)</label>
      <input id="nick" placeholder="YourNick" inputmode="latin" autocapitalize="off" autocomplete="off"/>
      <details class="adminBox">
        <summary>تسجيل دخول مشرف</summary>
        <input id="adminUser" placeholder="اسم الأدمن (اختياري)"/>
        <input id="adminPass" placeholder="رمز الأدمن" type="password"/>
      </details>
      <button id="joinBtn">دخول الغرفة</button>
      <p class="hint">الأسماء العربية تتحول تلقائيًا إلى Guest.</p>
    </div>
  </section>

  <!-- CHAT -->
  <section id="chat" class="hidden">
    <header class="topbar">
      <div class="title">#الوطن_العربي</div>
      <button id="usersBtn" class="icon">👥</button>
    </header>

    <main id="messages" aria-live="polite"></main>

    <footer class="inputBar">
      <input id="msg" placeholder="اكتب رسالة..."/>
      <button id="send">إرسال</button>
    </footer>

    <!-- Users -->
    <aside id="usersPanel" class="sheet hidden">
      <header>
        <h3>المتواجدون</h3>
        <button id="closeUsers" class="icon">✕</button>
      </header>
      <div id="usersList"></div>
    </aside>

    <!-- Context -->
    <div id="ctx" class="ctx hidden"></div>

    <!-- PM -->
    <aside id="pmPanel" class="sheet hidden">
      <header>
        <h3 id="pmWith">@</h3>
        <button id="closePM" class="icon">✕</button>
      </header>
      <div id="pmLog" class="pmLog"></div>
      <div class="pmInput">
        <input id="pmText" placeholder="اكتب رسالة خاصة..."/>
        <button id="pmSend">إرسال</button>
      </div>
    </aside>
  </section>

  <script src="/socket.io/socket.io.js"></script>
  <script>
  // ===== Client =====
  const socket = io({ transports:["websocket","polling"] });
  const $ = (q)=>document.querySelector(q);
  const login=$("#login"), chat=$("#chat");
  const messages=$("#messages"), msgInput=$("#msg"), send=$("#send");
  const usersBtn=$("#usersBtn"), usersPanel=$("#usersPanel"), usersList=$("#usersList"), closeUsers=$("#closeUsers");
  const ctx=$("#ctx");
  const pmPanel=$("#pmPanel"), pmWith=$("#pmWith"), pmLog=$("#pmLog"), pmText=$("#pmText"), pmSend=$("#pmSend"), closePM=$("#closePM");

  let myRole="user", myNick="", pmTarget=null;

  $("#joinBtn").onclick=()=>{
    const nick=$("#nick").value.trim();
    const au=$("#adminUser").value.trim();
    const ap=$("#adminPass").value.trim();
    myNick = nick;
    socket.emit("join",{name:nick, pass: (au && ap && au===nick) ? ap : ""});
    login.classList.add("hidden");
    chat.classList.remove("hidden");
    setTimeout(()=>msgInput.focus(),30);
  };

  socket.on("role", r=> myRole=r);
  socket.on("history", arr=>{ messages.innerHTML=""; arr.forEach(renderMessage); });
  socket.on("message", m=> renderMessage(m));
  socket.on("clearChat", ()=> messages.innerHTML="");
  socket.on("roster", list=> renderUsers(list));
  socket.on("banned", ()=> alert("🚫 تم حظرك من الدخول"));
  socket.on("kicked", ()=> alert("🚪 تم طردك من الغرفة"));

  function sendPublic(){
    const t=msgInput.value; if(!t.trim()) return;
    socket.emit("chat", t);
    msgInput.value=""; setTimeout(()=>msgInput.focus(),20); // iPhone: إبقاء الكيبورد
  }
  send.onclick=sendPublic;
  msgInput.addEventListener("keydown",(e)=>{ if(e.key==="Enter"){ e.preventDefault(); sendPublic(); }});

  function esc(s){ return (""+s).replace(/[&<>"]/g, m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m])); }
  function renderMessage(m){
    const div=document.createElement("div");
    div.className="msg"+(m.type==="info"?" info":"");
    if(m.type==="info"){ div.textContent=m.text; }
    else {
      const badges=[]; if(m.delegate) badges.push('<span class="badge">~</span>'); if(m.star) badges.push('<span class="badge">🌟</span>');
      div.innerHTML=\`
        <span class="meta">
          <span class="flag">\${m.country||""}</span>
          <button class="name btnUser" data-nick="\${esc(m.from)}" style="color:\${m.color||'var(--fg)'}">\${esc(m.from)}</button>
          \${badges.join("")}
        </span>
        <span>\${esc(m.text)}</span>\`;
    }
    messages.appendChild(div); messages.scrollTop=messages.scrollHeight;
  }

  function renderUsers(list){
    usersList.innerHTML="";
    list.forEach(u=>{
      const row=document.createElement("div"); row.className="userRow";
      row.innerHTML=\`
        <div class="nick">\${u.country||""} \${esc(u.name)} \${u.op?"~":""} \${u.star?"🌟":""} \${u.role==="admin"?"(مشرف)":""}</div>
        <button class="icon act" data-nick="\${esc(u.name)}">⋯</button>\`;
      usersList.appendChild(row);
    });
  }
  usersBtn.onclick=()=> usersPanel.classList.remove("hidden");
  closeUsers.onclick=()=> usersPanel.classList.add("hidden");

  // سياق (منبثق) على الاسم أو ⋯
  document.addEventListener("click",(e)=>{
    const nick = e.target.closest(".btnUser")?.dataset?.nick || e.target.closest(".act")?.dataset?.nick;
    if(nick){ openCtx(e.pageX,e.pageY,nick); }
    else if(!e.target.closest("#ctx")) ctx.classList.add("hidden");
  });
  function openCtx(x,y,nick){
    const items=[{id:"pm",label:"رسالة خاصة"},{id:"whois",label:"كشف معلومات"}];
    if(myRole==="admin"){
      items.push(
        {id:"star",label:"إعطاء نجمة 🌟"},
        {id:"unstar",label:"إزالة نجمة"},
        {id:"delegate",label:"توكيل ~"},
        {id:"undelegate",label:"إزالة التوكيل"},
        {id:"mute",label:"كتم"},{id:"unmute",label:"فك الكتم"},
        {id:"kick",label:"طرد"},{id:"ban",label:"حظر IP"},
        {id:"clear",label:"مسح السجل"}
      );
    }
    ctx.innerHTML = items.map(i=>\`<button data-act="\${i.id}" data-n="\${esc(nick)}">\${i.label}</button>\`).join("");
    ctx.style.left=Math.max(8,x-220)+"px"; ctx.style.top=(y+8)+"px"; ctx.classList.remove("hidden");
  }
  ctx.addEventListener("click",(e)=>{
    const act=e.target?.dataset?.act, n=e.target?.dataset?.n; if(!act) return; ctx.classList.add("hidden");
    if(act==="pm"){ openPM(n); return; }
    if(act==="whois"){ socket.emit("whois",{target:n}); return; }
    if(myRole==="admin"){ socket.emit("adminAction",{action:act,target:n}); }
  });

  // Whois
  socket.on("whoisResult",(d)=>{
    const ipPart = d.ip ? "\\nIP: "+d.ip : "";
    alert(\`المستخدم: \${d.name}\\nالدولة: \${d.country}\${ipPart}\`);
  });

  // خاص
  function openPM(n){ pmTarget=n; pmWith.textContent="خاص مع: "+n; pmLog.innerHTML=""; pmPanel.classList.remove("hidden"); pmText.focus(); }
  pmSend.onclick=()=>{ if(!pmTarget) return; const t=pmText.value.trim(); if(!t) return; socket.emit("private",{to:pmTarget,text:t}); pmText.value=""; pmText.focus(); };
  socket.on("private",({from,to,text})=>{
    const who = (from===myNick)? \`أنا → \${to}\` : \`\${from} → أنا\`;
    const d=document.createElement("div"); d.className="msg";
    d.innerHTML=\`<span class="meta"><span class="name">\${who}</span></span><span>\${esc(text)}</span>\`;
    pmLog.appendChild(d); pmLog.scrollTop=pmLog.scrollHeight;
    if(pmPanel.classList.contains("hidden")) openPM(from===myNick?to:from);
  });
  closePM.onclick=()=>{ pmPanel.classList.add("hidden"); pmTarget=null; };

  // اتصال
  socket.on("connect",()=>console.log("✓ connected"));
  socket.on("connect_error",(e)=>alert("فشل الاتصال: "+e.message));
  </script>
</body>
</html>`);
});

// Health (اختياري)
app.get("/health", (_req,res)=> res.send("ok"));

// ===== Socket =====
io.on("connection", (socket)=>{
  const ip = (socket.handshake.headers["x-forwarded-for"] || socket.handshake.address || "")
               .toString().split(",")[0].trim();

  if (bannedIPs.has(ip)) {
    socket.emit("banned");
    return socket.disconnect(true);
  }

  socket.on("join", async ({name, pass})=>{
    if (!nickOK(name)) name = "Guest" + Math.floor(Math.random()*9999);
    if (nameToId.has(name)) name = name + "_" + Math.floor(Math.random()*99);

    const role = (name === ADMIN_USER && pass === ADMIN_PASS) ? "admin" : "user";
    const country = await getFlag(ip);

    const u = { name, role, ip, country, star:false, op:false, muted:false };
    users.set(socket.id, u);
    nameToId.set(name, socket.id);
    socket.join(ROOM);

    socket.emit("history", history);
    io.to(ROOM).emit("roster", Array.from(users.values()).map(toPublic));

    const last=lastPresenceByIP.get(ip)||0;
    if (now()-last > 5*60*1000){
      const sys={type:"info", text:`${name} انضم`, ts:now()};
      addHistory(sys); io.to(ROOM).emit("message", sys);
      lastPresenceByIP.set(ip, now());
    }
    socket.emit("role", role);
  });

  socket.on("chat",(text)=>{
    const u=users.get(socket.id); if(!u || u.muted) return;
    const m={type:"chat", from:u.name, country:u.country, star:!!u.star, delegate:!!u.op,
             color: (u.role==="admin"||u.op) ? "var(--gold)" : "var(--fg)",
             text: (""+text).slice(0,800), ts:now()};
    addHistory(m); io.to(ROOM).emit("message", m);
  });

  socket.on("private",({to,text})=>{
    const s=users.get(socket.id); if(!s) return;
    const tid=nameToId.get(to); if(!tid) return;
    const payload={from:s.name,to,text:(""+text).slice(0,800),ts:now()};
    io.to(tid).emit("private",payload); socket.emit("private",payload);
  });

  socket.on("whois",({target})=>{
    const req=users.get(socket.id); if(!req) return;
    const tid=nameToId.get(target); if(!tid) return;
    const u=users.get(tid);
    socket.emit("whoisResult",{name:u.name, country:u.country, ip: req.role==="admin"? u.ip: undefined});
  });

  socket.on("adminAction",({action,target})=>{
    const me=users.get(socket.id); if(!me || me.role!=="admin") return;

    if (action==="clear"){ history=[]; io.to(ROOM).emit("clearChat"); return; }

    const tid=nameToId.get(target); if(!tid) return;
    const t=users.get(tid); if(!t) return;

    const say=(txt)=>{ const m={type:"info",text:txt,ts:now()}; addHistory(m); io.to(ROOM).emit("message",m); };

    if(action==="kick"){ io.to(tid).emit("kicked"); io.sockets.sockets.get(tid)?.disconnect(true); say(\`\${t.name} تم طرده\`); }
    else if(action==="ban"){ bannedIPs.add(t.ip); io.to(tid).emit("banned"); io.sockets.sockets.get(tid)?.disconnect(true); say(\`\${t.name} تم حظره\`); }
    else if(action==="mute"){ t.muted=true; say(\`\${t.name} تم كتمه\`); }
    else if(action==="unmute"){ t.muted=false; say(\`\${t.name} فُك كتمه\`); }
    else if(action==="star"){ t.star=true; io.to(ROOM).emit("roster", Array.from(users.values()).map(toPublic)); say(\`\${t.name} حصل على 🌟\`); }
    else if(action==="unstar"){ t.star=false; io.to(ROOM).emit("roster", Array.from(users.values()).map(toPublic)); say(\`\${t.name} أزيلت 🌟\`); }
    else if(action==="delegate"){ t.op=true; io.to(ROOM).emit("roster", Array.from(users.values()).map(toPublic)); say(\`ChanServ \${t.name} تم توكيل\`); }
    else if(action==="undelegate"){ t.op=false; io.to(ROOM).emit("roster", Array.from(users.values()).map(toPublic)); say(\`\${t.name} أزيل التوكيل\`); }
  });

  socket.on("disconnect",()=>{
    const u=users.get(socket.id); if(!u) return;
    users.delete(socket.id); nameToId.delete(u.name);
    io.to(ROOM).emit("roster", Array.from(users.values()).map(toPublic));
    const last=lastPresenceByIP.get(u.ip)||0;
    if (now()-last > 5*60*1000){
      const sys={type:"info", text:`${u.name} خرج`, ts:now()};
      addHistory(sys); io.to(ROOM).emit("message", sys);
      lastPresenceByIP.set(u.ip, now());
    }
  });
});

server.listen(PORT, ()=> console.log("ArabChat running on http://localhost:"+PORT));

// ArabChat Pro Dark – client
const socket = io({ transports: ["websocket", "polling"] });

const $ = (q) => document.querySelector(q);
const $$ = (q) => document.querySelectorAll(q);

const login = $("#login");
const chat = $("#chat");
const messages = $("#messages");
const usersBtn = $("#usersBtn");
const usersPanel = $("#usersPanel");
const usersList = $("#usersList");
const closeUsers = $("#closeUsers");
const ctx = $("#ctx");
const msgInput = $("#msg");
const sendBtn = $("#send");

const pmPanel = $("#pmPanel");
const pmWith = $("#pmWith");
const pmLog = $("#pmLog");
const pmText = $("#pmText");
const pmSend = $("#pmSend");
const closePM = $("#closePM");

let myRole = "user";
let myNick = "";
let pmTarget = null;

// حفظ/استرجاع سجل محليًا (لكل عميل)
const LSKEY = "arabchat_pro_log";
function pushLocalLog(m){
  try {
    const arr = JSON.parse(localStorage.getItem(LSKEY) || "[]");
    arr.push(m); if (arr.length > 120) arr.shift();
    localStorage.setItem(LSKEY, JSON.stringify(arr));
  } catch {}
}
function loadLocalLog(){
  try {
    const arr = JSON.parse(localStorage.getItem(LSKEY) || "[]");
    arr.forEach(renderMessage);
  } catch {}
}

// واجهة الدخول
$("#joinBtn").onclick = () => {
  const nick = $("#nick").value.trim();
  const adminUser = $("#adminUser").value.trim();
  const adminPass = $("#adminPass").value.trim();
  myNick = nick;

  socket.emit("join", { name: nick, pass: (adminUser && adminPass && adminUser === nick) ? adminPass : "" });

  login.classList.add("hidden");
  chat.classList.remove("hidden");
  loadLocalLog();
  setTimeout(() => msgInput.focus(), 30);
};

// إرسال عام
function sendPublic(){
  const t = msgInput.value;
  if(!t.trim()) return;
  socket.emit("chat", t);
  msgInput.value = "";
  // نحافظ على الكيبورد مفتوحًا عبر refocus سريع
  setTimeout(() => msgInput.focus(), 20);
}
sendBtn.onclick = sendPublic;
msgInput.addEventListener("keydown", (e)=>{
  if(e.key === "Enter"){ e.preventDefault(); sendPublic(); }
});

// استقبال دوري
socket.on("role", r => myRole = r);

socket.on("history", arr => {
  messages.innerHTML = "";
  arr.forEach(renderMessage);
});

socket.on("message", (m) => {
  renderMessage(m);
  pushLocalLog(m);
});

socket.on("clearChat", () => {
  messages.innerHTML = "";
  localStorage.removeItem(LSKEY);
});

socket.on("updateUsers", (list) => renderUsers(list));

socket.on("banned", () => alert("🚫 تم حظرك من الدخول"));
socket.on("kicked", () => alert("🚪 تم طردك من الغرفة"));

// خاص
function openPM(withNick){
  pmTarget = withNick;
  pmWith.textContent = "خاص مع: " + withNick;
  pmLog.innerHTML = "";
  pmPanel.classList.remove("hidden");
  pmText.focus();
}
pmSend.onclick = () => {
  if(!pmTarget) return;
  const text = pmText.value.trim();
  if(!text) return;
  socket.emit("private", { to: pmTarget, text });
  pmText.value = "";
  pmText.focus();
};
socket.on("private", ({from, to, text, ts})=>{
  const who = (from === myNick) ? `أنا → ${to}` : `${from} → أنا`;
  const div = document.createElement("div");
  div.className = "msg";
  div.innerHTML = `<span class="meta"><span class="name">${who}</span></span><span>${esc(text)}</span>`;
  pmLog.appendChild(div);
  pmLog.scrollTop = pmLog.scrollHeight;
  // لو اللوحة مغلقة والرسالة مني/ليه افتح تلقائيًا
  if(pmPanel.classList.contains("hidden")){
    openPM(from === myNick ? to : from);
  }
});
$("#closePM").onclick = ()=>{ pmPanel.classList.add("hidden"); pmTarget = null; };

// عرض رسالة عامة
function esc(s){ return (""+s).replace(/[&<>"]/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[m])); }
function renderMessage(m){
  const div = document.createElement("div");
  div.className = "msg " + (m.type === "info" ? "info" : "");
  if(m.type === "info"){
    div.textContent = m.text;
  } else {
    const badges = [];
    if (m.delegate) badges.push(`<span class="badge">~</span>`);
    if (m.star) badges.push(`<span class="badge">🌟</span>`);
    div.innerHTML =
      `<span class="meta">
        <span class="flag">${m.country || ""}</span>
        <button class="name btnUser" data-nick="${esc(m.from)}" style="color:${m.color || "var(--c-user)"}">${esc(m.from)}</button>
        ${badges.join("")}
      </span>
      <span>${esc(m.text)}</span>`;
  }
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

// قائمة المتواجدين
function renderUsers(list){
  usersList.innerHTML = "";
  list.forEach(u=>{
    const row = document.createElement("div");
    row.className = "userRow";
    row.innerHTML = `
      <div class="nick">${u.country || ""} ${esc(u.name)} ${u.delegate ? "~":""} ${u.star?"🌟":""} ${u.role==="admin"?"(مشرف)":""}</div>
      <button class="icon act" data-nick="${esc(u.name)}">⋯</button>
    `;
    usersList.appendChild(row);
  });
}
usersBtn.onclick = ()=> usersPanel.classList.remove("hidden");
closeUsers.onclick = ()=> usersPanel.classList.add("hidden");

// قائمة منبثقة عند الضغط على اسم
document.addEventListener("click",(e)=>{
  const targetNick = e.target.closest(".btnUser")?.dataset?.nick || e.target.closest(".act")?.dataset?.nick;
  if (targetNick){
    openCtx(e.pageX, e.pageY, targetNick);
  } else if (!e.target.closest("#ctx")){
    ctx.classList.add("hidden");
  }
});
function openCtx(x,y,nick){
  const items = [
    { id:"pm", label:"رسالة خاصة" },
    { id:"whois", label:"كشف معلومات" }
  ];
  if (myRole === "admin"){
    items.push(
      {id:"star", label:"إعطاء نجمة 🌟"},
      {id:"unstar", label:"إزالة نجمة"},
      {id:"delegate", label:"توكيل ~"},
      {id:"undelegate", label:"إزالة التوكيل"},
      {id:"mute", label:"كتم"},
      {id:"unmute", label:"فك الكتم"},
      {id:"kick", label:"طرد"},
      {id:"ban", label:"حظر IP"},
      {id:"clear", label:"مسح السجل"}
    );
  }
  ctx.innerHTML = items.map(i=>`<button data-act="${i.id}" data-n="${esc(nick)}">${i.label}</button>`).join("");
  ctx.style.left = Math.max(8, x-200) + "px";
  ctx.style.top = (y+8) + "px";
  ctx.classList.remove("hidden");
}
ctx.addEventListener("click",(e)=>{
  const act = e.target?.dataset?.act, n = e.target?.dataset?.n;
  if(!act) return;
  ctx.classList.add("hidden");
  if (act === "pm"){ openPM(n); return; }
  if (act === "whois"){ socket.emit("whois", { target:n }); return; }
  if (myRole === "admin"){
    socket.emit("adminAction", { action: act, target: n });
  }
});

// whois نتيجة
socket.on("whoisResult", (d)=>{
  const ipPart = d.ip ? `\nIP: ${d.ip}` : "";
  alert(`المستخدم: ${d.name}\nالدولة: ${d.country}${ipPart}`);
});

// تحسينات iPhone: إبقاء الإدخال واضحًا
// نعيد التركيز بعد الإرسال + padding آمن سفلي موجود بالـ CSS
window.addEventListener("touchend", (e)=>{
  if(e.target === messages) msgInput.blur();
});

// حفظ سجل الجلسة عند الخروج
window.addEventListener("beforeunload", ()=>{ /* المحتوى محفوظ مسبقًا في localStorage */ });

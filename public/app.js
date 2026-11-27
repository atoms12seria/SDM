const $ = s => document.querySelector(s);
let me = null, activeRequest = null, socket = null;
const deviceKey = "seria_admin_device_id";
const deviceId = () => {
  let v = localStorage.getItem(deviceKey);
  if (!v) { v = crypto.randomUUID(); localStorage.setItem(deviceKey, v); }
  return v;
};
async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set("content-type", "application/json");
  if (me?.role === "admin") headers.set("X-Device-Id", deviceId());
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "通信に失敗しました。");
  return data;
}
function notice(message, error = false) {
  const el = $("#notice"); el.textContent = message; el.classList.remove("hidden","error");
  if (error) el.classList.add("error");
}
function clearNotice(){ $("#notice").classList.add("hidden"); }
function showAuth(){ $("#authView").classList.remove("hidden"); $("#appView").classList.add("hidden"); $("#logoutBtn").classList.add("hidden"); }
function showApp(){
  $("#authView").classList.add("hidden"); $("#appView").classList.remove("hidden"); $("#logoutBtn").classList.remove("hidden");
  $("#welcomeTitle").textContent = `${me.name} さん`;
  $("#rolePill").textContent = me.role === "admin" ? "管理者" : "利用者";
  $("#adminEnroll").classList.toggle("hidden", me.role !== "admin");
  $("#requestFormPanel").classList.toggle("hidden", me.role === "admin");
  $("#listTitle").textContent = me.role === "admin" ? "すべての依頼" : "自分の依頼";
  loadRequests();
}
document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x === btn));
  $("#loginForm").classList.toggle("hidden", btn.dataset.tab !== "login");
  $("#registerForm").classList.toggle("hidden", btn.dataset.tab !== "register");
}));
$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault(); clearNotice();
  const f = new FormData(e.currentTarget);
  try { await api("/api/auth/login",{method:"POST",body:JSON.stringify(Object.fromEntries(f))}); await boot(); notice("ログインしました。"); }
  catch(err){ notice(err.message,true); }
});
$("#registerForm").addEventListener("submit", async e => {
  e.preventDefault(); clearNotice();
  try { const f = new FormData(e.currentTarget); const r = await api("/api/auth/register",{method:"POST",body:JSON.stringify(Object.fromEntries(f))}); notice(r.message); e.currentTarget.reset(); }
  catch(err){ notice(err.message,true); }
});
$("#logoutBtn").addEventListener("click", async () => {
  try { await api("/api/auth/logout",{method:"POST",body:"{}"}); } catch {}
  closeSocket(); me=null; showAuth(); notice("ログアウトしました。");
});
$("#deviceForm").addEventListener("submit", async e => {
  e.preventDefault();
  const f = new FormData(e.currentTarget);
  try { const r = await api("/api/device/register",{method:"POST",body:JSON.stringify({deviceId:deviceId(),...Object.fromEntries(f)})}); notice(r.message); }
  catch(err){ notice(err.message,true); }
});
$("#requestForm").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    const r = await api("/api/requests",{method:"POST",body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget)))});
    e.currentTarget.reset(); notice("依頼を送信しました。"); await loadRequests(); await openChat(r.requestId);
  } catch(err){ notice(err.message,true); }
});
$("#refreshBtn").addEventListener("click", loadRequests);
$("#closeChat").addEventListener("click", () => { closeSocket(); $("#chatPanel").classList.add("hidden"); activeRequest=null; });
$("#messageForm").addEventListener("submit", async e => {
  e.preventDefault(); if(!activeRequest) return;
  const field=e.currentTarget.elements.body, text=field.value.trim(); if(!text)return;
  try { await api("/api/messages",{method:"POST",body:JSON.stringify({requestId:activeRequest,body:text})}); field.value=""; }
  catch(err){ notice(err.message,true); }
});
async function loadRequests(){
  try {
    const r=await api("/api/requests");
    const list=$("#requestList"); list.replaceChildren();
    if(!r.requests.length){ list.innerHTML='<p class="muted">まだ依頼はありません。</p>'; return; }
    for(const item of r.requests){
      const button=document.createElement("button"); button.className="request-item";
      const left=document.createElement("span");
      const strong=document.createElement("strong"); strong.textContent=item.title;
      const small=document.createElement("small"); small.textContent=`${item.user_name ? item.user_name+" · " : ""}${item.category} · ${new Date(item.created_at.replace(" ","T")+"Z").toLocaleString("ja-JP")}`;
      left.append(strong,small);
      const status=document.createElement("span"); status.className="status"; status.textContent=item.status;
      button.append(left,status); button.addEventListener("click",()=>openChat(item.id,item.title));
      list.append(button);
      if (me.role === "admin") {
        const controls=document.createElement("div"); controls.className="admin-status";
        const select=document.createElement("select");
        ["受付","対応中","完了","却下"].forEach(v=>{const o=document.createElement("option");o.value=v;o.textContent=v;o.selected=v===item.status;select.append(o);});
        select.addEventListener("change",async()=>{
          try { await api("/api/admin/status",{method:"PATCH",body:JSON.stringify({requestId:item.id,status:select.value})}); notice("依頼の状態を更新しました。"); }
          catch(err){ notice(err.message,true); }
        });
        controls.append(select); list.append(controls);
      }
    }
  } catch(err){ notice(err.message,true); }
}
function addMessage(m){
  const box=$("#chatMessages"), el=document.createElement("div");
  el.className="message"+(m.sender_id===me.id?" mine":"");
  const who=document.createElement("small"); who.textContent=`${m.sender_name || "ユーザー"} · ${new Date(m.created_at).toLocaleString("ja-JP")}`;
  const text=document.createElement("div"); text.textContent=m.body;
  el.append(who,text); box.append(el); box.scrollTop=box.scrollHeight;
}
async function openChat(requestId,title="依頼チャット"){
  closeSocket(); activeRequest=requestId; $("#chatTitle").textContent=title; $("#chatPanel").classList.remove("hidden");
  $("#chatMessages").replaceChildren();
  try {
    const r=await api(`/api/requests/${encodeURIComponent(requestId)}/messages`);
    r.messages.forEach(addMessage);
    const protocol=location.protocol==="https:"?"wss:":"ws:";
    socket=new WebSocket(`${protocol}//${location.host}/api/chat/socket?requestId=${encodeURIComponent(requestId)}`);
    socket.addEventListener("message", e => { try { const data=JSON.parse(e.data); if(data.type==="message" && data.message.sender_id!==me.id)addMessage(data.message); } catch{} });
    socket.addEventListener("close",()=>{ if(activeRequest===requestId) notice("チャット接続が切れました。ページを更新してください。",true); });
  } catch(err){ notice(err.message,true); }
}
function closeSocket(){ if(socket){socket.close();socket=null;} }
async function boot(){
  try {
    const r=await api("/api/me"); me=r.user;
    if(me) showApp(); else showAuth();
  } catch { showAuth(); }
}
(async()=>{
  const token=new URLSearchParams(location.search).get("verify");
  if(token){
    try { const r=await api("/api/auth/verify",{method:"POST",body:JSON.stringify({token})}); history.replaceState({}, "", "/"); notice(r.message); }
    catch(err){ history.replaceState({}, "", "/"); notice(err.message,true); }
  }
  await boot();
})();

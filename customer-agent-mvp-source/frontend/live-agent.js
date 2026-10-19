(function(){
  "use strict";
  const cfg=window.CHAT_CONFIG||{},apiBase=(cfg.apiBaseUrl||"").replace(/\/$/,"");
  const localMode = cfg.backendMode === "local-typescript" &&
    ["localhost", "127.0.0.1"].includes(location.hostname) &&
    (() => { try { return ["localhost", "127.0.0.1"].includes(new URL(apiBase).hostname); } catch { return false; } })();
  const localTenantId = "slt", localAgentId = "local-agent-01";
  let auth=null,online=false,timer=null,selected=null;
  const state={waiting:[],assigned:[],messages:[]};
  const demo={waiting:[{sessionId:"a20c71b1-4238-4ee5-b038-5eef07dd21c7",publicAgentKey:"customer-care",status:"HANDOFF_REQUESTED",handoffReason:"Customer explicitly requested human assistance",updatedAt:Date.now()/1000}],assigned:[],messages:{"a20c71b1-4238-4ee5-b038-5eef07dd21c7":[{messageId:"m1",role:"user",text:"Hi, I need help choosing a package.",createdAt:new Date().toISOString()},{messageId:"m2",role:"assistant",text:"I can help with that. Would you like to speak with a person?",createdAt:new Date().toISOString()},{messageId:"m3",role:"user",text:"Yes, please connect me to a live agent.",createdAt:new Date().toISOString()}]}};
  const $=s=>document.querySelector(s),esc=v=>String(v??"").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
  async function request(path,options={}){
    if(localMode){
      let endpoint, requestBody;
      const messageRoute=path.match(/^\/v1\/live\/conversations\/([a-zA-Z0-9_-]{1,128})\/messages$/);
      const closeRoute=path.match(/^\/v1\/live\/conversations\/([a-zA-Z0-9_-]{1,128})\/close$/);
      if(path==="/v1/live/presence"){
        endpoint=JSON.parse(options.body||"{}").status==="ONLINE"?"/api/agent/presence/online":"/api/agent/presence/offline";
        requestBody=JSON.stringify({tenantId:localTenantId,agentId:localAgentId});
      }else if(path==="/v1/live/queue"){
        endpoint=`/api/dev/live/queue?tenantId=${encodeURIComponent(localTenantId)}&agentId=${encodeURIComponent(localAgentId)}`;
      }else if(messageRoute){
        endpoint=`/api/dev/live/conversations/${encodeURIComponent(messageRoute[1])}/messages?tenantId=${encodeURIComponent(localTenantId)}&agentId=${encodeURIComponent(localAgentId)}`;
        if((options.method||"GET").toUpperCase()==="POST"){
          requestBody=JSON.stringify({role:"live_agent",message:JSON.parse(options.body||"{}").message});
        }
      }else if(closeRoute){
        endpoint=`/api/dev/live/conversations/${encodeURIComponent(closeRoute[1])}/close?tenantId=${encodeURIComponent(localTenantId)}&agentId=${encodeURIComponent(localAgentId)}`;
      }else throw new Error("This action is not available in the local development console");
      const response=await fetch(apiBase+endpoint,{method:options.method||"GET",headers:{"Content-Type":"application/json"},body:requestBody});
      const data=await response.json().catch(()=>({}));
      if(!response.ok||data.success===false)throw new Error(data.error?.message||data.error||"Local backend request failed");
      return data;
    }
    if(!apiBase)return demoRequest(path,options);
    const token=auth.id_token||auth.access_token;const res=await fetch(apiBase+path,{...options,headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`,...options.headers}}),body=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(body.message||"Request failed");return body;
  }
  function demoRequest(path,options){const method=options.method||"GET",id=(path.match(/conversations\/([^/]+)/)||[])[1];
    if(path==="/v1/live/queue")return Promise.resolve({waiting:demo.waiting,assigned:demo.assigned});
    if(path==="/v1/live/presence")return Promise.resolve({presence:JSON.parse(options.body).status});
    if(path.endsWith("/accept")){const item=demo.waiting.find(x=>x.sessionId===id);demo.waiting=demo.waiting.filter(x=>x!==item);item.status="HUMAN_ACTIVE";demo.assigned.push(item);return Promise.resolve(item)}
    if(path.endsWith("/messages")&&method==="GET")return Promise.resolve({session:[...demo.waiting,...demo.assigned].find(x=>x.sessionId===id),messages:demo.messages[id]||[]});
    if(path.endsWith("/messages")&&method==="POST"){const body=JSON.parse(options.body),msg={messageId:`m${Date.now()}`,role:"live_agent",text:body.message,createdAt:new Date().toISOString(),senderName:"Admin One"};(demo.messages[id]||(demo.messages[id]=[])).push(msg);return Promise.resolve(msg)}
    if(path.endsWith("/close")){demo.assigned=demo.assigned.filter(x=>x.sessionId!==id);return Promise.resolve({status:"CLOSED"})}return Promise.resolve({});}
  async function setPresence(value){try{await request("/v1/live/presence",{method:"POST",body:JSON.stringify({status:value?"ONLINE":"OFFLINE"})});online=value;$("#presenceText").textContent=value?"You are online and receiving handoffs":"You are offline";$("#presenceDot").className=`dot ${value?"":"gray"}`;$("#onlineButton").disabled=value;$("#offlineButton").disabled=!value;$("#connectionDot").className=`dot ${value?"":"gray"}`;$("#connectionText").textContent=localMode?"Local development only (no Cognito login)":(value?"Connected":"Ready");if(value){await poll();timer=setInterval(poll,4000)}else{clearInterval(timer);timer=null}}catch(e){toast(e.message,true)}}
  async function poll(){if(!online)return;try{const result=await request("/v1/live/queue");state.waiting=result.waiting||[];state.assigned=result.assigned||[];
    if(localMode&&selected&&!state.assigned.some(s=>s.sessionId===selected.sessionId)){
      selected=null;
      $("#conversationTitle").textContent="No chat selected";
      $("#conversationMeta").textContent="Select a customer from the queue.";
      $("#closeConversation").classList.add("hidden");
      $("#liveInput").disabled=true;$("#liveSend").disabled=true;
      $("#liveMessages").innerHTML='<div class="waiting-placeholder">This conversation has left your active queue.</div>';
    }
    renderQueue();if(selected&&selected.status==="HUMAN_ACTIVE"&&state.assigned.some(s=>s.sessionId===selected.sessionId))await loadMessages()
  }catch(e){toast(e.message,true)}}
  function renderQueue(){const items=[...state.assigned.map(x=>({...x,bucket:"assigned"})),...state.waiting.map(x=>({...x,bucket:"waiting"}))];$("#queueCount").textContent=items.length;$("#queueList").innerHTML=items.length?items.map(x=>`<button class="queue-item ${selected?.sessionId===x.sessionId?'active':''}" data-session="${esc(x.sessionId)}" data-bucket="${x.bucket}"><strong>${x.bucket==='waiting'?'Waiting customer':'Active conversation'}</strong><span>${esc(x.publicAgentKey||x.agentId)} · ${new Date(Number(x.updatedAt)*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span></button>`).join(""):`<div class="empty-state"><strong>No conversations</strong>New handoffs will appear automatically.</div>`}
  async function selectSession(id,bucket){selected=(bucket==="assigned"?state.assigned:state.waiting).find(x=>x.sessionId===id);renderQueue();$("#conversationTitle").textContent=`Customer ${id.slice(0,8)}`;$("#conversationMeta").textContent=selected.publicAgentKey||selected.agentId||"Customer assistant";const waiting=selected.status==="HANDOFF_REQUESTED"||bucket==="waiting";$("#acceptButton").classList.toggle("hidden",localMode||!waiting);$("#closeConversation").classList.toggle("hidden",waiting);$("#liveInput").disabled=waiting;$("#liveSend").disabled=waiting;if(waiting){$("#liveMessages").innerHTML='<div class="waiting-placeholder">Accept this handoff to view and continue the conversation.</div>'}else await loadMessages()}
  async function accept(){if(!selected)return;try{selected=await request(`/v1/live/conversations/${selected.sessionId}/accept`,{method:"POST",body:"{}"});selected.status="HUMAN_ACTIVE";await poll();await selectSession(selected.sessionId,"assigned");toast("Conversation assigned to you")}catch(e){toast(e.message,true)}}
  async function loadMessages(){if(!selected)return;try{const result=await request(`/v1/live/conversations/${selected.sessionId}/messages`);state.messages=result.messages||[];renderMessages()}catch(e){toast(e.message,true)}}
  function renderMessages(){$("#liveMessages").innerHTML=state.messages.length?state.messages.map(m=>`<div class="live-msg ${m.role==='live_agent'?'agent':''}"><div class="live-bubble">${esc(m.text)}<div class="message-time">${m.role==='live_agent'?'You':m.role==='assistant'?'AI assistant':'Customer'} · ${new Date(m.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div></div></div>`).join(""):'<div class="waiting-placeholder">No messages in this conversation.</div>';$("#liveMessages").scrollTop=$("#liveMessages").scrollHeight}
  async function send(event){event.preventDefault();const input=$("#liveInput"),message=input.value.trim();if(!message||!selected)return;if(localMode&&message.length>1600){toast("Local test messages are limited to 1600 characters",true);return}input.value="";try{await request(`/v1/live/conversations/${selected.sessionId}/messages`,{method:"POST",body:JSON.stringify({message})});await loadMessages()}catch(e){input.value=message;toast(e.message,true)}}
  async function closeChat(){if(!selected||!confirm("Close this customer conversation?"))return;try{await request(`/v1/live/conversations/${selected.sessionId}/close`,{method:"POST",body:"{}"});selected=null;$("#conversationTitle").textContent="No chat selected";$("#conversationMeta").textContent="Select a customer from the queue.";$("#closeConversation").classList.add("hidden");$("#liveInput").disabled=true;$("#liveSend").disabled=true;$("#liveMessages").innerHTML='<div class="waiting-placeholder">Customer messages will appear here.</div>';await poll();toast("Conversation closed")}catch(e){toast(e.message,true)}}
  function toast(message,error){const el=$("#toast");el.textContent=message;el.style.background=error?"#a52e40":"#183754";el.classList.remove("hidden");setTimeout(()=>el.classList.add("hidden"),3200)}
  async function init(){try{auth=localMode?{claims:{name:"Local Test Agent (not authenticated)"}}:await ConsoleAuth.requireAuth("LIVE_AGENT");if(!auth)return;$("#loginGate").classList.add("hidden");$("#liveApp").classList.remove("hidden");$("#liveProfileName").textContent=auth.claims.name||auth.claims.email||"Agent";await setPresence(true)}catch(e){$("#loginGate p").textContent=e.message}}
  $("#loginButton").addEventListener("click",()=>localMode?init():ConsoleAuth.login());$("#liveLogout").addEventListener("click",()=>localMode?setPresence(false):ConsoleAuth.logout());$("#onlineButton").addEventListener("click",()=>setPresence(true));$("#offlineButton").addEventListener("click",()=>setPresence(false));$("#acceptButton").addEventListener("click",accept);$("#closeConversation").addEventListener("click",closeChat);$("#liveComposer").addEventListener("submit",send);$("#queueList").addEventListener("click",e=>{const b=e.target.closest("[data-session]");if(b)selectSession(b.dataset.session,b.dataset.bucket)});window.addEventListener("beforeunload",()=>{clearInterval(timer)});init();
})();

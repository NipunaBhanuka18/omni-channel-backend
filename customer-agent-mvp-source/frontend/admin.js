(function(){
  "use strict";
  const cfg=window.CHAT_CONFIG||{}, apiBase=(cfg.apiBaseUrl||"").replace(/\/$/,"");
  // This preview is limited to a frontend served on loopback with the local TypeScript dev API.
  // It never authenticates a real user or invokes any administrative write endpoints.
  const localAdminPreview = cfg.backendMode === "local-typescript" &&
    ["localhost", "127.0.0.1"].includes(window.location.hostname) &&
    /^http:\/\/(localhost|127\.0\.0\.1):3001$/.test(apiBase) &&
    !(cfg.auth && (cfg.auth.domain || cfg.auth.clientId));
  let auth=null, modalMode=null, editingId=null;
  const state={dashboard:{},agents:[],knowledge:[],tools:[],liveAgents:[],chats:[],team:[],workspace:{},seatRequests:[]};
  const demo={
    dashboard:{agents:2,publishedAgents:1,knowledgeBases:2,tools:3,liveAgents:2,onlineAgents:1,waitingHandoffs:1,activeHumanChats:1},
    agents:[{agentId:"agent-care",displayName:"Customer Care Assistant",brandName:"SLT-MOBITEL",publicAgentKey:"customer-care",status:"PUBLISHED",modelId:"amazon.nova-lite-v1:0",knowledgeBaseRef:"kb-products",toolIds:["tool-ticket","form-lead"],enabledSubAgents:["general","sales","billing","technical","lead"],welcomeMessage:"Hello! How can I help you today?",systemPrompt:"Answer using approved company information.",suggestedPrompts:["Explore packages","Check my bill","Technical help"]},{agentId:"agent-sales",displayName:"Sales Guide",brandName:"SLT-MOBITEL",publicAgentKey:"sales-guide",status:"DRAFT",modelId:"amazon.nova-lite-v1:0",toolIds:["form-lead"],enabledSubAgents:["general","sales","lead"],welcomeMessage:"Let’s find the right service for you.",systemPrompt:"Help customers compare available packages."}],
    knowledge:[{kbId:"kb-products",name:"Products & Packages",description:"Approved package, pricing, and service information.",bedrockKnowledgeBaseId:"KBDEMO001",dataSourceId:"DSDEMO001",status:"READY"},{kbId:"kb-support",name:"Support Guides",description:"Technical troubleshooting and customer help articles.",bedrockKnowledgeBaseId:"KBDEMO002",dataSourceId:"DSDEMO002",status:"READY"}],
    tools:[{toolId:"tool-ticket",name:"create_ticket",displayName:"Create support ticket",type:"mcp",description:"Creates a verified support ticket through AgentCore Gateway.",enabled:true,gatewayUrl:"https://gateway.example.com/mcp",targetToolName:"support___create_ticket"},{toolId:"tool-order",name:"check_order",displayName:"Check order status",type:"api",description:"Checks an order using a reference number.",enabled:true,endpoint:"https://api.example.com/orders/check",method:"POST"},{toolId:"form-lead",name:"sales_interest",displayName:"Sales interest form",type:"form",description:"Collects contact details for a sales follow-up.",enabled:true,formSchema:{formId:"sales_interest",title:"Tell us what you need",description:"Share the essentials for a follow-up.",fields:[{name:"name",label:"Your name",type:"text",required:true},{name:"contact",label:"Mobile or email",type:"text",required:true}]}}],
    liveAgents:[{userId:"u-1",name:"Admin One",email:"admin1@example.com",presence:"ONLINE",status:"ACTIVE"},{userId:"u-2",name:"Support Two",email:"support2@example.com",presence:"OFFLINE",status:"ACTIVE"}],
    chats:[{sessionId:"9ec1d1f8-demo",publicAgentKey:"customer-care",status:"HANDOFF_REQUESTED",updatedAt:Date.now()/1000},{sessionId:"73b122d1-demo",publicAgentKey:"customer-care",status:"HUMAN_ACTIVE",updatedAt:Date.now()/1000-320}],
    workspace:{tenantId:"ten_demo_acme",tenantSlug:"acme-demo",companyName:"Acme Corporation",status:"ACTIVE",plan:"STARTER",adminSeatLimit:1,liveAgentSeatLimit:1,usedAdminSeats:1,usedLiveAgentSeats:1},
    team:[{userId:"admin-demo",name:"Test Admin",email:"admin@acme.example",role:"COMPANY_ADMIN",status:"ACTIVE"},{userId:"u-1",name:"Admin One",email:"agent@acme.example",role:"LIVE_AGENT",status:"ACTIVE"}],seatRequests:[]
  };
  const $=s=>document.querySelector(s), esc=v=>String(v??"").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
  async function request(path,options={}){
    if(localAdminPreview){
      if((options.method||"GET").toUpperCase()!=="GET"){
        // Explicitly allow only agent-record creation in the restricted local demo.
        if(path==="/v1/admin/agents" && options.method==="POST"){
          const response=await fetch(apiBase+"/api/dev/admin/agents",{
            method:"POST",
            headers:{"Content-Type":"application/json","X-Local-Admin-Demo":"create-agent"},
            body:options.body
          });
          const body=await response.json().catch(()=>({}));
          if(!response.ok)throw new Error(body.error||`Agent creation failed (HTTP ${response.status})`);
          return body;
        }
        const publishMatch = path.match(/^\/v1\/admin\/agents\/(agent-[a-zA-Z0-9-]+)\/publish$/);
        if(publishMatch && options.method === "POST"){
          const response=await fetch(apiBase+`/api/dev/admin/agents/${encodeURIComponent(publishMatch[1])}/publish`,{
            method:"POST",headers:{"Content-Type":"application/json","X-Local-Admin-Demo":"publish-agent"},body:"{}"
          });
          const body=await response.json().catch(()=>({}));
          if(!response.ok)throw new Error(body.error||`Publishing failed (HTTP ${response.status})`);
          return body;
        }
        throw new Error("This admin action is not available in the local preview.");
      }
      if(path==="/v1/admin/dashboard"){
        try {
          const response=await fetch(apiBase+"/api/dev/admin/overview?tenantId=slt");
          if(!response.ok)throw new Error(`HTTP ${response.status}`);
          const body=await response.json();
          if(body.source!=="localstack"||body.tenantId!=="slt"||!body.dashboard)throw new Error("Unexpected local overview response");
          return body.dashboard;
        } catch(error){
          console.warn("Local dashboard metrics unavailable:",error);
          // Show unavailable rather than silently replacing real metrics with demo numbers.
          return {agents:null,knowledgeBases:null,tools:null,onlineAgents:null,
            waitingHandoffs:null,activeHumanChats:null,publishedAgents:null,dataUnavailable:true};
        }
      }
      if(path==="/v1/admin/agents"){
        try {
          const response=await fetch(apiBase+"/api/dev/admin/agents?tenantId=slt");
          if(!response.ok)throw new Error(`HTTP ${response.status}`);
          const body=await response.json();
          if(body.source!=="localstack"||body.tenantId!=="slt"||!Array.isArray(body.items)){
            throw new Error("Unexpected agent list response");
          }
          return {items:body.items,total:body.total};
        }catch(error){
          console.warn("Local agent records unavailable:",error);
          return {items:[],dataUnavailable:true};
        }
      }
      if(path==="/v1/admin/knowledge-bases"){
        try {
          const response=await fetch(apiBase+"/api/dev/admin/knowledge-files?tenantId=slt");
          if(!response.ok)throw new Error(`HTTP ${response.status}`);
          const body=await response.json();
          if(body.source!=="localstack-s3"||body.tenantId!=="slt"||!Array.isArray(body.items)){
            throw new Error("Unexpected local S3 document inventory response");
          }
          return {items:body.items,bucket:body.bucket,bucketStatus:body.bucketStatus,
            truncated:!!body.truncated,total:body.totalShown};
        }catch(error){
          console.warn("Local S3 document inventory unavailable:",error);
          return {items:[],dataUnavailable:true};
        }
      }
      if(path==="/v1/admin/chats"){
        try {
          const response=await fetch(apiBase+"/api/dev/admin/chats?tenantId=slt");
          if(!response.ok)throw new Error(`HTTP ${response.status}`);
          const body=await response.json();
          if(body.source!=="localstack"||body.tenantId!=="slt"||!Array.isArray(body.items)){
            throw new Error("Unexpected local chat monitor response");
          }
          return {items:body.items,total:body.total};
        }catch(error){
          console.warn("Local Chat Monitor unavailable:",error);
          return {items:[],dataUnavailable:true};
        }
      }
      return demoRequest(path,options);
    }
    if(!apiBase)return demoRequest(path,options);
    const token=(auth||{}).id_token||(auth||{}).access_token; const res=await fetch(apiBase+path,{...options,headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`,...options.headers}});
    const body=await res.json().catch(()=>({})); if(!res.ok)throw new Error(body.message||"Request failed"); return body;
  }
  function demoRequest(path,options){
    const method=options.method||"GET", body=options.body?JSON.parse(options.body):{};
    if(path==="/v1/admin/dashboard")return Promise.resolve(demo.dashboard);
    const lists={"/v1/admin/agents":"agents","/v1/admin/knowledge-bases":"knowledge","/v1/admin/tools":"tools","/v1/admin/live-agents":"liveAgents","/v1/admin/chats":"chats"};
    if(lists[path]&&method==="GET")return Promise.resolve({items:demo[lists[path]]});
    if(path==="/v1/admin/team"&&method==="GET")return Promise.resolve({workspace:demo.workspace,items:demo.team,seatRequests:demo.seatRequests});
    if(path==="/v1/admin/team"&&method==="POST"){body.userId=`user-${Date.now()}`;body.status="INVITED";demo.team.push(body);if(body.role==="COMPANY_ADMIN")demo.workspace.usedAdminSeats++;else demo.workspace.usedLiveAgentSeats++;return Promise.resolve(body)}
    if(path==="/v1/admin/seat-requests"&&method==="POST"){body.requestId=`req-${Date.now()}`;body.status="PENDING";body.createdAt=Date.now()/1000;demo.seatRequests.push(body);return Promise.resolve(body)}
    if(path==="/v1/admin/agents"&&method==="POST"){body.agentId=`agent-${Date.now()}`;body.status="DRAFT";demo.agents.push(body);return Promise.resolve(body)}
    if(/^\/v1\/admin\/agents\/[^/]+$/.test(path)&&method==="PUT"){const i=demo.agents.findIndex(x=>path.endsWith(x.agentId));demo.agents[i]={...demo.agents[i],...body};return Promise.resolve(demo.agents[i])}
    if(path.endsWith("/publish")){const a=demo.agents.find(x=>path.includes(aId(x)));a.status="PUBLISHED";return Promise.resolve(a)}
    if(path==="/v1/admin/knowledge-bases"&&method==="POST"){body.kbId=`kb-${Date.now()}`;body.status="READY";demo.knowledge.push(body);return Promise.resolve(body)}
    if(path==="/v1/admin/tools"&&method==="POST"){body.toolId=`tool-${Date.now()}`;demo.tools.push(body);return Promise.resolve(body)}
    if(/^\/v1\/admin\/tools\/[^/]+$/.test(path)&&method==="PUT"){const i=demo.tools.findIndex(x=>path.endsWith(x.toolId));demo.tools[i]={...demo.tools[i],...body};return Promise.resolve(demo.tools[i])}
    if(path==="/v1/admin/live-agents"&&method==="POST"){body.userId=`user-${Date.now()}`;body.presence="OFFLINE";body.status="ACTIVE";demo.liveAgents.push(body);return Promise.resolve(body)}
    if(method==="DELETE"){for(const key of ["agents","knowledge","tools"]){const id=path.split("/").pop(),i=demo[key].findIndex(x=>Object.values(x).includes(id));if(i>=0)demo[key].splice(i,1)}return Promise.resolve({deleted:true})}
    if(path.endsWith("/sync"))return Promise.resolve({status:"SYNCING"});
    if(path.endsWith("/upload-url"))return Promise.resolve({uploadUrl:"demo",objectKey:"demo/document.pdf"});
    return Promise.resolve({});
  }
  function aId(a){return `/agents/${a.agentId}/`}
  async function loadAll(){
    const [dashboard,agents,knowledge,tools,liveAgents,chats,team]=await Promise.all([request("/v1/admin/dashboard"),request("/v1/admin/agents"),request("/v1/admin/knowledge-bases"),request("/v1/admin/tools"),request("/v1/admin/live-agents"),request("/v1/admin/chats"),request("/v1/admin/team")]);
    Object.assign(state,{dashboard,agents:agents.items||[],agentRecordsUnavailable:!!agents.dataUnavailable,knowledge:knowledge.items||[],knowledgeUnavailable:!!knowledge.dataUnavailable,kbBucketStatus:knowledge.bucketStatus,kbBucket:knowledge.bucket,kbTruncated:!!knowledge.truncated,tools:tools.items||[],liveAgents:liveAgents.items||[],chats:chats.items||[],chatMonitorUnavailable:!!chats.dataUnavailable,chatTotal:chats.total,team:team.items||[],workspace:team.workspace||{},seatRequests:team.seatRequests||[]});renderAll();
  }
  function renderAll(){renderDashboard();renderAgents();renderKnowledge();renderTools();renderLiveAgents();renderChats();renderTeam();if(localAdminPreview)disablePreviewWrites()}
  function disablePreviewWrites(){
    document.querySelectorAll('#adminApp button[data-open]:not([data-open="agent"]),#adminApp button[data-edit-agent],#adminApp button[data-delete-agent],#adminApp button[data-delete-kb],#adminApp button[data-upload],#adminApp button[data-sync],#adminApp button[data-edit-tool],#adminApp button[data-delete-tool]').forEach(button=>{
      button.disabled=true;
      button.title="Unavailable in read-only local preview";
    });
  }
  async function startLocalPreview(){
    auth={claims:{name:"Local Admin Preview"}};
    $("#loginGate").classList.add("hidden");
    $("#adminApp").classList.remove("hidden");
    $("#profileName").textContent="Local Admin Preview";
    $("#profileAvatar").textContent="LP";
    $("#logoutButton").disabled=true;
    $("#logoutButton").title="No user is signed in during the local preview";
    const banner=document.createElement("div");
    banner.setAttribute("role","status");
    banner.style.cssText="margin:18px 22px 0;padding:14px 18px;background:#fff4d8;color:#65420b;border:1px solid #f3dca6;border-radius:12px;line-height:1.5";
    banner.textContent="LOCAL DEVELOPMENT PREVIEW — AI agent DRAFT records can be created only when the backend explicitly enables local writes. No Cognito login or agent deployment. Publishing creates a LOCAL DEMO chat link only, not an internet-accessible or Bedrock-deployed chatbot. Other admin writes are disabled. Dashboard, AI Agents and Chat Monitor read SLT records from LocalStack; Knowledge Bases lists S3 source files. Tools and team show sample data.";
    document.querySelector("#adminApp .content").before(banner);
    $("#view-knowledge .page-heading h1").textContent="Knowledge source files (S3)";
    $("#view-knowledge .page-heading p").textContent="SLT source files stored in LocalStack S3. Bedrock knowledge-base registration and indexing are not tracked.";
    const operational=document.querySelector("#view-dashboard .status-line");
    if(operational)operational.textContent="LocalStack (SLT test tenant; no authentication)";
    await loadAll();
    if(state.dashboard.dataUnavailable){
      banner.textContent+=" Dashboard metrics are unavailable. Check that the backend and LocalStack tables are running; no sample counters are substituted.";
    }
  }
  function renderDashboard(){
    const d=state.dashboard;
    const display=v=>Number.isFinite(v)?v:"—";
    const metrics=[["◉",d.agents,"AI agents"],["◇",d.knowledgeBases,"Knowledge bases"],["⌘",d.tools,"Connected tools"],["♙",d.onlineAgents,"Agents online"],["◌",d.waitingHandoffs,"Waiting handoffs"],["↔",d.activeHumanChats,"Active human chats"]];
    $("#metrics").innerHTML=metrics.map(x=>`<article class="metric-card"><span class="metric-icon">${x[0]}</span><strong>${display(x[1])}</strong><span>${x[2]}</span></article>`).join("");
    const published=Number.isFinite(d.publishedAgents)?`${d.publishedAgents} live`:"Not tracked";
    const waiting=Number.isFinite(d.waitingHandoffs)?`${d.waitingHandoffs} waiting`:"Unavailable";
    $("#readiness").innerHTML=`<table class="data-table"><tr><td>Published customer agents</td><td><span class="status-pill published">${published}</span></td></tr><tr><td>Human assistance queue</td><td><span class="status-pill ${d.waitingHandoffs?'waiting':'ready'}">${waiting}</span></td></tr><tr><td>Tenant data boundary</td><td><span class="status-pill ready">${localAdminPreview?"Local tenant filtering only (no auth)":"Enforced"}</span></td></tr></table>`;
  }
  function table(headers,rows,empty){return rows.length?`<table class="data-table"><thead><tr>${headers.map(h=>`<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`:`<div class="empty-state"><strong>${empty}</strong>Create the first item to get started.</div>`}
  function renderAgents(){
    if(localAdminPreview){
      if(state.agentRecordsUnavailable){
        $("#agentsTable").innerHTML='<div class="empty-state"><strong>Agent records unavailable</strong>Check the SLT agent table in LocalStack, then refresh.</div>';
        return;
      }
      if(!state.agents.length){
        $("#agentsTable").innerHTML='<div class="empty-state"><strong>No SLT agent records</strong>No agents were found in the local DynamoDB table.</div>';
        return;
      }
      $("#agentsTable").innerHTML=table(["Agent","Local chat link","Model","Record status","Actions"],state.agents.map(a=>{
        const status=String(a.status||"").toUpperCase();
        const published=status==="PUBLISHED" && !!a.publicAgentKey;
        const key=encodeURIComponent(a.publicAgentKey||"");
        const publicUrl=published?`<small>/chat.html?company=slt&amp;agent=${esc(key)}</small>`:
          status==="DRAFT"?"Reserved only (not published)":"Not configured";
        const actions=published
          ? `<button class="small-btn" data-copy-chat="${esc(a.publicAgentKey)}">Copy local link</button><button class="small-btn" data-open-chat="${esc(a.publicAgentKey)}">Open chat</button>`
          : status==="DRAFT" && a.publicAgentKey
            ? `<button class="small-btn" data-publish="${esc(a.agentId)}">Publish local demo</button>`
            : '<span class="type-pill">No publishing action</span>';
        return `<tr><td><strong>${esc(a.displayName)}</strong><br><small>${esc(a.agentId)}</small></td><td>${publicUrl}</td><td>${esc(a.modelId||"Not configured")}</td><td><span class="status-pill ${published||status==="ACTIVE"?"ready":"offline"}">${esc(status)}</span></td><td><div class="row-actions">${actions}</div></td></tr>`;
      }),"No SLT agent records");
      return;
    }
    $("#agentsTable").innerHTML=table(["Agent","Public URL","Model","Status","Actions"],state.agents.map(a=>`<tr><td><strong>${esc(a.displayName)}</strong><br><small>${esc(a.agentId)}</small></td><td>/chat.html?agent=${esc(a.publicAgentKey)}</td><td>${esc(a.modelId||"Default")}</td><td><span class="status-pill ${String(a.status).toLowerCase()}">${esc(a.status)}</span></td><td><div class="row-actions"><button class="small-btn" data-edit-agent="${esc(a.agentId)}">Edit</button>${a.status!=="PUBLISHED"?`<button class="small-btn" data-publish="${esc(a.agentId)}">Publish</button>`:""}<button class="small-btn" data-delete-agent="${esc(a.agentId)}">Delete</button></div></td></tr>`),"No AI agents yet")}
  function renderKnowledge(){
    if(localAdminPreview){
      if(state.knowledgeUnavailable){
        $("#knowledgeGrid").innerHTML='<div class="empty-state"><strong>Local S3 files unavailable</strong>Check LocalStack S3, then refresh. No sample knowledge bases are shown.</div>';
        return;
      }
      if(state.kbBucketStatus==="missing"){
        $("#knowledgeGrid").innerHTML='<div class="empty-state"><strong>Local S3 bucket not created</strong>Run: npx tsx scripts/create-kb-bucket.ts. This does not configure a Bedrock Knowledge Base.</div>';
        return;
      }
      const cards=state.knowledge.map(k=>{
        const size=Number.isFinite(k.bytes)?`${k.bytes} bytes`:"Size unknown";
        const modified=k.lastModified?new Date(k.lastModified).toLocaleString():"Unknown date";
        return `<article class="resource-card"><div class="resource-card-top"><h3>${esc(k.name)}</h3><span class="type-pill">S3 source file</span></div><p>Stored under the SLT tenant prefix. Bedrock indexing is not tracked.</p><div class="resource-meta"><span class="type-pill">${esc(size)}</span><span class="type-pill">${esc(modified)}</span></div><p><small>${esc(k.key)}</small></p></article>`;
      });
      if(state.kbTruncated)cards.unshift('<div class="empty-state"><strong>Partial listing</strong>Only the first 100 objects are displayed.</div>');
      $("#knowledgeGrid").innerHTML=cards.join("")||'<div class="empty-state"><strong>No SLT S3 source files</strong>No files were found under tenants/slt/. A stored file alone would not confirm Bedrock ingestion.</div>';
      return;
    }
    $("#knowledgeGrid").innerHTML=state.knowledge.length?state.knowledge.map(k=>`<article class="resource-card"><div class="resource-card-top"><h3>${esc(k.name)}</h3><span class="status-pill ready">${esc(k.status||"READY")}</span></div><p>${esc(k.description||"No description")}</p><div class="resource-meta"><span class="type-pill">Bedrock KB</span><span class="type-pill">${esc(k.kbId)}</span></div><div class="resource-actions"><button class="small-btn" data-upload="${esc(k.kbId)}">Upload files</button><button class="small-btn" data-sync="${esc(k.kbId)}">Sync</button><button class="small-btn" data-delete-kb="${esc(k.kbId)}">Delete</button></div></article>`).join(""):`<div class="empty-state"><strong>No knowledge bases</strong>Add a Bedrock knowledge base for tenant-specific answers.</div>`;
  }
  function renderTools(){$("#toolsGrid").innerHTML=state.tools.length?state.tools.map(t=>`<article class="resource-card"><div class="resource-card-top"><h3>${esc(t.displayName||t.name)}</h3><span class="type-pill">${esc(String(t.type).toUpperCase())}</span></div><p>${esc(t.description||"No description")}</p><div class="resource-meta"><span class="status-pill ${t.enabled?'ready':'offline'}">${t.enabled?'Enabled':'Disabled'}</span><span class="type-pill">${esc(t.name)}</span></div><div class="resource-actions"><button class="small-btn" data-edit-tool="${esc(t.toolId)}">Edit</button><button class="small-btn" data-delete-tool="${esc(t.toolId)}">Delete</button></div></article>`).join(""):`<div class="empty-state"><strong>No tools or forms</strong>Create an API, MCP, or customer form tool.</div>`}
  function renderLiveAgents(){$("#liveAgentsTable").innerHTML=table(["Agent","Email","Presence","Account"],state.liveAgents.map(a=>`<tr><td><strong>${esc(a.name)}</strong></td><td>${esc(a.email)}</td><td><span class="status-pill ${String(a.presence).toLowerCase()}">${esc(a.presence)}</span></td><td>${esc(a.status)}</td></tr>`),"No live agents yet")}
  function renderChats(){
    if(localAdminPreview){
      if(state.chatMonitorUnavailable){
        $("#chatsTable").innerHTML='<div class="empty-state"><strong>Chat Monitor unavailable</strong>Check the backend and omni-channel-chat-sessions table in LocalStack. No demo records are substituted.</div>';
        return;
      }
      const rows=state.chats.map(c=>{
        const parsed=c.updatedAt?new Date(c.updatedAt):null;
        const updated=parsed&&!Number.isNaN(parsed.getTime())?parsed.toLocaleString():"—";
        const style=["HANDOFF_REQUESTED","WAITING_FOR_HUMAN"].includes(c.status)?"waiting":
          ["RESOLVED","CLOSED","MISSED_HANDOFF"].includes(c.status)?"offline":"online";
        return `<tr><td>${esc(c.sessionId)}</td><td>${esc(c.customerName||"Guest Customer")}</td><td>${esc(c.assignedAgentId||"—")}</td><td><span class="status-pill ${style}">${esc(c.status)}</span></td><td>${esc(updated)}</td></tr>`;
      });
      $("#chatsTable").innerHTML=rows.length?
        table(["Session","Customer","Human agent","Status","Updated"],rows,"")+
          (state.chatTotal>100?'<p>Showing the 100 most recently updated SLT sessions.</p>':""):
        '<div class="empty-state"><strong>No SLT handoff conversations yet</strong>Create a local handoff from the customer chatbot to populate this table.</div>';
      return;
    }
    $("#chatsTable").innerHTML=table(["Session","Customer agent","Status","Updated"],state.chats.map(c=>`<tr><td>${esc(c.sessionId)}</td><td>${esc(c.publicAgentKey||c.agentId)}</td><td><span class="status-pill ${c.status==="HANDOFF_REQUESTED"?'waiting':c.status==="CLOSED"?'offline':'online'}">${esc(c.status)}</span></td><td>${new Date(Number(c.updatedAt)*1000).toLocaleString()}</td></tr>`),"No human-assistance chats");
  }
  function renderTeam(){const w=state.workspace||{},seats=[{title:"Company admin seats",used:w.usedAdminSeats||0,limit:w.adminSeatLimit||0,role:"Full workspace control"},{title:"Live-agent seats",used:w.usedLiveAgentSeats||0,limit:w.liveAgentSeatLimit||0,role:"Human support console"}];$("#seatGrid").innerHTML=`<article class="workspace-summary"><span>${esc(w.plan||"STARTER")} WORKSPACE</span><strong>${esc(w.companyName||"Company")}</strong><small>${esc(w.tenantSlug||w.tenantId||"")}</small></article>`+seats.map(s=>`<article class="seat-card"><div><span>${esc(s.title)}</span><b>${s.used} <i>/ ${s.limit}</i></b></div><div class="seat-bar"><i style="width:${Math.min(100,s.limit?s.used/s.limit*100:0)}%"></i></div><small>${esc(s.role)}</small></article>`).join("");$("#teamTable").innerHTML=table(["Member","Email","Role","Account"],state.team.map(m=>`<tr><td><strong>${esc(m.name)}</strong></td><td>${esc(m.email)}</td><td><span class="type-pill">${esc(String(m.role||"").replace("_"," "))}</span></td><td><span class="status-pill ready">${esc(m.status||"ACTIVE")}</span></td></tr>`),"No workspace members");$("#seatRequestsTable").innerHTML=table(["Request","Admin seats","Live seats","Status"],state.seatRequests.map(r=>`<tr><td>${esc(r.requestId)}</td><td>+${Number(r.adminSeats||0)}</td><td>+${Number(r.liveAgentSeats||0)}</td><td><span class="status-pill waiting">${esc(r.status)}</span></td></tr>`),"No seat requests")}
  function field(label,name,value="",type="text",span=""){return `<div class="field ${span}"><label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}"></div>`}
  function openModal(type,id){modalMode=type;editingId=id||null;let title="",html="";
    if(type==="agent"){const a=state.agents.find(x=>x.agentId===id)||{};title=id?"Edit AI agent":"Create AI agent";html=`<div class="form-grid">${field("Display name","displayName",a.displayName||"", "text")}${field("Public URL key","publicAgentKey",a.publicAgentKey||"","text")}${field("Brand name","brandName",a.brandName||"")}${field("Bedrock model ID","modelId",a.modelId||"amazon.nova-lite-v1:0")}<div class="field"><label>Knowledge base</label><select name="knowledgeBaseRef"><option value="">None</option>${state.knowledge.map(k=>`<option value="${esc(k.kbId)}" ${a.knowledgeBaseRef===k.kbId?'selected':''}>${esc(k.name)}</option>`).join("")}</select></div>${field("Suggested prompts (comma separated)","suggestedPrompts",(a.suggestedPrompts||[]).join(", "))}<div class="field full-span"><label>Enabled tools</label><div class="check-grid">${state.tools.map(t=>`<label class="check-card"><input type="checkbox" name="toolIds" value="${esc(t.toolId)}" ${(a.toolIds||[]).includes(t.toolId)?'checked':''}>${esc(t.displayName||t.name)} · ${esc(t.type)}</label>`).join("")||"No tools created"}</div></div><div class="field full-span"><label>Specialist sub-agents</label><div class="check-grid">${["general","sales","billing","technical","lead"].map(s=>`<label class="check-card"><input type="checkbox" name="subagents" value="${s}" ${(a.enabledSubAgents||["general","sales","billing","technical","lead"]).includes(s)?'checked':''}>${s}</label>`).join("")}</div></div><div class="field full-span"><label>Welcome message</label><textarea name="welcomeMessage">${esc(a.welcomeMessage||"")}</textarea></div><div class="field full-span"><label>System instruction</label><textarea name="systemPrompt">${esc(a.systemPrompt||"")}</textarea></div></div>`}
    if(type==="knowledge"){title="Add knowledge base";html=`<div class="form-grid">${field("Name","name")}${field("Internal ID","kbId","kb-products")}${field("Bedrock Knowledge Base ID","bedrockKnowledgeBaseId")}${field("Data Source ID","dataSourceId")}<div class="field full-span"><label>Description</label><textarea name="description"></textarea></div></div>`}
    if(type==="tool"){const t=state.tools.find(x=>x.toolId===id)||{};title=id?"Edit tool":"Create tool";html=`<div class="form-grid">${field("Display name","displayName",t.displayName||"")}${field("Tool name (letters/numbers/_)","name",t.name||"")}${field("Internal ID","toolId",t.toolId||"tool-") }<div class="field"><label>Type</label><select name="type"><option value="api" ${t.type==='api'?'selected':''}>HTTPS API</option><option value="mcp" ${t.type==='mcp'?'selected':''}>MCP / AgentCore Gateway</option><option value="form" ${t.type==='form'?'selected':''}>Customer form</option></select></div><div class="field full-span"><label>Description</label><textarea name="description">${esc(t.description||"")}</textarea></div>${field("API endpoint","endpoint",t.endpoint||"")}${field("Secret ID","secretId",t.secretId||"")}${field("MCP Gateway URL","gatewayUrl",t.gatewayUrl||"")}${field("MCP target tool name","targetToolName",t.targetToolName||"")}${field("Form title","formTitle",t.formSchema?.title||"")}${field("Form fields (label:name, comma separated)","formFields",(t.formSchema?.fields||[]).map(f=>`${f.label}:${f.name}`).join(", "))}<div class="field full-span"><label>Tool input JSON Schema</label><textarea name="inputSchema">${esc(JSON.stringify(t.inputSchema||{type:"object",properties:{}},null,2))}</textarea></div></div>`}
    if(type==="liveAgent"){title="Invite live agent";html=`<div class="form-grid">${field("Full name","name")}${field("Email address","email","","email")}</div>`}
    if(type==="member"){title="Invite workspace member";html=`<div class="form-grid">${field("Full name","name")}${field("Work email","email","","email")}<div class="field full-span"><label>Role</label><select name="role"><option value="LIVE_AGENT">Live agent</option><option value="COMPANY_ADMIN">Company admin</option></select></div></div>`}
    if(type==="seatRequest"){title="Request additional seats";html=`<div class="form-grid">${field("Additional admin seats","adminSeats","0","number")}${field("Additional live-agent seats","liveAgentSeats","1","number")}<div class="field full-span"><label>Business reason</label><textarea name="reason" placeholder="Expected team growth, support volume, or rollout date"></textarea></div></div>`}
    if(localAdminPreview && type==="agent" && !id){
      html='<p role="status">Local demo: this form saves a DRAFT record to LocalStack only. It does not deploy a Bedrock agent, publish a chat URL, or activate tools.</p>'+html;
    }
    $("#modalTitle").textContent=title;$("#modalBody").innerHTML=html;$("#modalBackdrop").classList.remove("hidden");
  }
  function closeModal(){$("#modalBackdrop").classList.add("hidden");modalMode=null;editingId=null}
  async function submitModal(event){event.preventDefault();const form=new FormData(event.target),obj=Object.fromEntries(form.entries());try{
    if(modalMode==="agent"){obj.toolIds=form.getAll("toolIds");obj.enabledSubAgents=form.getAll("subagents");obj.suggestedPrompts=(obj.suggestedPrompts||"").split(",").map(x=>x.trim()).filter(Boolean);await request(editingId?`/v1/admin/agents/${editingId}`:"/v1/admin/agents",{method:editingId?"PUT":"POST",body:JSON.stringify(obj)})}
    if(modalMode==="knowledge")await request("/v1/admin/knowledge-bases",{method:"POST",body:JSON.stringify(obj)});
    if(modalMode==="tool"){obj.enabled=true;try{obj.inputSchema=JSON.parse(obj.inputSchema||'{"type":"object","properties":{}}')}catch(_){throw new Error("Tool input schema must be valid JSON")};if(obj.type==="form"){obj.formSchema={formId:obj.name,title:obj.formTitle||obj.displayName,description:obj.description,fields:(obj.formFields||"").split(",").map(x=>{const [label,name]=x.trim().split(":");return{name:name||label.toLowerCase().replace(/\W+/g,"_"),label,type:"text",required:true}}).filter(x=>x.label)}}await request(editingId?`/v1/admin/tools/${editingId}`:"/v1/admin/tools",{method:editingId?"PUT":"POST",body:JSON.stringify(obj)})}
    if(modalMode==="liveAgent")await request("/v1/admin/live-agents",{method:"POST",body:JSON.stringify(obj)});
    if(modalMode==="member")await request("/v1/admin/team",{method:"POST",body:JSON.stringify(obj)});
    if(modalMode==="seatRequest")await request("/v1/admin/seat-requests",{method:"POST",body:JSON.stringify(obj)});
    closeModal();await loadAll();toast("Saved successfully");
  }catch(e){toast(e.message,true)}}
  async function action(target){try{
    if(target.dataset.editAgent)return openModal("agent",target.dataset.editAgent);if(target.dataset.editTool)return openModal("tool",target.dataset.editTool);
    if(target.dataset.copyChat || target.dataset.openChat){
      if(!localAdminPreview)throw new Error("Only local-demo links are available here.");
      const key=target.dataset.copyChat || target.dataset.openChat;
      const row=state.agents.find(a=>a.publicAgentKey===key && String(a.status).toUpperCase()==="PUBLISHED");
      if(!row)throw new Error("This agent is not published.");
      const url=new URL(`/chat.html?company=slt&agent=${encodeURIComponent(key)}`,window.location.origin).href;
      if(target.dataset.openChat){window.open(url,"_blank","noopener,noreferrer");return;}
      await navigator.clipboard.writeText(url);return toast("Local demo link copied (works on this laptop only)");
    }
    if(target.dataset.publish){
      if(localAdminPreview && !confirm("Publish this agent configuration for LOCAL demo chat only? This does not deploy a Bedrock agent or provide a public internet URL."))return;
      await request(`/v1/admin/agents/${target.dataset.publish}/publish`,{method:"POST",body:"{}"});
      await loadAll();return toast(localAdminPreview?"Local demo chatbot enabled — use Copy local link":"Agent published");
    }
    const deletions=[["deleteAgent","agents"],["deleteKb","knowledge-bases"],["deleteTool","tools"]];for(const [key,path] of deletions)if(target.dataset[key]){if(confirm("Delete this item?")){await request(`/v1/admin/${path}/${target.dataset[key]}`,{method:"DELETE"});await loadAll();toast("Deleted")};return}
    if(target.dataset.sync){await request(`/v1/admin/knowledge-bases/${target.dataset.sync}/sync`,{method:"POST",body:"{}"});return toast("Knowledge sync started")}
    if(target.dataset.upload){const input=document.createElement("input");input.type="file";input.accept=".pdf,.docx,.txt,.md,.csv,.html";input.onchange=async()=>{const file=input.files[0];if(!file)return;const result=await request(`/v1/admin/knowledge-bases/${target.dataset.upload}/upload-url`,{method:"POST",body:JSON.stringify({filename:file.name,contentType:file.type||"application/octet-stream"})});if(result.uploadUrl!=="demo"){const put=await fetch(result.uploadUrl,{method:"PUT",headers:{"Content-Type":file.type||"application/octet-stream"},body:file});if(!put.ok)throw new Error("Upload failed")}toast("File uploaded. Select Sync when ready.")};input.click()}
  }catch(e){toast(e.message,true)}}
  function toast(message,error){const el=$("#toast");el.textContent=message;el.style.background=error?"#a52e40":"#183754";el.classList.remove("hidden");setTimeout(()=>el.classList.add("hidden"),3200)}
  async function init(){try{if(localAdminPreview){await startLocalPreview();return;}auth=await ConsoleAuth.requireAuth("COMPANY_ADMIN");if(!auth)return;$("#loginGate").classList.add("hidden");$("#adminApp").classList.remove("hidden");const name=auth.claims.name||auth.claims.email||"Admin";$("#profileName").textContent=name;$("#profileAvatar").textContent=name.split(/\s+/).map(x=>x[0]).join("").slice(0,2).toUpperCase();await loadAll()}catch(e){$("#loginGate p").textContent=e.message;toast(e.message,true)}}
  document.addEventListener("click",e=>{const t=e.target.closest("button,a");if(!t)return;if(t.dataset.view){document.querySelectorAll(".nav-btn").forEach(x=>x.classList.toggle("active",x===t));document.querySelectorAll(".view").forEach(x=>x.classList.toggle("active",x.id===`view-${t.dataset.view}`));$("#currentSection").textContent=t.textContent.trim()}if(t.dataset.open)openModal(t.dataset.open);if(t.hasAttribute("data-close"))closeModal();if(t.hasAttribute("data-refresh"))loadAll();action(t)});
  $("#modalForm").addEventListener("submit",submitModal);$("#loginButton").addEventListener("click",()=>ConsoleAuth.login());$("#logoutButton").addEventListener("click",()=>ConsoleAuth.logout());init();
})();

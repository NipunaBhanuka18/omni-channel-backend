(function () {
  "use strict";

  const config = window.CHAT_CONFIG || {};
  const params = new URLSearchParams(window.location.search);
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const agentKey = params.get("agent") || (pathParts[0] === "chat" ? pathParts[1] : "") || config.defaultAgentKey || "demo-support";
  const apiBase = (config.apiBaseUrl || "").replace(/\/$/, "");
  const localBackendMode = config.backendMode === "local-typescript";
  // While integrating, only agent configuration comes from the TypeScript server.
  // Chat messages stay in demo mode until the public message API is implemented.
  const demoMode = !apiBase || localBackendMode;

  const state = { sessionId: null, conversationId: null, tenantId: null, agent: null, sending: false, humanMode: false, pollTimer: null, handoffRequested: false, handoffClosed: false, localAgentId: null, pollErrorShown: false, seenMessageIds: new Set() };
  const el = {
    messages: document.getElementById("messages"), suggestions: document.getElementById("suggestions"),
    composer: document.getElementById("composer"), input: document.getElementById("messageInput"),
    send: document.getElementById("sendButton"), loading: document.getElementById("loadingState"),
    restart: document.getElementById("restartButton"), agentName: document.getElementById("agentName"),
    brandName: document.getElementById("brandName"), brandMark: document.getElementById("brandMark"),
    agentStatus: document.getElementById("agentStatus")
  };

  const demoAgent = {
    agentKey: "demo-support", displayName: "Connect AI Assistant", brandName: "Connect AI",
    welcomeMessage: "Hi! I’m your AI assistant. How can I help you today?",
    suggestedPrompts: ["Explore packages", "Check my bill", "Get technical help", "Talk to a person"],
    theme: { primary: "#075fc6", accent: "#06a96b" }
  };

  function timeNow() { return new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" }).format(new Date()); }
  function makeId() { return window.crypto && crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); }); }
  function scrollBottom() { requestAnimationFrame(() => { el.messages.scrollTop = el.messages.scrollHeight; }); }
  function escapeText(value) { return String(value == null ? "" : value); }

  async function api(path, options) {
    const response = await fetch(apiBase + path, { ...(options || {}), headers: { "Content-Type": "application/json", ...((options && options.headers) || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "The assistant is temporarily unavailable.");
    return data;
  }

  function applyAgent(agent) {
    state.agent = agent;
    el.agentName.textContent = agent.displayName;
    el.brandName.textContent = agent.brandName;
    el.brandMark.textContent = agent.brandName.split(/\s+/).map(x => x[0]).join("").slice(0, 2).toUpperCase();
    document.title = agent.displayName;
    if (agent.theme && agent.theme.primary) document.documentElement.style.setProperty("--brand", agent.theme.primary);
    if (agent.theme && agent.theme.accent) document.documentElement.style.setProperty("--accent", agent.theme.accent);
    renderSuggestions(agent.suggestedPrompts || []);
  }

  function renderSuggestions(items) {
    el.suggestions.replaceChildren();
    items.slice(0, 5).forEach(text => {
      const button = document.createElement("button");
      button.type = "button"; button.className = "suggestion"; button.textContent = text;
      button.addEventListener("click", () => sendMessage(text));
      el.suggestions.appendChild(button);
    });
  }

  function addUserMessage(text) {
    const node = document.getElementById("userMessageTemplate").content.cloneNode(true);
    node.querySelector(".user-bubble").textContent = escapeText(text);
    node.querySelector(".message-time").textContent = timeNow();
    el.messages.insertBefore(node, el.loading); scrollBottom();
  }

  function addBotMessage(payload) {
    const node = document.getElementById("botMessageTemplate").content.cloneNode(true);
    const article = node.querySelector("article");
    const bubble = node.querySelector(".bot-bubble");
    bubble.textContent = escapeText(payload.message);
    node.querySelector(".message-time").textContent = timeNow();
    article.dataset.messageId = payload.messageId || "";
    if (payload.messageId) state.seenMessageIds.add(payload.messageId);

    if (payload.citations && payload.citations.length) {
      const citations = document.createElement("div"); citations.className = "citation-list";
      citations.textContent = "Sources: " + payload.citations.map((c, i) => c.title || `Reference ${i + 1}`).join(" · ");
      bubble.appendChild(citations);
    }
    if (payload.uiAction && payload.uiAction.type === "form") bubble.appendChild(buildForm(payload.uiAction));

    node.querySelectorAll("[data-rating]").forEach(button => button.addEventListener("click", () => submitFeedback(article, button.dataset.rating)));
    el.messages.insertBefore(node, el.loading);
    if (payload.status === "handoff_requested") {
      addNotice("handoff-note", "Your request has been placed in the live-agent queue. You can continue typing while you wait.");
      startHumanPolling();
    }
    scrollBottom();
  }

  function addNotice(className, text) {
    const note = document.createElement("div"); note.className = className; note.textContent = text;
    el.messages.insertBefore(note, el.loading); scrollBottom();
  }

  function buildForm(action) {
    const form = document.createElement("form"); form.className = "chat-form";
    const title = document.createElement("h3"); title.textContent = action.title || "Your details"; form.appendChild(title);
    if (action.description) { const p = document.createElement("p"); p.textContent = action.description; form.appendChild(p); }
    (action.fields || []).forEach(field => {
      const wrapper = document.createElement("div"); wrapper.className = "form-field";
      const label = document.createElement("label"); label.textContent = field.label; label.htmlFor = `form-${field.name}`;
      const input = document.createElement("input"); input.id = label.htmlFor; input.name = field.name; input.type = field.type || "text"; input.required = field.required !== false; input.maxLength = field.maxLength || 200;
      wrapper.append(label, input); form.appendChild(wrapper);
    });
    const submit = document.createElement("button"); submit.className = "form-submit"; submit.type = "submit"; submit.textContent = action.submitLabel || "Submit"; form.appendChild(submit);
    form.addEventListener("submit", async event => {
      event.preventDefault(); submit.disabled = true;
      const values = Object.fromEntries(new FormData(form).entries());
      try { await sendMessage("Details submitted", { formId: action.formId, values }, false); form.replaceWith(document.createTextNode("✓ Details submitted securely")); }
      catch (_) { submit.disabled = false; }
    });
    return form;
  }

  function setSending(value) { state.sending = value; el.send.disabled = value; el.input.disabled = value; el.loading.classList.toggle("visible", value); if (value) scrollBottom(); }

  function demoReply(text, formSubmission) {
    if (formSubmission) return { messageId: makeId(), message: "Thank you. Your details have been recorded and our team can follow up with you.", route: "lead", status: "completed" };
    const lower = text.toLowerCase();
    if (/human|person|agent/.test(lower)) return { messageId: makeId(), message: "Of course. I’ve recorded your request to speak with a person.", route: "handoff", status: "handoff_requested" };
    if (/bill|payment|charge/.test(lower)) return { messageId: makeId(), message: "I can help explain billing details, payment methods, and recent charges. What would you like to check?", route: "billing", status: "completed" };
    if (/technical|internet|slow|not working|fault/.test(lower)) return { messageId: makeId(), message: "Let’s troubleshoot this together. Please tell me which service is affected and what you currently see.", route: "technical", status: "completed" };
    if (/package|plan|buy|connection/.test(lower)) return { messageId: makeId(), message: "I can recommend the right option. Share a few details and I’ll guide you.", route: "lead", status: "completed", uiAction: { type: "form", formId: "sales_interest", title: "Tell us what you need", description: "Only the essentials—we’ll use these details to assist you.", submitLabel: "Continue", fields: [{ name: "name", label: "Your name", type: "text", required: true }, { name: "contact", label: "Mobile or email", type: "text", required: true }] } };
    return { messageId: makeId(), message: "Thanks for reaching out. I can help with services, billing, technical support, or finding the right package. What would you like to do?", route: "general", status: "completed" };
  }

  // Local development adapter only. The TypeScript API uses intent-based requests,
  // and its current mock JWT verifier is NOT suitable for production authentication.
  function localIntent(text) {
    if (/\b(balance|bill|billing|charge|charges)\b/i.test(text)) return "check_balance";
    if (/\b(usage|data used|data usage|consumption)\b/i.test(text)) return "check_usage";
    if (/\b(router|wi-?fi|internet|technical|slow|fault|not working)\b/i.test(text)) return "troubleshoot_router";
    return null;
  }

  function localMockToken() {
    const claims = {
      sub: "local-chat-test-user",
      "custom:tenant_id": state.tenantId,
      "cognito:groups": ["staff"]
    };
    return `e30.${btoa(JSON.stringify(claims)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}.local-test-signature`;
  }

  function formatLocalAgentResponse(intent, data) {
    if (intent === "check_balance") {
      return `Example billing data: your account balance is ${data.currency || "LKR"} ${Number(data.balance).toFixed(2)}. Account: ${data.accountNumber || "not available"}. Due date: ${data.dueDate || "not available"}. This is mock customer data.`;
    }
    if (intent === "check_usage") {
      return `Example usage data for ${data.packageName || "your package"}: ${data.dataUsedGb} GB of ${data.dataTotalGb} GB used, and ${data.voiceUsedMins} of ${data.voiceTotalMins} voice minutes used. This is mock customer data.`;
    }
    if (intent === "troubleshoot_router") {
      return `Local technical support result (mock knowledge base):\n${String(data.result || "No troubleshooting information returned.")}`;
    }
    return "The backend processed your request, but its response is not yet supported by this chat UI.";
  }

  // Only the handoff request is integrated at this stage. The live-agent UI does
  // not yet share an inbox or message transport with the TypeScript backend.
  function wantsHumanAgent(text) {
    return /\b(human|person|representative|someone|handoff|live[\s-]*agent)\b/i.test(text)
      || /\b(?:talk|speak|connect|transfer)\s+(?:me\s+)?(?:to|with)\s+(?:(?:a|an)\s+)?agent\b/i.test(text);
  }

  async function requestLocalHandoff(text) {
    if (state.handoffRequested) {
      return {
        messageId: makeId(),
        message: "A human-support request was already recorded for this chat. Restart the chat to test a new request.",
        status: "completed"
      };
    }

    const result = await api("/api/chat/handoff/request", {
      method: "POST",
      body: JSON.stringify({
        tenantId: state.tenantId,
        sessionId: state.sessionId,
        reason: text,
        customerInfo: { name: "Local Test Customer" }
      })
    });
    // server.ts flattens the handoff result into { success, assigned, status, agentId, sessionId }.
    if (!result.success || result.sessionId !== state.sessionId ||
        !["HUMAN_ACTIVE", "MISSED_HANDOFF"].includes(result.status)) {
      throw new Error(result.error?.message || "Could not confirm the handoff request.");
    }
    state.handoffRequested = true;
    if (result.status === "HUMAN_ACTIVE" && result.assigned) {
      // The local message API currently supports this one fixed development agent.
      if (result.agentId !== "local-agent-01") {
        return {
          messageId: makeId(), status: "completed",
          message: `Your handoff was assigned to ${result.agentId || "another agent"}, but the local two-way chat preview only supports local-agent-01. Messaging has not been enabled for this session.`
        };
      }
      state.localAgentId = result.agentId;
      return {
        messageId: makeId(), status: "delivered_to_human",
        message: "You're connected to local-agent-01 in the local test environment. Your next messages will go to the human-agent console, and their replies will appear here. This is a demo, not a production support service."
      };
    }
    return {
      messageId: makeId(), status: "completed",
      message: "No human agent was available. The local backend recorded a missed handoff; follow-up notifications are not configured."
    };
  }

  // TEMPORARY LOCAL-ONLY shared messaging route. Production needs real customer
  // authentication and separate customer/agent authorization (not agentId in a URL).
  function localHumanMessagePath() {
    if (!state.sessionId || state.tenantId !== "slt" || state.localAgentId !== "local-agent-01") {
      throw new Error("This local human-chat session is not available.");
    }
    return `/api/dev/live/conversations/${encodeURIComponent(state.sessionId)}/messages?tenantId=slt&agentId=local-agent-01`;
  }

  async function sendLocalHumanMessage(text) {
    if (text.length > 1600) throw new Error("Human-chat messages are limited to 1600 characters in this local demo.");
    const result = await api(localHumanMessagePath(), {
      method: "POST", body: JSON.stringify({role: "user", message: text})
    });
    if (!result.messageId || result.role !== "user") {
      throw new Error("The human-chat message was not confirmed by the backend.");
    }
    // The customer's bubble is already displayed by sendMessage(); no fake bot reply.
    return { messageId: result.messageId, status: "human_message_saved" };
  }

  async function localBackendReply(text, formSubmission) {
    if (location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
      throw new Error("Local testing is only allowed when the frontend runs on localhost.");
    }
    const backendUrl = new URL(apiBase);
    if (!["localhost", "127.0.0.1"].includes(backendUrl.hostname)) {
      throw new Error("Local testing requires a localhost backend. Do not use mock credentials on a public server.");
    }

    if (state.handoffClosed) throw new Error("This human conversation is closed. Select Restart to start a new chat.");
    // Once connected, all customer messages go to the human conversation, not
    // the intent-based billing/usage/support demo handlers.
    if (state.humanMode && !formSubmission) return sendLocalHumanMessage(text);

    // A request for a person takes precedence over billing or support keywords.
    if (!formSubmission && wantsHumanAgent(text)) return requestLocalHandoff(text);

    const intent = formSubmission ? null : localIntent(text);
    if (!intent) {
      let message;
      if (formSubmission) message = "Demo form only: your details were not sent to a backend or saved.";
      else message = `${demoReply(text).message} (Demo response only — not sent to the backend.)`;
      return { messageId: makeId(), message, status: "completed" };
    }

    const result = await api("/api/agent", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${localMockToken()}`,
        "x-tenant-id": state.tenantId,
        "x-channel": "web",
        "x-session-id": state.sessionId,
        "x-conversation-id": state.conversationId
      },
      body: JSON.stringify({ intent, params: { query: text } })
    });
    // The existing server returns HTTP 200 even when AgentActionResponse.success is false.
    if (!result.success) throw new Error(result.error?.message || "The backend rejected this request.");
    return { messageId: makeId(), message: formatLocalAgentResponse(intent, result.data || {}), status: "completed" };
  }

  async function sendMessage(text, formSubmission, showUserMessage = true) {
    text = (text || "").trim(); if ((!text && !formSubmission) || state.sending) return;
    if (showUserMessage) addUserMessage(text); el.input.value = ""; resizeInput(); renderSuggestions([]); setSending(true);
    try {
      let response;
      if (localBackendMode) response = await localBackendReply(text, formSubmission);
      else if (demoMode) { await new Promise(resolve => setTimeout(resolve, 650)); response = demoReply(text, formSubmission); }
      else response = await api(`/v1/public/sessions/${encodeURIComponent(state.sessionId)}/messages`, { method: "POST", body: JSON.stringify({ message: text, formSubmission }) });
      if (response.message) addBotMessage(response);
      if (response.messageId) state.seenMessageIds.add(response.messageId);
      if (response.status === "delivered_to_human") startHumanPolling();
    } catch (error) { addNotice("error-note", error.message || "Unable to send your message. Please try again."); }
    finally { setSending(false); el.input.focus(); }
  }

  async function submitFeedback(article, rating) {
    const controls = article.querySelector(".feedback-controls");
    controls.classList.add("rated"); controls.querySelectorAll("button").forEach(x => x.classList.toggle("selected", x.dataset.rating === rating));
    if (!demoMode && article.dataset.messageId) {
      try { await api(`/v1/public/sessions/${encodeURIComponent(state.sessionId)}/feedback`, { method: "POST", body: JSON.stringify({ messageId: article.dataset.messageId, rating }) }); } catch (_) { /* feedback is non-blocking */ }
    }
  }

  function resizeInput() { el.input.style.height = "auto"; el.input.style.height = Math.min(el.input.scrollHeight, 120) + "px"; }

  function startHumanPolling() {
    state.humanMode = true;
    if ((demoMode && !localBackendMode) || state.pollTimer) return;
    el.agentStatus.textContent = "Human agent (local demo)";
    pollHumanMessages();
    state.pollTimer = setInterval(pollHumanMessages, 3000);
  }

  async function pollHumanMessages() {
    if (!state.sessionId || !state.humanMode || (demoMode && !localBackendMode)) return;
    try {
      const result = localBackendMode
        ? await api(localHumanMessagePath())
        : await api(`/v1/public/sessions/${encodeURIComponent(state.sessionId)}/messages`);
      state.pollErrorShown = false;
      (result.messages || []).forEach(message => {
        if (message.role === "live_agent" && !state.seenMessageIds.has(message.messageId)) {
          addBotMessage({ messageId: message.messageId, message: `Human agent: ${message.text}`, status: "human_reply" });
        }
      });
      if (result.session?.status === "RESOLVED" || result.sessionStatus === "CLOSED") {
        clearInterval(state.pollTimer); state.pollTimer = null;
        state.humanMode = false; state.handoffClosed = true;
        el.agentStatus.textContent = "Conversation closed";
        addNotice("handoff-note", "The human agent has closed this conversation. Select Restart to begin another chat.");
      }
    } catch (error) {
      if (!state.pollErrorShown) {
        state.pollErrorShown = true;
        addNotice("error-note", `Can't retrieve human-agent replies right now: ${error.message || "connection unavailable"}`);
      }
    }
  }

  async function initialize() {
    el.loading.classList.add("visible");
    try {
      let agent;
      if (localBackendMode) {
        const company = encodeURIComponent(config.companySlug || "slt");
        const agentSlug = encodeURIComponent(config.agentSlug || "support");
        const result = await api(`/api/resolve-chat-url?company=${company}&agent=${agentSlug}`);
        if (!result.success || !result.tenantId) throw new Error("Backend did not provide an agent configuration.");
        state.tenantId = result.tenantId;
        agent = {
          ...demoAgent,
          displayName: result.agentName || demoAgent.displayName,
          brandName: result.companyName || demoAgent.brandName,
          welcomeMessage: result.welcomeMessage || demoAgent.welcomeMessage,
          theme: { ...demoAgent.theme, primary: result.themeColor || demoAgent.theme.primary }
        };
      } else {
        agent = demoMode ? demoAgent : await api(`/v1/public/agents/${encodeURIComponent(agentKey)}`);
      }
      applyAgent(agent);
      state.sessionId = demoMode ? makeId() : (await api("/v1/public/sessions", { method: "POST", body: JSON.stringify({ agentKey }) })).sessionId;
      if (localBackendMode) state.conversationId = `conv-${makeId()}`;
      addBotMessage({ message: agent.welcomeMessage, messageId: "welcome", status: "completed" });
      if (localBackendMode) {
        addNotice("handoff-note", "Local development: billing, usage and support use mock backend services. Human handoff and two-way messages use LocalStack. Other replies are demo-only.");
      }
    } catch (error) {
      applyAgent(demoAgent); addNotice("error-note", error.message || "This assistant could not be loaded."); el.agentStatus.textContent = "Temporarily unavailable";
    } finally { el.loading.classList.remove("visible"); el.input.focus(); }
  }

  el.composer.addEventListener("submit", event => { event.preventDefault(); sendMessage(el.input.value); });
  el.input.addEventListener("input", resizeInput);
  el.input.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); el.composer.requestSubmit(); } });
  el.restart.addEventListener("click", () => {
    clearInterval(state.pollTimer); state.pollTimer = null; state.humanMode = false; state.seenMessageIds.clear(); state.sessionId = null; state.conversationId = null; state.tenantId = null; state.handoffRequested = false; state.handoffClosed = false; state.localAgentId = null; state.pollErrorShown = false;
    [...el.messages.querySelectorAll(".message-row,.handoff-note,.error-note")].forEach(x => x.remove()); initialize();
  });
  initialize();
})();

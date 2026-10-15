(function () {
  "use strict";

  const config = window.CHAT_CONFIG || {};
  const params = new URLSearchParams(window.location.search);
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const agentKey = params.get("agent") || (pathParts[0] === "chat" ? pathParts[1] : "") || config.defaultAgentKey || "demo-support";
  const apiBase = (config.apiBaseUrl || "").replace(/\/$/, "");
  const demoMode = !apiBase;

  const state = { sessionId: null, agent: null, sending: false, humanMode: false, pollTimer: null, seenMessageIds: new Set() };
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
    const response = await fetch(apiBase + path, { headers: { "Content-Type": "application/json", ...(options && options.headers) }, ...options });
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

  async function sendMessage(text, formSubmission, showUserMessage = true) {
    text = (text || "").trim(); if ((!text && !formSubmission) || state.sending) return;
    if (showUserMessage) addUserMessage(text); el.input.value = ""; resizeInput(); renderSuggestions([]); setSending(true);
    try {
      let response;
      if (demoMode) { await new Promise(resolve => setTimeout(resolve, 650)); response = demoReply(text, formSubmission); }
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
    if (demoMode || state.pollTimer) return;
    pollHumanMessages();
    state.pollTimer = setInterval(pollHumanMessages, 3000);
  }

  async function pollHumanMessages() {
    if (!state.sessionId || demoMode) return;
    try {
      const result = await api(`/v1/public/sessions/${encodeURIComponent(state.sessionId)}/messages`);
      (result.messages || []).forEach(message => {
        if (message.role === "live_agent" && !state.seenMessageIds.has(message.messageId)) {
          addBotMessage({messageId: message.messageId, message: message.text, status: "human_reply"});
        }
      });
      if (result.sessionStatus === "CLOSED") {
        clearInterval(state.pollTimer); state.pollTimer = null; state.humanMode = false;
        addNotice("handoff-note", "This conversation has been closed by the support agent. You can start a new conversation at any time.");
      }
    } catch (_) { /* keep the customer conversation usable during a transient poll failure */ }
  }

  async function initialize() {
    el.loading.classList.add("visible");
    try {
      const agent = demoMode ? demoAgent : await api(`/v1/public/agents/${encodeURIComponent(agentKey)}`);
      applyAgent(agent);
      state.sessionId = demoMode ? makeId() : (await api("/v1/public/sessions", { method: "POST", body: JSON.stringify({ agentKey }) })).sessionId;
      addBotMessage({ message: agent.welcomeMessage, messageId: "welcome", status: "completed" });
    } catch (error) {
      applyAgent(demoAgent); addNotice("error-note", error.message || "This assistant could not be loaded."); el.agentStatus.textContent = "Temporarily unavailable";
    } finally { el.loading.classList.remove("visible"); el.input.focus(); }
  }

  el.composer.addEventListener("submit", event => { event.preventDefault(); sendMessage(el.input.value); });
  el.input.addEventListener("input", resizeInput);
  el.input.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); el.composer.requestSubmit(); } });
  el.restart.addEventListener("click", () => {
    clearInterval(state.pollTimer); state.pollTimer = null; state.humanMode = false; state.seenMessageIds.clear(); state.sessionId = null;
    [...el.messages.querySelectorAll(".message-row,.handoff-note,.error-note")].forEach(x => x.remove()); initialize();
  });
  initialize();
})();

(function () {
  "use strict";
  const cfg = (window.CHAT_CONFIG || {}).auth || {};
  const tokenKey = "console_tokens";

  function b64url(bytes) {
    return btoa(String.fromCharCode.apply(null, new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function randomString() { const bytes = new Uint8Array(48); crypto.getRandomValues(bytes); return b64url(bytes); }
  function decodeJwt(token) {
    try { return JSON.parse(decodeURIComponent(escape(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))))); } catch (_) { return {}; }
  }
  async function challenge(verifier) {
    return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  }
  function getTokens() {
    try {
      const tokens = JSON.parse(sessionStorage.getItem(tokenKey) || "null");
      if (!tokens || decodeJwt(tokens.access_token).exp * 1000 < Date.now() + 15000) return null;
      return tokens;
    } catch (_) { return null; }
  }
  async function login() {
    if (!cfg.domain || !cfg.clientId) throw new Error("Cognito login is not configured.");
    const verifier = randomString(), state = randomString();
    sessionStorage.setItem("pkce_verifier", verifier); sessionStorage.setItem("oauth_state", state);
    const url = new URL(cfg.domain.replace(/\/$/, "") + "/oauth2/authorize");
    url.search = new URLSearchParams({response_type: "code", client_id: cfg.clientId, redirect_uri: location.origin + location.pathname,
      scope: "openid email profile", state, code_challenge_method: "S256", code_challenge: await challenge(verifier)});
    location.assign(url.toString());
  }
  async function handleCallback() {
    const params = new URLSearchParams(location.search), code = params.get("code");
    if (!code) return getTokens();
    if (params.get("state") !== sessionStorage.getItem("oauth_state")) throw new Error("Login state validation failed.");
    const response = await fetch(cfg.domain.replace(/\/$/, "") + "/oauth2/token", {method: "POST",
      headers: {"Content-Type": "application/x-www-form-urlencoded"},
      body: new URLSearchParams({grant_type: "authorization_code", client_id: cfg.clientId, code,
        redirect_uri: location.origin + location.pathname, code_verifier: sessionStorage.getItem("pkce_verifier") || ""})});
    if (!response.ok) throw new Error("Login could not be completed.");
    const tokens = await response.json(); sessionStorage.setItem(tokenKey, JSON.stringify(tokens));
    sessionStorage.removeItem("pkce_verifier"); sessionStorage.removeItem("oauth_state");
    history.replaceState({}, document.title, location.pathname); return tokens;
  }
  function logout() {
    sessionStorage.removeItem(tokenKey);
    if (!cfg.domain || !cfg.clientId) return location.reload();
    const url = new URL(cfg.domain.replace(/\/$/, "") + "/logout");
    url.search = new URLSearchParams({client_id: cfg.clientId, logout_uri: location.origin + location.pathname});
    location.assign(url.toString());
  }
  async function requireAuth(role) {
    if (!(window.CHAT_CONFIG || {}).apiBaseUrl) return {demo: true, access_token: "demo", claims: {name: role === "COMPANY_ADMIN" ? "Test Admin" : "Admin One", email: "demo@example.com", "custom:role": role}};
    const tokens = await handleCallback();
    if (!tokens) { await login(); return null; }
    const claims = decodeJwt(tokens.id_token || tokens.access_token);
    if (claims["custom:role"] !== role && !(role === "LIVE_AGENT" && claims["custom:role"] === "COMPANY_ADMIN")) throw new Error("This account does not have access to this console.");
    return {...tokens, claims};
  }
  window.ConsoleAuth = {requireAuth, login, logout, getTokens, decodeJwt};
})();


/*
 * Lokyy OS — Agent Importer Extension für Hermes WebUI (nesquena/hermes-webui)
 * --------------------------------------------------------------------------
 * Importiert einen kompletten Agenten aus einem JSON-Bundle in EINEM Schritt:
 *   Profil anlegen → reinwechseln → echte SOUL.md → MCP-Server → Skills.
 * Nutzt ausschließlich existierende, authentifizierte WebUI-Endpoints:
 *   POST /api/profile/create   { name, model_provider?, default_model? }
 *   POST /api/profile/switch   { name }
 *   POST /api/memory/write     { section:"soul", content }
 *   PUT  /api/mcp/servers/{n}  { url, headers? } | { command, args?, env? }
 *   POST /api/skills/save      { name, category?, content }
 * Kein Core-Fork. Idempotent gegen Doppel-Injektion.
 *
 * Bundle-Format (JSON):
 * {
 *   "name": "nina",
 *   "model_provider": "anthropic",          // optional
 *   "default_model": "claude-opus-4-6",      // optional
 *   "soul": "…komplette SOUL.md…",
 *   "mcp_servers": [
 *     { "name":"kie-ai", "url":"https://…/mcp", "auth":"__PROMPT__" }   // __PROMPT__ → Token wird beim Import abgefragt
 *   ],
 *   "skills": [ { "name":"brand-visuals", "category":"design", "content":"# Skill…" } ]
 * }
 */
(() => {
  'use strict';
  if (window.__lokyyAgentImporterLoaded) return;
  window.__lokyyAgentImporterLoaded = true;

  const BTN_ID = 'lokyy-agent-import-btn';
  const MODAL_ID = 'lokyy-agent-import-modal';

  function callApi(path, opts) {
    if (typeof window.api === 'function') return Promise.resolve(window.api(path, opts));
    return fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    }).then((r) => r.json());
  }
  function toast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type);
  }
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let logEl = null;
  function log(msg, kind) {
    if (!logEl) return;
    const line = document.createElement('div');
    line.className = 'lokyy-ai-log-line lokyy-ai-' + (kind || 'info');
    line.textContent = (kind === 'ok' ? '✓ ' : kind === 'err' ? '✗ ' : '• ') + msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function importBundle(bundle) {
    if (!bundle || !bundle.name) throw new Error('Bundle ohne "name"');
    const name = String(bundle.name);

    // 1. Profil anlegen
    log('Profil "' + name + '" anlegen …');
    const createPayload = { name };
    if (bundle.model_provider) createPayload.model_provider = bundle.model_provider;
    if (bundle.default_model) createPayload.default_model = bundle.default_model;
    const cr = await callApi('/api/profile/create', { method: 'POST', body: JSON.stringify(createPayload) });
    // create gibt bei Erfolg ein Objekt zurück; ein bereits existierendes Profil tolerieren wir
    log('Profil angelegt', 'ok');

    // 2. Ins Profil wechseln (damit SOUL/MCP/Skills im richtigen Profil landen)
    log('Wechsle in Profil "' + name + '" …');
    await callApi('/api/profile/switch', { method: 'POST', body: JSON.stringify({ name }) });
    log('Profil aktiv', 'ok');

    // 3. SOUL.md schreiben
    if (bundle.soul) {
      log('Schreibe Agenten-Seele (SOUL.md) …');
      await callApi('/api/memory/write', { method: 'POST', body: JSON.stringify({ section: 'soul', content: String(bundle.soul) }) });
      log('SOUL.md gesetzt', 'ok');
    }

    // 4. MCP-Server
    for (const m of (bundle.mcp_servers || [])) {
      if (!m || !m.name) continue;
      log('MCP-Server "' + m.name + '" …');
      const payload = {};
      if (m.url) {
        payload.url = m.url;
        let auth = m.auth;
        if (auth === '__PROMPT__') auth = window.prompt('Authorization-Token für MCP-Server "' + m.name + '" (z.B. "Bearer sk-…"). Leer = ohne Token:') || '';
        if (auth) payload.headers = { Authorization: auth };
      } else if (m.command) {
        payload.command = m.command;
        if (Array.isArray(m.args)) payload.args = m.args;
        if (m.env && typeof m.env === 'object') payload.env = m.env;
      } else {
        log('  übersprungen (weder url noch command)', 'err');
        continue;
      }
      if (m.timeout) payload.timeout = m.timeout;
      await callApi('/api/mcp/servers/' + encodeURIComponent(m.name), { method: 'PUT', body: JSON.stringify(payload) });
      log('MCP "' + m.name + '" konfiguriert', 'ok');
    }

    // 5. Skills
    for (const s of (bundle.skills || [])) {
      if (!s || !s.name || !s.content) continue;
      log('Skill "' + s.name + '" …');
      await callApi('/api/skills/save', { method: 'POST', body: JSON.stringify({ name: s.name, category: s.category || undefined, content: s.content }) });
      log('Skill "' + s.name + '" installiert', 'ok');
    }

    log('Fertig — Agent "' + name + '" importiert. Du bist jetzt in seinem Profil.', 'ok');
    log('MCP-Tools werden im Chat per /reload-mcp aktiv. Profil wechseln über das Profil-Menü.', 'info');
  }

  function buildModal() {
    if (document.getElementById(MODAL_ID)) return document.getElementById(MODAL_ID);
    const overlay = document.createElement('div');
    overlay.id = MODAL_ID;
    overlay.className = 'lokyy-ai-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="lokyy-ai-dialog" role="dialog" aria-modal="true" aria-label="Agent importieren">
        <div class="lokyy-ai-head">
          <h3>📥 Agent importieren</h3>
          <button type="button" class="lokyy-ai-x" data-close aria-label="Schließen">×</button>
        </div>
        <label class="lokyy-ai-label">Bundle-URL (JSON)
          <input id="lokyy-ai-url" placeholder="https://raw.githubusercontent.com/…/nina.json" autocomplete="off">
        </label>
        <div class="lokyy-ai-or">— oder —</div>
        <label class="lokyy-ai-label">Bundle-Datei
          <input id="lokyy-ai-file" type="file" accept="application/json,.json">
        </label>
        <p class="lokyy-ai-note">
          Legt ein Profil mit echter Agenten-Seele (SOUL.md), MCP-Servern und Skills an.
          Tokens (<code>__PROMPT__</code>) werden beim Import sicher abgefragt — niemals im Bundle.
        </p>
        <div class="lokyy-ai-actions">
          <button type="button" class="lokyy-ai-ghost" data-close>Schließen</button>
          <button type="button" class="lokyy-ai-primary" id="lokyy-ai-go">Importieren</button>
        </div>
        <div class="lokyy-ai-log" id="lokyy-ai-log" hidden></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { overlay.hidden = true; }));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.hidden = true; });
    overlay.querySelector('#lokyy-ai-go').addEventListener('click', onImport);
    return overlay;
  }

  async function onImport() {
    const overlay = document.getElementById(MODAL_ID);
    const urlEl = overlay.querySelector('#lokyy-ai-url');
    const fileEl = overlay.querySelector('#lokyy-ai-file');
    const goBtn = overlay.querySelector('#lokyy-ai-go');
    logEl = overlay.querySelector('#lokyy-ai-log');
    logEl.hidden = false;
    logEl.innerHTML = '';

    let bundle = null;
    try {
      if (fileEl.files && fileEl.files[0]) {
        bundle = JSON.parse(await fileEl.files[0].text());
      } else if (urlEl.value.trim()) {
        log('Lade Bundle …');
        const res = await fetch(urlEl.value.trim());
        if (!res.ok) throw new Error('HTTP ' + res.status);
        bundle = await res.json();
      } else {
        toast('Bundle-URL oder Datei angeben', 'error');
        return;
      }
    } catch (e) {
      log('Bundle konnte nicht geladen/geparst werden: ' + e.message, 'err');
      return;
    }

    goBtn.disabled = true; goBtn.textContent = 'Importiere …';
    try {
      await importBundle(bundle);
      toast('Agent "' + bundle.name + '" importiert', 'success');
    } catch (e) {
      log('Import abgebrochen: ' + (e && e.message ? e.message : e), 'err');
      toast('Import fehlgeschlagen', 'error');
    } finally {
      goBtn.disabled = false; goBtn.textContent = 'Importieren';
    }
  }

  function openModal() { buildModal().hidden = false; }

  function injectButton() {
    const panel = document.getElementById('profilesPanel');
    if (!panel) return;
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.className = 'lokyy-ai-import-btn';
    btn.textContent = '📥 Agent importieren';
    btn.addEventListener('click', openModal);
    panel.insertBefore(btn, panel.firstChild);
  }

  const observer = new MutationObserver(() => injectButton());
  observer.observe(document.body, { childList: true, subtree: true });
  injectButton();
})();

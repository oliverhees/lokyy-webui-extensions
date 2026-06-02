/*
 * Lokyy OS — Agent Importer Extension für Hermes WebUI (nesquena/hermes-webui)
 * --------------------------------------------------------------------------
 * Importiert einen kompletten Agenten aus einem JSON-Bundle in EINEM Schritt:
 *   Profil anlegen → reinwechseln → echte SOUL.md → MCP-Server → Skills.
 * UI: Agent-Galerie (Karten aus einem Katalog) + optional eigene URL/Datei.
 * Nutzt nur existierende WebUI-Endpoints. Kein Core-Fork. Robust gegen fehlendes CSS
 * (kritische Layout-Styles inline).
 *
 * Katalog (catalog.json): { "agents": [ { name, emoji, role, description, bundle } ] }
 * Bundle (nina.json):     { name, model_provider?, default_model?, soul, mcp_servers[], skills[] }
 *   mcp_servers[].auth === "__PROMPT__"  → Token wird beim Import sicher abgefragt.
 */
(() => {
  'use strict';
  if (window.__lokyyAgentImporterLoaded) return;
  window.__lokyyAgentImporterLoaded = true;

  const BTN_ID = 'lokyy-agent-import-btn';
  const MODAL_ID = 'lokyy-agent-import-modal';
  // Same-origin laden (WebUI-CSP blockiert cross-origin fetch zu GitHub).
  // catalog.json + Bundles liegen neben den Extension-Dateien unter /extensions/.
  const CATALOG_URL = '/extensions/catalog.json';

  function callApi(path, opts) {
    if (typeof window.api === 'function') return Promise.resolve(window.api(path, opts));
    return fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts }).then((r) => r.json());
  }
  // Verifizierte Host-Signatur: showToast(msg, ms, type) (hermes-webui static/ui.js:4130).
  // Der 3. Parameter ist der type; der 2. ist die Auto-Dismiss-Dauer in ms. Wir übersetzen
  // type→ms (error länger sichtbar) + type, damit die Einfärbung korrekt greift und der
  // type-String NICHT im ms-Parameter landet.
  function toast(msg, type) {
    const ms = type === 'error' ? 5000 : 3000;
    if (typeof window.showToast === 'function') window.showToast(msg, ms, type);
    else console.log('[agent-importer]', type || 'info', msg);
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let logEl = null;
  function log(msg, kind) {
    if (!logEl) return;
    const line = document.createElement('div');
    line.className = 'lokyy-ai-log-line lokyy-ai-' + (kind || 'info');
    line.style.cssText = 'padding:2px 0;color:' + (kind === 'ok' ? '#22c55e' : kind === 'err' ? '#ef4444' : '#9aa0b4');
    line.textContent = (kind === 'ok' ? '✓ ' : kind === 'err' ? '✗ ' : '• ') + msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function importBundle(bundle) {
    if (!bundle || !bundle.name) throw new Error('Bundle ohne "name"');
    const name = String(bundle.name);
    log('Profil "' + name + '" anlegen …');
    const createPayload = { name };
    if (bundle.model_provider) createPayload.model_provider = bundle.model_provider;
    if (bundle.default_model) createPayload.default_model = bundle.default_model;
    await callApi('/api/profile/create', { method: 'POST', body: JSON.stringify(createPayload) });
    log('Profil angelegt', 'ok');

    log('Wechsle in Profil "' + name + '" …');
    await callApi('/api/profile/switch', { method: 'POST', body: JSON.stringify({ name }) });
    log('Profil aktiv', 'ok');

    if (bundle.soul) {
      log('Schreibe Agenten-Seele (SOUL.md) …');
      await callApi('/api/memory/write', { method: 'POST', body: JSON.stringify({ section: 'soul', content: String(bundle.soul) }) });
      log('SOUL.md gesetzt', 'ok');
    }
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
      } else { log('  übersprungen (weder url noch command)', 'err'); continue; }
      if (m.timeout) payload.timeout = m.timeout;
      await callApi('/api/mcp/servers/' + encodeURIComponent(m.name), { method: 'PUT', body: JSON.stringify(payload) });
      log('MCP "' + m.name + '" konfiguriert', 'ok');
    }
    for (const s of (bundle.skills || [])) {
      if (!s || !s.name || !s.content) continue;
      log('Skill "' + s.name + '" …');
      await callApi('/api/skills/save', { method: 'POST', body: JSON.stringify({ name: s.name, category: s.category || undefined, content: s.content }) });
      log('Skill "' + s.name + '" installiert', 'ok');
    }
    log('Fertig — "' + name + '" importiert. Du bist jetzt in seinem Profil.', 'ok');
    log('Tools im Chat per /reload-mcp aktivieren. Modell ggf. in der Profil-UI wählen.', 'info');
  }

  // --- Modal mit inline Kern-Styles (robust gegen fehlendes CSS) -------------
  function buildModal() {
    let overlay = document.getElementById(MODAL_ID);
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = MODAL_ID;
    overlay.className = 'lokyy-ai-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.65);display:none;align-items:center;justify-content:center;padding:16px';
    overlay.innerHTML = `
      <div class="lokyy-ai-dialog" role="dialog" aria-modal="true" aria-label="Agent importieren"
           style="width:100%;max-width:600px;max-height:88vh;overflow-y:auto;background:#14161f;color:#e8e8ee;border:1px solid #2a2d3a;border-radius:12px;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.5)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <h3 style="margin:0;font-size:17px">📥 Agent importieren</h3>
          <button type="button" data-close aria-label="Schließen" style="background:none;border:none;color:#9aa0b4;font-size:24px;line-height:1;cursor:pointer">×</button>
        </div>
        <div id="lokyy-ai-catalog" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div style="color:#9aa0b4;font-size:13px;grid-column:1/-1">Lade Agenten …</div>
        </div>
        <details style="margin-top:16px">
          <summary style="cursor:pointer;color:#9aa0b4;font-size:12px">Eigenes Bundle (URL oder Datei) …</summary>
          <div style="margin-top:10px">
            <input id="lokyy-ai-url" placeholder="https://…/mein-agent.json"
                   style="width:100%;box-sizing:border-box;padding:8px 10px;background:#0e1018;color:#e8e8ee;border:1px solid #2a2d3a;border-radius:7px;font:13px ui-monospace,monospace">
            <div style="text-align:center;color:#777c90;font-size:11px;margin:6px 0">— oder —</div>
            <input id="lokyy-ai-file" type="file" accept="application/json,.json" style="color:#9aa0b4;font-size:12px">
            <button type="button" id="lokyy-ai-custom-go" style="margin-top:10px;padding:8px 16px;border:1px solid #2a2d3a;background:transparent;color:#e8e8ee;border-radius:8px;cursor:pointer;font:13px system-ui">Eigenes Bundle importieren</button>
          </div>
        </details>
        <p style="font-size:11px;color:#9aa0b4;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25);border-radius:7px;padding:8px 10px;margin:14px 0 0">
          Legt Profil + echte Agenten-Seele (SOUL.md) + MCP-Server + Skills an. Tokens werden beim Import sicher abgefragt — nie im Bundle gespeichert.
        </p>
        <div id="lokyy-ai-log" style="margin-top:14px;max-height:220px;overflow-y:auto;font:12px ui-monospace,monospace;display:none"></div>
        <div style="display:flex;justify-content:flex-end;margin-top:14px">
          <button type="button" data-close style="padding:9px 18px;border:1px solid #2a2d3a;background:transparent;color:#9aa0b4;border-radius:8px;cursor:pointer;font:13px system-ui">Schließen</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    overlay.querySelector('#lokyy-ai-custom-go').addEventListener('click', () => {
      const urlEl = overlay.querySelector('#lokyy-ai-url');
      const fileEl = overlay.querySelector('#lokyy-ai-file');
      runImport({ url: urlEl.value.trim(), file: fileEl.files && fileEl.files[0] });
    });
    return overlay;
  }

  function openModal() {
    const overlay = buildModal();
    overlay.style.display = 'flex';
    logEl = overlay.querySelector('#lokyy-ai-log');
    logEl.style.display = 'none';
    logEl.innerHTML = '';
    loadCatalog();
  }
  function closeModal() { const o = document.getElementById(MODAL_ID); if (o) o.style.display = 'none'; }

  function loadCatalog() {
    const box = document.getElementById('lokyy-ai-catalog');
    if (!box) return;
    fetch(CATALOG_URL).then((r) => r.json()).then((cat) => {
      const agents = (cat && cat.agents) || [];
      if (!agents.length) { box.innerHTML = '<div style="color:#9aa0b4;font-size:13px;grid-column:1/-1">Katalog leer. Nutze „Eigenes Bundle".</div>'; return; }
      box.innerHTML = agents.map((a, i) => `
        <div class="lokyy-ai-card" data-idx="${i}" style="border:1px solid #2a2d3a;border-radius:10px;padding:14px;cursor:pointer;transition:border-color .15s,background .15s">
          <div style="font-size:24px">${esc(a.emoji || '🤖')}</div>
          <div style="font-weight:600;font-size:15px;margin-top:6px">${esc(a.name)}</div>
          <div style="color:#f59e0b;font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:2px 0 6px">${esc(a.role || '')}</div>
          <div style="color:#9aa0b4;font-size:12px;line-height:1.4">${esc(a.description || '')}</div>
          <button type="button" style="margin-top:10px;width:100%;padding:7px;border:1px solid #f59e0b;background:transparent;color:#f59e0b;border-radius:7px;cursor:pointer;font:600 12px system-ui">Importieren</button>
        </div>`).join('');
      box.querySelectorAll('.lokyy-ai-card').forEach((card) => {
        const a = agents[parseInt(card.getAttribute('data-idx'), 10)];
        card.addEventListener('mouseenter', () => { card.style.borderColor = '#f59e0b'; card.style.background = 'rgba(245,158,11,.05)'; });
        card.addEventListener('mouseleave', () => { card.style.borderColor = '#2a2d3a'; card.style.background = 'transparent'; });
        card.addEventListener('click', () => runImport({ url: a.bundle }));
      });
    }).catch(() => {
      box.innerHTML = '<div style="color:#ef4444;font-size:12px;grid-column:1/-1">Katalog konnte nicht geladen werden. Nutze „Eigenes Bundle".</div>';
    });
  }

  async function runImport({ url, file }) {
    logEl = document.getElementById('lokyy-ai-log');
    logEl.style.display = 'block';
    logEl.innerHTML = '';
    let bundle = null;
    try {
      if (file) bundle = JSON.parse(await file.text());
      else if (url) { log('Lade Bundle …'); const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status); bundle = await r.json(); }
      else { toast('Bundle-URL oder Datei angeben', 'error'); return; }
    } catch (e) { log('Bundle konnte nicht geladen/geparst werden: ' + e.message, 'err'); return; }
    try {
      await importBundle(bundle);
      toast('Agent "' + bundle.name + '" importiert', 'success');
    } catch (e) { log('Import abgebrochen: ' + (e && e.message ? e.message : e), 'err'); toast('Import fehlgeschlagen', 'error'); }
  }

  function injectButton() {
    const panel = document.getElementById('profilesPanel');
    if (!panel || document.getElementById(BTN_ID)) return;
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.className = 'lokyy-ai-import-btn';
    btn.textContent = '📥 Agent importieren';
    btn.style.cssText = 'display:block;width:calc(100% - 24px);margin:10px 12px;padding:9px 12px;border:1px solid #f59e0b;background:transparent;color:#f59e0b;border-radius:8px;font:600 13px system-ui;cursor:pointer';
    btn.addEventListener('click', openModal);
    panel.insertBefore(btn, panel.firstChild);
  }

  const observer = new MutationObserver(() => injectButton());
  observer.observe(document.body, { childList: true, subtree: true });
  injectButton();
})();

/*
 * Lokyy OS — MCP Manager Extension für Hermes WebUI (nesquena/hermes-webui)
 * --------------------------------------------------------------------------
 * Fügt der Settings → System → MCP-Server-Sektion einen "MCP-Server
 * hinzufügen"-Button + Formular hinzu und erlaubt Löschen vorhandener Server.
 * Nutzt ausschließlich die bereits existierenden, getesteten WebUI-Endpoints:
 *   PUT    /api/mcp/servers/{name}   (anlegen/ändern)
 *   DELETE /api/mcp/servers/{name}   (löschen)
 *   GET    /api/mcp/servers          (auflisten)
 * Kein Core-Fork. Rein additiv. Idempotent gegen Doppel-Injektion.
 */
(() => {
  'use strict';
  if (window.__lokyyMcpManagerLoaded) return;
  window.__lokyyMcpManagerLoaded = true;

  const PANEL_ID = 'lokyy-mcp-add-bar';
  const MODAL_ID = 'lokyy-mcp-modal';

  // --- API-Wrapper: bevorzugt die Host-Funktion api() (regelt CSRF + Auth korrekt) ---
  function callApi(path, opts) {
    if (typeof window.api === 'function') return window.api(path, opts);
    // Fallback (sollte selten nötig sein): same-origin fetch.
    return fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    }).then((r) => r.json());
  }

  // Verifizierte Host-Signatur: showToast(msg, ms, type) (hermes-webui static/ui.js:4130).
  // Der 3. Parameter ist der type; der 2. ist die Auto-Dismiss-Dauer in ms. Wir übersetzen
  // type→ms (error länger sichtbar) + type, damit die Einfärbung korrekt greift und der
  // type-String NICHT im ms-Parameter landet.
  function toast(msg, type) {
    const ms = type === 'error' ? 5000 : 3000;
    if (typeof window.showToast === 'function') window.showToast(msg, ms, type);
    else console.log('[mcp-manager]', type || 'info', msg);
  }

  function refreshHostList() {
    // Lässt die eingebaute Liste neu laden, falls vorhanden.
    if (typeof window.loadMcpServers === 'function') window.loadMcpServers();
  }

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // --- Modal aufbauen --------------------------------------------------------
  function buildModal() {
    if (document.getElementById(MODAL_ID)) return document.getElementById(MODAL_ID);

    const overlay = document.createElement('div');
    overlay.id = MODAL_ID;
    overlay.className = 'lokyy-mcp-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="lokyy-mcp-dialog" role="dialog" aria-modal="true" aria-label="MCP-Server verwalten">
        <div class="lokyy-mcp-head">
          <h3>MCP-Server hinzufügen</h3>
          <button type="button" class="lokyy-mcp-x" data-close aria-label="Schließen">×</button>
        </div>

        <form class="lokyy-mcp-form" id="lokyy-mcp-form">
          <label>Name <span class="lokyy-mcp-req">*</span>
            <input name="name" required placeholder="z.B. lokyy-brain" autocomplete="off">
            <small>Nur Buchstaben, Zahlen, - und _ (keine Leerzeichen).</small>
          </label>

          <div class="lokyy-mcp-transport">
            <label class="lokyy-mcp-radio"><input type="radio" name="transport" value="http" checked> HTTP / Remote</label>
            <label class="lokyy-mcp-radio"><input type="radio" name="transport" value="stdio"> stdio / Lokal</label>
          </div>

          <div class="lokyy-mcp-http">
            <label>Server-URL <span class="lokyy-mcp-req">*</span>
              <input name="url" placeholder="https://mcp.example.com/mcp" autocomplete="off">
            </label>
            <label>Authorization-Header (optional)
              <input name="auth" placeholder="Bearer sk-..." autocomplete="off">
              <small>Wird als Header <code>Authorization</code> gesendet. Leer lassen, wenn keiner nötig.</small>
            </label>
          </div>

          <div class="lokyy-mcp-stdio" hidden>
            <label>Command <span class="lokyy-mcp-req">*</span>
              <input name="command" placeholder="npx" autocomplete="off">
            </label>
            <label>Argumente (eine pro Zeile)
              <textarea name="args" rows="3" placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/data"></textarea>
            </label>
            <label>Environment (KEY=VALUE, eine pro Zeile)
              <textarea name="env" rows="2" placeholder="API_KEY=..."></textarea>
            </label>
          </div>

          <label>Timeout in Sekunden (optional)
            <input name="timeout" type="number" min="1" placeholder="30" autocomplete="off">
          </label>

          <p class="lokyy-mcp-note">
            Hinweis: <b>Neue</b> Server werden beim nächsten Chat automatisch aktiv.
            Bei <b>Änderungen/Löschen</b> bestehender Server Hermes einmal neu starten.
          </p>

          <div class="lokyy-mcp-actions">
            <button type="button" class="lokyy-mcp-btn-ghost" data-close>Abbrechen</button>
            <button type="submit" class="lokyy-mcp-btn-primary">Speichern</button>
          </div>
        </form>

        <div class="lokyy-mcp-existing">
          <h4>Vorhandene MCP-Server</h4>
          <div id="lokyy-mcp-existing-list"><small>Lade…</small></div>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    // Transport-Umschaltung
    const httpBox = overlay.querySelector('.lokyy-mcp-http');
    const stdioBox = overlay.querySelector('.lokyy-mcp-stdio');
    overlay.querySelectorAll('input[name="transport"]').forEach((r) =>
      r.addEventListener('change', () => {
        const http = overlay.querySelector('input[name="transport"][value="http"]').checked;
        httpBox.hidden = !http;
        stdioBox.hidden = http;
      }));

    // Schließen
    overlay.querySelectorAll('[data-close]').forEach((b) =>
      b.addEventListener('click', () => { overlay.hidden = true; }));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.hidden = true; });

    // Submit
    overlay.querySelector('#lokyy-mcp-form').addEventListener('submit', onSubmit);

    return overlay;
  }

  function parseLines(text) {
    return String(text || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }

  function onSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const f = (n) => (form.elements[n] ? form.elements[n].value.trim() : '');
    const name = f('name');
    if (!name) { toast('Name fehlt', 'error'); return; }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      toast('Name darf nur Buchstaben, Zahlen, - und _ enthalten (keine Leerzeichen)', 'error');
      return;
    }
    const transport = form.elements['transport'].value;

    const payload = {};
    if (transport === 'http') {
      if (!f('url')) { toast('URL fehlt', 'error'); return; }
      payload.url = f('url');
      if (f('auth')) payload.headers = { Authorization: f('auth') };
    } else {
      if (!f('command')) { toast('Command fehlt', 'error'); return; }
      payload.command = f('command');
      const args = parseLines(f('args'));
      if (args.length) payload.args = args;
      const env = {};
      parseLines(f('env')).forEach((line) => {
        const i = line.indexOf('=');
        if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      });
      if (Object.keys(env).length) payload.env = env;
    }
    if (f('timeout')) payload.timeout = parseInt(f('timeout'), 10);

    const submitBtn = form.querySelector('.lokyy-mcp-btn-primary');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Speichere…';

    Promise.resolve(
      callApi('/api/mcp/servers/' + encodeURIComponent(name), {
        method: 'PUT',
        body: JSON.stringify(payload),
      })
    )
      .then((r) => {
        if (r && r.ok) {
          toast('MCP-Server "' + name + '" gespeichert', 'success');
          form.reset();
          // Transport-Boxen zurücksetzen
          form.querySelector('.lokyy-mcp-http').hidden = false;
          form.querySelector('.lokyy-mcp-stdio').hidden = true;
          loadExisting();
          refreshHostList();
        } else {
          toast('Speichern fehlgeschlagen: ' + ((r && r.error) || 'unbekannt'), 'error');
        }
      })
      .catch(() => toast('Speichern fehlgeschlagen (Netzwerk/Session)', 'error'))
      .finally(() => { submitBtn.disabled = false; submitBtn.textContent = 'Speichern'; });
  }

  function loadExisting() {
    const box = document.getElementById('lokyy-mcp-existing-list');
    if (!box) return;
    box.innerHTML = '<small>Lade…</small>';
    Promise.resolve(callApi('/api/mcp/servers'))
      .then((r) => {
        const servers = (r && r.servers) || [];
        if (!servers.length) { box.innerHTML = '<small>Keine MCP-Server konfiguriert.</small>'; return; }
        box.innerHTML = servers.map((s) => {
          const detail = s.transport === 'http' ? (s.url || '') : ((s.command || '') + ' ' + (Array.isArray(s.args) ? s.args.join(' ') : ''));
          return `<div class="lokyy-mcp-row">
            <span class="lokyy-mcp-row-name">${esc(s.name)}</span>
            <span class="lokyy-mcp-row-detail">${esc(detail)}</span>
            <button type="button" class="lokyy-mcp-del" data-name="${esc(s.name)}">Löschen</button>
          </div>`;
        }).join('');
        box.querySelectorAll('.lokyy-mcp-del').forEach((b) =>
          b.addEventListener('click', () => deleteServer(b.getAttribute('data-name'))));
      })
      .catch(() => { box.innerHTML = '<small style="color:#ef4444">Liste konnte nicht geladen werden.</small>'; });
  }

  function deleteServer(name) {
    if (!name) return;
    if (!window.confirm('MCP-Server "' + name + '" wirklich löschen?')) return;
    Promise.resolve(callApi('/api/mcp/servers/' + encodeURIComponent(name), { method: 'DELETE' }))
      .then((r) => {
        if (r && r.ok) { toast('"' + name + '" gelöscht — bei Bedarf Hermes neu starten', 'success'); loadExisting(); refreshHostList(); }
        else toast('Löschen fehlgeschlagen', 'error');
      })
      .catch(() => toast('Löschen fehlgeschlagen', 'error'));
  }

  function openModal() {
    const m = buildModal();
    m.hidden = false;
    loadExisting();
  }

  // --- Button in die MCP-Settings-Sektion einklinken (sobald sichtbar) -------
  function injectBar() {
    const list = document.getElementById('mcpServerList');
    if (!list) return false;
    if (document.getElementById(PANEL_ID)) return true; // schon da
    const bar = document.createElement('div');
    bar.id = PANEL_ID;
    bar.className = 'lokyy-mcp-bar';
    bar.innerHTML = `<button type="button" class="lokyy-mcp-add-btn">➕ MCP-Server hinzufügen</button>`;
    bar.querySelector('button').addEventListener('click', openModal);
    list.parentNode.insertBefore(bar, list);
    return true;
  }

  // Settings werden dynamisch gerendert → beobachten, bis #mcpServerList auftaucht.
  const observer = new MutationObserver(() => injectBar());
  observer.observe(document.body, { childList: true, subtree: true });
  // Erstversuch (falls schon da)
  injectBar();
})();

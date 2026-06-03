/*
 * Lokyy OS — Loki Workspace Auto-Activate Extension für Hermes WebUI
 * -----------------------------------------------------------------------------
 * Problem: Der Workspace-Panel rechts bleibt leer, bis man in "Spaces" manuell
 * einen Workspace zum Arbeiten aktiviert. Beim Öffnen einer Session ist oft
 * keiner aktiv → "leer", obwohl die Dateien da sind.
 *
 * Lösung: Beim Laden/Session-Wechsel automatisch den ersten Workspace ("Home")
 * aktivieren (via die native window.switchToWorkspace) bzw. den Files-Panel
 * nachladen (window.loadDir). Per Toggle unter Settings → Preferences
 * ein-/ausschaltbar. Default: AN.
 *
 * Verwendete native Globals (verifiziert in panels.js/workspace.js):
 *   - window.switchToWorkspace(path,name)  → setzt s.workspace + lädt Panel
 *   - window.loadDir(path)                 → lädt Files-Panel neu
 *   - #composerWorkspaceLabel              → zeigt aktiven Workspace-Namen / "No workspace"
 *   - GET /api/workspaces                  → { workspaces:[{path,name}], last }
 */
(() => {
  'use strict';
  if (window.__lokiWorkspaceLoaded) return;
  window.__lokiWorkspaceLoaded = true;

  const LS_KEY = 'loki-auto-workspace';           // 'on' | 'off' (default on)
  const isOn = () => localStorage.getItem(LS_KEY) !== 'off';
  const setOn = (on) => { try { localStorage.setItem(LS_KEY, on ? 'on' : 'off'); } catch (_) {} };

  let _lastSession = null;

  function currentSessionId() {
    const m = location.pathname.match(/\/session\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }

  // Heuristik: ist gerade ein Workspace aktiv? (composer-Label zeigt Namen oder "No workspace")
  function noWorkspaceActive() {
    const label = document.getElementById('composerWorkspaceLabel');
    if (!label) return false;                       // unbekannt → nicht eingreifen
    const txt = (label.textContent || '').trim();
    if (!txt) return false;                         // leer (Boot) → warten, nicht eingreifen
    return /no[\s-]?workspace|kein\s*workspace/i.test(txt);
  }

  async function firstWorkspace() {
    try {
      const d = await fetch('/api/workspaces', { cache: 'no-store' }).then(r => r.json());
      return (d && Array.isArray(d.workspaces) && d.workspaces[0]) || null;
    } catch (_) { return null; }
  }

  // Stellt sicher, dass ein Workspace aktiv + der Files-Panel geladen ist.
  async function ensureWorkspace(force) {
    if (!isOn()) return;
    const sid = currentSessionId();
    if (!sid) return;                               // keine Session offen
    if (!force && _lastSession === sid) return;     // pro Session nur einmal
    if (typeof window.switchToWorkspace !== 'function') return; // App noch nicht bereit
    _lastSession = sid;

    if (noWorkspaceActive()) {
      const ws = await firstWorkspace();
      if (ws) { try { await window.switchToWorkspace(ws.path, ws.name); } catch (_) {} }
    } else if (typeof window.loadDir === 'function') {
      // Workspace ist aktiv, aber der Files-Panel kann beim Session-Load leer
      // gerendert sein → einmal neu laden.
      try { window.loadDir('.'); } catch (_) {}
    }
  }

  // ── Settings-Toggle (Settings → Preferences) ───────────────────────────────
  function buildToggle() {
    const wrap = document.createElement('div');
    wrap.id = 'lokiAutoWsField';
    wrap.style.cssText = 'margin:16px 0;padding-top:14px;border-top:1px solid var(--border,#2a2d3a)';
    wrap.innerHTML =
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
      '<input type="checkbox" id="lokiAutoWsToggle" style="width:15px;height:15px;accent-color:var(--accent,#F97316)">' +
      '<span>Workspace automatisch aktivieren</span>' +
      '</label>' +
      '<div style="font-size:11px;color:var(--muted,#9aa0b4);margin-top:4px">' +
      'Aktiviert beim Öffnen einer Session automatisch den Workspace „Home", damit die Dateien rechts ' +
      'sofort erscheinen — ohne dass du ihn erst manuell in „Spaces" auswählen musst.' +
      '</div>';
    const cb = wrap.querySelector('#lokiAutoWsToggle');
    cb.checked = isOn();
    cb.addEventListener('change', () => {
      setOn(cb.checked);
      if (cb.checked) ensureWorkspace(true);
    });
    return wrap;
  }

  function mountToggle() {
    const pane = document.getElementById('settingsPanePreferences');
    if (!pane || document.getElementById('lokiAutoWsField')) return;
    pane.appendChild(buildToggle());
  }

  // ── Trigger ─────────────────────────────────────────────────────────────
  function boot() {
    mountToggle();
    // Boot-Timing: mehrere verzögerte Versuche, bis App + Session bereit sind.
    [800, 2000, 4000].forEach(ms => setTimeout(() => { mountToggle(); ensureWorkspace(false); }, ms));

    // Session-Wechsel überwachen (SPA-Routing) → bei neuer Session erneut sicherstellen.
    let lastUrlSid = currentSessionId();
    setInterval(() => {
      mountToggle();                                 // falls Settings-Pane neu gerendert wurde
      const sid = currentSessionId();
      if (sid !== lastUrlSid) { lastUrlSid = sid; ensureWorkspace(true); }
    }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();

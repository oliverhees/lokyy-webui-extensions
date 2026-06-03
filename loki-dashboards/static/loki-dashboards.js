/*
 * Lokyy OS — Loki Dashboards Extension für Hermes WebUI (nesquena/hermes-webui)
 * --------------------------------------------------------------------------
 * Reine DASHBOARD-ANZEIGE. KEIN Multi-Agent, KEIN Chat.
 *
 * Was es tut:
 *   1. Eigener Nav-Eintrag "📊 Dashboards" in der Rail + Sidebar-Nav (ganz oben).
 *   2. 2-Spalten-Layout im Panel-Body:
 *        LINKS  — .loki-dash-list: Liste der gefundenen Dashboards (Ordner mit dashboard.html).
 *        RECHTS — .loki-dash-view: <iframe class="loki-dash-frame"> + leerer Zustand.
 *   3. DISCOVERY: Über die verifizierte File-API werden alle Ordner gesucht, die eine
 *      'dashboard.html' enthalten. Pro Treffer: Name = Ordnername. Liste links rendern.
 *   4. Klick auf ein Dashboard → rechts ein sandboxed <iframe> mit der file/raw-URL der
 *      dashboard.html (inline=1, Cache-Bust). Die dashboard.html lädt ihre Daten selbst.
 *   5. Refresh-Button (lädt Liste + iframe neu). Robust gegen fehlende API (404/503).
 *   6. hidePanel: iframe-src leeren (kein Hintergrund-Laden).
 *
 * VERIFIZIERTE FILE-/WORKSPACE-API (nesquena/hermes-webui, gegen echten Code geprüft):
 *   - File-Ops laufen über `session_id` (NICHT `workspace`). Pfade sind relativ zum
 *     Workspace-Root der Session. Den Handle holen wir aus dem Frontend-State:
 *     window.S.session.session_id (so macht es die Host-UI selbst, static/workspace.js).
 *   - Ordner-LISTING: GET /api/list?session_id=<SID>&path=<rel>  (Default path=".")
 *       → { entries: [{name, path, type:'dir'|'file'|'symlink', size, mtime_ns, ...}],
 *           signature, path }   (max. 200 Einträge, sortiert)
 *   - Datei roh: GET /api/file/raw?session_id=<SID>&path=<rel>[&inline=1]
 *       .html ist "dangerous type" → für iframe-Einbettung inline=1 ZWINGEND
 *       (sonst attachment/Download). iframe MUSS sandboxed sein (allow-scripts).
 *   - Es gibt KEINEN `workspace`-Query-Param auf den File-Endpoints.
 *   - GET /api/workspaces liefert { workspaces:[{path,name}], last:"<abs>" } — verwaltet
 *     nur die Picker-Liste, liefert KEINE session_id. Wir arbeiten gegen die Session.
 *
 * DISCOVERY-STRATEGIE:
 *   - Wir listen den Workspace-Root (path="."). Für jeden Eintrag vom Typ 'dir' listen
 *     wir dessen Inhalt und prüfen, ob eine 'dashboard.html' (file/symlink) enthalten ist.
 *   - Treffer = Dashboard. Name = Ordnername, htmlPath = "<dir>/dashboard.html".
 *   - Zusätzlich: liegt direkt im Root eine 'dashboard.html', zählt der Root selbst als
 *     Dashboard "(root)".
 *   - Tiefe 1 (Root + direkte Unterordner) reicht für die Konvention "ein Ordner = ein
 *     Dashboard". Robust gegen Fehler: einzelne nicht-listbare Ordner werden übersprungen.
 *
 * Rein additiv. Idempotent. Kein Core-Fork. Vanilla JS, kein Build-Step.
 * Nav/Panel-Switching/Bootstrap-Mechanik 1:1 aus loki-orchestrator übernommen (verifiziert).
 */
(() => {
  'use strict';
  if (window.__lokiDashboardsLoaded) return;
  window.__lokiDashboardsLoaded = true;

  const PANEL_NAME = 'dashboards';                 // interner switchPanel-Name
  const PANEL_ID = 'lokiDashboardsPanel';          // DOM-id unseres main-view-Geschwisters
  const PANEL_CLASS = 'loki-dashboards-panel';     // KEIN host .main-view
  const RAIL_BTN_ID = 'lokiDashRailBtn';
  const SIDEBAR_BTN_ID = 'lokiDashSidebarBtn';

  const DASHBOARD_FILE = 'dashboard.html';

  // ── API-Wrapper: bevorzugt Host-api() (credentials:'include'), sonst fetch. ──
  // window.api() löst JSON bereits auf UND wirft bei !ok einen Error mit .status.
  function callApi(path, opts) {
    if (typeof window.api === 'function') return Promise.resolve(window.api(path, opts));
    return fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    }).then((r) => {
      if (!r.ok) {
        const err = new Error('HTTP ' + r.status);
        err.status = r.status;
        throw err;
      }
      return r.json();
    });
  }

  // Verifizierte Host-Signatur: showToast(msg, ms, type) (static/ui.js). type→ms+type.
  function toast(msg, type) {
    const ms = type === 'error' ? 5000 : 3000;
    if (typeof window.showToast === 'function') window.showToast(msg, ms, type);
    else console.log('[loki-dashboards]', type || 'info', msg);
  }

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── State ─────────────────────────────────────────────────────────────────
  let panelActive = false;
  let dashboards = [];        // [{ name, htmlPath }] — gefundene Dashboards
  let selectedPath = null;    // htmlPath des aktuell angezeigten Dashboards
  let loading = false;        // Discovery läuft

  // Liefert die session_id aus dem Host-Frontend-State (einziger File-Zugriff-Handle).
  function getSessionId() {
    try {
      const s = window.S && window.S.session;
      const sid = s && s.session_id;
      return sid ? String(sid) : null;
    } catch (_) { return null; }
  }

  // Baut die verifizierte file/raw-URL für ein HTML-Dashboard (relativ, ohne führenden
  // Slash — exakt wie die Host-UI). inline=1 ist für .html PFLICHT, sonst Download.
  // Cache-Bust per &t=… (Server liefert no-store).
  function buildFrameUrl(sid, relPath) {
    return 'api/file/raw'
      + '?session_id=' + encodeURIComponent(sid)
      + '&path=' + encodeURIComponent(relPath)
      + '&inline=1'
      + '&t=' + Date.now();
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  PANEL-DOM  (2-Spalten: Dashboard-Liste links + iframe-Ansicht rechts)
  // ───────────────────────────────────────────────────────────────────────────
  function buildPanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    const main = document.querySelector('main.main') || document.querySelector('main');
    if (!main) return null;

    panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.className = PANEL_CLASS;
    panel.hidden = true;
    // Inline-Kern-Styles als Fallback, falls die CSS-Datei nicht geladen wird.
    panel.style.cssText = 'flex:1;min-height:0;min-width:0;flex-direction:column;background:var(--bg,#0b0d16);overflow:hidden;';
    panel.innerHTML = `
      <div class="loki-dash-headbar">
        <div class="loki-dash-head-title">📊 Dashboards <span class="loki-dash-sub">— deine Auswertungen</span></div>
        <button type="button" class="loki-dash-btn-primary" id="lokiDashRefreshBtn" title="Neu laden">⟳ Aktualisieren</button>
      </div>

      <div class="loki-dash-body">
        <aside class="loki-dash-list" id="lokiDashList">
          <div class="loki-dash-list-empty">Lade Dashboards…</div>
        </aside>

        <div class="loki-dash-view" id="lokiDashView">
          <div class="loki-dash-view-empty" id="lokiDashViewEmpty">
            <div class="loki-dash-view-empty-icon">📊</div>
            <div>Wähle links ein Dashboard aus.</div>
          </div>
        </div>
      </div>`;

    main.appendChild(panel);

    const refreshBtn = panel.querySelector('#lokiDashRefreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', () => refresh());

    return panel;
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  DISCOVERY  — Ordner mit dashboard.html finden (verifizierte /api/list)
  // ───────────────────────────────────────────────────────────────────────────
  // listDir(sid, rel): GET /api/list → entries[] (oder [] bei Fehler).
  function listDir(sid, rel) {
    const p = 'api/list?session_id=' + encodeURIComponent(sid)
      + '&path=' + encodeURIComponent(rel == null ? '.' : rel);
    return callApi(p)
      .then((r) => (r && Array.isArray(r.entries)) ? r.entries : [])
      .catch((e) => { throw e; });
  }

  // Enthält die Einträge-Liste eine dashboard.html (file oder symlink-zu-file)?
  function hasDashboardFile(entries) {
    return entries.some((it) =>
      it && it.name === DASHBOARD_FILE && it.type !== 'dir' && it.is_dir !== true);
  }

  // discoverDashboards(): listet den Root, prüft Root selbst + jeden Unterordner auf
  // dashboard.html. Liefert Promise<[{name, htmlPath}]>. Wirft bei Root-Listing-Fehler
  // (→ klare API-Fehlermeldung); einzelne Unterordner-Fehler werden geschluckt.
  async function discoverDashboards(sid) {
    const found = [];
    const rootEntries = await listDir(sid, '.'); // wirft bei API-Fehler → caller zeigt Meldung

    // Root selbst als Dashboard, wenn dort direkt eine dashboard.html liegt.
    if (hasDashboardFile(rootEntries)) {
      found.push({ name: '(root)', htmlPath: DASHBOARD_FILE });
    }

    // Direkte Unterordner prüfen (Tiefe 1 — "ein Ordner = ein Dashboard").
    const dirs = rootEntries.filter((it) =>
      it && (it.type === 'dir' || (it.type === 'symlink' && it.is_dir === true)));

    for (const d of dirs) {
      const rel = d.path || d.name;
      try {
        // eslint-disable-next-line no-await-in-loop
        const sub = await listDir(sid, rel);
        if (hasDashboardFile(sub)) {
          found.push({ name: d.name, htmlPath: rel + '/' + DASHBOARD_FILE });
        }
      } catch (_) {
        // Nicht-listbarer Ordner (Rechte/Traversal) → überspringen.
      }
    }

    // Stabil nach Name sortieren ((root) zuerst).
    found.sort((a, b) => {
      if (a.name === '(root)') return -1;
      if (b.name === '(root)') return 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    return found;
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  RENDERN  — linke Liste
  // ───────────────────────────────────────────────────────────────────────────
  function renderList() {
    const list = document.getElementById('lokiDashList');
    if (!list) return;

    if (loading) {
      list.innerHTML = '<div class="loki-dash-list-empty">Lade Dashboards…</div>';
      return;
    }
    if (!dashboards.length) {
      list.innerHTML = '<div class="loki-dash-list-empty">Noch keine Dashboards. '
        + 'Lass dir per Skill eins bauen.</div>';
      return;
    }

    list.innerHTML =
      '<div class="loki-dash-list-head">Dashboards</div>' +
      dashboards.map((d) =>
        '<button type="button" class="loki-dash-item' +
          (d.htmlPath === selectedPath ? ' active' : '') + '" ' +
          'data-path="' + esc(d.htmlPath) + '" title="' + esc(d.name) + '">' +
          '<span class="loki-dash-item-icon">📈</span>' +
          '<span class="loki-dash-item-name">' + esc(d.name) + '</span>' +
        '</button>'
      ).join('');

    Array.from(list.querySelectorAll('.loki-dash-item')).forEach((btn) => {
      btn.addEventListener('click', () => openDashboard(btn.dataset.path));
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  RECHTS  — iframe setzen / leeren
  // ───────────────────────────────────────────────────────────────────────────
  // openDashboard(htmlPath): sandboxed iframe mit der verifizierten file/raw-URL setzen.
  function openDashboard(htmlPath) {
    if (!htmlPath) return;
    const sid = getSessionId();
    const view = document.getElementById('lokiDashView');
    if (!view) return;

    if (!sid) {
      showViewMessage(view,
        '⚠️ Keine aktive Session gefunden. Öffne zuerst einen Workspace, dann erneut versuchen.');
      return;
    }

    selectedPath = htmlPath;

    // View leeren, frischen sandboxed iframe einsetzen.
    view.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.className = 'loki-dash-frame';
    // SICHERHEIT: sandbox ist ZWINGEND. allow-same-origin hier, damit das Dashboard
    // im iframe seine eigene session_id-relative File-API (api/list, api/file/raw)
    // same-origin ansprechen kann (Daten laden). allow-scripts für die Dashboard-Logik.
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.setAttribute('title', 'Dashboard');
    iframe.src = buildFrameUrl(sid, htmlPath);
    view.appendChild(iframe);

    // Aktiven Zustand in der Liste markieren.
    renderList();
  }

  // Zeigt im View-Bereich eine Klartext-Meldung (leerer/Fehler-Zustand).
  function showViewMessage(view, text) {
    if (!view) view = document.getElementById('lokiDashView');
    if (!view) return;
    view.innerHTML =
      '<div class="loki-dash-view-empty">' +
        '<div class="loki-dash-view-empty-icon">📊</div>' +
        '<div>' + esc(text) + '</div>' +
      '</div>';
  }

  // iframe leeren (kein Hintergrund-Laden) → leerer Zustand.
  function clearView() {
    const view = document.getElementById('lokiDashView');
    if (!view) return;
    const iframe = view.querySelector('.loki-dash-frame');
    if (iframe) { try { iframe.src = 'about:blank'; } catch (_) {} }
    showViewMessage(view, 'Wähle links ein Dashboard aus.');
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  LADEN / REFRESH
  // ───────────────────────────────────────────────────────────────────────────
  // refresh(): Discovery neu, Liste neu rendern, ggf. aktuelles iframe neu laden.
  async function refresh() {
    const list = document.getElementById('lokiDashList');
    const sid = getSessionId();

    if (!sid) {
      loading = false;
      dashboards = [];
      if (list) {
        list.innerHTML = '<div class="loki-dash-list-empty">⚠️ Keine aktive Session. '
          + 'Öffne zuerst einen Workspace.</div>';
      }
      const view = document.getElementById('lokiDashView');
      if (view) showViewMessage(view,
        '⚠️ Keine aktive Session gefunden. Öffne zuerst einen Workspace, dann erneut versuchen.');
      return;
    }

    loading = true;
    renderList();

    let result;
    try {
      result = await discoverDashboards(sid);
    } catch (e) {
      loading = false;
      dashboards = [];
      const status = e && e.status;
      let msg;
      if (status === 404) msg = '⚠️ File-API nicht gefunden (404). Ist hermes-webui aktuell?';
      else if (status === 503) msg = '⚠️ Dienst nicht verfügbar (503). Später erneut versuchen.';
      else msg = '⚠️ Dashboards konnten nicht geladen werden: ' + (e && e.message ? e.message : e);
      if (list) list.innerHTML = '<div class="loki-dash-list-empty">' + esc(msg) + '</div>';
      toast(msg, 'error');
      return;
    }

    loading = false;
    dashboards = result;

    // Auswahl ggf. behalten, wenn das Dashboard noch existiert; sonst View leeren.
    const stillThere = selectedPath && dashboards.some((d) => d.htmlPath === selectedPath);
    renderList();

    if (stillThere) {
      // Aktuelles iframe frisch laden (Cache-Bust).
      openDashboard(selectedPath);
    } else {
      selectedPath = null;
      clearView();
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  NAV-EINTRÄGE (Rail + Sidebar)
  // ───────────────────────────────────────────────────────────────────────────
  // Eigenes Icon: Balkendiagramm/Grid.
  const RAIL_SVG =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="6"/><rect x="12" y="7" width="3" height="10"/><rect x="17" y="13" width="3" height="4"/></svg>';

  function buildNav() {
    // Rail (Desktop) — ganz oben einhängen (insertBefore firstRailBtn).
    const rail = document.querySelector('nav.rail');
    if (rail && !document.getElementById(RAIL_BTN_ID)) {
      const firstRailBtn = rail.querySelector('.rail-btn');
      const btn = document.createElement('button');
      btn.id = RAIL_BTN_ID;
      btn.type = 'button';
      btn.className = 'rail-btn nav-tab has-tooltip loki-dash-nav-btn';
      btn.setAttribute('data-panel', PANEL_NAME);
      btn.setAttribute('data-tooltip', 'Dashboards');
      btn.setAttribute('aria-label', 'Dashboards');
      btn.innerHTML = RAIL_SVG;
      btn.addEventListener('click', () => openPanel());
      if (firstRailBtn) rail.insertBefore(btn, firstRailBtn);
      else rail.appendChild(btn);
    }

    // Sidebar-Nav (Mobile/kompakt) — ebenfalls ganz oben.
    const sidebarNav = document.querySelector('.sidebar-nav');
    if (sidebarNav && !document.getElementById(SIDEBAR_BTN_ID)) {
      const firstNavTab = sidebarNav.querySelector('.nav-tab');
      const btn = document.createElement('button');
      btn.id = SIDEBAR_BTN_ID;
      btn.type = 'button';
      btn.className = 'nav-tab has-tooltip has-tooltip--bottom loki-dash-nav-btn';
      btn.setAttribute('data-panel', PANEL_NAME);
      btn.setAttribute('data-label', 'Dashboards');
      btn.setAttribute('data-tooltip', 'Dashboards');
      btn.innerHTML = RAIL_SVG;
      btn.addEventListener('click', () => openPanel());
      if (firstNavTab) sidebarNav.insertBefore(btn, firstNavTab);
      else sidebarNav.appendChild(btn);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  PANEL ÖFFNEN/SCHLIESSEN  (kooperiert mit dem Host-switchPanel)
  // ───────────────────────────────────────────────────────────────────────────
  function showPanel() {
    const panel = buildPanel();
    if (!panel) return;
    const main = document.querySelector('main.main');
    if (main) {
      Array.from(main.classList)
        .filter((c) => c.indexOf('showing-') === 0)
        .forEach((c) => main.classList.remove(c));
      main.classList.add('loki-dash-active');
    }
    panel.hidden = false;
    panelActive = true;
    document.querySelectorAll('[data-panel]').forEach((t) =>
      t.classList.toggle('active', t.dataset.panel === PANEL_NAME));
    // Beim Öffnen Discovery starten.
    refresh();
  }

  function hidePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.hidden = true;
    const main = document.querySelector('main.main');
    if (main) main.classList.remove('loki-dash-active');
    panelActive = false;
    // iframe leeren → kein Hintergrund-Laden.
    const view = document.getElementById('lokiDashView');
    if (view) {
      const iframe = view.querySelector('.loki-dash-frame');
      if (iframe) { try { iframe.src = 'about:blank'; } catch (_) {} }
    }
  }

  function openPanel() {
    if (typeof window.switchPanel === 'function') {
      window.switchPanel(PANEL_NAME, { fromRailClick: true });
    } else {
      showPanel();
    }
  }

  // window.switchPanel wrappen: für 'dashboards' unser Panel zeigen, sonst verstecken.
  function wrapSwitchPanel() {
    if (window.__lokiDashSwitchPanelWrapped) return;
    const orig = window.switchPanel;
    if (typeof orig !== 'function') return; // später erneut versuchen
    window.__lokiDashSwitchPanelWrapped = true;
    window.switchPanel = function (name, opts) {
      if (name === PANEL_NAME) {
        showPanel();
        return Promise.resolve(true);
      }
      if (panelActive) hidePanel();
      return orig.call(this, name, opts);
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  BOOTSTRAP  (Nav + switchPanel-Wrap, sobald DOM/Host bereit)
  // ───────────────────────────────────────────────────────────────────────────
  let observer = null;
  let tickScheduled = false;

  function navInstalled() {
    return !!(document.getElementById(RAIL_BTN_ID) || document.getElementById(SIDEBAR_BTN_ID));
  }
  function integrationComplete() {
    return navInstalled() && window.__lokiDashSwitchPanelWrapped === true;
  }

  function tick() {
    buildNav();
    wrapSwitchPanel();
    if (observer && integrationComplete()) {
      try { observer.disconnect(); } catch (_) {}
      observer = null;
    }
  }

  function scheduleTick() {
    if (tickScheduled) return;
    tickScheduled = true;
    const run = () => { tickScheduled = false; tick(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  observer = new MutationObserver(scheduleTick);
  observer.observe(document.body, { childList: true, subtree: true });
  tick();
})();

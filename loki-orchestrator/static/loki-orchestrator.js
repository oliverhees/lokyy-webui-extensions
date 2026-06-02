/*
 * Lokyy OS — Loki Orchestrator Extension für Hermes WebUI (nesquena/hermes-webui)
 * --------------------------------------------------------------------------
 * "Mira dirigiert das Team" — ein Orchestrierungs-Panel für Loki OS.
 *
 * Was es tut (V1):
 *   1. Eigener Nav-Eintrag "🐺 Loki Orchestrator" in der Rail + Sidebar-Nav.
 *   2. Mission-Eingabe: Textfeld + Orchestrator-Profil-Auswahl + "Mission starten"
 *      → POST /api/session/new → POST /api/chat/start. Der gewählte Agent zerlegt
 *      die Mission selbst (via Kanban-Toolset). Status/Reasoning live via SSE.
 *   3. Live-Team-Board: GET /api/kanban/board als Spalten
 *      (triage/todo/ready/running/blocked/done) mit Task-Karten (Titel + Worker-Badge).
 *      Live-Update via EventSource /api/kanban/events/stream (Fallback: Polling 5s).
 *   4. Dispatch-Button: POST /api/kanban/dispatch (spawnt bereitstehende Worker) + Toast.
 *   5. Robust gegen fehlende/abgeschaltete Endpoints (Kanban 404/503 → klare Meldung).
 *
 * ARCHITEKTUR (verifiziert gegen einen frischen Clone von nesquena/hermes-webui @ master):
 *   - Panel-Switching: Host nutzt switchPanel(name, opts) (static/panels.js:203). Bekannte
 *     Panels werden über main.main.showing-<name> CSS getoggelt (static/style.css:3092-3111,
 *     chat ist der Default ohne showing-*, :3102) und [data-panel] nav-tabs bekommen .active
 *     (panels.js:235). 'loki' ist dem Host UNBEKANNT → wir wrappen window.switchPanel, um
 *     unser Panel selbst zu zeigen/verstecken, und reasserten die nav-active-Klasse.
 *     Host-Liste der showing-*-Panels (panels.js:243-248) ist endlich, aber wir entfernen
 *     showing-* GENERISCH (s. showPanel) — robust gegen künftige Upstream-Panels.
 *   - Unser Panel ist KEIN .main-view. Nicht-aktive Host-Views werden per ID-Regel
 *     main.main > #mainXxx{display:none} versteckt (style.css:3092-3101); für ein
 *     unbekanntes 'loki' gäbe es keine solche Regel. Deshalb eigene Klasse
 *     .loki-orchestrator-panel + [hidden]-Toggle (CSS-Datei + Inline-Fallback) und
 *     main.main.loki-active > #mainChat{display:none} (loki-orchestrator.css:21), damit
 *     der Chat-Default nach dem showing-*-Strip nicht durchscheint.
 *   - API-Aufrufe via window.api() (static/workspace.js:1, credentials:'include', wirft
 *     Errors mit .status für 404/503-Branching), Fallback same-origin fetch. CSRF: ein
 *     globaler window.fetch-Wrapper in index.html (sameOriginUnsafe → setzt
 *     X-Hermes-CSRF-Token) injiziert den Token in JEDEN same-origin-unsafe fetch — damit
 *     sind BEIDE callApi-Pfade abgedeckt. Nur bei aktivierter Auth relevant.
 *   - apperror-Payload hat KEIN 'error'-Feld: streaming.py:747 _provider_error_payload
 *     liefert {message,type,hint}, gateway_chat.py {label,type,message,hint}. Wir lesen
 *     message/label/details (error nur als Altfall).
 *   - showToast-Signatur VERIFIZIERT: showToast(msg, ms, type) (static/ui.js:4130) — type
 *     ist der 3. Parameter, ms (2.) ist die Auto-Dismiss-Dauer. Alle drei Lokyy-Extensions
 *     (loki-orchestrator, agent-importer, mcp-manager) verwenden jetzt dieselbe 3-arg-Form.
 *
 * Rein additiv. Idempotent. Kein Core-Fork.
 */
(() => {
  'use strict';
  if (window.__lokiOrchestratorLoaded) return;
  window.__lokiOrchestratorLoaded = true;

  const PANEL_NAME = 'loki';                       // interner switchPanel-Name
  const PANEL_ID = 'lokiOrchestratorPanel';        // DOM-id unseres main-view-Geschwisters
  const PANEL_CLASS = 'loki-orchestrator-panel';   // KEIN host .main-view (siehe Header)
  const RAIL_BTN_ID = 'lokiRailBtn';
  const SIDEBAR_BTN_ID = 'lokiSidebarBtn';

  // Feste Board-Spalten (kanban_bridge.py:23 BOARD_COLUMNS — verifiziert).
  const COLUMNS = [
    { key: 'triage',  label: '📥 Triage'  },
    { key: 'todo',    label: '📋 To-Do'   },
    { key: 'ready',   label: '✅ Ready'    },
    { key: 'running', label: '⚙️ Running'  },
    { key: 'blocked', label: '⛔ Blocked'  },
    { key: 'done',    label: '🏁 Done'     },
  ];

  // ── API-Wrapper: bevorzugt Host-api() (credentials:'include', static/workspace.js:1), sonst fetch. ──
  // Wichtig: window.api() löst JSON bereits auf UND wirft bei !ok einen Error mit .status
  // (für 404/503-Branching in loadBoard/onDispatch genutzt); Fallback macht .json() + .status selbst.
  // CSRF wird NICHT hier gesetzt — der globale window.fetch-Wrapper (index.html, sameOriginUnsafe)
  // injiziert den X-Hermes-CSRF-Token in beide Pfade automatisch (nur bei aktivierter Auth nötig).
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

  // Verifizierte Host-Signatur: showToast(msg, ms, type) (static/ui.js:4130, gegen master
  // gegengeprüft). Wir übersetzen hier zentral type→ms+type, sodass die internen
  // toast(msg,'error'/'success'/'info')-Aufrufe unverändert bleiben können. So landet der
  // type-String NICHT im ms-Parameter (Auto-Dismiss-Timer + Einfärbung bleiben korrekt).
  // Identische 3-arg-Form in agent-importer.js und mcp-manager.js.
  function toast(msg, type) {
    const ms = type === 'error' ? 5000 : 3000;
    if (typeof window.showToast === 'function') window.showToast(msg, ms, type);
    else console.log('[loki-orchestrator]', type || 'info', msg);
  }

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── State ─────────────────────────────────────────────────────────────────
  let kanbanES = null;       // EventSource für Board-Live-Updates
  let pollTimer = null;      // Fallback-Poll-Timer
  let chatES = null;         // EventSource für Mira-Mission-Antwort
  let panelActive = false;

  // ───────────────────────────────────────────────────────────────────────────
  //  PANEL-DOM
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
      <div class="loki-head">
        <div class="loki-head-title">🐺 Loki Orchestrator <span class="loki-sub">— Mira dirigiert das Team</span></div>
        <div class="loki-head-actions">
          <button type="button" class="loki-btn-ghost" id="lokiRefreshBtn" title="Board neu laden">⟳ Board</button>
          <button type="button" class="loki-btn-primary" id="lokiDispatchBtn" title="Bereitstehende Worker spawnen">🚀 Dispatch</button>
        </div>
      </div>

      <div class="loki-mission">
        <div class="loki-mission-row">
          <select id="lokiProfileSelect" class="loki-select" title="Orchestrator-Profil (der Agent, der die Mission zerlegt)">
            <option value="">Profil lädt…</option>
          </select>
          <button type="button" class="loki-btn-primary loki-mission-go" id="lokiMissionGo">▶ Mission starten</button>
        </div>
        <textarea id="lokiMissionText" class="loki-mission-text" rows="3"
          placeholder="Mission für den Orchestrator… z.B. 'Plane ein Launch-Video: Recherche, Skript, Thumbnail. Lege die Teilaufgaben als Kanban-Tasks an und weise Worker zu.'"></textarea>
        <div id="lokiMissionStatus" class="loki-mission-status" hidden></div>
        <div id="lokiMissionStream" class="loki-mission-stream" hidden></div>
      </div>

      <div class="loki-board-wrap">
        <div id="lokiBoard" class="loki-board">
          <div class="loki-board-loading">Board lädt…</div>
        </div>
      </div>`;

    main.appendChild(panel);

    panel.querySelector('#lokiRefreshBtn').addEventListener('click', () => loadBoard());
    panel.querySelector('#lokiDispatchBtn').addEventListener('click', onDispatch);
    panel.querySelector('#lokiMissionGo').addEventListener('click', onMissionStart);

    return panel;
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  NAV-EINTRÄGE (Rail + Sidebar)
  // ───────────────────────────────────────────────────────────────────────────
  const RAIL_SVG =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-8 9 8"/><path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5"/><path d="M9 21v-6h6v6"/></svg>';

  function buildNav() {
    // Rail (Desktop)
    const rail = document.querySelector('nav.rail');
    if (rail && !document.getElementById(RAIL_BTN_ID)) {
      const settingsBtn = rail.querySelector('.rail-btn[data-panel="settings"]');
      const btn = document.createElement('button');
      btn.id = RAIL_BTN_ID;
      btn.type = 'button';
      btn.className = 'rail-btn nav-tab has-tooltip loki-nav-btn';
      btn.setAttribute('data-panel', PANEL_NAME);
      btn.setAttribute('data-tooltip', 'Loki Orchestrator');
      btn.setAttribute('aria-label', 'Loki Orchestrator');
      btn.innerHTML = RAIL_SVG;
      btn.addEventListener('click', () => openPanel());
      // Vor Settings einhängen (passt thematisch ans Ende der Funktions-Tabs).
      if (settingsBtn) rail.insertBefore(btn, settingsBtn);
      else rail.appendChild(btn);
    }

    // Sidebar-Nav (Mobile/kompakt)
    const sidebarNav = document.querySelector('.sidebar-nav');
    if (sidebarNav && !document.getElementById(SIDEBAR_BTN_ID)) {
      const settingsBtn = sidebarNav.querySelector('.nav-tab[data-panel="settings"]');
      const btn = document.createElement('button');
      btn.id = SIDEBAR_BTN_ID;
      btn.type = 'button';
      btn.className = 'nav-tab has-tooltip has-tooltip--bottom loki-nav-btn';
      btn.setAttribute('data-panel', PANEL_NAME);
      btn.setAttribute('data-label', 'Loki');
      btn.setAttribute('data-tooltip', 'Loki Orchestrator');
      btn.innerHTML = RAIL_SVG;
      btn.addEventListener('click', () => openPanel());
      if (settingsBtn) sidebarNav.insertBefore(btn, settingsBtn);
      else sidebarNav.appendChild(btn);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  PANEL ÖFFNEN/SCHLIESSEN  (kooperiert mit dem Host-switchPanel)
  // ───────────────────────────────────────────────────────────────────────────
  function showPanel() {
    const panel = buildPanel();
    if (!panel) return;
    // Host main.main showing-* Klassen entfernen → versteckt alle Host-Views.
    // Generisch über das aktuelle classList (NICHT über eine feste Liste): so werden
    // auch künftige Host-Panels mit neuer showing-X-Klasse zuverlässig versteckt und
    // scheinen nicht hinter dem Loki-Panel durch. Der Host toggelt diese Klassen in
    // switchPanel (panels.js:243-248) — wir spiegeln nur die "alle aus"-Operation.
    const main = document.querySelector('main.main');
    if (main) {
      Array.from(main.classList)
        .filter((c) => c.indexOf('showing-') === 0)
        .forEach((c) => main.classList.remove(c));
      // chat ist der CSS-Default ohne showing-* → wir verstecken #mainChat via .loki-active (CSS).
      main.classList.add('loki-active');
    }
    panel.hidden = false;
    panelActive = true;
    // nav-active re-asserten (Host kennt 'loki' nicht, setzt es nicht aktiv).
    document.querySelectorAll('[data-panel]').forEach((t) =>
      t.classList.toggle('active', t.dataset.panel === PANEL_NAME));
    startBoardLive();
    loadProfiles();
    loadBoard();
  }

  function hidePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.hidden = true;
    const main = document.querySelector('main.main');
    if (main) main.classList.remove('loki-active');
    panelActive = false;
    stopBoardLive();
    // Mission-Live-Stream (chat/stream SSE) ebenfalls schließen — sonst bleibt die
    // Verbindung beim Wegnavigieren vor stream_end offen (Ressourcen-Leak),
    // analog zum kanbanES-Cleanup in stopBoardLive().
    if (chatES) { try { chatES.close(); } catch (_) {} chatES = null; }
  }

  function openPanel() {
    // Geht über den Host-Switch, damit dessen Cleanup (z.B. Kanban-SSE schließen,
    // Settings-Guard) korrekt läuft. Unser Wrapper zeigt danach unser Panel.
    if (typeof window.switchPanel === 'function') {
      window.switchPanel(PANEL_NAME, { fromRailClick: true });
    } else {
      showPanel();
    }
  }

  // window.switchPanel wrappen: für 'loki' unser Panel zeigen, sonst verstecken.
  function wrapSwitchPanel() {
    if (window.__lokiSwitchPanelWrapped) return;
    const orig = window.switchPanel;
    if (typeof orig !== 'function') return; // später erneut versuchen
    window.__lokiSwitchPanelWrapped = true;
    window.switchPanel = function (name, opts) {
      if (name === PANEL_NAME) {
        // Host kennt 'loki' nicht — nicht durchreichen (würde nur Klassen toggeln).
        // Aber Host-Cleanup für den vorherigen Panel-Wechsel ist hier nicht nötig,
        // da unser showPanel() die showing-* Klassen ohnehin entfernt.
        showPanel();
        return Promise.resolve(true);
      }
      // Wechsel WEG von loki → unser Panel ausblenden, dann Host normal arbeiten lassen.
      if (panelActive) hidePanel();
      return orig.call(this, name, opts);
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  PROFILE (Orchestrator-Auswahl)
  // ───────────────────────────────────────────────────────────────────────────
  function loadProfiles() {
    const sel = document.getElementById('lokiProfileSelect');
    if (!sel) return;
    callApi('/api/profiles')
      .then((r) => {
        const profiles = (r && r.profiles) || [];
        const active = r && r.active;
        if (!profiles.length) {
          sel.innerHTML = '<option value="">default</option>';
          return;
        }
        sel.innerHTML = profiles.map((p) => {
          const name = p.name;
          const isActive = name === active;
          const badge = p.gateway_running ? ' ●' : '';
          return `<option value="${esc(name)}"${isActive ? ' selected' : ''}>${esc(name)}${badge}</option>`;
        }).join('');
      })
      .catch(() => {
        // Fallback: Assignees (bereits genutzte Worker-Namen), kein harter Fehler.
        callApi('/api/kanban/assignees')
          .then((r) => {
            const names = (r && r.assignees) || [];
            sel.innerHTML = (['default'].concat(names))
              .map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
          })
          .catch(() => { sel.innerHTML = '<option value="">default</option>'; });
      });
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  MISSION STARTEN  (session/new → chat/start → chat/stream SSE)
  // ───────────────────────────────────────────────────────────────────────────
  function setMissionStatus(msg, kind) {
    const el = document.getElementById('lokiMissionStatus');
    if (!el) return;
    el.hidden = false;
    el.className = 'loki-mission-status loki-status-' + (kind || 'info');
    el.textContent = msg;
  }

  function appendStream(text) {
    const el = document.getElementById('lokiMissionStream');
    if (!el) return;
    el.hidden = false;
    el.textContent += text;
    el.scrollTop = el.scrollHeight;
  }

  async function onMissionStart() {
    const textEl = document.getElementById('lokiMissionText');
    const profEl = document.getElementById('lokiProfileSelect');
    const goBtn = document.getElementById('lokiMissionGo');
    const message = (textEl && textEl.value || '').trim();
    if (!message) { toast('Mission-Text fehlt', 'error'); return; }
    const profile = (profEl && profEl.value || '').trim();

    goBtn.disabled = true;
    goBtn.textContent = '… startet';
    const streamEl = document.getElementById('lokiMissionStream');
    if (streamEl) { streamEl.textContent = ''; streamEl.hidden = true; }
    setMissionStatus('Session wird angelegt…', 'info');

    try {
      // 1) Session anlegen (Voraussetzung für chat/start).
      const sessPayload = {};
      if (profile && profile !== 'default') sessPayload.profile = profile;
      const sess = await callApi('/api/session/new', {
        method: 'POST',
        body: JSON.stringify(sessPayload),
      });
      const sessionId = sess && sess.session && sess.session.session_id;
      if (!sessionId) throw new Error('keine session_id erhalten');

      // 2) Mission an den Orchestrator-Agent.
      setMissionStatus('Mission an Orchestrator…', 'info');
      const startPayload = { session_id: sessionId, message };
      if (profile && profile !== 'default') startPayload.profile = profile;
      const started = await callApi('/api/chat/start', {
        method: 'POST',
        body: JSON.stringify(startPayload),
      });
      if (started && started.error) {
        throw new Error(started.error + (started.active_stream_id ? ' (aktiver Stream läuft bereits)' : ''));
      }
      const streamId = started && started.stream_id;
      if (!streamId) throw new Error('keine stream_id erhalten');

      setMissionStatus('Mira arbeitet — Live-Antwort:', 'ok');
      attachChatStream(streamId);
      toast('Mission gestartet', 'success');
    } catch (e) {
      setMissionStatus('Mission fehlgeschlagen: ' + (e && e.message ? e.message : e), 'err');
      toast('Mission fehlgeschlagen', 'error');
    } finally {
      goBtn.disabled = false;
      goBtn.textContent = '▶ Mission starten';
    }
  }

  function attachChatStream(streamId) {
    // Alten Chat-Stream schließen.
    if (chatES) { try { chatES.close(); } catch (_) {} chatES = null; }
    const url = '/api/chat/stream?stream_id=' + encodeURIComponent(streamId);
    let es;
    try { es = new EventSource(url, { withCredentials: true }); }
    catch (_) { setMissionStatus('Live-Stream nicht verfügbar (Antwort läuft serverseitig).', 'info'); return; }
    chatES = es;

    // Text-Deltas + Reasoning live anzeigen.
    es.addEventListener('token', (ev) => {
      try { const d = JSON.parse(ev.data); if (d && d.text) appendStream(d.text); } catch (_) {}
    });
    es.addEventListener('reasoning', (ev) => {
      try { const d = JSON.parse(ev.data); if (d && d.text) appendStream(d.text); } catch (_) {}
    });
    es.addEventListener('tool', (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d && d.name) appendStream('\n[tool: ' + d.name + ']\n');
      } catch (_) {}
    });
    es.addEventListener('apperror', (ev) => {
      try {
        // Echte Payload-Formen: streaming.py _provider_error_payload {message,type,hint,details}
        // bzw. Gateway-Pfad gateway_chat.py {label,type,message,hint}. Es gibt KEIN 'error'-Feld
        // — deshalb message/label/details lesen (d.error nur als Altfall-Fallback).
        const d = JSON.parse(ev.data);
        const m = d && (d.message || d.label || d.details || d.error);
        setMissionStatus('Agent-Fehler: ' + (m || 'unbekannt'), 'err');
      } catch (_) {}
    });
    es.addEventListener('stream_end', () => {
      setMissionStatus('Mission abgeschlossen. Board zeigt die erzeugten Tasks.', 'ok');
      try { es.close(); } catch (_) {}
      chatES = null;
      loadBoard();
    });
    es.onerror = () => {
      // SSE bricht auch bei normalem Streamende ab — nicht als harten Fehler werten.
      // Board trotzdem aktualisieren.
      loadBoard();
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  DISPATCH  (Worker spawnen)
  // ───────────────────────────────────────────────────────────────────────────
  function onDispatch() {
    const btn = document.getElementById('lokiDispatchBtn');
    if (btn) { btn.disabled = true; btn.textContent = '… dispatch'; }
    // Body wird ignoriert; Parameter NUR als Query (kanban_bridge.py:646-660).
    callApi('/api/kanban/dispatch?max=8', { method: 'POST' })
      .then((r) => {
        // Feld-AGNOSTISCH: das Antwort-Shape von kb.dispatch_once ist library-seitig
        // (hermes_cli) und NICHT verlässlich verifizierbar — die Logik hängt von KEINEM
        // Antwortfeld ab. Verlässliche Rückmeldung sind die echten 'running'-Tasks im
        // Board, das wir gleich neu laden. Falls die Antwort DOCH ein plausibles
        // Zähler-Feld liefert, erwähnen wir es rein OPPORTUNISTISCH im Toast.
        const n = (r && typeof r === 'object' && typeof r.spawned === 'number') ? r.spawned : null;
        toast('Dispatch ausgelöst' + (n != null ? ' — ' + n + ' Worker gespawnt' : ''), 'success');
        loadBoard();
      })
      .catch((e) => {
        const s = e && e.status;
        if (s === 404 || s === 503) toast('Kanban/Dispatch nicht verfügbar', 'error');
        else toast('Dispatch fehlgeschlagen', 'error');
      })
      .finally(() => { if (btn) { btn.disabled = false; btn.textContent = '🚀 Dispatch'; } });
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  BOARD RENDERN
  // ───────────────────────────────────────────────────────────────────────────
  function renderBoardError(msg) {
    const board = document.getElementById('lokiBoard');
    if (!board) return;
    board.classList.add('loki-board-haserror');
    board.innerHTML = `<div class="loki-board-error">
      <div class="loki-board-error-title">⚠️ Board nicht verfügbar</div>
      <div class="loki-board-error-sub">${esc(msg)}</div>
      <div class="loki-board-error-hint">Stelle sicher, dass dieses Hermes mit aktivem Kanban-Bridge läuft
        (Endpoint <code>/api/kanban/board</code>). Voraussetzung: ein Orchestrator-Profil mit Kanban-Toolset.</div>
    </div>`;
  }

  function taskCard(task) {
    const title = esc(task.title || '(ohne Titel)');
    const worker = task.assignee ? `<span class="loki-worker">👤 ${esc(task.assignee)}</span>` : `<span class="loki-worker loki-worker-none">nicht zugewiesen</span>`;
    const prio = (task.priority != null && task.priority !== 0) ? `<span class="loki-prio">P${esc(task.priority)}</span>` : '';
    const meta = [];
    if (task.comment_count) meta.push('💬 ' + esc(task.comment_count));
    if (task.link_counts && (task.link_counts.parents || task.link_counts.children)) {
      meta.push('🔗 ' + esc((task.link_counts.parents || 0) + (task.link_counts.children || 0)));
    }
    const metaHtml = meta.length ? `<div class="loki-card-meta">${meta.join(' · ')}</div>` : '';
    return `<div class="loki-card" data-task-id="${esc(task.id)}">
      <div class="loki-card-title">${title}${prio}</div>
      <div class="loki-card-foot">${worker}</div>
      ${metaHtml}
    </div>`;
  }

  function renderBoard(data) {
    const board = document.getElementById('lokiBoard');
    if (!board) return;
    board.classList.remove('loki-board-haserror');

    // Spalten aus der Antwort indizieren (Reihenfolge fix via COLUMNS).
    const colMap = {};
    ((data && data.columns) || []).forEach((c) => { colMap[c.name] = c.tasks || []; });

    board.innerHTML = COLUMNS.map((col) => {
      const tasks = colMap[col.key] || [];
      const cards = tasks.length
        ? tasks.map(taskCard).join('')
        : '<div class="loki-col-empty">—</div>';
      return `<div class="loki-col" data-col="${esc(col.key)}">
        <div class="loki-col-head">${col.label}<span class="loki-col-count">${tasks.length}</span></div>
        <div class="loki-col-body">${cards}</div>
      </div>`;
    }).join('');
  }

  function loadBoard() {
    if (!panelActive) return;
    callApi('/api/kanban/board')
      .then((data) => {
        if (!data || !Array.isArray(data.columns)) {
          renderBoardError('Unerwartete Antwort vom Board-Endpoint.');
          return;
        }
        renderBoard(data);
      })
      .catch((e) => {
        const s = e && e.status;
        if (s === 404 || s === 503) renderBoardError('Kanban-Bridge ist auf diesem Hermes nicht aktiv (HTTP ' + s + ').');
        else renderBoardError('Konnte das Board nicht laden (' + (e && e.message ? e.message : 'Netzwerk/Session') + ').');
      });
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  LIVE-UPDATES  (EventSource /api/kanban/events/stream, Fallback Polling 5s)
  // ───────────────────────────────────────────────────────────────────────────
  function startBoardLive() {
    stopBoardLive();
    if (typeof EventSource === 'function') {
      try {
        kanbanES = new EventSource('/api/kanban/events/stream', { withCredentials: true });
        // Jedes events-Frame signalisiert Board-Änderung → neu laden (debounced).
        kanbanES.addEventListener('events', () => scheduleBoardReload());
        kanbanES.addEventListener('hello', () => { /* Verbindung offen */ });
        kanbanES.onerror = () => {
          // Stream tot/abgewiesen → auf Polling zurückfallen.
          if (kanbanES) { try { kanbanES.close(); } catch (_) {} kanbanES = null; }
          startPolling();
        };
        return;
      } catch (_) { /* fällt unten auf Polling zurück */ }
    }
    startPolling();
  }

  let reloadPending = null;
  function scheduleBoardReload() {
    if (reloadPending) return;
    reloadPending = setTimeout(() => { reloadPending = null; loadBoard(); }, 250);
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => { if (panelActive) loadBoard(); }, 5000);
  }

  function stopBoardLive() {
    if (kanbanES) { try { kanbanES.close(); } catch (_) {} kanbanES = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (reloadPending) { clearTimeout(reloadPending); reloadPending = null; }
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  BOOTSTRAP  (Nav + switchPanel-Wrap, sobald DOM/Host bereit)
  // ───────────────────────────────────────────────────────────────────────────
  // tick() läuft idempotent, aber wir wollen NICHT bei jeder DOM-Mutation über die
  // gesamte Seitenlebensdauer feuern. Deshalb: per requestAnimationFrame debouncen
  // und den Observer disconnecten, sobald beide Integrationspunkte einmal sitzen
  // (mind. ein Nav-Button injiziert UND switchPanel gewrappt). Bis dahin reagiert er
  // auf das verzögerte Erscheinen von rail/sidebar-nav bzw. window.switchPanel.
  let observer = null;
  let tickScheduled = false;

  function navInstalled() {
    return !!(document.getElementById(RAIL_BTN_ID) || document.getElementById(SIDEBAR_BTN_ID));
  }
  function integrationComplete() {
    return navInstalled() && window.__lokiSwitchPanelWrapped === true;
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

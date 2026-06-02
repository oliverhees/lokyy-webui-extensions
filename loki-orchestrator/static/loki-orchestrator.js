/*
 * Lokyy OS — Loki Orchestrator Extension für Hermes WebUI (nesquena/hermes-webui)
 * --------------------------------------------------------------------------
 * "Agentur am Tisch" — ein Team-Chat-Panel für Loki OS.
 *
 * Was es tut (V3 — Mission als Kanban-Triage-Task statt Solo-Chat):
 *   1. Eigener Nav-Eintrag "🐺 Loki Orchestrator" in der Rail + Sidebar-Nav.
 *   2. Mission-Eingabe: Textfeld + Orchestrator-Profil-Auswahl + "Mission starten"
 *      → POST /api/kanban/tasks { title, body, triage:true }. Die Mission landet als
 *      TRIAGE-TASK auf dem Board. Der Gateway zerlegt sie via auto_decompose (Mira =
 *      global gesetztes orchestrator_profile) und verteilt Subtasks an die Worker —
 *      das ist der bewiesene Delegations-Weg (kein Solo-Chat mit Mira mehr).
 *   3. CHAT-VERLAUF statt Board: Mira + Worker erscheinen als Bubbles mit
 *      Avatar(emoji)/Name/Farbe, chronologisch. Olivers Mission als eigene
 *      User-Bubble, Worker-Statuswechsel (running/done/blocked) als Worker-Bubbles.
 *      Artefakte (Bilder) inline.
 *   4. Der Team-Verlauf wird aus dem Kanban-Board abgeleitet: GET /api/kanban/board
 *      wird gegen einen gemerkten Task-State gediffed (seenTasks) → jede Änderung
 *      wird zu einer Chat-Bubble. Live via EventSource /api/kanban/events/stream
 *      (Fallback: Polling 5s). So erscheinen auch die per auto_decompose entstehenden
 *      Subtasks als Worker-Bubbles.
 *   5. Dispatch-Button "Team loslegen": POST /api/kanban/dispatch + Sync.
 *   6. Robust gegen fehlende/abgeschaltete Endpoints (Kanban 404/503 → klare Meldung).
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
 *   - Mission-Endpoint VERIFIZIERT (api/kanban_bridge.py): POST /api/kanban/tasks
 *     (:1164); Payload _create_task_payload (:306) { title<REQUIRED>, body, triage:true };
 *     Antwort { task:{ id, title, status, ... } } (status wird 'triage').
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

  // ── Team-Mapping: Worker-Key → Avatar(emoji) + Anzeige-Label ────────────────
  // Bekannte Loki-Worker mit fester Persönlichkeit. Unbekannte fallen auf
  // {emoji:'🤖', label: Name mit großem Anfangsbuchstaben} zurück (siehe worker()).
  const WORKERS = {
    mira:   { emoji: '🧭', label: 'Mira'   },
    tanja:  { emoji: '📱', label: 'Tanja'  },
    peter:  { emoji: '🔍', label: 'Peter'  },
    lars:   { emoji: '✍️', label: 'Lars'   },
    sophia: { emoji: '📊', label: 'Sophia' },
    nina:   { emoji: '🎨', label: 'Nina'   },
    tom:    { emoji: '🎬', label: 'Tom'    },
    jonas:  { emoji: '🤝', label: 'Jonas'  },
    max:    { emoji: '🛠️', label: 'Max'    },
    default:{ emoji: '🤖', label: 'Assistent' },
  };

  // Worker-Lookup mit Fallback. Unbekannte Keys → 🤖 + kapitalisierter Name.
  function worker(key) {
    const k = String(key == null ? '' : key).trim().toLowerCase();
    if (k && WORKERS[k]) return WORKERS[k];
    if (k) return { emoji: '🤖', label: k.charAt(0).toUpperCase() + k.slice(1) };
    return WORKERS.default;
  }

  // ── API-Wrapper: bevorzugt Host-api() (credentials:'include', static/workspace.js:1), sonst fetch. ──
  // Wichtig: window.api() löst JSON bereits auf UND wirft bei !ok einen Error mit .status
  // (für 404/503-Branching in syncTeamFromBoard/onDispatch/onMissionStart genutzt); Fallback macht .json() + .status selbst.
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

  // ── Mini-Markdown → sicheres HTML ───────────────────────────────────────────
  // Reihenfolge: ZUERST esc() (XSS-Schutz), DANN auf dem escapeten String die
  // wenigen Markdown-Muster ersetzen. URLs werden nur akzeptiert, wenn sie
  // http(s) oder relativ (/, ./, ../, ohne Schema) sind — kein javascript:/data:.
  function safeUrl(u) {
    const s = String(u == null ? '' : u).trim();
    if (/^https?:\/\//i.test(s)) return s;          // absolute http(s)
    if (/^(\/|\.\/|\.\.\/)/.test(s)) return s;       // relativ
    if (/^[^:]+$/.test(s)) return s;                 // schemalos (z.B. "img/x.png")
    return '#';                                       // alles mit Schema (javascript:, data:) → blockieren
  }

  function renderMd(text) {
    let h = esc(text);
    // Bilder ZUERST (sonst greift der Link-Regex in das ![..](..)-Muster).
    // ![alt](url) → <img>
    h = h.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) =>
      '<img class="loki-bubble-img" src="' + esc(safeUrl(url)) + '" alt="' + esc(alt) + '">');
    // [text](url) → <a target="_blank">
    h = h.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, url) =>
      '<a href="' + esc(safeUrl(url)) + '" target="_blank" rel="noopener noreferrer">' + esc(t) + '</a>');
    // **bold**
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // *italic*
    h = h.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    // Zeilenumbrüche → <br>
    h = h.replace(/\n/g, '<br>');
    return h;
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let kanbanES = null;       // EventSource für Team-Live-Updates (Board-Diff)
  let pollTimer = null;      // Fallback-Poll-Timer
  let panelActive = false;

  // Team-Chat-State.
  const seenTasks = new Map(); // task-id → { status, assignee }  (für Board-Diff)
  let teamSynced = false;    // false = erster Sync nur befüllen, keine Bubbles (keine Altlast-Flut)

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
        <div class="loki-head-title">🐺 Loki Orchestrator <span class="loki-sub">— Die Agentur am Tisch</span></div>
        <div class="loki-head-actions">
          <button type="button" class="loki-btn-ghost" id="lokiRefreshBtn" title="Team-Verlauf neu abgleichen">⟳ Sync</button>
          <button type="button" class="loki-btn-primary" id="lokiDispatchBtn" title="Bereitstehende Worker spawnen">🚀 Team loslegen</button>
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
          placeholder="Mission für dein Team… z.B. 'Plane ein Launch-Video: Recherche, Skript, Thumbnail. Lege die Teilaufgaben als Kanban-Tasks an und weise Worker zu.'"></textarea>
      </div>

      <div id="lokiChat" class="loki-chat">
        <div class="loki-chat-empty">Gib deinem Team oben eine Mission — Mira verteilt sie ans Team.</div>
      </div>`;

    main.appendChild(panel);

    panel.querySelector('#lokiRefreshBtn').addEventListener('click', () => syncTeamFromBoard());
    panel.querySelector('#lokiDispatchBtn').addEventListener('click', onDispatch);
    panel.querySelector('#lokiMissionGo').addEventListener('click', onMissionStart);

    return panel;
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  CHAT-BUBBLES
  // ───────────────────────────────────────────────────────────────────────────
  // appendBubble(speakerKey, html, kind):
  //   - erzeugt <div class="loki-bubble loki-bubble-<kind>"> mit Avatar(emoji)+Name-Header + Body(html)
  //   - hängt an #lokiChat an, scrollt ans Ende, gibt das Body-Element zurück.
  //   - kind ∈ {'user','mira','worker','system'}.
  //   - 'user' (Olivers Mission): KEIN Worker-Avatar-Lookup, Label "Du".
  function appendBubble(speakerKey, html, kind) {
    const chat = document.getElementById('lokiChat');
    if (!chat) return null;
    // Leerzustand entfernen, sobald die erste echte Bubble kommt.
    const empty = chat.querySelector('.loki-chat-empty');
    if (empty) empty.remove();

    const k = kind || 'worker';
    let emoji, label;
    if (k === 'user') {
      emoji = '🧑'; label = 'Du';
    } else if (k === 'system') {
      emoji = 'ℹ️'; label = 'System';
    } else {
      const w = worker(k === 'mira' ? 'mira' : speakerKey);
      emoji = w.emoji; label = w.label;
    }

    const bubble = document.createElement('div');
    bubble.className = 'loki-bubble loki-bubble-' + k;

    // System-Bubbles sind zentriert, kompakt, ohne Avatar.
    if (k === 'system') {
      bubble.innerHTML = '<div class="loki-bubble-body">' + html + '</div>';
    } else {
      bubble.innerHTML =
        '<div class="loki-avatar">' + esc(emoji) + '</div>' +
        '<div class="loki-bubble-card">' +
          '<div class="loki-bubble-head">' + esc(label) + '</div>' +
          '<div class="loki-bubble-body">' + html + '</div>' +
        '</div>';
    }

    chat.appendChild(bubble);
    chat.scrollTop = chat.scrollHeight;
    return bubble.querySelector('.loki-bubble-body');
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
      const firstRailBtn = rail.querySelector('.rail-btn');
      const btn = document.createElement('button');
      btn.id = RAIL_BTN_ID;
      btn.type = 'button';
      btn.className = 'rail-btn nav-tab has-tooltip loki-nav-btn';
      btn.setAttribute('data-panel', PANEL_NAME);
      btn.setAttribute('data-tooltip', 'Loki Orchestrator');
      btn.setAttribute('aria-label', 'Loki Orchestrator');
      btn.innerHTML = RAIL_SVG;
      btn.addEventListener('click', () => openPanel());
      // Oben in der Rail einhängen (bei den Haupt-Tabs, ganz oben — nicht unten bei Settings).
      if (firstRailBtn) rail.insertBefore(btn, firstRailBtn);
      else rail.appendChild(btn);
    }

    // Sidebar-Nav (Mobile/kompakt)
    const sidebarNav = document.querySelector('.sidebar-nav');
    if (sidebarNav && !document.getElementById(SIDEBAR_BTN_ID)) {
      const firstNavTab = sidebarNav.querySelector('.nav-tab');
      const btn = document.createElement('button');
      btn.id = SIDEBAR_BTN_ID;
      btn.type = 'button';
      btn.className = 'nav-tab has-tooltip has-tooltip--bottom loki-nav-btn';
      btn.setAttribute('data-panel', PANEL_NAME);
      btn.setAttribute('data-label', 'Loki');
      btn.setAttribute('data-tooltip', 'Loki Orchestrator');
      btn.innerHTML = RAIL_SVG;
      btn.addEventListener('click', () => openPanel());
      // Oben einhängen, konsistent mit der Rail.
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
    initTeamChat();
  }

  function hidePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.hidden = true;
    const main = document.querySelector('main.main');
    if (main) main.classList.remove('loki-active');
    panelActive = false;
    stopTeamLive();
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
        // Orchestrator-Default: 'mira' bevorzugen, falls vorhanden.
        const hasMira = profiles.some((p) => String(p.name).toLowerCase() === 'mira');
        if (hasMira) {
          const opt = Array.from(sel.options).find((o) => o.value.toLowerCase() === 'mira');
          if (opt) sel.value = opt.value;
        }
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
  //  MISSION STARTEN  (Mission als Kanban-TRIAGE-TASK → auto_decompose verteilt ans Team)
  // ───────────────────────────────────────────────────────────────────────────
  // Statt einen Solo-Chat mit Mira zu starten, legen wir die Mission als TRIAGE-Task an:
  //   POST /api/kanban/tasks { title, body, triage:true }  (api/kanban_bridge.py:1164/:306).
  // Der Gateway zerlegt sie via auto_decompose (Mira = global gesetztes orchestrator_profile)
  // und verteilt Subtasks an die Worker — das ist der bewiesene Delegations-Weg. Die
  // entstehenden Subtasks erscheinen über syncTeamFromBoard() als Worker-Bubbles.
  async function onMissionStart() {
    const textEl = document.getElementById('lokiMissionText');
    const goBtn = document.getElementById('lokiMissionGo');
    const mission = (textEl && textEl.value || '').trim();
    if (!mission) { toast('Mission-Text fehlt', 'error'); return; }

    // Kurztitel ableiten: erste Zeile bzw. die ersten ~10 Wörter, hart auf 80 Zeichen
    // gekürzt (für das title-Feld). Die VOLLE Mission geht ins body-Feld.
    const firstLine = mission.split('\n')[0].trim();
    let title = (firstLine || mission).split(/\s+/).slice(0, 10).join(' ');
    if (title.length > 80) title = title.slice(0, 80).trim();
    if (!title) title = mission.slice(0, 80).trim();

    // (a) Mission als USER-Bubble (Olivers Auftrag an das Team).
    appendBubble(null, renderMd(mission), 'user');

    goBtn.disabled = true;
    goBtn.textContent = '… sende';

    try {
      const res = await callApi('/api/kanban/tasks', {
        method: 'POST',
        body: JSON.stringify({ title, body: mission, triage: true }),
      });
      const task = res && res.task;
      if (!task || !task.id) {
        throw new Error('keine Task-ID erhalten');
      }
      // Erfolg: Mira nimmt die Mission auf und zerlegt sie via auto_decompose.
      appendBubble('mira',
        '🧭 Mira nimmt die Mission auf und verteilt sie ans Team … (kann einen Moment dauern)',
        'system');
      // Mission-Textarea leeren — der Auftrag steht jetzt im Verlauf.
      if (textEl) textEl.value = '';
      // Live-Sync sicherstellen + sofort abgleichen → die entstehenden Subtasks
      // erscheinen als Worker-Bubbles.
      startTeamLive();
      syncTeamFromBoard();
    } catch (e) {
      const s = e && e.status;
      if (s === 404 || s === 503) {
        appendBubble(null, 'Kanban ist auf diesem Hermes nicht aktiv.', 'system');
      } else {
        const m = e && e.message ? e.message : e;
        appendBubble(null, 'Konnte die Mission nicht anlegen: ' + esc(m), 'system');
      }
      toast('Mission konnte nicht angelegt werden', 'error');
    } finally {
      goBtn.disabled = false;
      goBtn.textContent = '▶ Mission starten';
    }
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
        // Board, das wir gleich neu abgleichen. Falls die Antwort DOCH ein plausibles
        // Zähler-Feld liefert, erwähnen wir es rein OPPORTUNISTISCH im Toast.
        const n = (r && typeof r === 'object' && typeof r.spawned === 'number') ? r.spawned : null;
        toast('Dispatch ausgelöst' + (n != null ? ' — ' + n + ' Worker gespawnt' : ''), 'success');
        syncTeamFromBoard();
      })
      .catch((e) => {
        const s = e && e.status;
        if (s === 404 || s === 503) toast('Kanban/Dispatch nicht verfügbar', 'error');
        else toast('Dispatch fehlgeschlagen', 'error');
      })
      .finally(() => { if (btn) { btn.disabled = false; btn.textContent = '🚀 Team loslegen'; } });
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  TEAM-VERLAUF AUS BOARD ABLEITEN  (Board-Diff → Chat-Bubbles)
  // ───────────────────────────────────────────────────────────────────────────
  // syncTeamFromBoard():
  //   - lädt /api/kanban/board, sammelt alle Tasks flach (status = column.name),
  //   - diffed gegen seenTasks (Map id → {status, assignee}),
  //   - erzeugt pro ÄNDERUNG eine Bubble (siehe Übergangsregeln unten),
  //   - aktualisiert seenTasks danach.
  //   Erster Aufruf nach Panel-Öffnen (teamSynced=false): NUR befüllen, keine Bubbles.
  function syncTeamFromBoard() {
    if (!panelActive) return;
    callApi('/api/kanban/board')
      .then((data) => {
        if (!data || !Array.isArray(data.columns)) {
          // Unerwartete Antwort — beim allerersten Sync stumm, sonst dezenter Hinweis.
          if (teamSynced) appendBubble(null, 'Unerwartete Antwort vom Board-Endpoint.', 'system');
          return;
        }

        // Alle Tasks flach sammeln; status = Spaltenname.
        const flat = [];
        data.columns.forEach((col) => {
          const status = col && col.name;
          (col && col.tasks || []).forEach((t) => {
            flat.push({
              id: t.id,
              title: t.title || '(ohne Titel)',
              status: status,
              assignee: t.assignee || '',
            });
          });
        });

        // Erster Sync: nur State befüllen, KEINE Bubbles (keine Altlast-Flut).
        if (!teamSynced) {
          flat.forEach((t) => seenTasks.set(t.id, { status: t.status, assignee: t.assignee }));
          teamSynced = true;
          return;
        }

        // Diffen: für jede Änderung eine passende Bubble.
        flat.forEach((t) => {
          const prev = seenTasks.get(t.id);
          const wLabel = t.assignee ? worker(t.assignee).label : '';

          if (!prev) {
            // NEU. Mit Assignee → Mira verteilt sichtbar an den Worker.
            if (t.assignee) {
              appendBubble('mira',
                renderMd('🧭 Mira → ' + wLabel + ': „' + t.title + '"'), 'mira');
            }
          } else {
            // Statuswechsel?
            if (prev.status !== t.status) {
              if (t.status === 'running') {
                appendBubble(t.assignee || 'default',
                  renderMd((wLabel ? wLabel + ': ' : '') + 'Ich übernehme „' + t.title + '"…'), 'worker');
              } else if (t.status === 'done') {
                appendBubble(t.assignee || 'default',
                  renderMd('✅ „' + t.title + '" erledigt.'), 'worker');
              } else if (t.status === 'blocked') {
                appendBubble(t.assignee || 'default',
                  renderMd('⛔ „' + t.title + '" blockiert.'), 'worker');
              }
            }
          }

          seenTasks.set(t.id, { status: t.status, assignee: t.assignee });
        });
      })
      .catch((e) => {
        const s = e && e.status;
        // Beim allerersten Sync still bleiben (Panel gerade geöffnet, evtl. kein Kanban).
        if (!teamSynced) { teamSynced = true; return; }
        if (s === 404 || s === 503) {
          appendBubble(null, 'Kanban-Bridge ist auf diesem Hermes nicht aktiv (HTTP ' + s + ').', 'system');
        }
        // Andere Netzfehler bei Live-Sync schlucken wir leise (Polling versucht es erneut).
      });
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  TEAM-CHAT INIT
  // ───────────────────────────────────────────────────────────────────────────
  function initTeamChat() {
    loadProfiles();
    teamSynced = false;        // erster Sync nach Öffnen nur befüllen, keine Bubbles
    startTeamLive();
    syncTeamFromBoard();
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  LIVE-UPDATES  (EventSource /api/kanban/events/stream, Fallback Polling 5s)
  // ───────────────────────────────────────────────────────────────────────────
  function startTeamLive() {
    stopTeamLive();
    if (typeof EventSource === 'function') {
      try {
        kanbanES = new EventSource('/api/kanban/events/stream', { withCredentials: true });
        // Jedes events-Frame signalisiert Board-Änderung → Team-Verlauf abgleichen (debounced).
        kanbanES.addEventListener('events', () => scheduleTeamReload());
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
  function scheduleTeamReload() {
    if (reloadPending) return;
    reloadPending = setTimeout(() => { reloadPending = null; syncTeamFromBoard(); }, 250);
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => { if (panelActive) syncTeamFromBoard(); }, 5000);
  }

  function stopTeamLive() {
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

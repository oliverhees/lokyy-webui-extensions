/*
 * Lokyy OS — Loki Orchestrator Extension für Hermes WebUI (nesquena/hermes-webui)
 * --------------------------------------------------------------------------
 * "Die Agentur am Tisch" — ein MULTI-AGENT @mention-CHAT-Panel für Loki OS.
 *
 * Was es tut (P2 — Einzelansprache, NOCH KEINE Mira-Kaskade):
 *   1. Eigener Nav-Eintrag "🐺 Loki Orchestrator" in der Rail + Sidebar-Nav.
 *   2. 2-Spalten-Layout im Panel-Body:
 *        LINKS  — schmale Agenten-Liste (.loki-team-list), gespeist aus GET /api/profiles.
 *                 Jeder Eintrag: Emoji + Name (großgeschrieben). Klick → "@<name> " in die Eingabe.
 *        RECHTS — Chat-Verlauf (.loki-chat) + Eingabe-Leiste unten (.loki-input-bar).
 *   3. @mention-Autocomplete: tippt der Nutzer "@…", erscheint ein Dropdown (.loki-mention-pop)
 *      mit gefilterten Agenten-Namen; Auswahl fügt "@name " ein.
 *   4. onSend(): Text parsen → @mentions extrahieren → nur GÜLTIGE Profile (case-insensitive
 *      gegen die geladene Profilliste). Keine gültige Mention → Default 'mira' (sonst 'default').
 *      Für JEDEN angesprochenen Agent SERIELL callAgent(profile, userText, contextText) mit den
 *      letzten ~8 Chat-Bubbles als Klartext-Kontext.
 *   5. callAgent(profile, task, context):
 *        POST /api/session/new {profile}            → session.session_id
 *        POST /api/chat/start   {session_id,message,profile} → stream_id
 *        GET  /api/chat/stream?stream_id=… (SSE)     → token/reasoning/tool/apperror/done/stream_end
 *      Eine Agent-Bubble (kind 'worker') sammelt Plaintext, rendert am Ende via renderMd.
 *      Promise resolved bei stream_end ODER onerror (nie hart fehlschlagen → serieller Ablauf).
 *
 * VERIFIZIERTE CHAT-API (nesquena/hermes-webui, geprüft):
 *   - POST /api/session/new  { profile? , … }  → { session: { session_id, … } }
 *   - POST /api/chat/start    { session_id<REQ>, message<REQ>, profile? } → { stream_id, session_id, … }
 *       Fehler: 409 (active stream), 404 (session not found), 501 (adapter); Fehlerfeld { error }.
 *   - GET  /api/chat/stream?stream_id=…  (SSE, text/event-stream)
 *       Events: token{text} · reasoning{text} · interim_assistant{text} · tool{name,…} ·
 *               tool_complete{…} · apperror{message,type,hint?} · done{session,usage} ·
 *               stream_end{session_id} · cancel · error
 *     Profil einmalig bei session/new setzen; profile bei chat/start ist harmlos, aber nicht der Hebel.
 *
 * ARCHITEKTUR (verifiziert gegen einen frischen Clone von nesquena/hermes-webui @ master):
 *   - Panel-Switching: Host nutzt switchPanel(name, opts) (static/panels.js:203). Bekannte
 *     Panels werden über main.main.showing-<name> CSS getoggelt; chat ist der Default ohne
 *     showing-*. 'loki' ist dem Host UNBEKANNT → wir wrappen window.switchPanel und zeigen/
 *     verstecken unser Panel selbst, reasserten die nav-active-Klasse.
 *   - Unser Panel ist KEIN .main-view: eigene Klasse .loki-orchestrator-panel + [hidden]-Toggle
 *     und main.main.loki-active > #mainChat{display:none} (CSS), damit der Chat-Default nach dem
 *     showing-*-Strip nicht durchscheint.
 *   - API-Aufrufe via window.api() (static/workspace.js:1, credentials:'include', wirft Errors mit
 *     .status), Fallback same-origin fetch. CSRF: globaler window.fetch-Wrapper in index.html.
 *
 * Rein additiv. Idempotent. Kein Core-Fork. Vanilla JS, kein Build-Step.
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
  // window.api() löst JSON bereits auf UND wirft bei !ok einen Error mit .status; Fallback macht
  // .json() + .status selbst. CSRF: globaler window.fetch-Wrapper (index.html) injiziert den Token.
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

  // Verifizierte Host-Signatur: showToast(msg, ms, type) (static/ui.js:4130). Wir übersetzen
  // type→ms+type zentral, sodass interne toast(msg,'error'/'success'/'info')-Aufrufe gleich bleiben.
  function toast(msg, type) {
    const ms = type === 'error' ? 5000 : 3000;
    if (typeof window.showToast === 'function') window.showToast(msg, ms, type);
    else console.log('[loki-orchestrator]', type || 'info', msg);
  }

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── Mini-Markdown → sicheres HTML ───────────────────────────────────────────
  // Reihenfolge: ZUERST esc() (XSS-Schutz), DANN auf dem escapeten String die wenigen
  // Markdown-Muster ersetzen. URLs nur, wenn http(s) oder relativ — kein javascript:/data:.
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
  let panelActive = false;
  let profileList = [];        // [{ name, emoji, label }] — die geladene Agenten-Liste (links)
  const activeStreams = new Set(); // offene EventSources dieses Panels (Cleanup bei hidePanel)
  let sending = false;         // verhindert paralleles onSend

  // @mention-Autocomplete-State.
  let mentionPop = null;       // das Dropdown-Element (oder null)
  let mentionStart = -1;       // Cursor-Index des '@', das wir gerade vervollständigen

  // ───────────────────────────────────────────────────────────────────────────
  //  PANEL-DOM  (2-Spalten: Agenten-Liste links + Chat/Eingabe rechts)
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
      </div>

      <div class="loki-body">
        <aside class="loki-team-list" id="lokiTeamList">
          <div class="loki-team-empty">Team lädt…</div>
        </aside>

        <div class="loki-chat-area">
          <div id="lokiChat" class="loki-chat">
            <div class="loki-chat-empty">Schreib deinem Team eine Nachricht. Tippe <strong>@</strong> um einen Agenten direkt anzusprechen — sonst antwortet Mira.</div>
          </div>

          <div class="loki-input-bar">
            <div class="loki-input-wrap">
              <textarea id="lokiInput" class="loki-input" rows="1"
                placeholder="Nachricht an dein Team… (@name für Einzelansprache, Enter zum Senden)"></textarea>
            </div>
            <button type="button" class="loki-btn-primary loki-send" id="lokiSendBtn" title="Senden (Enter)">➤ Senden</button>
          </div>
        </div>
      </div>`;

    main.appendChild(panel);

    panel.querySelector('#lokiSendBtn').addEventListener('click', onSend);

    const input = panel.querySelector('#lokiInput');
    input.addEventListener('keydown', onInputKeydown);
    input.addEventListener('input', onInputChanged);
    // Mention-Dropdown schließen, wenn der Fokus das Eingabefeld verlässt (verzögert,
    // damit ein Klick im Dropdown noch greift).
    input.addEventListener('blur', () => setTimeout(closeMentionPop, 120));

    return panel;
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  CHAT-BUBBLES
  // ───────────────────────────────────────────────────────────────────────────
  // appendBubble(speakerKey, html, kind):
  //   - erzeugt <div class="loki-bubble loki-bubble-<kind>"> mit Avatar(emoji)+Name + Body(html)
  //   - hängt an #lokiChat an, scrollt ans Ende, gibt das Body-Element zurück.
  //   - kind ∈ {'user','worker','system'}.  'user' → Label "Du" rechts; 'system' → zentriert.
  //   - speakerKey bei 'worker' = Profilname (Avatar/Label via worker()).
  function appendBubble(speakerKey, html, kind) {
    const chat = document.getElementById('lokiChat');
    if (!chat) return null;
    const empty = chat.querySelector('.loki-chat-empty');
    if (empty) empty.remove();

    const k = kind || 'worker';
    let emoji, label;
    if (k === 'user') {
      emoji = '🧑'; label = 'Du';
    } else if (k === 'system') {
      emoji = 'ℹ️'; label = 'System';
    } else {
      const w = worker(speakerKey);
      emoji = w.emoji; label = w.label;
    }

    const bubble = document.createElement('div');
    bubble.className = 'loki-bubble loki-bubble-' + k;
    bubble.dataset.speaker = String(speakerKey == null ? '' : speakerKey);

    if (k === 'system') {
      bubble.innerHTML = '<div class="loki-bubble-body">' + html + '</div>';
    } else {
      bubble.innerHTML =
        '<div class="loki-avatar">' + esc(emoji) + '</div>' +
        '<div class="loki-bubble-card">' +
          '<div class="loki-bubble-head">' + esc(label) +
            '<span class="loki-bubble-status" hidden></span>' +
          '</div>' +
          '<div class="loki-bubble-body">' + html + '</div>' +
        '</div>';
    }

    chat.appendChild(bubble);
    chat.scrollTop = chat.scrollHeight;
    return bubble.querySelector('.loki-bubble-body');
  }

  // Setzt/entfernt den Status-Text im Bubble-Head (z.B. "⚙️ tippt…", "⚠️ Fehler: …").
  // statusText == null/'' → Status ausblenden.
  function setBubbleStatus(bodyEl, statusText, statusClass) {
    if (!bodyEl) return;
    const bubble = bodyEl.closest('.loki-bubble');
    if (!bubble) return;
    const badge = bubble.querySelector('.loki-bubble-status');
    if (!badge) return;
    if (!statusText) {
      badge.hidden = true;
      badge.textContent = '';
      badge.className = 'loki-bubble-status';
      return;
    }
    badge.hidden = false;
    badge.textContent = statusText;
    badge.className = 'loki-bubble-status' + (statusClass ? ' ' + statusClass : '');
  }

  // Ist der Chat-Verlauf (nahezu) ganz unten gescrollt? Für sanftes Auto-Scroll.
  function chatAtBottom(chat) {
    if (!chat) return true;
    return (chat.scrollHeight - chat.scrollTop - chat.clientHeight) < 60;
  }

  // Sammelt die letzten ~8 Chat-Bubbles als kompakten Klartext-Verlauf ("Name: text").
  // Dient als Kontext für den angesprochenen Agenten. System-Bubbles werden übersprungen.
  function collectContext(maxBubbles) {
    const chat = document.getElementById('lokiChat');
    if (!chat) return '';
    const bubbles = Array.from(chat.querySelectorAll('.loki-bubble'));
    const tail = bubbles.slice(-(maxBubbles || 8));
    const lines = [];
    tail.forEach((b) => {
      if (b.classList.contains('loki-bubble-system')) return;
      const head = b.querySelector('.loki-bubble-head');
      const body = b.querySelector('.loki-bubble-body');
      let name = 'Du';
      if (head) {
        // Status-Badge aus dem Namen herausnehmen.
        const clone = head.cloneNode(true);
        const badge = clone.querySelector('.loki-bubble-status');
        if (badge) badge.remove();
        name = (clone.textContent || '').trim() || 'Du';
      }
      const text = body ? (body.textContent || '').trim() : '';
      if (text) lines.push(name + ': ' + text);
    });
    return lines.join('\n');
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  AGENTEN-LISTE (links)  — aus GET /api/profiles
  // ───────────────────────────────────────────────────────────────────────────
  // loadProfiles():
  //   - GET /api/profiles → profiles[] → profileList = [{name, emoji, label}].
  //   - Rendert die linke Agenten-Liste; Klick fügt "@<name> " in die Eingabe ein.
  //   - Fallback: GET /api/kanban/assignees, sonst die bekannten WORKERS-Keys.
  function loadProfiles() {
    const list = document.getElementById('lokiTeamList');
    callApi('/api/profiles')
      .then((r) => {
        const profiles = (r && r.profiles) || [];
        const names = profiles.map((p) => p && p.name).filter(Boolean);
        if (names.length) { setProfiles(names); return; }
        throw new Error('keine Profile');
      })
      .catch(() => {
        callApi('/api/kanban/assignees')
          .then((r) => {
            const names = (r && r.assignees) || [];
            if (names.length) setProfiles(names);
            else setProfiles(Object.keys(WORKERS).filter((k) => k !== 'default'));
          })
          .catch(() => setProfiles(Object.keys(WORKERS).filter((k) => k !== 'default')));
      });
  }

  // Übernimmt die rohe Namensliste in profileList (mit Emoji/Label) und rendert links.
  function setProfiles(names) {
    const seen = new Set();
    profileList = [];
    names.forEach((raw) => {
      const name = String(raw == null ? '' : raw).trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const w = worker(name);
      profileList.push({ name: name, emoji: w.emoji, label: w.label });
    });
    renderTeamList();
  }

  function renderTeamList() {
    const list = document.getElementById('lokiTeamList');
    if (!list) return;
    if (!profileList.length) {
      list.innerHTML = '<div class="loki-team-empty">Kein Team gefunden.</div>';
      return;
    }
    list.innerHTML =
      '<div class="loki-team-head">Team</div>' +
      profileList.map((p) =>
        '<button type="button" class="loki-team-item" data-name="' + esc(p.name) + '" title="@' + esc(p.name) + '">' +
          '<span class="loki-team-emoji">' + esc(p.emoji) + '</span>' +
          '<span class="loki-team-name">' + esc(p.label) + '</span>' +
        '</button>'
      ).join('');
    Array.from(list.querySelectorAll('.loki-team-item')).forEach((btn) => {
      btn.addEventListener('click', () => insertMention(btn.dataset.name));
    });
  }

  // Liefert das Profil-Objekt zu einem Namen (case-insensitive) oder null.
  function findProfile(name) {
    const key = String(name == null ? '' : name).trim().toLowerCase();
    if (!key) return null;
    return profileList.find((p) => p.name.toLowerCase() === key) || null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  EINGABE: @mention einfügen + Autocomplete
  // ───────────────────────────────────────────────────────────────────────────
  // Fügt "@<name> " an der aktuellen Mention-Position (oder am Cursor) ein und fokussiert.
  function insertMention(name) {
    const input = document.getElementById('lokiInput');
    if (!input) return;
    const insert = '@' + name + ' ';
    const val = input.value;
    let from, to;
    if (mentionStart >= 0) {
      // Ersetze das gerade getippte "@frag" (von mentionStart bis Cursor).
      from = mentionStart;
      to = input.selectionStart != null ? input.selectionStart : val.length;
    } else {
      from = to = input.selectionStart != null ? input.selectionStart : val.length;
    }
    input.value = val.slice(0, from) + insert + val.slice(to);
    const caret = from + insert.length;
    input.focus();
    try { input.setSelectionRange(caret, caret); } catch (_) {}
    closeMentionPop();
    autoGrow(input);
  }

  // Textarea wächst mit dem Inhalt (1–6 Zeilen).
  function autoGrow(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }

  function onInputKeydown(e) {
    // Bei offenem Mention-Dropdown: Pfeile/Enter/Escape navigieren das Dropdown.
    if (mentionPop) {
      const items = Array.from(mentionPop.querySelectorAll('.loki-mention-item'));
      const activeIdx = items.findIndex((it) => it.classList.contains('active'));
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const n = items.length ? (activeIdx + 1) % items.length : -1;
        highlightMention(items, n);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const n = items.length ? (activeIdx - 1 + items.length) % items.length : -1;
        highlightMention(items, n);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (items.length) {
          e.preventDefault();
          const pick = items[activeIdx >= 0 ? activeIdx : 0];
          if (pick) insertMention(pick.dataset.name);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMentionPop();
        return;
      }
    }
    // Enter (ohne Shift) sendet.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }

  function onInputChanged(e) {
    const input = e.target;
    autoGrow(input);
    updateMentionPop(input);
  }

  // Prüft, ob direkt vor dem Cursor ein "@frag"-Token steht; öffnet/aktualisiert das Dropdown.
  function updateMentionPop(input) {
    const pos = input.selectionStart != null ? input.selectionStart : input.value.length;
    const upto = input.value.slice(0, pos);
    // @ am Wortanfang (Zeilenanfang oder nach Whitespace), gefolgt von erlaubten Zeichen.
    const m = upto.match(/(^|\s)@([a-zA-Z0-9_-]*)$/);
    if (!m) { closeMentionPop(); return; }
    mentionStart = pos - (m[2].length + 1); // Index des '@'
    const frag = m[2].toLowerCase();
    const matches = profileList.filter((p) =>
      p.name.toLowerCase().indexOf(frag) === 0 || p.label.toLowerCase().indexOf(frag) === 0);
    if (!matches.length) { closeMentionPop(); return; }
    openMentionPop(matches);
  }

  function openMentionPop(matches) {
    const wrap = document.querySelector('.loki-input-wrap');
    if (!wrap) return;
    if (!mentionPop) {
      mentionPop = document.createElement('div');
      mentionPop.className = 'loki-mention-pop';
      wrap.appendChild(mentionPop);
    }
    mentionPop.innerHTML = matches.map((p, i) =>
      '<button type="button" class="loki-mention-item' + (i === 0 ? ' active' : '') + '" data-name="' + esc(p.name) + '">' +
        '<span class="loki-mention-emoji">' + esc(p.emoji) + '</span>' +
        '<span class="loki-mention-name">' + esc(p.label) + '</span>' +
        '<span class="loki-mention-handle">@' + esc(p.name) + '</span>' +
      '</button>'
    ).join('');
    Array.from(mentionPop.querySelectorAll('.loki-mention-item')).forEach((it) => {
      // mousedown statt click: feuert vor dem blur des Textfelds.
      it.addEventListener('mousedown', (ev) => { ev.preventDefault(); insertMention(it.dataset.name); });
    });
  }

  function highlightMention(items, idx) {
    items.forEach((it, i) => it.classList.toggle('active', i === idx));
    if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
  }

  function closeMentionPop() {
    if (mentionPop) { mentionPop.remove(); mentionPop = null; }
    mentionStart = -1;
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  SENDEN  (P2 — Einzelansprache, seriell pro @mention)
  // ───────────────────────────────────────────────────────────────────────────
  // onSend():
  //   1. Text trimmen. @mentions parsen → gültige Profilnamen (case-insensitive).
  //      Keine gültige Mention → Default 'mira' (falls vorhanden, sonst 'default').
  //   2. User-Bubble anhängen, Eingabe leeren.
  //   3. Für JEDEN angesprochenen Agent SERIELL callAgent(profile, userText, contextText).
  async function onSend() {
    if (sending) return;
    const input = document.getElementById('lokiInput');
    const btn = document.getElementById('lokiSendBtn');
    const text = (input && input.value || '').trim();
    if (!text) return;

    closeMentionPop();

    // (1) @mentions extrahieren → nur gültige Profile (case-insensitive, in Reihenfolge, dedupe).
    const mentioned = [];
    const seen = new Set();
    const re = /@([a-zA-Z0-9_-]+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const prof = findProfile(m[1]);
      if (prof && !seen.has(prof.name.toLowerCase())) {
        seen.add(prof.name.toLowerCase());
        mentioned.push(prof.name);
      }
    }
    // Default-Adressat, wenn keine gültige @mention vorhanden.
    if (!mentioned.length) {
      const def = findProfile('mira') ? 'mira' : (findProfile('default') ? 'default' : (profileList[0] && profileList[0].name) || 'default');
      mentioned.push(def);
    }

    // (2) User-Bubble + Eingabe leeren.
    appendBubble(null, renderMd(text), 'user');
    if (input) { input.value = ''; autoGrow(input); }

    // Kontext: Verlauf VOR dem Senden inkl. der gerade gesetzten User-Bubble.
    const context = collectContext(8);

    sending = true;
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    if (input) input.disabled = true;

    try {
      // (3) Seriell jeden angesprochenen Agent abarbeiten.
      for (const profile of mentioned) {
        // eslint-disable-next-line no-await-in-loop
        await callAgent(profile, text, context);
      }
    } finally {
      sending = false;
      if (btn) { btn.disabled = false; btn.textContent = '➤ Senden'; }
      if (input) { input.disabled = false; input.focus(); }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  callAgent(profile, task, context)  →  Promise (resolved bei stream_end/onerror)
  // ───────────────────────────────────────────────────────────────────────────
  // Eine direkte Nachricht an EINEN Agenten:
  //   POST /api/session/new {profile}              → session.session_id
  //   POST /api/chat/start  {session_id,message,profile} → stream_id
  //   GET  /api/chat/stream?stream_id=… (SSE)       → live an die Agent-Bubble
  // XSS: gesammelter Plaintext, am Ende via renderMd gerendert (live nur textContent-Append).
  function callAgent(profile, task, context) {
    return new Promise(async (resolve) => {
      // Agent-Bubble anlegen, Status "⚙️ tippt…".
      const body = appendBubble(profile, '', 'worker');
      setBubbleStatus(body, '⚙️ tippt…', 'loki-status-running');

      let session_id;
      try {
        const sres = await callApi('/api/session/new', {
          method: 'POST',
          body: JSON.stringify({ profile: profile }),
        });
        session_id = sres && sres.session && sres.session.session_id;
        if (!session_id) throw new Error('keine session_id erhalten');
      } catch (e) {
        setBubbleStatus(body, '', null);
        if (body) body.innerHTML = renderMd('⚠️ Konnte keine Session öffnen: ' + (e && e.message ? e.message : e));
        resolve();
        return;
      }

      // Nachricht zusammenbauen: Team-Kontext + direkte Ansprache.
      const message =
        '[Team-Chat Kontext]\n' + (context || '(kein vorheriger Verlauf)') +
        '\n\n[Direkte Nachricht an dich (' + profile + ')]\n' + task;

      let stream_id;
      try {
        const cres = await callApi('/api/chat/start', {
          method: 'POST',
          body: JSON.stringify({ session_id: session_id, message: message, profile: profile }),
        });
        if (cres && cres.error) throw new Error(cres.error);
        stream_id = cres && cres.stream_id;
        if (!stream_id) throw new Error('keine stream_id erhalten');
      } catch (e) {
        setBubbleStatus(body, '', null);
        if (body) body.innerHTML = renderMd('⚠️ Konnte den Chat nicht starten: ' + (e && e.message ? e.message : e));
        resolve();
        return;
      }

      // SSE lesen. Plaintext sammeln, live als textContent anhängen, am Ende renderMd.
      const chat = document.getElementById('lokiChat');
      let buf = '';            // gesammelter Assistant-Text (für finalen renderMd)
      let toolNote = false;    // ob bereits eine Tool-Zeile angehängt wurde (Auto-Scroll-Hinweis)
      let settled = false;
      let es;

      const cleanup = () => {
        if (es) { try { es.close(); } catch (_) {} activeStreams.delete(es); es = null; }
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        setBubbleStatus(body, '', null);
        // Finalen Text sicher rendern (Markdown + escaped). Tool-Notizen stehen als <div> im Body
        // und würden durch renderMd überschrieben — wir hängen den gerenderten Text an die
        // bestehenden Tool-Zeilen an, indem wir den reinen Text-Knoten neu setzen.
        if (body) {
          const tools = Array.from(body.querySelectorAll('.loki-tool-note'));
          body.innerHTML = '';
          tools.forEach((t) => body.appendChild(t));
          const span = document.createElement('span');
          span.className = 'loki-final-text';
          span.innerHTML = renderMd(buf);
          body.appendChild(span);
          if (chatAtBottom(chat)) chat.scrollTop = chat.scrollHeight;
        }
        resolve();
      };

      const appendText = (t) => {
        if (!t) return;
        buf += t;
        if (!body) return;
        // Live: reinen Text als textContent anhängen (kein HTML-Parsing → XSS-sicher).
        let live = body.querySelector('.loki-live-text');
        if (!live) {
          live = document.createElement('span');
          live.className = 'loki-live-text';
          body.appendChild(live);
        }
        live.textContent = buf;
        if (chatAtBottom(chat)) chat.scrollTop = chat.scrollHeight;
      };

      const appendToolNote = (name) => {
        if (!body || !name) return;
        const note = document.createElement('div');
        note.className = 'loki-tool-note';
        note.textContent = '[nutzt ' + name + ']';
        // Tool-Note VOR den Live-Text (damit der Text unten weiterwächst).
        const live = body.querySelector('.loki-live-text');
        if (live) body.insertBefore(note, live);
        else body.appendChild(note);
        toolNote = true;
        if (chatAtBottom(chat)) chat.scrollTop = chat.scrollHeight;
      };

      try {
        es = new EventSource('/api/chat/stream?stream_id=' + encodeURIComponent(stream_id), { withCredentials: true });
      } catch (e) {
        setBubbleStatus(body, '', null);
        if (body) body.innerHTML = renderMd('⚠️ Stream konnte nicht geöffnet werden.');
        resolve();
        return;
      }
      activeStreams.add(es);

      const parse = (ev) => { try { return ev && ev.data ? JSON.parse(ev.data) : {}; } catch (_) { return {}; } };

      // token → die eigentliche Antwort (Text-Delta). Beim ersten Token den "tippt…"-Status entfernen.
      es.addEventListener('token', (ev) => { const d = parse(ev); if (d && d.text) { if (!buf) setBubbleStatus(body, '', null); appendText(d.text); } });
      // reasoning = internes Denken des Agenten — NICHT in den finalen Antworttext hängen
      // (sonst Duplikat: Denken enthält oft einen Antwort-Entwurf). Nur als dezenten Status zeigen.
      es.addEventListener('reasoning', (ev) => { const d = parse(ev); if (d && d.text && !buf) setBubbleStatus(body, '💭 überlegt…', null); });
      // tool → dezente "[nutzt <name>]"-Zeile.
      es.addEventListener('tool', (ev) => { const d = parse(ev); appendToolNote(d && d.name); });
      // apperror → Status auf Fehler.
      es.addEventListener('apperror', (ev) => {
        const d = parse(ev);
        const msg = (d && d.message) ? d.message : 'Fehler';
        setBubbleStatus(body, '⚠️ Fehler: ' + msg, 'loki-status-error');
        // Stream wird clientseitig durch apperror beendet → finish.
        finish();
      });
      // done → finaler Session-State (Text ist bereits über token gestreamt).
      es.addEventListener('done', () => { /* Abschluss kommt über stream_end */ });
      // stream_end → fertig.
      es.addEventListener('stream_end', () => finish());
      // generisches error-Event (Server-Abbruchbedingung).
      es.addEventListener('error', () => finish());
      // EventSource-Transportfehler → ebenfalls resolven (nicht hart fehlschlagen).
      es.onerror = () => {
        // EventSource feuert onerror auch bei Stream-Ende; wenn schon settled → ignorieren.
        if (settled) return;
        // Kurz warten: viele Server schließen nach stream_end, das onerror dann triggert.
        finish();
      };
    });
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
      main.classList.add('loki-active');
    }
    panel.hidden = false;
    panelActive = true;
    document.querySelectorAll('[data-panel]').forEach((t) =>
      t.classList.toggle('active', t.dataset.panel === PANEL_NAME));
    initChat();
  }

  function hidePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.hidden = true;
    const main = document.querySelector('main.main');
    if (main) main.classList.remove('loki-active');
    panelActive = false;
    closeMentionPop();
    // Cleanup: alle offenen EventSources dieses Panels schließen (kein Leak).
    activeStreams.forEach((es) => { try { es.close(); } catch (_) {} });
    activeStreams.clear();
  }

  function openPanel() {
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
        showPanel();
        return Promise.resolve(true);
      }
      if (panelActive) hidePanel();
      return orig.call(this, name, opts);
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  CHAT INIT
  // ───────────────────────────────────────────────────────────────────────────
  function initChat() {
    loadProfiles();
    const input = document.getElementById('lokiInput');
    if (input) { autoGrow(input); setTimeout(() => input.focus(), 50); }
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

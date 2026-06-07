/*
 * Lokyy OS — Loki Dashboards Extension für Hermes WebUI (nesquena/hermes-webui)
 * --------------------------------------------------------------------------
 * DASHBOARD-ANZEIGE + WRITE-BACK. KEIN Multi-Agent, KEIN Chat.
 *
 * Was es tut:
 *   1. Eigener Nav-Eintrag "📊 Dashboards" in der Rail + Sidebar-Nav (ganz oben).
 *   2. 2-Spalten-Layout im Panel-Body:
 *        LINKS  — .loki-dash-list: Liste der gefundenen Dashboards (Ordner mit dashboard.html).
 *        RECHTS — .loki-dash-view: <iframe class="loki-dash-frame"> + leerer Zustand.
 *   3. DISCOVERY: Über die verifizierte File-API werden alle Ordner gesucht, die eine
 *      'dashboard.html' enthalten. Pro Treffer: Name = Ordnername. Liste links rendern.
 *   4. Klick auf ein Dashboard → der PARENT (diese Extension) lädt selbst:
 *        a) die JSON-Daten aus '<ordner>/daten/*.json'  (loadDashboardData)
 *        b) das HTML-Template '<ordner>/dashboard.html'  (loadDashboardHtml)
 *      und injiziert die Daten als `window.LOKI_DATA` in das HTML (buildSrcdoc).
 *      Das fertige HTML wird per `iframe.srcdoc` gesetzt (NICHT iframe.src).
 *   5. Refresh-Button (lädt Liste + aktives Dashboard neu). Robust gegen fehlende API.
 *   6. hidePanel: iframe.srcdoc/src leeren (kein Hintergrund-Laden).
 *   7. WRITE-BACK (Formulare → Workspace): Das Dashboard kann Datensätze ZURÜCKSPEICHERN.
 *      Es ruft `LOKI.save(record, {file?})` auf (von buildSrcdoc injiziert); das sendet
 *      `postMessage({type:'loki:save', reqId, file, data})` an den PARENT. Der Parent
 *      validiert hart (nur aktives Dashboard, nur dessen 'daten/'-Ordner, nur *.json,
 *      Dateiname sanitized, max. 256 KB, 'date' wird ergänzt) und schreibt über den
 *      verifizierten Host-Endpoint  POST /api/file/save  {session_id, path, content}
 *      (so speichert die Host-UI selbst — static/workspace.js). Danach lädt der Parent
 *      die daten/*.json frisch und antwortet
 *      `postMessage({type:'loki:save:result', reqId, ok, rows|error})` — das Dashboard
 *      kann seine Charts live neu rendern. Das iframe ist sandbox="allow-scripts
 *      allow-forms" (allow-forms ist Pflicht, sonst feuert das submit-Event nie —
 *      siehe Kommentar an der iframe-Erstellung); es bekommt weiterhin KEINEN
 *      API-Zugriff, es darf nur anfragen. Native Submissions canceled der injizierte
 *      window-capture-Listener, bevor sie navigieren können.
 *
 * WARUM srcdoc + window.LOKI_DATA STATT iframe.src=file/raw?
 * -----------------------------------------------------------------------------
 *   Der Hermes-Server liefert user-HTML über /api/file/raw mit dem Header
 *   "content-security-policy: sandbox allow-scripts allow-popups" — OHNE
 *   allow-same-origin. Dadurch erhält ein per iframe.src geladenes Dokument
 *   einen OPAKEN (null) Origin und kann KEINE same-origin-API-Calls machen
 *   (fetch /api/list, /api/file/raw → "Failed to fetch").
 *   Der PARENT (diese Extension, in der echten Host-Origin) darf die API aber
 *   (Status 200 verifiziert). Also lädt der Parent die Daten selbst und reicht
 *   sie dem Dashboard via iframe.srcdoc + injiziertem window.LOKI_DATA durch.
 *   Bei srcdoc greift das sandbox-ATTRIBUT des iframe (allow-scripts) — der
 *   Server-CSP der file/raw-Antwort spielt keine Rolle mehr, weil das Dokument
 *   nicht mehr über die file/raw-URL geladen wird. Das Dashboard macht KEINEN
 *   fetch mehr; es liest nur window.LOKI_DATA.
 *
 * VERIFIZIERTE FILE-/WORKSPACE-API (nesquena/hermes-webui, gegen echten Code geprüft):
 *   - File-Ops laufen über `session_id` (NICHT `workspace`). Pfade sind relativ zum
 *     Workspace-Root der Session. Den Handle holen wir aus dem Frontend-State:
 *     window.S.session.session_id (so macht es die Host-UI selbst, static/workspace.js).
 *   - Ordner-LISTING: GET /api/list?session_id=<SID>&path=<rel>  (Default path=".")
 *       → { entries: [{name, path, type:'dir'|'file'|'symlink', size, mtime_ns, ...}],
 *           signature, path }   (max. 200 Einträge, sortiert)
 *   - Datei roh: GET /api/file/raw?session_id=<SID>&path=<rel>
 *       → roher Dateiinhalt (JSON/HTML als Text). Im PARENT same-origin erlaubt.
 *   - Es gibt KEINEN `workspace`-Query-Param auf den File-Endpoints.
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
  // Für JSON-Endpoints (api/list). Discovery + JSON-Daten laufen hierüber.
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

  // ── Roh-Text-Wrapper für /api/file/raw (HTML-Template + JSON-Dateien). ──
  // file/raw liefert rohen Dateiinhalt; window.api() würde JSON-parsen wollen,
  // deshalb hier IMMER direkt fetch() (same-origin im Parent, Status 200 verifiziert).
  function callApiText(path, opts) {
    return fetch(path, { credentials: 'same-origin', ...opts }).then((r) => {
      if (!r.ok) {
        const err = new Error('HTTP ' + r.status);
        err.status = r.status;
        throw err;
      }
      return r.text();
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
      if (s && s.session_id) return String(s.session_id);
    } catch (_) {}
    // Fallback: session_id aus der URL (/session/<id>) — window.S.session ist beim
    // Panel-Wechsel nicht immer gesetzt, aber die Host-UI navigiert auf /session/<id>.
    try {
      const m = String(location.pathname).match(/\/session\/([A-Za-z0-9_-]+)/);
      if (m) return m[1];
    } catch (_) {}
    return null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  PARENT-SEITIGES DATEN-/HTML-LADEN  (das iframe macht KEINEN fetch mehr)
  // ───────────────────────────────────────────────────────────────────────────

  // Leitet den Ordner eines Dashboards aus seinem htmlPath ab.
  // 'a/b/dashboard.html' → 'a/b';  'dashboard.html' (Root) → ''.
  function dashboardFolder(htmlPath) {
    const i = String(htmlPath || '').lastIndexOf('/');
    return i >= 0 ? htmlPath.slice(0, i) : '';
  }

  // loadDashboardData(sid, folder): listet '<folder>/daten', holt jede *.json roh,
  // parst sie (einzelne Fehler werden übersprungen), sortiert nach 'date' (falls da).
  // Gibt { rows, folder } zurück. Wirft NICHT bei fehlendem daten/-Ordner — gibt dann
  // einfach rows:[] zurück (das Dashboard zeigt seinen eigenen Hinweis).
  async function loadDashboardData(sid, folder) {
    const datenDir = folder ? (folder + '/daten') : 'daten';
    let entries = [];
    try {
      const listPath = 'api/list?session_id=' + encodeURIComponent(sid)
        + '&path=' + encodeURIComponent(datenDir);
      const res = await callApi(listPath);
      entries = (res && Array.isArray(res.entries)) ? res.entries : [];
    } catch (_) {
      // daten/ existiert nicht oder nicht listbar → keine Daten.
      return { rows: [], folder };
    }

    const files = entries.filter((e) =>
      e && e.type !== 'dir' && e.is_dir !== true && /\.json$/i.test(e.name || ''));

    // Deterministische Lese-Reihenfolge nach Dateiname: zusammen mit dem stabilen
    // Array-Sort unten ergibt das eine verlässliche Intra-Tag-Ordnung für
    // Suffix-Dateien wie '2026-06-07_morgens.json' / '2026-06-07_abends.json'.
    files.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

    const rows = [];
    for (const f of files) {
      const rel = f.path || (datenDir + '/' + f.name);
      try {
        // eslint-disable-next-line no-await-in-loop
        const txt = await callApiText(
          '/api/file/raw?session_id=' + encodeURIComponent(sid)
            + '&path=' + encodeURIComponent(rel));
        const obj = JSON.parse(txt);
        if (obj && typeof obj === 'object') rows.push(obj);
      } catch (_) {
        // Defekte/nicht lesbare Datei → überspringen (robust).
      }
    }

    // Nach 'date' sortieren, falls vorhanden. Array#sort ist stabil (ES2019) —
    // Datensätze mit gleichem 'date' behalten die Dateinamen-Reihenfolge von oben.
    rows.sort((a, b) => {
      const da = a && a.date != null ? String(a.date) : '';
      const db = b && b.date != null ? String(b.date) : '';
      return da.localeCompare(db);
    });

    return { rows, folder };
  }

  // loadDashboardHtml(sid, htmlPath): holt das HTML-Template roh (Text).
  // ORIGIN-RELATIV (führender Slash): die Seiten-URL ist /session/<id>.
  function loadDashboardHtml(sid, htmlPath) {
    return callApiText(
      '/api/file/raw?session_id=' + encodeURIComponent(sid)
        + '&path=' + encodeURIComponent(htmlPath));
  }

  // buildSrcdoc(htmlTemplate, rows, meta): injiziert einen Daten-Block in das Template.
  // SICHERHEIT (PFLICHT): JSON.stringify kann '</script>' enthalten und damit den
  // Inline-<script> vorzeitig schließen (Breakout/XSS). Wir ersetzen daher in der
  // JSON-Ausgabe JEDES '</' durch '<\/'. Im JSON-String-Kontext ist '<\/' identisch
  // zu '</', aber der HTML-Parser sieht kein schließendes </script> mehr.
  //
  // Zusätzlich wird der LOKI-Helper injiziert (WRITE-BACK-Kontrakt fürs Dashboard):
  //   LOKI.data                  → Alias auf window.LOKI_DATA (Array der Datensätze)
  //   LOKI.dashboard             → Alias auf window.LOKI_DASHBOARD ({folder, count})
  //   LOKI.save(record, {file?}) → Promise. Sendet 'loki:save' an den Parent, wartet
  //                                auf 'loki:save:result' (reqId-gematcht, 10s-Timeout).
  //                                Bei ok: aktualisiert LOKI_DATA/LOKI.data auf die
  //                                frischen rows und resolved {ok, file, path, rows}.
  //   Kein fetch, kein eval — reiner postMessage-Botengang. Der Parent validiert.
  function buildSrcdoc(htmlTemplate, rows, meta) {
    const safe = (val) => JSON.stringify(val == null ? null : val).replace(/<\//g, '<\\/');
    const helperJs =
      '(function () {' +
      '"use strict";' +
      'var pending = {}; var seq = 0;' +
      'window.LOKI = {' +
      '  data: window.LOKI_DATA,' +
      '  dashboard: window.LOKI_DASHBOARD,' +
      '  save: function (record, opts) {' +
      '    opts = opts || {};' +
      '    return new Promise(function (resolve, reject) {' +
      '      var reqId = "s" + (++seq) + "_" + Math.random().toString(36).slice(2);' +
      '      pending[reqId] = { resolve: resolve, reject: reject };' +
      '      window.parent.postMessage({ type: "loki:save", reqId: reqId, file: opts.file || null, data: record }, "*");' +
      '      setTimeout(function () {' +
      '        if (pending[reqId]) { delete pending[reqId]; reject(new Error("Timeout beim Speichern (10s)")); }' +
      '      }, 10000);' +
      '    });' +
      '  }' +
      '};' +
      'window.addEventListener("message", function (ev) {' +
      '  if (ev.source !== window.parent) return;' +
      '  var m = ev.data;' +
      '  if (!m || m.type !== "loki:save:result" || !m.reqId || !pending[m.reqId]) return;' +
      '  var p = pending[m.reqId]; delete pending[m.reqId];' +
      '  if (m.ok) {' +
      '    if (Array.isArray(m.rows)) { window.LOKI_DATA = m.rows; window.LOKI.data = m.rows; }' +
      '    p.resolve(m);' +
      '  } else { p.reject(new Error(m.error || "Speichern fehlgeschlagen")); }' +
      '});' +
      // SICHERHEITSNETZ: JEDE native Form-Submission canceln — window-capture, und
      // weil dieser Helper als ERSTES Script im Dokument läuft, ist es der erste
      // registrierte Listener: er feuert vor jedem Dashboard-Code und preventDefaultet,
      // bevor irgendwer die Submission umleiten oder durchlassen könnte.
      // KONTEXT (live verifiziert 2026-06-07): Die Sandbox hat allow-forms — NÖTIG,
      // denn ohne allow-forms blockt Chromium die Submission VOR dem submit-Event
      // (der Event feuert nie, kein Handler läuft, LOKI.save unerreichbar). Mit
      // allow-forms feuert der Event normal; dieses Netz sorgt dafür, dass die
      // native Navigation trotzdem NIE stattfindet. Dashboard-Handler laufen weiter
      // (preventDefault stoppt keine Propagation). form.submit() (programmatisch,
      // ohne Event) bleibt verboten — der Skill schreibt LOKI.save vor.
      'window.addEventListener("submit", function (ev) { ev.preventDefault(); }, true);' +
      '})();';
    const dataScript =
      '<script>window.LOKI_DATA = ' + safe(rows) + ';'
      + 'window.LOKI_DASHBOARD = ' + safe(meta) + ';'
      + helperJs + '<\/script>';

    const html = String(htmlTemplate || '');

    // Bevorzugt direkt nach dem ersten <head> einsetzen, sonst am Anfang von <body>,
    // sonst ganz vorn. Case-insensitive, toleriert Attribute (<head ...>, <body ...>).
    const headMatch = html.match(/<head[^>]*>/i);
    if (headMatch) {
      const at = headMatch.index + headMatch[0].length;
      return html.slice(0, at) + dataScript + html.slice(at);
    }
    const bodyMatch = html.match(/<body[^>]*>/i);
    if (bodyMatch) {
      const at = bodyMatch.index + bodyMatch[0].length;
      return html.slice(0, at) + dataScript + html.slice(at);
    }
    return dataScript + html;
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  WRITE-BACK-BRIDGE  (iframe-Formular → postMessage → POST /api/file/save)
  // ───────────────────────────────────────────────────────────────────────────
  // SICHERHEITSMODELL: Das sandboxed iframe (allow-scripts, OHNE allow-same-origin)
  // hat einen opaken Origin und KEINEN API-Zugriff — hart per Browser-Spec. Es darf
  // nur per postMessage ANFRAGEN. Der Parent (diese Extension) ist der einzige
  // Schreiber und validiert jede Anfrage:
  //   - Quelle:    event.source === contentWindow des AKTIVEN Dashboard-iframes.
  //                (event.origin ist bei srcdoc-Sandbox 'null' und als Filter
  //                 unbrauchbar — der source-Vergleich ist der belastbare Check.)
  //   - Ziel:      NUR '<aktives-dashboard>/daten/<datei>.json'. Kein anderer Ordner.
  //   - Dateiname: Whitelist ^[A-Za-z0-9._-]+\.json$, '..' / '/' / '\' verboten.
  //                Fehlt er, wird '<data.date>.json' bzw. '<heute>.json' verwendet.
  //   - Payload:   Muss ein flaches JSON-Objekt sein (kein Array/String/null),
  //                max. 256 KB serialisiert. Fehlendes 'date' wird ergänzt
  //                (Kontrakt von loki-skills/dashboard-data: Pflichtfeld 'date').
  //   - Endpoint:  POST /api/file/save {session_id, path, content} — exakt der
  //                Call, mit dem die Host-UI selbst speichert (static/workspace.js,
  //                gegen Upstream-Code verifiziert).
  // Nach erfolgreichem Schreiben lädt der Parent daten/*.json frisch und gibt die
  // rows im Result mit — das Dashboard rendert live neu, ohne iframe-Reload.
  // HINWEIS: /api/file/save legt fehlende Ordner NICHT verlässlich an. Der
  // dashboard-builder-Skill erstellt 'daten/' deshalb verpflichtend zur Bauzeit.

  const SAVE_MSG = 'loki:save';
  const SAVE_RESULT_MSG = 'loki:save:result';
  const MAX_SAVE_BYTES = 256 * 1024;
  const SAVE_FILENAME_RE = /^[A-Za-z0-9._-]+\.json$/;

  // Liefert das iframe des aktuell angezeigten Dashboards (oder null).
  function activeDashFrame() {
    const view = document.getElementById('lokiDashView');
    return view ? view.querySelector('.loki-dash-frame') : null;
  }

  function todayIso() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // sanitizeSaveFile(name, dateStr): expliziter Name → strenge Whitelist-Prüfung
  // (null bei Verstoß = ablehnen, NICHT reparieren). Ohne Namen → '<date>.json'
  // aus dem 'date'-Feld, sonst '<heute>.json'.
  function sanitizeSaveFile(name, dateStr) {
    if (name != null) {
      const s = String(name);
      if (s.indexOf('/') >= 0 || s.indexOf('\\') >= 0 || s.indexOf('..') >= 0) return null;
      if (!SAVE_FILENAME_RE.test(s)) return null;
      return s;
    }
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '')) ? String(dateStr) : todayIso();
    return d + '.json';
  }

  // handleSaveRequest(msg): validiert und schreibt. Gibt IMMER ein Result-Objekt
  // zurück ({ok:true, file, path, rows} | {ok:false, error}) — wirft nie.
  // WICHTIG: Ziel-Ordner wird SYNCHRON aus selectedPath abgeleitet, bevor ein
  // await läuft — ein Dashboard-Wechsel während des Speicherns kann das Ziel
  // nicht mehr verschieben.
  async function handleSaveRequest(msg) {
    const sid = getSessionId();
    if (!sid) return { ok: false, error: 'Keine aktive Session.' };
    if (!selectedPath) return { ok: false, error: 'Kein Dashboard geöffnet.' };

    const data = msg && msg.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: 'Daten müssen ein JSON-Objekt sein.' };
    }

    const record = Object.assign({}, data);
    if (!record.date) record.date = todayIso();

    const file = sanitizeSaveFile(msg.file, record.date);
    if (!file) {
      return { ok: false, error: 'Ungültiger Dateiname (erlaubt: A-Za-z0-9._- mit Endung .json).' };
    }

    let content;
    try { content = JSON.stringify(record, null, 2); }
    catch (_) { return { ok: false, error: 'Daten sind nicht JSON-serialisierbar.' }; }
    if (content.length > MAX_SAVE_BYTES) {
      return { ok: false, error: 'Daten zu groß (max. 256 KB).' };
    }

    const folder = dashboardFolder(selectedPath);
    // Defensiv (host-unabhängige Garantie): der Ordner-Teil stammt zwar aus der
    // Server-Discovery (nie aus iframe-Input), aber ein '..'-Segment darin wäre
    // trotzdem ein No-Go — lieber ablehnen als dem Listing blind vertrauen.
    if (folder && (folder.indexOf('..') >= 0 || folder.indexOf('\\') >= 0)) {
      return { ok: false, error: 'Ungültiger Dashboard-Pfad.' };
    }
    const path = (folder ? folder + '/' : '') + 'daten/' + file;

    try {
      await callApi('/api/file/save', {
        method: 'POST',
        body: JSON.stringify({ session_id: sid, path: path, content: content }),
      });
    } catch (e) {
      const status = e && e.status;
      let err = 'Speichern fehlgeschlagen';
      if (status === 404) err += ' (404 — fehlt der Ordner daten/ im Dashboard-Ordner?)';
      else if (status === 503) err += ' (503 — Dienst nicht verfügbar)';
      else if (e && e.message) err += ': ' + e.message;
      return { ok: false, error: err };
    }

    // Frische Daten für Live-Update im Dashboard (weicher Fehler → rows: null).
    let rows = null;
    try { rows = (await loadDashboardData(sid, folder)).rows; } catch (_) {}

    return { ok: true, file: file, path: path, rows: rows };
  }

  // Globaler message-Listener. Wird genau EINMAL registriert (IIFE ist per
  // __lokiDashboardsLoaded doppel-load-sicher). Antwortet nur, wenn das anfragende
  // iframe noch das aktive Dashboard ist.
  function onDashboardMessage(ev) {
    const iframe = activeDashFrame();
    if (!iframe || ev.source !== iframe.contentWindow) return;
    const msg = ev.data;
    if (!msg || msg.type !== SAVE_MSG) return;

    const reqId = msg.reqId == null ? null : String(msg.reqId);
    const pathAtRequest = selectedPath;

    handleSaveRequest(msg).then((result) => {
      const frameNow = activeDashFrame();
      // Nur antworten UND toasten, wenn das anfragende iframe noch das aktive
      // Dashboard ist. Sonst gehört das Ergebnis zu einem nicht mehr sichtbaren
      // Dashboard — kein Result zustellen (iframe-Promise läuft in seinen 10s-Timeout)
      // und KEIN Toast, der sonst fälschlich im neuen Dashboard-Kontext erschiene.
      if (frameNow && frameNow.contentWindow === ev.source && selectedPath === pathAtRequest) {
        try {
          ev.source.postMessage(
            Object.assign({ type: SAVE_RESULT_MSG, reqId: reqId }, result), '*');
        } catch (_) { /* iframe inzwischen weg → nichts zu tun */ }
        if (result.ok) toast('💾 Gespeichert: ' + result.file);
        else toast(result.error, 'error');
      }
    });
  }

  window.addEventListener('message', onDashboardMessage);

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
  // openDashboard(htmlPath): Daten + HTML PARENT-seitig laden, Daten via srcdoc +
  // window.LOKI_DATA in ein sandboxed iframe injizieren. KEIN iframe.src/fetch im iframe.
  async function openDashboard(htmlPath) {
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
    renderList(); // Auswahl sofort markieren
    showViewMessage(view, 'Lade Dashboard…');

    const folder = dashboardFolder(htmlPath);

    // 1) HTML-Template holen (Pflicht — ohne Template kein Dashboard).
    let htmlTemplate;
    try {
      htmlTemplate = await loadDashboardHtml(sid, htmlPath);
    } catch (e) {
      const status = e && e.status;
      let msg = '⚠️ Dashboard-HTML konnte nicht geladen werden';
      if (status === 404) msg += ' (404 — Datei nicht gefunden)';
      else if (status === 503) msg += ' (503 — Dienst nicht verfügbar)';
      else if (e && e.message) msg += ': ' + e.message;
      showViewMessage(view, msg + '.');
      toast(msg, 'error');
      return;
    }

    // Falls inzwischen ein anderes Dashboard gewählt wurde → Ergebnis verwerfen.
    if (selectedPath !== htmlPath) return;

    // 2) Daten holen (Fehler hier sind weich → rows:[], Dashboard zeigt eigenen Hinweis).
    let data;
    try {
      data = await loadDashboardData(sid, folder);
    } catch (_) {
      data = { rows: [], folder };
    }
    if (selectedPath !== htmlPath) return;

    // 3) srcdoc bauen + setzen. sandbox: allow-scripts + allow-forms, KEIN allow-same-origin.
    const srcdoc = buildSrcdoc(htmlTemplate, data.rows, {
      folder: folder,
      count: data.rows.length,
    });

    view.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.className = 'loki-dash-frame';
    // SICHERHEIT: sandbox ist ZWINGEND. allow-same-origin wird NICHT gesetzt — das
    // iframe braucht keinen API-Zugriff mehr (Parent reicht die Daten via srcdoc durch).
    // Bei srcdoc greift das sandbox-Attribut, nicht der Server-CSP der file/raw-Antwort.
    //
    // allow-forms ist PFLICHT (live verifiziert 2026-06-07): OHNE allow-forms blockt
    // Chromium die Form-Submission VOR dem submit-Event — der Event feuert NIE, kein
    // Handler (auch kein preventDefault/LOKI.save) läuft je. Mit allow-forms feuert
    // das submit-Event; der injizierte window-capture-Listener (buildSrcdoc, als
    // ERSTER registriert) canceled dann JEDE native Submission, bevor irgendein
    // Dashboard-Code sie umleiten könnte → keine Navigation, kein Daten-Abfluss
    // über form-action. Exfiltration via fetch/img wäre aus dem opaken Origin ohnehin
    // möglich — allow-forms öffnet keinen neuen Kanal, solange das Netz zuerst läuft.
    iframe.setAttribute('sandbox', 'allow-scripts allow-forms');
    iframe.setAttribute('title', 'Dashboard');
    iframe.removeAttribute('src');
    iframe.srcdoc = srcdoc;
    view.appendChild(iframe);
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
    if (iframe) {
      try { iframe.removeAttribute('srcdoc'); iframe.src = 'about:blank'; } catch (_) {}
    }
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
      if (iframe) {
        try { iframe.removeAttribute('srcdoc'); iframe.src = 'about:blank'; } catch (_) {}
      }
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

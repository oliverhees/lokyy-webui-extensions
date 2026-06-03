/*
 * Lokyy OS — Loki Notifications Extension für Hermes WebUI (nesquena/hermes-webui)
 * ------------------------------------------------------------------------------
 * Notification-Center in der Top-Bar: 🔔 Glocke oben rechts mit Badge + Dropdown
 * der letzten Ereignisse, plus optionale Browser-Desktop-Benachrichtigungen.
 *
 * WARUM diese Extension existiert:
 *   Ohne hinterlegtes Telegram gibt die WebUI KEIN sichtbares Feedback, wenn ein
 *   geplanter/manuell getriggerter cron-Task fertig läuft. Man sieht "nichts".
 *   Diese Extension pollt /api/crons/recent (liefert completions: name, status,
 *   completed_at) und macht jede Ausführung sichtbar — als Badge, Liste und
 *   (auf Wunsch) als Desktop-Popup.
 *
 * ERWEITERBARES EVENT-SYSTEM (bewusst so gebaut):
 *   `SOURCES` ist eine Liste von Event-Quellen. Aktuell nur `taskSource`
 *   (cron-Ausführungen). Eine neue Quelle muss nur { id, label, fetchEvents() }
 *   liefern, das normalisierte Events {key,title,status,ts,source,detail}
 *   zurückgibt — dann taucht sie automatisch in Glocke + Popups auf.
 *
 * TOP-BAR-LAYOUT:
 *   Titel ("Loki OS") wird per CSS nach LINKS geschoben (justify-content),
 *   die Glocke wird rechts in <header class="app-titlebar"> eingehängt.
 *   Re-Insert via MutationObserver, falls die SPA die Bar neu rendert
 *   (gleiche Strategie wie loki-branding). Idempotent: nur einfügen wenn fehlt.
 *
 * PROFIL-HINWEIS:
 *   /api/crons/recent ist profil-abhängig (aktiver hermes_profile-Cookie). Die
 *   cron-Jobs liegen global im default-Profil — im default-Profil zeigt die
 *   Glocke also alles. (Siehe Lokyy-Brain: loki-os-two-container-fix.)
 */
(() => {
  'use strict';

  if (window.__lokiNotifLoaded) return;
  window.__lokiNotifLoaded = true;

  // ── Konfiguration ──────────────────────────────────────────────────────────
  const POLL_MS = 30000;            // Poll-Intervall
  const MAX_ITEMS = 25;             // max. Einträge im Dropdown
  const LS_SEEN = 'loki_notif_seen_ts';        // Badge: ungelesen = ts > seen
  const LS_NOTIFIED = 'loki_notif_notified_ts'; // Popups: nur ts > notified

  // ── State ────────────────────────────────────────────────────────────────
  let events = [];                  // gemergte, nach ts absteigend sortierte Events
  let dropdownOpen = false;
  let pollTimer = null;

  const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : 0;
  const getLS = (k) => { const v = parseFloat(localStorage.getItem(k)); return isFinite(v) ? v : 0; };
  const setLS = (k, v) => { try { localStorage.setItem(k, String(v)); } catch (_) {} };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function relTime(tsSec) {
    const now = Date.now() / 1000;
    let d = Math.max(0, now - num(tsSec));
    if (d < 60) return 'gerade eben';
    if (d < 3600) return `vor ${Math.floor(d / 60)} Min`;
    if (d < 86400) return `vor ${Math.floor(d / 3600)} Std`;
    return `vor ${Math.floor(d / 86400)} Tg`;
  }

  function statusIcon(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'ok' || s === 'success' || s === 'done') return '✅';
    if (s === 'running' || s === 'pending') return '⏳';
    return '❌';
  }

  // ── Event-Quellen (erweiterbar) ────────────────────────────────────────────
  const taskSource = {
    id: 'tasks',
    label: 'Aufgaben',
    async fetchEvents() {
      const r = await fetch('/api/crons/recent', { cache: 'no-store' });
      if (!r.ok) return [];
      const data = await r.json();
      const comps = Array.isArray(data && data.completions) ? data.completions : [];
      return comps.map((c) => ({
        key: `tasks:${c.job_id}:${num(c.completed_at)}`,
        title: c.name || c.job_id || 'Aufgabe',
        status: c.status || 'ok',
        ts: num(c.completed_at),
        source: 'tasks',
        jobId: c.job_id,
      }));
    },
  };

  // Weitere Quellen hier ergänzen → erscheinen automatisch in Glocke + Popups.
  const SOURCES = [taskSource];

  // ── DOM: Glocke + Dropdown ─────────────────────────────────────────────────
  function buildBell() {
    const wrap = document.createElement('div');
    wrap.id = 'lokiNotifWrap';
    wrap.className = 'loki-notif-wrap';

    const btn = document.createElement('button');
    btn.id = 'lokiNotifBell';
    btn.className = 'loki-notif-bell has-tooltip has-tooltip--bottom';
    btn.setAttribute('aria-label', 'Benachrichtigungen');
    btn.setAttribute('data-tooltip', 'Benachrichtigungen');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm6.5-6V11a6.5 6.5 0 0 0-5-6.32V4a1.5 1.5 0 0 0-3 0v.68A6.5 6.5 0 0 0 5.5 11v5l-1.7 1.7a1 1 0 0 0 .7 1.7h15a1 1 0 0 0 .7-1.7L18.5 16Z"/>' +
      '</svg>' +
      '<span class="loki-notif-badge" id="lokiNotifBadge" hidden>0</span>';

    const panel = document.createElement('div');
    panel.id = 'lokiNotifPanel';
    panel.className = 'loki-notif-panel';
    panel.hidden = true;
    panel.innerHTML =
      '<div class="loki-notif-head">' +
      '<span class="loki-notif-title">Aktivität</span>' +
      '<button class="loki-notif-clear" id="lokiNotifClear" type="button">Als gelesen</button>' +
      '</div>' +
      '<div class="loki-notif-perm" id="lokiNotifPerm" hidden>' +
      '<button type="button" id="lokiNotifPermBtn">🔔 Desktop-Benachrichtigungen aktivieren</button>' +
      '</div>' +
      '<div class="loki-notif-list" id="lokiNotifList"></div>';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDropdown();
    });
    wrap.appendChild(btn);
    wrap.appendChild(panel);

    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.querySelector('#lokiNotifClear').addEventListener('click', markAllRead);
    panel.querySelector('#lokiNotifPermBtn').addEventListener('click', requestPermission);
    return wrap;
  }

  function ensureMounted() {
    const header = document.querySelector('header.app-titlebar');
    if (!header) return false;
    if (!document.getElementById('lokiNotifWrap')) {
      header.appendChild(buildBell());
      header.classList.add('loki-has-notif'); // CSS-Hook: Titel nach links
      renderPanel();
      updateBadge();
    }
    return true;
  }

  // ── Dropdown ───────────────────────────────────────────────────────────────
  function toggleDropdown() {
    dropdownOpen = !dropdownOpen;
    const panel = document.getElementById('lokiNotifPanel');
    if (!panel) return;
    panel.hidden = !dropdownOpen;
    if (dropdownOpen) {
      refreshPermHint();
      poll();          // beim Öffnen frisch laden
      markAllRead();   // öffnen = gelesen
    }
  }

  function closeDropdown() {
    dropdownOpen = false;
    const panel = document.getElementById('lokiNotifPanel');
    if (panel) panel.hidden = true;
  }

  document.addEventListener('click', () => { if (dropdownOpen) closeDropdown(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && dropdownOpen) closeDropdown(); });

  function renderPanel() {
    const list = document.getElementById('lokiNotifList');
    if (!list) return;
    if (!events.length) {
      list.innerHTML = '<div class="loki-notif-empty">Noch keine Aktivität.</div>';
      return;
    }
    const seen = getLS(LS_SEEN);
    list.innerHTML = events.slice(0, MAX_ITEMS).map((ev) => {
      const fresh = ev.ts > seen ? ' loki-notif-item--fresh' : '';
      return (
        `<button type="button" class="loki-notif-item${fresh}" data-job="${esc(ev.jobId || '')}" data-src="${esc(ev.source)}">` +
        `<span class="loki-notif-ico">${statusIcon(ev.status)}</span>` +
        `<span class="loki-notif-body">` +
        `<span class="loki-notif-name">${esc(ev.title)}</span>` +
        `<span class="loki-notif-meta">${esc(ev.source)} · ${esc(relTime(ev.ts))}</span>` +
        `</span></button>`
      );
    }).join('') + '<div class="loki-notif-detail" id="lokiNotifDetail" hidden></div>';

    list.querySelectorAll('.loki-notif-item').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const job = el.getAttribute('data-job');
        const src = el.getAttribute('data-src');
        if (src === 'tasks' && job) showTaskOutput(job, el);
      });
    });
  }

  async function showTaskOutput(jobId, anchorEl) {
    const detail = document.getElementById('lokiNotifDetail');
    if (!detail) return;
    detail.hidden = false;
    detail.textContent = 'lädt…';
    try {
      const r = await fetch('/api/crons/output?job_id=' + encodeURIComponent(jobId), { cache: 'no-store' });
      const data = r.ok ? await r.json() : null;
      // tolerant gegenüber Feldnamen: output / content / text / result
      let out = '';
      if (data) out = data.output || data.content || data.text || data.result || JSON.stringify(data, null, 2);
      detail.textContent = out ? String(out).slice(0, 4000) : 'Keine Ausgabe gespeichert.';
    } catch (err) {
      detail.textContent = 'Ausgabe konnte nicht geladen werden.';
    }
  }

  // ── Badge + gelesen ──────────────────────────────────────────────────────
  function updateBadge() {
    const badge = document.getElementById('lokiNotifBadge');
    if (!badge) return;
    const seen = getLS(LS_SEEN);
    const unread = events.filter((ev) => ev.ts > seen).length;
    if (unread > 0) {
      badge.hidden = false;
      badge.textContent = unread > 99 ? '99+' : String(unread);
      document.getElementById('lokiNotifBell')?.classList.add('loki-notif-bell--active');
    } else {
      badge.hidden = true;
      document.getElementById('lokiNotifBell')?.classList.remove('loki-notif-bell--active');
    }
  }

  function markAllRead() {
    const newest = events.reduce((m, ev) => Math.max(m, ev.ts), getLS(LS_SEEN));
    setLS(LS_SEEN, newest);
    updateBadge();
    renderPanel();
  }

  // ── Browser-Notifications ──────────────────────────────────────────────────
  function canNotify() {
    return ('Notification' in window) && Notification.permission === 'granted';
  }

  function refreshPermHint() {
    const perm = document.getElementById('lokiNotifPerm');
    if (!perm) return;
    const need = ('Notification' in window) && Notification.permission === 'default';
    perm.hidden = !need;
  }

  async function requestPermission() {
    if (!('Notification' in window)) return;
    try { await Notification.requestPermission(); } catch (_) {}
    refreshPermHint();
  }

  function firePopups(fresh) {
    if (!canNotify() || !fresh.length) return;
    // bei Schwung mehrerer Events nicht fluten: max 3 Einzel-Popups, sonst Sammel
    if (fresh.length <= 3) {
      fresh.forEach((ev) => {
        try {
          new Notification(`${statusIcon(ev.status)} ${ev.title}`, {
            body: `${ev.source} · ${relTime(ev.ts)}`,
            tag: ev.key,
          });
        } catch (_) {}
      });
    } else {
      try {
        new Notification(`${fresh.length} neue Aktivitäten`, {
          body: fresh.slice(0, 4).map((e) => e.title).join(', ') + '…',
          tag: 'loki-batch',
        });
      } catch (_) {}
    }
  }

  // ── Polling ────────────────────────────────────────────────────────────────
  async function poll() {
    let collected = [];
    for (const src of SOURCES) {
      try {
        const evs = await src.fetchEvents();
        if (Array.isArray(evs)) collected = collected.concat(evs);
      } catch (_) { /* Quelle fehlgeschlagen → ignorieren, andere weiter */ }
    }
    // dedupe per key, sortieren nach ts desc
    const seenKeys = new Set();
    collected = collected.filter((e) => (e && !seenKeys.has(e.key)) ? (seenKeys.add(e.key), true) : false);
    collected.sort((a, b) => b.ts - a.ts);

    // Popups nur für wirklich neue (ts > notified). Erstlauf: notified initialisieren,
    // damit nicht die gesamte Historie auf einmal poppt.
    const notified = getLS(LS_NOTIFIED);
    const newestTs = collected.reduce((m, e) => Math.max(m, e.ts), 0);
    if (notified === 0) {
      setLS(LS_NOTIFIED, newestTs); // erster Lauf: alles als "bereits gesehen"
    } else {
      const fresh = collected.filter((e) => e.ts > notified);
      if (fresh.length) { firePopups(fresh); setLS(LS_NOTIFIED, newestTs); }
    }

    events = collected;
    renderPanel();
    updateBadge();
  }

  function startPolling() {
    poll();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(poll, POLL_MS);
    // bei Tab-Reaktivierung sofort aktualisieren
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  }

  // ── Mount + Re-Insert-Observer ─────────────────────────────────────────────
  function boot() {
    ensureMounted();
    startPolling();
    const obs = new MutationObserver(() => { ensureMounted(); });
    obs.observe(document.body, { childList: true, subtree: true });
    window.__lokiNotifObserver = obs;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();

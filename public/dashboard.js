/* Dashboard: Klassen verwalten, Sitzungen starten, Live-Übersicht, Exporte */
(function () {
  'use strict';

  var state = { klasseId: null, sitzungId: null, timer: null };

  var el = function (id) { return document.getElementById(id); };
  var klasseForm = el('klasse-form'), klasseName = el('klasse-name'), klassenListe = el('klassen-liste'), klassenMeldung = el('klassen-meldung');
  var detail = el('klasse-detail'), detailTitel = el('detail-titel'), sitzungenListe = el('sitzungen-liste'), sitzungMeldung = el('sitzung-meldung');
  var sitzungForm = el('sitzung-form'), sFach = el('s-fach'), sDatum = el('s-datum'), sStunde = el('s-stunde'),
      sBegruendung = el('s-begruendung');
  var ueb = el('uebersicht'), uebTitel = el('ueb-titel'), uebQr = el('ueb-qr'), uebQrLink = el('ueb-qr-link'),
      uebStatus = el('ueb-status'), uebStats = el('ueb-stats'), uebListe = el('ueb-liste'),
      uebLink = el('ueb-link'), uebCopy = el('ueb-copy');

  sDatum.value = new Date().toISOString().slice(0, 10);

  async function api(path, opts) {
    var r = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin'
    }, opts || {}));
    if (r.status === 401) { window.location.href = '/admin/login'; throw new Error('Nicht eingeloggt.'); }
    var body = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(body.error || 'Fehler (' + r.status + ')');
    return body;
  }

  function meldung(elm, text, fehler) {
    elm.textContent = text || '';
    elm.className = 'meldung' + (fehler ? ' fehler' : '');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function statusBadge(status) {
    var cls = status === 'offen' ? 'badge badge-offen' : status === 'geschlossen' ? 'badge badge-geschlossen' : 'badge badge-archiviert';
    return '<span class="' + cls + '">' + esc(status) + '</span>';
  }

  // Anzeige-Label der Note mit Tendenz, z. B. "2+" oder "2-"
  function noteLabel(note, tendenz) {
    return String(note) + (tendenz === '+' || tendenz === '-' ? tendenz : '');
  }

  // Zahlenwert für den Durchschnitt in Drittelstufen: 1+ = 0,67 ... 5- = 5,33, 6 = 6
  function noteWert(note, tendenz) {
    if (tendenz === '+') return note - 1 / 3;
    if (tendenz === '-') return note + 1 / 3;
    return note;
  }

  // ---------- Klassen ----------

  async function ladeKlassen() {
    var data = await api('/api/klassen');
    klassenListe.innerHTML = '';
    if (!data.klassen.length) {
      klassenListe.innerHTML = '<p class="hint">Noch keine Klassen — lege oben deine erste Klasse an.</p>';
      return;
    }
    data.klassen.forEach(function (k) {
      var div = document.createElement('div');
      div.className = 'karte klasse-karte';
      var initial = (k.name || '?').trim().charAt(0).toUpperCase();
      div.innerHTML =
        '<div class="kopf"><span class="avatar">' + esc(initial) + '</span>' +
        '<div><h3>' + esc(k.name) + '</h3>' +
        '<p class="hint">' + k.sitzungsanzahl + ' Sitzung(en)' +
        (k.offene > 0 ? ' · <strong>' + k.offene + ' offen</strong>' : '') + '</p></div></div>' +
        '<div class="row">' +
        '<button class="btn btn-klein" type="button">Öffnen</button>' +
        '<button class="btn btn-danger btn-ghost btn-klein" type="button">Löschen</button>' +
        '</div>';
      div.querySelector('.btn').addEventListener('click', function () { oeffneKlasse(k.id, k.name); });
      div.querySelector('.btn-danger').addEventListener('click', async function () {
        if (!confirm('Klasse "' + k.name + '" inkl. aller Sitzungen wirklich löschen?')) return;
        try {
          await api('/api/klassen/' + k.id, { method: 'DELETE' });
          if (state.klasseId === k.id) schliesseDetail();
          ladeKlassen();
        } catch (err) { meldung(klassenMeldung, err.message, true); }
      });
      klassenListe.appendChild(div);
    });
  }

  klasseForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    try {
      await api('/api/klassen', { method: 'POST', body: JSON.stringify({ name: klasseName.value }) });
      klasseName.value = '';
      meldung(klassenMeldung, 'Klasse angelegt.');
      ladeKlassen();
    } catch (err) { meldung(klassenMeldung, err.message, true); }
  });

  // ---------- Klasse im Detail ----------

  async function oeffneKlasse(id, name) {
    state.klasseId = id;
    detailTitel.textContent = name;
    detail.classList.remove('hidden');
    ueb.classList.add('hidden');
    stopTimer();
    await ladeSitzungen();
    detail.scrollIntoView({ behavior: 'smooth' });
  }

  function schliesseDetail() {
    state.klasseId = null;
    detail.classList.add('hidden');
    ueb.classList.add('hidden');
    stopTimer();
  }
  el('detail-zurueck').addEventListener('click', schliesseDetail);

  async function ladeSitzungen() {
    var data = await api('/api/klassen/' + state.klasseId);
    sitzungenListe.innerHTML = '';
    if (!data.sitzungen.length) {
      sitzungenListe.innerHTML = '<p class="hint">Noch keine Sitzungen — starte oben eine neue Sitzung.</p>';
      return;
    }
    data.sitzungen.forEach(function (s) {
      var div = document.createElement('div');
      div.className = 'karte sitzung-karte';
      div.innerHTML =
        '<div class="row spread wrap-row">' +
          '<div><strong>' + esc(s.fach) + '</strong> · ' + esc(s.datum) + (s.stunde ? ' · ' + esc(s.stunde) : '') + '<br>' +
          '<span class="hint">Einträge: ' + s.anzahl + '</span>' +
          (s.begruendung_erlaubt ? ' <span class="badge badge-offen">Begründung aktiv</span>' : '') + '</div>' +
          statusBadge(s.status) +
        '</div>' +
        '<div class="row wrap-row mt">' +
          '<button class="btn btn-klein" type="button">Übersicht / QR</button>' +
        '</div>';
      div.querySelector('.btn').addEventListener('click', function () { oeffneUebersicht(s.id); });
      sitzungenListe.appendChild(div);
    });
  }

  sitzungForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    try {
      await api('/api/klassen/' + state.klasseId + '/sitzungen', {
        method: 'POST',
        body: JSON.stringify({ fach: sFach.value, datum: sDatum.value, stunde: sStunde.value, begruendung_erlaubt: sBegruendung.checked })
      });
      sFach.value = ''; sStunde.value = ''; sBegruendung.checked = false;
      meldung(sitzungMeldung, 'Sitzung gestartet — QR-Code in der Übersicht anzeigen.');
      ladeSitzungen();
    } catch (err) { meldung(sitzungMeldung, err.message, true); }
  });

  // ---------- Übersicht ----------

  async function oeffneUebersicht(id) {
    state.sitzungId = id;
    ueb.classList.remove('hidden');
    await ladeUebersicht();
    stopTimer();
    state.timer = setInterval(function () {
      if (state.sitzungId) ladeUebersicht(true);
    }, 5000);
    ueb.scrollIntoView({ behavior: 'smooth' });
  }

  function stopTimer() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }

  async function ladeUebersicht(still) {
    if (!state.sitzungId) return;
    try {
      var data = await api('/api/sitzungen/' + state.sitzungId);
      var s = data.sitzung, eintraege = data.eintraege;
      uebTitel.textContent = s.fach + ' – ' + s.klasse_name + ' (' + s.datum + (s.stunde ? ', ' + s.stunde : '') + ')';
      uebQr.src = '/qr/' + s.token + '.svg';
      uebQrLink.href = '/qr/' + s.token;
      uebStatus.innerHTML = statusBadge(s.status) +
        (s.begruendung_erlaubt ? ' <span class="badge badge-offen">Begründung aktiv</span>' : '') +
        ' <span class="hint">aktualisiert alle 5 s</span>';
      uebLink.value = window.location.origin + '/s/' + s.token;
      el('ueb-csv').href = '/api/sitzungen/' + s.id + '/export.csv';
      el('ueb-pdf').href = '/api/sitzungen/' + s.id + '/export.pdf';
      el('ueb-schliessen').disabled = s.status !== 'offen';
      el('ueb-archivieren').disabled = s.status === 'archiviert';

      var summe = 0;
      uebListe.innerHTML = '';
      eintraege.forEach(function (e) {
        summe += noteWert(e.note, e.tendenz);
        var div = document.createElement('div');
        div.className = 'eintrag';
        div.innerHTML =
          '<span class="name">' + esc(e.vorname) +
            (e.begruendung ? '<span class="begruendung-text">' + esc(e.begruendung) + '</span>' : '') +
          '</span>' +
          '<span>' + esc(e.initials) + '</span>' +
          '<span><span class="note-pill" data-note="' + e.note + '"' +
            (e.tendenz ? ' data-tendenz="' + esc(e.tendenz) + '"' : '') + '>' +
            esc(noteLabel(e.note, e.tendenz)) + '</span></span>' +
          '<span class="hint versteckt-mobil">' + esc(e.erstellt_am) + '</span>' +
          '<span class="hint versteckt-mobil">' + esc(e.geaendert_am || '–') + '</span>';
        uebListe.appendChild(div);
      });
      var avg = eintraege.length ? (summe / eintraege.length).toFixed(2).replace('.', ',') : '–';
      uebStats.textContent = eintraege.length + ' Einträge · Ø Note: ' + avg;
    } catch (err) {
      if (!still) meldung(uebStatus, err.message, true);
    }
  }

  el('ueb-refresh').addEventListener('click', function () { ladeUebersicht(); });
  uebCopy.addEventListener('click', async function () {
    try {
      await navigator.clipboard.writeText(uebLink.value);
      uebCopy.textContent = 'Kopiert!';
      setTimeout(function () { uebCopy.textContent = 'Link kopieren'; }, 1500);
    } catch (err) {
      uebLink.select();
      document.execCommand('copy');
      uebCopy.textContent = 'Kopiert!';
      setTimeout(function () { uebCopy.textContent = 'Link kopieren'; }, 1500);
    }
  });
  el('ueb-schliessen').addEventListener('click', async function () {
    try {
      await api('/api/sitzungen/' + state.sitzungId + '/schliessen', { method: 'POST' });
      ladeUebersicht();
    } catch (err) { alert(err.message); }
  });
  el('ueb-archivieren').addEventListener('click', async function () {
    if (!confirm('Sitzung archivieren? Danach sind keine Änderungen mehr möglich.')) return;
    try {
      await api('/api/sitzungen/' + state.sitzungId + '/archivieren', { method: 'POST' });
      ladeUebersicht();
      ladeSitzungen();
    } catch (err) { alert(err.message); }
  });

  // ---------- Kopf ----------

  el('logout').addEventListener('click', async function () {
    await fetch('/api/lehrer/logout', { method: 'POST', credentials: 'same-origin' });
    window.location.href = '/admin/login';
  });

  (async function init() {
    try {
      var me = await api('/api/me');
      el('me').textContent = me.email;
    } catch (err) { /* leitet ohnehin zum Login um */ }
    ladeKlassen();
  })();
})();

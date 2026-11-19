/* Schüler-Seite: Sitzung laden, Note per Chip abgeben (wird einmalig gespeichert, keine Änderung möglich) */
(function () {
  'use strict';

  var token = window.location.pathname.split('/').filter(Boolean).pop();
  var titel = document.getElementById('titel');
  var info = document.getElementById('info');
  var form = document.getElementById('form');
  var vorname = document.getElementById('vorname');
  var initials = document.getElementById('initials');
  var chips = document.getElementById('chips');
  var begruendungLabel = document.getElementById('begruendung-label');
  var begruendung = document.getElementById('begruendung');
  var meldung = document.getElementById('meldung');
  var erfolg = document.getElementById('erfolg');
  var erfolgText = document.getElementById('erfolg-text');
  var geschlossen = document.getElementById('geschlossen');

  var selectedNote = null;
  var selectedTendenz = '';
  var storageKey = 'notenqr_' + token;

  function noteLabel(note, tendenz) {
    return String(note) + (tendenz === '+' || tendenz === '-' ? tendenz : '');
  }

  function waehleChip(note, tendenz) {
    selectedNote = note;
    selectedTendenz = tendenz || '';
    var alle = chips.querySelectorAll('.chip');
    for (var i = 0; i < alle.length; i++) {
      var gleich = Number(alle[i].getAttribute('data-note')) === note &&
        (alle[i].getAttribute('data-tendenz') || '') === selectedTendenz;
      alle[i].classList.toggle('selected', gleich);
    }
  }

  chips.addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (chip) waehleChip(Number(chip.getAttribute('data-note')), chip.getAttribute('data-tendenz') || '');
  });

  function zeigeFehler(text) {
    erfolg.classList.add('hidden');
    meldung.textContent = text;
    meldung.className = 'meldung fehler';
  }

  async function ladeSitzung() {
    try {
      var r = await fetch('/api/s/' + encodeURIComponent(token));
      if (r.status === 404) {
        info.textContent = 'Diese Sitzung wurde nicht gefunden. Bitte den QR-Code erneut scannen.';
        return;
      }
      var s = await r.json();
      titel.textContent = s.fach + ' – ' + s.klasse_name;
      info.textContent = 'Unterrichtsstunde vom ' + s.datum + (s.stunde ? ' (' + s.stunde + ')' : '') +
        '. Wie fandest du die Stunde? Gib dir selbst eine Note von 1 (sehr gut) bis 6 (ungenügend) – optional mit Plus/Minus-Tendenz, z. B. 2+ oder 2-.';
      if (s.status !== 'offen') {
        geschlossen.classList.remove('hidden');
        form.classList.add('hidden');
        return;
      }
      form.classList.remove('hidden');
      // Begründungsfeld nur anzeigen, wenn die Lehrkraft es für diese Sitzung aktiviert hat
      if (s.begruendung_erlaubt) begruendungLabel.classList.remove('hidden');
      try {
        var saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
        if (saved) { vorname.value = saved.vorname || ''; initials.value = saved.initials || ''; }
      } catch (e) { /* egal */ }
    } catch (e) {
      info.textContent = 'Fehler beim Laden. Bitte Seite neu laden.';
    }
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    meldung.textContent = '';
    if (!selectedNote) {
      zeigeFehler('Bitte wähle zuerst eine Note aus.');
      return;
    }
    var label = noteLabel(selectedNote, selectedTendenz);
    if (!confirm('Deine Note ' + label + ' wird endgültig gespeichert und kann danach nicht mehr geändert werden. Trotzdem abgeben?')) {
      return;
    }
    var payload = {
      vorname: vorname.value.trim(),
      initials: initials.value.trim(),
      note: selectedNote,
      tendenz: selectedTendenz,
      begruendung: begruendung.value.trim()
    };
    try {
      var r = await fetch('/api/s/' + encodeURIComponent(token) + '/eintrag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      var body = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(body.error || 'Fehler (' + r.status + ')');
      localStorage.setItem(storageKey, JSON.stringify({ vorname: payload.vorname, initials: payload.initials }));
      meldung.textContent = '';
      form.classList.add('hidden');
      erfolgText.innerHTML = 'Danke, <strong>' + escapeHtml(payload.vorname) + '</strong>! Deine Note <strong>' +
        escapeHtml(noteLabel(body.note, body.tendenz)) + '</strong> wurde endgültig gespeichert und kann nicht mehr geändert werden.';
      erfolg.classList.remove('hidden');
      erfolg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      zeigeFehler(err.message);
    }
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  initials.addEventListener('input', function () {
    initials.value = initials.value.replace(/[^A-Za-zÀ-ÿß]/g, '').slice(0, 2);
  });

  ladeSitzung();
})();

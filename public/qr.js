/* Große QR-Ansicht unter /qr/<token>: zeigt das SVG (/qr/<token>.svg) großflächig an */
(function () {
  'use strict';

  var token = window.location.pathname.split('/').filter(Boolean).pop();
  var titel = document.getElementById('titel');
  var info = document.getElementById('info');
  var qr = document.getElementById('qr');
  var url = document.getElementById('url');
  var meldung = document.getElementById('meldung');

  qr.src = '/qr/' + encodeURIComponent(token) + '.svg';

  (async function ladeSitzung() {
    try {
      var r = await fetch('/api/s/' + encodeURIComponent(token));
      if (r.status === 404) {
        info.textContent = 'Diese Sitzung wurde nicht gefunden.';
        qr.remove();
        url.textContent = '';
        return;
      }
      var s = await r.json();
      titel.textContent = s.fach + ' – ' + s.klasse_name;
      info.textContent = 'Unterrichtsstunde vom ' + s.datum + (s.stunde ? ' (' + s.stunde + ')' : '') +
        (s.status !== 'offen' ? ' · Sitzung: ' + s.status : '');
      url.textContent = window.location.origin + '/s/' + token;
    } catch (e) {
      meldung.textContent = 'Fehler beim Laden. Bitte Seite neu laden.';
    }
  })();
})();

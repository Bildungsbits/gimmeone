/* Login/Registrierung – schickt JSON an die API, Cookie wird automatisch gesetzt */
(function () {
  'use strict';

  var tabLogin = document.getElementById('tab-login');
  var tabRegister = document.getElementById('tab-register');
  var loginForm = document.getElementById('login-form');
  var registerForm = document.getElementById('register-form');
  var meldung = document.getElementById('meldung');

  function show(tab) {
    var login = tab === 'login';
    tabLogin.classList.toggle('active', login);
    tabRegister.classList.toggle('active', !login);
    loginForm.classList.toggle('hidden', !login);
    registerForm.classList.toggle('hidden', login);
    meldung.textContent = '';
    meldung.className = 'meldung';
  }
  tabLogin.addEventListener('click', function () { show('login'); });
  tabRegister.addEventListener('click', function () { show('register'); });

  function fehler(text) {
    meldung.textContent = text;
    meldung.className = 'meldung fehler';
  }

  async function post(path, data) {
    var r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(data)
    });
    var body = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(body.error || 'Fehler (' + r.status + ')');
    return body;
  }

  loginForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    try {
      await post('/api/lehrer/login', {
        email: document.getElementById('login-email').value,
        passwort: document.getElementById('login-passwort').value
      });
      window.location.href = '/admin';
    } catch (err) {
      fehler(err.message);
    }
  });

  registerForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    try {
      await post('/api/lehrer/registrieren', {
        email: document.getElementById('reg-email').value,
        passwort: document.getElementById('reg-passwort').value
      });
      window.location.href = '/admin';
    } catch (err) {
      fehler(err.message);
    }
  });
})();

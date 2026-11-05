(function () {
  'use strict';

  const DASHBOARD_URL = 'dashboard.html';

  // Student number (8 digits) + @dut4life.ac.za, e.g. 12345678@dut4life.ac.za
  const EMAIL_RE = /^\d{8}@dut4life\.ac\.za$/i;
  const PHONE_RE = /^0\d{9}$/;

  const $ = (id) => document.getElementById(id);

  /* ---------- talking to the server ---------- */
  async function api(method, url, body) {
    try {
      const res = await fetch(url, {
        method: method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'same-origin'
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data: data, error: data.error };
    } catch (e) {
      return { ok: false, status: 0, data: {}, error: 'Cannot reach the server. Check your connection and try again.' };
    }
  }

  function lock(form, on) {
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = on;
  }

  function setMsg(id, text, type) {
    const el = $(id);
    el.textContent = text || '';
    el.className = 'msg' + (type ? ' ' + type : '');
  }

  /* ---------- tabs ---------- */
  const tabs = document.querySelectorAll('.tab');
    const panels = { login: $('panel-login'), signup: $('panel-signup'), forgot: $('panel-forgot'), admin: $('panel-admin') };

  function showTab(name) {
    if (!panels[name]) name = 'login';
    tabs.forEach((t) => {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    Object.keys(panels).forEach((key) => { panels[key].hidden = key !== name; });
    history.replaceState(null, '', '#' + name);
    document.title = 'UniLift – ' + { login: 'Log in', signup: 'Sign up', forgot: 'Reset password' }[name];
  }

  tabs.forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.go)));
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

  /* ---------- show / hide password ---------- */
  document.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.toggle);
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      btn.textContent = hidden ? 'Hide' : 'Show';
    });
  });

  /* ---------- LOG IN ---------- */
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const email = $('login-email').value.trim().toLowerCase();
    const password = $('login-password').value;

    if (!EMAIL_RE.test(email)) return setMsg('login-msg', 'Use your student email, like 12345678@dut4life.ac.za.', 'error');
    if (!password) return setMsg('login-msg', 'Enter your password.', 'error');

    lock(form, true);
    setMsg('login-msg', 'Logging in…');
    const res = await api('POST', '/api/auth/login', { email: email, password: password, remember: $('login-remember').checked });
    lock(form, false);

      if (!res.ok) return setMsg('login-msg', res.error || 'Could not log in.', 'error');

      setMsg('login-msg', 'Logged in. Taking you to your dashboard…', 'ok');

      if (res.data.user && res.data.user.role === 'admin') {
          window.location.href = 'admin.html';
      } else {
          window.location.href = DASHBOARD_URL;
      }
  });
    /* ---------- ADMIN LOG IN ---------- */
    $('admin-login-form').addEventListener('submit', async (e) => {
        e.preventDefault();

        const form = e.currentTarget;
        const email = $('admin-email').value.trim().toLowerCase();
        const password = $('admin-password').value;

        if (!EMAIL_RE.test(email)) {
            return setMsg(
                'admin-login-msg',
                'Use your student email, like 12345678@dut4life.ac.za.',
                'error'
            );
        }

        if (!password) {
            return setMsg('admin-login-msg', 'Enter your password.', 'error');
        }

        lock(form, true);
        setMsg('admin-login-msg', 'Logging in…');

        const res = await api('POST', '/api/auth/login', {
            email: email,
            password: password,
            remember: true,adminOnly:true
        });

        lock(form, false);

        if (!res.ok) {
            return setMsg(
                'admin-login-msg',
                res.error || 'Could not log in.',
                'error'
            );
        }

        if (!res.data.user || res.data.user.role !== 'admin') {
            return setMsg(
                'admin-login-msg',
                'This account does not have administrator access.',
                'error'
            );
        }

        setMsg('admin-login-msg', 'Logged in. Opening admin panel…', 'ok');

        window.location.href = 'admin.html';
    });


  /* ---------- SIGN UP ---------- */
  $('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const role = document.querySelector('input[name="role"]:checked').value;
    const name = $('su-name').value.trim();
    const email = $('su-email').value.trim().toLowerCase();
    const phone = $('su-phone').value.replace(/\s+/g, '');
    const pass = $('su-pass').value;
    const pass2 = $('su-pass2').value;
    const question = $('su-question').value;
    const answer = $('su-answer').value.trim();

    if (name.length < 2) return setMsg('signup-msg', 'Enter your full name.', 'error');
    if (!EMAIL_RE.test(email)) return setMsg('signup-msg', 'Email must look like 12345678@dut4life.ac.za.', 'error');
    if (!PHONE_RE.test(phone)) return setMsg('signup-msg', 'Enter a 10-digit phone number, like 082 000 0000.', 'error');
    if (pass.length < 8) return setMsg('signup-msg', 'Password must be at least 8 characters.', 'error');
    if (pass !== pass2) return setMsg('signup-msg', "Passwords don't match.", 'error');
    if (!question) return setMsg('signup-msg', 'Choose a security question.', 'error');
    if (answer.length < 2) return setMsg('signup-msg', 'Enter an answer to your security question.', 'error');
    if (!$('su-terms').checked) return setMsg('signup-msg', 'Agree to the terms and campus safety guidelines to continue.', 'error');

    lock(form, true);
    setMsg('signup-msg', 'Creating your account…');
    const res = await api('POST', '/api/auth/register', {
      role: role, name: name, email: email, phone: phone, password: pass, question: question, answer: answer
    });
    lock(form, false);

    if (!res.ok) return setMsg('signup-msg', res.error || 'Could not create your account.', 'error');

    form.reset();
    setMsg('signup-msg', '');
    $('login-email').value = email;
    $('login-password').value = '';
    showTab('login');
    setMsg('login-msg', 'Account created. Log in to continue.', 'ok');
    $('login-password').focus();
  });

  /* ---------- FORGOT PASSWORD ---------- */
  let resetEmail = null;

  $('forgot-step1').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const email = $('fp-email').value.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return setMsg('fp1-msg', 'Use your student email, like 12345678@dut4life.ac.za.', 'error');

    lock(form, true);
    const res = await api('POST', '/api/auth/question', { email: email });
    lock(form, false);
    if (!res.ok) return setMsg('fp1-msg', res.error || 'Something went wrong.', 'error');

    resetEmail = email;
    $('fp-question').textContent = res.data.question;
    setMsg('fp1-msg', '');
    $('forgot-step1').hidden = true;
    $('forgot-step2').hidden = false;
    $('fp-answer').focus();
  });

  $('forgot-step2').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const answer = $('fp-answer').value.trim();
    const pass = $('fp-pass').value;
    const pass2 = $('fp-pass2').value;

    if (!resetEmail) return setMsg('fp2-msg', 'Something went wrong. Start again.', 'error');
    if (!answer) return setMsg('fp2-msg', 'Enter your answer.', 'error');
    if (pass.length < 8) return setMsg('fp2-msg', 'New password must be at least 8 characters.', 'error');
    if (pass !== pass2) return setMsg('fp2-msg', "Passwords don't match.", 'error');

    lock(form, true);
    const res = await api('POST', '/api/auth/reset', { email: resetEmail, answer: answer, password: pass });
    lock(form, false);
    if (!res.ok) return setMsg('fp2-msg', res.error || 'Could not reset your password.', 'error');

    const email = resetEmail;
    resetEmail = null;
    form.reset();
    form.hidden = true;
    $('forgot-step1').hidden = false;
    $('forgot-step1').reset();
    setMsg('fp2-msg', '');

    $('login-email').value = email;
    $('login-password').value = '';
    showTab('login');
    setMsg('login-msg', 'Password updated. Log in with your new password.', 'ok');
    $('login-password').focus();
  });

  /* ---------- start ---------- */
  showTab(location.hash.slice(1) || 'login');

  // Already logged in? Skip straight to the dashboard.
    api('GET', '/api/me').then((res) => { if (res.ok && res.data.user) window.location.replace(res.data.user.role === 'admin' ? 'admin.html' : DASHBOARD_URL); });
})();

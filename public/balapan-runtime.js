/* Балапан ЖИ — сайттың өз «runtime»-ы.
   Бет бұрын claude.ai ішінде window.claude.use('sample'|'db'|'user'|'downloads') арқылы жұмыс істеді.
   Бұл файл сол интерфейсті өз серверімізге (/api/*) қосады: email+құпиясөзбен кіру, профиль, ЖИ. */
(function () {
  'use strict';
  let user = null;
  let resolveAuth;
  const authed = new Promise((r) => (resolveAuth = r));

  async function api(path, opts = {}) {
    const r = await fetch(path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: opts.body ? { 'content-type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await r.json(); } catch (e) {}
    if (!r.ok) {
      const e = new Error((data && data.error && data.error.message) || 'Қате');
      e.code = (data && data.error && data.error.code) || 'failed';
      e.status = r.status;
      if (r.status === 401) showAuth();
      throw e;
    }
    return data;
  }

  /* ---------- Кіру / тіркелу терезесі ---------- */
  const CSS = `
  #bauth{position:fixed;inset:0;z-index:9999;background:linear-gradient(180deg,#eafbe0,#ffffff 60%);display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto;font-family:Nunito,system-ui,sans-serif;color:#2b2b2b}
  #bauth[hidden]{display:none!important}
  #bauth .bx{width:100%;max-width:400px;background:#fff;border:2px solid #e5e5e5;border-radius:24px;padding:26px 22px 20px;box-shadow:0 4px 0 #e5e5e5;text-align:center}
  #bauth img{width:92px;height:92px;border-radius:24px}
  #bauth h1{margin:10px 0 2px;font-size:28px;font-weight:900;color:#3c3c3c}
  #bauth .sub{margin:0 0 16px;color:#777;font-weight:700;font-size:15px}
  #bauth .sw{display:grid;grid-template-columns:1fr 1fr;gap:6px;background:#f2f2f2;border-radius:14px;padding:4px;margin-bottom:14px}
  #bauth .sw button{border:0;background:transparent;font:inherit;font-weight:800;font-size:15px;padding:9px;border-radius:11px;color:#777;cursor:pointer}
  #bauth .sw button[aria-pressed=true]{background:#fff;color:#58a700;box-shadow:0 2px 0 #e0e0e0}
  #bauth label{display:block;text-align:left;font-weight:800;font-size:14px;margin:10px 0 4px}
  #bauth input{width:100%;box-sizing:border-box;font:inherit;font-size:16px;padding:12px 14px;border:2px solid #e5e5e5;border-radius:14px;background:#f7f7f7;color:#2b2b2b}
  #bauth input:focus{outline:none;border-color:#58c322;background:#fff}
  #bauth .go2{margin-top:16px;width:100%;border:0;background:#58c322;color:#fff;font:inherit;font-weight:900;font-size:17px;padding:14px;border-radius:16px;cursor:pointer;box-shadow:0 4px 0 #46a302;text-transform:none}
  #bauth .go2:active{transform:translateY(2px);box-shadow:0 2px 0 #46a302}
  #bauth .go2:disabled{opacity:.6;cursor:wait}
  #bauth .bmsg{background:none;border:0;padding:0;box-shadow:none;min-height:20px;margin:12px 0 0;font-weight:800;font-size:14px;color:#d33}
  #bauth .ft{margin:14px 0 0;color:#999;font-size:13px;font-weight:700}
  #bauth .eye{display:flex;align-items:center;gap:6px;margin-top:6px;font-size:13px;color:#777;font-weight:700;text-align:left}
  #bauth .eye input{width:auto}
  `;
  let box, mode = 'register';
  function buildAuth() {
    if (box) return box;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    box = document.createElement('div'); box.id = 'bauth'; box.hidden = true;
    box.innerHTML = `
      <form class="bx" novalidate>
        <img src="/logo.png" alt="Балапан ЖИ">
        <h1>Балапан ЖИ</h1>
        <p class="sub">Мектепке дейінгі ұйым педагогтерінің ЖИ-көмекшісі</p>
        <div class="sw" role="group">
          <button type="button" data-m="register">Тіркелу</button>
          <button type="button" data-m="login">Кіру</button>
        </div>
        <label for="ba-email">Email</label>
        <input id="ba-email" type="email" autocomplete="email" placeholder="mail@example.com" required>
        <label for="ba-pass">Құпиясөз</label>
        <input id="ba-pass" type="password" autocomplete="new-password" placeholder="кемінде 6 таңба" required>
        <label class="eye"><input type="checkbox" id="ba-show"> Құпиясөзді көрсету</label>
        <button class="go2" type="submit">Тіркелу</button>
        <p class="bmsg" role="alert"></p>
        <p class="ft">Тегін. Тек email мен құпиясөз керек.</p>
      </form>`;
    document.body.appendChild(box);
    const f = box.querySelector('form'), msg = box.querySelector(".bmsg"), go = box.querySelector('.go2');
    const em = box.querySelector('#ba-email'), pw = box.querySelector('#ba-pass');
    const setMode = (m) => {
      mode = m;
      box.querySelectorAll('.sw button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === m)));
      go.textContent = m === 'register' ? 'Тіркелу' : 'Кіру';
      pw.autocomplete = m === 'register' ? 'new-password' : 'current-password';
      msg.textContent = '';
    };
    box.querySelectorAll('.sw button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.m)));
    box.querySelector('#ba-show').addEventListener('change', (e) => (pw.type = e.target.checked ? 'text' : 'password'));
    let had = false; try { had = localStorage.getItem('balapan-had-account') === '1'; } catch (e) {}
    setMode(had ? 'login' : 'register');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.textContent = '';
      const email = em.value.trim(), password = pw.value;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.textContent = 'Email дұрыс емес.'; return; }
      if (password.length < 6) { msg.textContent = 'Құпиясөз кемінде 6 таңба болсын.'; return; }
      go.disabled = true;
      try {
        const u = await api('/api/' + (mode === 'register' ? 'register' : 'login'), { method: 'POST', body: { email, password } });
        try { localStorage.setItem('balapan-had-account', '1'); localStorage.removeItem('balapan-out'); } catch (e) {}
        onAuthed(u);
      } catch (err) {
        msg.textContent = err.message || 'Қате шықты, қайта көріңіз.';
        if (err.code === 'email_taken') setMode('login'), (msg.textContent = err.message);
      } finally { go.disabled = false; }
    });
    return box;
  }
  function showAuth() {
    const go = () => { buildAuth().hidden = false; document.documentElement.style.overflow = 'hidden'; };
    document.body ? go() : document.addEventListener('DOMContentLoaded', go);
  }
  function onAuthed(u) {
    const first = !user;
    user = u;
    if (box) box.hidden = true;
    document.documentElement.style.overflow = '';
    if (first) resolveAuth(u);
    else location.reload();
  }

  api('/api/me').then((d) => {
    if (d && d.user) onAuthed(d.user);
    else showAuth();
  }).catch(() => showAuth());

  /* ---------- db: members/<id> және members тізімі ---------- */
  const docListeners = new Set(), colListeners = new Set();
  let lastProfile;
  async function refreshDoc() {
    const d = await api('/api/profile');
    lastProfile = d.profile;
    docListeners.forEach((l) => l(lastProfile));
  }
  async function refreshCol() {
    if (!colListeners.size) return;
    const d = await api('/api/members');
    colListeners.forEach((l) => l(d.members || []));
  }
  const snapDoc = (p) => ({ exists: !!p, data: () => (p ? { ...p } : undefined) });
  function prefillEmail() {
    const el = document.getElementById('pf-email');
    if (el && !el.value && user) el.value = user.email;
  }
  const db = {
    doc() {
      return {
        onSnapshot(cb, onErr) {
          const l = (p) => { try { cb(snapDoc(p)); } catch (e) { console.error(e); } if (!p) setTimeout(prefillEmail, 0); };
          docListeners.add(l);
          refreshDoc().catch((e) => onErr && onErr(e));
          return () => docListeners.delete(l);
        },
        async get() { const d = await api('/api/profile'); return snapDoc(d.profile); },
        async set(data) {
          const d = await api('/api/profile', { method: 'PUT', body: data });
          lastProfile = d.profile;
          docListeners.forEach((l) => l(lastProfile));
          refreshCol().catch(() => {});
        },
        async delete() {
          await api('/api/profile', { method: 'DELETE' });
          lastProfile = null;
          docListeners.forEach((l) => l(null));
          refreshCol().catch(() => {});
        },
      };
    },
    collection() {
      const q = {
        orderBy() { return q; },
        limit() { return q; },
        onSnapshot(cb, onErr) {
          const l = (rows) => cb({ docs: rows.map((r) => ({ data: () => r })), size: rows.length });
          colListeners.add(l);
          api('/api/members').then((d) => l(d.members || [])).catch((e) => onErr && onErr(e));
          return () => colListeners.delete(l);
        },
      };
      return q;
    },
  };

  /* ---------- ЖИ (sample) ---------- */
  async function sample(prompt, opts = {}) {
    if (!user) { showAuth(); const e = new Error('auth'); e.code = 'not_granted'; throw e; }
    const r = await fetch('/api/ai', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: String(prompt) }),
    });
    if (!r.ok) {
      let d = null; try { d = await r.json(); } catch (e) {}
      const e = new Error((d && d.error && d.error.message) || 'Қате');
      e.code = (d && d.error && d.error.code) || 'failed';
      if (r.status === 401) { showAuth(); e.code = 'not_granted'; }
      if (e.code === 'rate_limited' && d && d.error && /лимит/.test(d.error.message)) alert(d.error.message);
      throw e;
    }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      const shown = text.replace(/\n*\[\[ERR:[a-z_]*\]?\]?$/, '').replace(/\n*\[\[?$/, '');
      if (opts.onText) try { opts.onText({ text: shown }); } catch (e) {}
    }
    text += dec.decode();
    const m = text.match(/\n*\[\[ERR:([a-z_]+)\]\]\s*$/);
    if (m) {
      const e = new Error('ai'); e.code = m[1] === 'rate_limited' ? 'rate_limited' : 'failed'; throw e;
    }
    return { text };
  }

  /* ---------- Жүктеу ---------- */
  const downloads = {
    async save({ filename, data, mimeType }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType || 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename || 'file';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    },
  };

  const userCap = {
    async id() { return user && user.id; },
    isOwner() { return !!(user && user.owner); },
    can() { return true; },
    async email() { return user && user.email; },
  };

  window.claude = {
    use(name) {
      if (name === 'sample') return Promise.resolve(sample);
      if (name === 'downloads') return Promise.resolve(downloads);
      if (name === 'user') return authed.then(() => userCap);
      if (name === 'db') return authed.then(() => db);
      return Promise.resolve(null);
    },
  };

  /* «Шығу» батырмасы — шынымен сессиядан шығу. */
  document.addEventListener('click', async (e) => {
    const b = e.target.closest && e.target.closest('#pf-out');
    if (!b) return;
    e.stopImmediatePropagation(); e.preventDefault();
    try { await api('/api/logout', { method: 'POST' }); } catch (x) {}
    try { localStorage.removeItem('balapan-out'); } catch (x) {}
    location.reload();
  }, true);
})();

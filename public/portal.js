// portal.js — client-side, read-only vault view unlocked by an access code.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let code = sessionStorage.getItem('cv_portal_code') || '';

  async function login(c) {
    const res = await fetch('/api/portal/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: c }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Login failed.');
    return data.client;
  }

  async function openVault(c) {
    code = c;
    sessionStorage.setItem('cv_portal_code', c);
    const res = await fetch(`/api/portal/${encodeURIComponent(c)}/notes`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load vault.');

    $('#login').classList.add('hidden');
    $('#vault').classList.remove('hidden');
    $('#vName').textContent = data.client.name;
    $('#vBiz').textContent = data.client.business || '';

    await loadDocs();

    const nav = $('#portalNav');
    nav.innerHTML = '';
    if (!data.notes.length) {
      $('#portalContent').innerHTML = '<p class="muted">Your vault is being set up. Check back soon.</p>';
      return;
    }
    data.notes.forEach((n, i) => {
      const btn = document.createElement('button');
      btn.textContent = n.name.replace(/\.md$/, '');
      btn.addEventListener('click', () => openNote(n.name, btn));
      nav.appendChild(btn);
      if (i === 0) openNote(n.name, btn);
    });
  }

  async function openNote(name, btn) {
    document.querySelectorAll('#portalNav button').forEach((b) => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const res = await fetch(`/api/portal/${encodeURIComponent(code)}/notes/${encodeURIComponent(name)}`);
    const data = await res.json();
    $('#portalContent').innerHTML = res.ok ? data.html : `<p class="muted">${esc(data.error || 'Could not load note.')}</p>`;
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2400);
  }

  const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

  // --- documents + signing ---------------------------------------------------
  async function loadDocs() {
    const res = await fetch(`/api/portal/${encodeURIComponent(code)}/documents`);
    const data = await res.json().catch(() => ({ documents: [] }));
    const wrap = $('#portalDocsWrap');
    const ul = $('#portalDocs');
    ul.innerHTML = '';
    if (!res.ok || !data.documents || !data.documents.length) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    for (const d of data.documents) {
      const li = document.createElement('li');
      li.style.justifyContent = 'space-between';
      const status = d.signature
        ? `<span class="muted" style="font-size:12px;color:var(--good)">✍ Signed ${new Date(d.signature.signedAt).toLocaleDateString()}</span>`
        : '';
      li.innerHTML =
        `<span style="display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap"><span class="doc-icon">📎</span>` +
        `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.name)}</span>` +
        `<span class="muted" style="font-size:12px">${fmtBytes(d.size)}</span>${status}</span>`;
      const actions = document.createElement('span');
      actions.className = 'row';
      const dl = document.createElement('button');
      dl.className = 'ghost'; dl.style.padding = '4px 9px'; dl.textContent = 'Download';
      dl.addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = `/api/portal/${encodeURIComponent(code)}/documents/${encodeURIComponent(d.name)}`;
        a.download = d.name; document.body.appendChild(a); a.click(); a.remove();
      });
      actions.appendChild(dl);
      if (!d.signature) {
        const sign = document.createElement('button');
        sign.className = 'primary'; sign.style.padding = '4px 12px'; sign.textContent = 'Sign';
        sign.addEventListener('click', () => openSign(d.name));
        actions.appendChild(sign);
      }
      li.appendChild(actions);
      ul.appendChild(li);
    }
  }

  // Signature pad ------------------------------------------------------------
  const pad = { canvas: null, ctx: null, drawing: false, dirty: false, doc: null };
  function setupPad() {
    pad.canvas = $('#sigPad');
    pad.ctx = pad.canvas.getContext('2d');
    pad.ctx.lineWidth = 2.2; pad.ctx.lineCap = 'round'; pad.ctx.strokeStyle = '#111';
    const pos = (e) => {
      const r = pad.canvas.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      return { x: (p.clientX - r.left) * (pad.canvas.width / r.width), y: (p.clientY - r.top) * (pad.canvas.height / r.height) };
    };
    const start = (e) => { e.preventDefault(); pad.drawing = true; pad.dirty = true; const { x, y } = pos(e); pad.ctx.beginPath(); pad.ctx.moveTo(x, y); };
    const move = (e) => { if (!pad.drawing) return; e.preventDefault(); const { x, y } = pos(e); pad.ctx.lineTo(x, y); pad.ctx.stroke(); };
    const end = () => { pad.drawing = false; };
    pad.canvas.addEventListener('mousedown', start); pad.canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    pad.canvas.addEventListener('touchstart', start, { passive: false });
    pad.canvas.addEventListener('touchmove', move, { passive: false });
    pad.canvas.addEventListener('touchend', end);
  }
  function clearPad() { pad.ctx.clearRect(0, 0, pad.canvas.width, pad.canvas.height); pad.dirty = false; }

  function openSign(docName) {
    pad.doc = docName;
    $('#signDocName').textContent = docName;
    $('#signName').value = '';
    $('#signAgree').checked = false;
    $('#signError').textContent = '';
    clearPad();
    $('#signModal').classList.add('open');
  }

  $('#sigClear').addEventListener('click', clearPad);
  $('#signCancel').addEventListener('click', () => $('#signModal').classList.remove('open'));
  $('#signSubmit').addEventListener('click', async () => {
    const name = $('#signName').value.trim();
    if (!name) { $('#signError').textContent = 'Please type your full name.'; return; }
    if (!pad.dirty) { $('#signError').textContent = 'Please draw your signature.'; return; }
    if (!$('#signAgree').checked) { $('#signError').textContent = 'Please check the agreement box.'; return; }
    try {
      const res = await fetch(`/api/portal/${encodeURIComponent(code)}/documents/${encodeURIComponent(pad.doc)}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signerName: name, signatureImage: pad.canvas.toDataURL('image/png') }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not save signature.');
      $('#signModal').classList.remove('open');
      toast('Signed — thank you!');
      await loadDocs();
    } catch (e) { $('#signError').textContent = e.message; }
  });

  $('#loginBtn').addEventListener('click', async () => {
    const c = $('#code').value.trim().toUpperCase();
    if (!c) return;
    try { await login(c); await openVault(c); }
    catch (e) { $('#loginError').textContent = e.message; }
  });
  $('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#loginBtn').click(); });
  $('#logoutBtn').addEventListener('click', () => {
    sessionStorage.removeItem('cv_portal_code');
    $('#vault').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#code').value = '';
  });

  setupPad();

  // Auto-open if we already have a code from this session.
  if (code) openVault(code).catch(() => sessionStorage.removeItem('cv_portal_code'));
})();

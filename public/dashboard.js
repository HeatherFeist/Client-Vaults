// dashboard.js — owner-side logic for Client Vaults.
(() => {
  const $ = (sel) => document.querySelector(sel);
  const state = { ownerKey: localStorage.getItem('cv_owner_key') || '', clients: [], selectedClient: null, selectedNote: null };

  // --- API helper ------------------------------------------------------------
  async function api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.ownerKey) headers['x-owner-key'] = state.ownerKey;
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // --- boot ------------------------------------------------------------------
  async function boot() {
    const cfg = await api('GET', '/api/config').catch(() => ({}));
    renderAgentStatus(cfg);

    if (cfg.ownerProtected) {
      // Verify any stored key; otherwise show the password gate.
      const ok = state.ownerKey && (await api('POST', '/api/owner/check', { password: state.ownerKey }).then((r) => r.ok).catch(() => false));
      if (!ok) return showGate();
    }
    showApp();
  }

  function renderAgentStatus(cfg) {
    const el = $('#agentStatus');
    if (cfg.hasApiKey) {
      el.className = 'status on';
      el.querySelector('.txt').textContent = `AI agent ready · ${cfg.agentModel || ''}`.trim();
    } else {
      el.className = 'status off';
      el.querySelector('.txt').textContent = 'AI agent off — add ANTHROPIC_API_KEY';
    }
  }

  function showGate() {
    $('#gate').classList.remove('hidden');
    $('#app').classList.add('hidden');
  }

  async function showApp() {
    $('#gate').classList.add('hidden');
    $('#app').classList.remove('hidden');
    await loadClients();
  }

  $('#unlockBtn').addEventListener('click', async () => {
    const pw = $('#ownerPassword').value;
    const ok = await api('POST', '/api/owner/check', { password: pw }).then((r) => r.ok).catch(() => false);
    if (!ok) { $('#gateError').textContent = 'Incorrect password.'; return; }
    state.ownerKey = pw;
    localStorage.setItem('cv_owner_key', pw);
    showApp();
  });
  $('#ownerPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#unlockBtn').click(); });

  // --- clients ---------------------------------------------------------------
  async function loadClients() {
    const { clients } = await api('GET', '/api/clients');
    state.clients = clients;
    renderClientList();
  }

  function renderClientList() {
    const ul = $('#clientList');
    ul.innerHTML = '';
    $('#noClients').classList.toggle('hidden', state.clients.length > 0);
    for (const c of state.clients) {
      const li = document.createElement('li');
      li.className = state.selectedClient?.id === c.id ? 'active' : '';
      li.innerHTML = `<div class="name">${esc(c.name)}</div><div class="biz">${esc(c.business || '—')}</div>`;
      li.addEventListener('click', () => selectClient(c.id));
      ul.appendChild(li);
    }
  }

  async function selectClient(id) {
    state.selectedClient = state.clients.find((c) => c.id === id) || null;
    state.selectedNote = null;
    renderClientList();
    if (!state.selectedClient) return;
    $('#emptyState').classList.add('hidden');
    $('#clientView').classList.remove('hidden');
    const c = state.selectedClient;
    $('#cvName').textContent = c.name;
    $('#cvBiz').textContent = c.business || '';
    $('#cvCode').textContent = c.accessCode;
    $('#agentClientName').textContent = c.name;
    $('#noteEditor').value = '';
    $('#noteName').textContent = '';
    $('#notePreview').classList.add('hidden');
    $('#noteEditor').classList.remove('hidden');
    $('#agentOutput').classList.add('hidden');
    await loadNotes();
    await loadDocuments();
  }

  // --- documents -------------------------------------------------------------
  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  async function loadDocuments() {
    const { documents } = await api('GET', `/api/clients/${state.selectedClient.id}/documents`);
    const ul = $('#docList');
    ul.innerHTML = '';
    $('#noDocs').classList.toggle('hidden', documents.length > 0);
    for (const d of documents) {
      const li = document.createElement('li');
      li.style.justifyContent = 'space-between';
      const sigLabel = d.signature
        ? `<span class="muted" style="font-size:12px;color:var(--good)">✍ Signed by ${esc(d.signature.signerName)} · ${new Date(d.signature.signedAt).toLocaleDateString()}</span>`
        : `<span class="muted" style="font-size:12px">Awaiting signature</span>`;
      li.innerHTML =
        `<span style="display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap"><span class="doc-icon">📎</span>` +
        `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.name)}</span>` +
        `<span class="muted" style="font-size:12px">${formatBytes(d.size)}</span>${sigLabel}</span>`;
      const actions = document.createElement('span');
      actions.className = 'row';
      if (d.signature) {
        const view = document.createElement('button');
        view.className = 'ghost'; view.style.padding = '4px 9px'; view.textContent = 'Signature';
        view.addEventListener('click', (e) => { e.stopPropagation(); viewSignature(d.name); });
        actions.appendChild(view);
      }
      const dl = document.createElement('button');
      dl.className = 'ghost'; dl.style.padding = '4px 9px'; dl.textContent = 'Download';
      dl.addEventListener('click', (e) => { e.stopPropagation(); downloadDoc(d.name); });
      const del = document.createElement('button');
      del.className = 'ghost'; del.style.padding = '4px 9px'; del.style.color = 'var(--danger)'; del.textContent = '✕';
      del.title = 'Delete document';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${d.name}"?`)) return;
        await api('DELETE', `/api/clients/${state.selectedClient.id}/documents/${encodeURIComponent(d.name)}`);
        await loadDocuments();
        toast('Document deleted');
      });
      actions.appendChild(dl); actions.appendChild(del);
      li.appendChild(actions);
      ul.appendChild(li);
    }
  }

  async function downloadDoc(name) {
    // Fetch as a blob (so the owner password header is sent) then save it.
    const headers = state.ownerKey ? { 'x-owner-key': state.ownerKey } : {};
    const res = await fetch(`/api/clients/${state.selectedClient.id}/documents/${encodeURIComponent(name)}`, { headers });
    if (!res.ok) { toast('Download failed'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  async function viewSignature(name) {
    try {
      const { signature } = await api('GET', `/api/clients/${state.selectedClient.id}/documents/${encodeURIComponent(name)}/signature`);
      $('#sigDocName').textContent = signature.document;
      $('#sigMeta').innerHTML =
        `<b>Signed by:</b> ${esc(signature.signerName)}<br>` +
        `<b>Date:</b> ${new Date(signature.signedAt).toLocaleString()}<br>` +
        `<b>IP address:</b> ${esc(signature.ip || '—')}`;
      const img = $('#sigImage');
      if (signature.signatureImage) { img.src = signature.signatureImage; img.classList.remove('hidden'); }
      else img.classList.add('hidden');
      $('#sigModal').classList.add('open');
    } catch (e) { toast(e.message); }
  }
  $('#sigClose').addEventListener('click', () => $('#sigModal').classList.remove('open'));
  $('#sigModal').addEventListener('click', (e) => { if (e.target === $('#sigModal')) $('#sigModal').classList.remove('open'); });

  $('#uploadDocBtn').addEventListener('click', () => $('#docFileInput').click());
  $('#docFileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    const headers = state.ownerKey ? { 'x-owner-key': state.ownerKey } : {};
    try {
      const res = await fetch(`/api/clients/${state.selectedClient.id}/documents`, { method: 'POST', headers, body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Upload failed.');
      toast(`Uploaded ${data.document.name}`);
      await loadDocuments();
    } catch (err) { toast(err.message); }
    finally { e.target.value = ''; }
  });

  // --- notes -----------------------------------------------------------------
  async function loadNotes() {
    const { notes } = await api('GET', `/api/clients/${state.selectedClient.id}/notes`);
    const ul = $('#noteList');
    ul.innerHTML = '';
    for (const n of notes) {
      const li = document.createElement('li');
      li.className = state.selectedNote === n.name ? 'active' : '';
      li.innerHTML = `<span class="doc-icon">📄</span><span>${esc(n.name.replace(/\.md$/, ''))}</span>`;
      li.addEventListener('click', () => selectNote(n.name));
      ul.appendChild(li);
    }
    if (!state.selectedNote && notes.length) selectNote(notes[0].name);
  }

  async function selectNote(name) {
    state.selectedNote = name;
    const data = await api('GET', `/api/clients/${state.selectedClient.id}/notes/${encodeURIComponent(name)}`);
    $('#noteName').textContent = name;
    $('#noteEditor').value = data.content;
    $('#notePreview').innerHTML = data.html;
    // Keep whichever view the user last had; default to editor.
    Array.from($('#noteList').children).forEach((li) => {
      li.classList.toggle('active', li.textContent.trim() === name.replace(/\.md$/, ''));
    });
  }

  $('#saveNoteBtn').addEventListener('click', async () => {
    if (!state.selectedNote) return;
    await api('PUT', `/api/clients/${state.selectedClient.id}/notes/${encodeURIComponent(state.selectedNote)}`, { content: $('#noteEditor').value });
    const flash = $('#savedFlash');
    flash.classList.remove('hidden');
    setTimeout(() => flash.classList.add('hidden'), 1500);
    // Refresh preview.
    const data = await api('GET', `/api/clients/${state.selectedClient.id}/notes/${encodeURIComponent(state.selectedNote)}`);
    $('#notePreview').innerHTML = data.html;
  });

  $('#togglePreviewBtn').addEventListener('click', () => {
    const ed = $('#noteEditor'), pv = $('#notePreview'), btn = $('#togglePreviewBtn');
    const showPreview = ed.classList.contains('hidden') === false; // currently editing -> switch to preview
    ed.classList.toggle('hidden', showPreview);
    pv.classList.toggle('hidden', !showPreview);
    btn.textContent = showPreview ? 'Edit' : 'Preview';
  });

  $('#newNoteBtn').addEventListener('click', async () => {
    const raw = prompt('New note name:', 'New Note');
    if (!raw) return;
    const name = raw.toLowerCase().endsWith('.md') ? raw : `${raw}.md`;
    await api('PUT', `/api/clients/${state.selectedClient.id}/notes/${encodeURIComponent(name)}`, { content: `# ${raw.replace(/\.md$/, '')}\n\n` });
    state.selectedNote = name;
    await loadNotes();
    selectNote(name);
    toast('Note created');
  });

  $('#deleteNoteBtn').addEventListener('click', async () => {
    if (!state.selectedNote) return;
    if (!confirm(`Delete "${state.selectedNote}"? This cannot be undone.`)) return;
    await api('DELETE', `/api/clients/${state.selectedClient.id}/notes/${encodeURIComponent(state.selectedNote)}`);
    state.selectedNote = null;
    await loadNotes();
    $('#noteEditor').value = '';
    $('#noteName').textContent = '';
    toast('Note deleted');
  });

  $('#copyCodeBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.selectedClient.accessCode); toast('Access code copied'); }
    catch { toast(state.selectedClient.accessCode); }
  });

  $('#deleteClientBtn').addEventListener('click', async () => {
    const c = state.selectedClient;
    if (!confirm(`Delete client "${c.name}" and their entire vault? This cannot be undone.`)) return;
    await api('DELETE', `/api/clients/${c.id}`);
    state.selectedClient = null;
    $('#clientView').classList.add('hidden');
    $('#emptyState').classList.remove('hidden');
    await loadClients();
    toast('Client deleted');
  });

  // --- add client modal ------------------------------------------------------
  const modal = $('#addModal');
  $('#addClientBtn').addEventListener('click', () => { modal.classList.add('open'); $('#mName').focus(); });
  $('#cancelAdd').addEventListener('click', () => modal.classList.remove('open'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });
  $('#confirmAdd').addEventListener('click', async () => {
    const body = {
      name: $('#mName').value.trim(),
      business: $('#mBiz').value.trim(),
      contactEmail: $('#mEmail').value.trim(),
      contactPhone: $('#mPhone').value.trim(),
      notes: $('#mNotes').value.trim(),
    };
    if (!body.name) { $('#addError').textContent = 'A name is required.'; return; }
    try {
      const { client } = await api('POST', '/api/clients', body);
      modal.classList.remove('open');
      ['mName', 'mBiz', 'mEmail', 'mPhone', 'mNotes'].forEach((id) => ($('#' + id).value = ''));
      $('#addError').textContent = '';
      await loadClients();
      selectClient(client.id);
      toast(`Client created · code ${client.accessCode}`);
    } catch (e) { $('#addError').textContent = e.message; }
  });

  // --- AI agent --------------------------------------------------------------
  async function runAgent(prompt, clientId, outEl, btn) {
    if (!prompt.trim()) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Working…';
    outEl.classList.remove('hidden');
    outEl.innerHTML = '<p class="muted">The agent is working — this can take a few seconds…</p>';
    try {
      const result = await api('POST', '/api/agent', { prompt, clientId });
      const actions = (result.actions || []).map((a) => `<li>${esc(a)}</li>`).join('');
      outEl.innerHTML =
        (actions ? `<ul class="agent-actions">${actions}</ul>` : '') +
        `<div class="agent-reply" style="white-space:pre-wrap">${esc(result.reply || '')}</div>`;
      // Refresh state — the agent may have created clients or written notes.
      await loadClients();
      if (state.selectedClient) {
        state.selectedClient = state.clients.find((c) => c.id === state.selectedClient.id) || state.selectedClient;
        const keepNote = state.selectedNote;
        await loadNotes();
        if (keepNote) selectNote(keepNote).catch(() => {});
      }
    } catch (e) {
      outEl.innerHTML = `<div class="agent-reply" style="color:var(--danger)">${esc(e.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  $('#agentRun').addEventListener('click', () => {
    runAgent($('#agentPrompt').value, state.selectedClient?.id || null, $('#agentOutput'), $('#agentRun'));
  });
  $('#globalAgentRun').addEventListener('click', () => {
    runAgent($('#globalAgentPrompt').value, null, $('#globalAgentOutput'), $('#globalAgentRun'));
  });
  $('#agentSuggestions').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) { $('#agentPrompt').value = chip.dataset.prompt; $('#agentPrompt').focus(); }
  });

  boot().catch((e) => { console.error(e); toast('Failed to start: ' + e.message); });
})();

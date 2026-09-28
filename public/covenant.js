// BUILD MARKER: sequencer-c2d-2026-09-28
// Money moves through covenant-actions.js (shared with the freelance deed); this file draws the cards.
// Covenant page (/c/<token>): one question first ("is there something for me
// to do?"), rendered as a state per viewer, with the evidence folded below
// (rules, parties, code). Shares the session (kc_* keys) with the Studio.
(function () {
  document.documentElement.setAttribute('data-theme', localStorage.getItem('ss_theme') || 'dark');
  const token = (location.pathname.match(/^\/c\/([A-Za-z0-9_-]{16,64})\/?$/) || [])[1] || null;
  const main = document.getElementById('cvMain');
  const authEl = document.getElementById('cvAuth');

  // Footer: the Studio never holds funds; it holds the map, and hands out copies.
  (function ksmFooter() {
    const foot = document.querySelector('.cv-foot');
    if (!foot || !token) return;
    foot.innerHTML = 'Coins at this address are held by the Kaspa network under the rules above. The Studio never holds funds; it keeps the map that explains them, and '
      + '<a href="/api/share/' + encodeURIComponent(token) + '/manifest.ksm" download>here is your copy</a> '
      + '(<a href="/ksm.html" target="_blank" rel="noopener">what is this?</a>).';
  })();

  let authToken = null, connectedWallet = null, me = null;
  let data = null;

  const CA = window.CovenantActions;
  CA.configure({ api: '' });
  function hasKaspire() { return CA.wallet.hasKaspire(); }
  function kaspireRequest(method, params) { return CA.wallet.kaspireRequest(method, params); }

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = a => a && a.length > 20 ? a.slice(0, 12) + '…' + a.slice(-6) : (a || '');
  const kas = sompi => (Number(sompi) / 1e8).toFixed(4).replace(/\.?0+$/, '') || '0';

  // ── Session (same storage as the Studio; read through the library) ──
  function loadSession() {
    const sess = CA.session.load();
    if (sess) { authToken = sess.token; me = sess.address; connectedWallet = sess.walletType; }
    else { authToken = null; me = null; connectedWallet = null; }
  }
  function onWalletConnected(d) {
    if (!d || !d.token) return;
    CA.session.store(d);
    loadSession();
    renderAuth();
    pingSession('connect');
    joinThenReload();
  }
  // ── Presence ping (same as the Studio's): connect = sign-in, else "tab open" ──
  let _pingTimer = null;
  function pingSession(event) {
    if (!authToken) return;
    fetch('/api/session/ping', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: event || 'heartbeat', walletType: connectedWallet || null, page: 'covenant' })
    }).catch(function () {});
    if (!_pingTimer) _pingTimer = setInterval(function () { pingSession('heartbeat'); }, 120000);
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') pingSession('heartbeat'); });
  function connect() {
    if (typeof window.KasperoConnect === 'undefined') return alert('Wallet widget not loaded');
    KasperoConnect.connect({
      merchant: 'kpm_v90br29k',
      wallets: ['kasware', 'kastle', 'kaspire', 'kasla'],
      theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
      modalTitle: 'Connect to this covenant',
      onConnect: onWalletConnected,
      onCancel: function () {},
      onError: function (e) { alert('Connection error: ' + e); }
    });
  }
  function disconnect() {
    if (typeof window.KasperoConnect !== 'undefined') KasperoConnect.disconnect();
    CA.session.clear();
    if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
    loadSession(); renderAuth(); load();
  }
  // ── Session must follow the wallet's active account ───────────────
  async function assertSessionMatchesWallet() { return CA.wallet.assertSessionMatchesWallet(); }
  let accountWatchBound = false;
  function watchAccountSwitch() {
    if (accountWatchBound) return;
    accountWatchBound = CA.wallet.watchAccountSwitch((next) => {
      if (!me || !next || next === me) return;
      disconnect();
      connect();
    });
  }

  function renderAuth() {
    if (!authToken) { authEl.innerHTML = `<button class="ghost" id="cvConnect">Connect wallet</button>`; }
    else {
      const you = data && data.you;
      const roles = you && you.roles && you.roles.length ? you.roles.join(', ') : null;
      authEl.innerHTML = `
        <span class="role"><span class="dot${roles ? '' : ' off'}"></span>${roles ? 'You are the ' + esc(roles) : 'Not a party'}</span>
        <span class="addr mono" title="${esc(me)}">${esc(short(me))}</span>
        <button class="ghost" id="cvDisconnect">Disconnect</button>`;
    }
    const c = document.getElementById('cvConnect'); if (c) c.onclick = connect;
    const d = document.getElementById('cvDisconnect'); if (d) d.onclick = disconnect;
  }
  document.getElementById('themeToggle').onclick = function () {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('ss_theme', t);
  };

  // ── Data ──────────────────────────────────────────────────────────
  async function api(path, opts) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, (opts && opts.headers) || {});
    if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
    const r = await fetch(path, Object.assign({}, opts, { headers }));
    return r.json();
  }
  async function load(fresh) {
    if (!token) { main.innerHTML = '<div class="contracts-empty">This is not a covenant link.</div>'; return; }
    try { data = await api('/api/share/' + encodeURIComponent(token) + (fresh ? '?fresh=1' : '')); }
    catch (e) { data = { success: false, error: 'Network error: ' + e.message }; }
    if (!data.success) { main.innerHTML = `<div class="contracts-empty">${esc(data.error || 'This link is not valid')}</div>`; return; }
    document.title = data.contractName + ' - Covenant';
    renderAuth();
    render();
  }
  async function joinThenReload() {
    if (authToken && token) {
      try { await api('/api/share/' + encodeURIComponent(token) + '/join', { method: 'POST' }); } catch (_) {}
    }
    load();
  }

  // After a spend we broadcast: poll fresh until the balance moves (the node's
  // UTXO index follows the block, usually within a couple of seconds).
  async function reloadAfterSpend(previousBalance) {
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, i === 0 ? 1500 : 2500));
      let d; try { d = await api('/api/share/' + encodeURIComponent(token) + '?fresh=1'); } catch (_) { continue; }
      if (d && d.success && d.balanceSompi !== null && d.balanceSompi !== previousBalance) { data = d; renderAuth(); render(); return; }
    }
    load(true);
  }

  // ── Render: a state machine per viewer ────────────────────────────
  const LOCK_TIME_THRESHOLD = 500000000000;   // CLTV values above this are ms timestamps (same rule as the server)
  // Filled pictograms (same family as the start panel): solid shapes in currentColor with real
  // cutouts (SVG masks), so the tile color decides the tone: grey, gold when it is your move, green when done.
  const PIC = {
    coins: '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><mask id="cvm-coins"><rect width="48" height="48" fill="#fff"/><ellipse cx="30" cy="25" rx="13.5" ry="5.5" fill="none" stroke="#000" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M16.5 25 V37 a13.5 5.5 0 0 0 27 0 V25" fill="none" stroke="#000" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M16.5 31 a13.5 5.5 0 0 0 27 0" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 18 a13.5 5.5 0 0 0 27 0" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 24 a13.5 5.5 0 0 0 11 5.3" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></mask></defs><g fill="currentColor" mask="url(#cvm-coins)"><ellipse cx="18" cy="12" rx="12" ry="5"/><rect x="6" y="12" width="24" height="18"/><ellipse cx="18" cy="30" rx="12" ry="5"/> <ellipse cx="30" cy="25" rx="12" ry="5"/><rect x="18" y="25" width="24" height="12"/><ellipse cx="30" cy="37" rx="12" ry="5"/></g><ellipse cx="30" cy="25" rx="8" ry="2.4" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".45"/></svg>',
    lock: '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><mask id="cvm-lock"><rect width="48" height="48" fill="#fff"/><circle cx="24" cy="30" r="3.6" fill="#000"/><rect x="22.3" y="31" width="3.4" height="6.5" rx="1.5" fill="#000"/></mask></defs><g fill="currentColor" mask="url(#cvm-lock)"><path d="M15 22 V16 a9 9 0 0 1 18 0 V22" fill="none" stroke="currentColor" stroke-width="5"/><rect x="9" y="20" width="30" height="23" rx="5"/></g></svg>',
    pen: '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><mask id="cvm-pen"><rect width="48" height="48" fill="#fff"/><path d="M24 19 V32" fill="none" stroke="#000" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="24" cy="19" r="2.6" fill="#000"/></mask></defs><g fill="currentColor" mask="url(#cvm-pen)"><path d="M24 4 L35 19 L29.5 34 H18.5 L13 19 Z"/><rect x="17" y="36" width="14" height="6" rx="2"/></g><path d="M15 45.5 c3-2.5 6-2.5 9 0 s6 2.5 9 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".5"/></svg>',
    clock: '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><mask id="cvm-clock"><rect width="48" height="48" fill="#fff"/><path d="M24 24 V12.5" fill="none" stroke="#000" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 24 L32 29" fill="none" stroke="#000" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="24" cy="24" r="2.8" fill="#000"/></mask></defs><g fill="currentColor" mask="url(#cvm-clock)"><circle cx="24" cy="24" r="19"/></g></svg>',
    check: '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><mask id="cvm-check"><rect width="48" height="48" fill="#fff"/><path d="M14.5 24.5 L21 31 L34 17.5" fill="none" stroke="#000" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></mask></defs><g fill="currentColor" mask="url(#cvm-check)"><circle cx="24" cy="24" r="19"/></g></svg>',
    key: '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><mask id="cvm-key"><rect width="48" height="48" fill="#fff"/><circle cx="14" cy="24" r="4.2" fill="#000"/></mask></defs><g fill="currentColor" mask="url(#cvm-key)"><circle cx="14" cy="24" r="10"/><rect x="21" y="21" width="23" height="6" rx="2"/><rect x="33" y="26" width="4" height="7"/><rect x="39" y="26" width="4" height="9"/></g></svg>',
    eye: '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><mask id="cvm-eye"><rect width="48" height="48" fill="#fff"/><circle cx="24" cy="24" r="8.5" fill="#000"/></mask></defs><g fill="currentColor" mask="url(#cvm-eye)"><path d="M3 24 C11 11 37 11 45 24 C37 37 11 37 3 24 Z"/></g><circle cx="24" cy="24" r="4.2" fill="currentColor"/></svg>',
    inbox: '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><mask id="cvm-inbox"><rect width="48" height="48" fill="#fff"/><path d="M24 12 V26" fill="none" stroke="#000" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 21 L24 27 L30 21" fill="none" stroke="#000" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 31 H15 l3 4 h12 l3 -4 H43" fill="none" stroke="#000" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></mask></defs><g fill="currentColor" mask="url(#cvm-inbox)"><path d="M5 30 L11 8 H37 L43 30 V40 a4 4 0 0 1 -4 4 H9 a4 4 0 0 1 -4 -4 Z"/></g></svg>',
    rules: '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><mask id="cvm-rules"><rect width="48" height="48" fill="#fff"/><path d="M30 5 V14 H39" fill="none" stroke="#000" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><rect x="16" y="20" width="16" height="3.4" rx="1.5" fill="#000"/><rect x="16" y="27" width="16" height="3.4" rx="1.5" fill="#000"/><rect x="16" y="34" width="10" height="3.4" rx="1.5" fill="#000"/></mask></defs><g fill="currentColor" mask="url(#cvm-rules)"><path d="M11 4 H31 L40 13 V44 H11 Z"/></g></svg>',
    people: '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><mask id="cvm-people"><rect width="48" height="48" fill="#fff"/><circle cx="17" cy="16" r="9.5" fill="#000"/><path d="M2 44 a15 15 0 0 1 30 0 Z" fill="#000"/></mask></defs><g fill="currentColor"><g mask="url(#cvm-people)"><circle cx="32" cy="17" r="6"/><path d="M21 42 a11 11 0 0 1 22 0 Z"/></g><circle cx="17" cy="16" r="6.5"/><path d="M5 42 a12 12 0 0 1 24 0 Z"/></g></svg>',
    code: '<svg viewBox="0 0 48 48" aria-hidden="true"><defs><mask id="cvm-code"><rect width="48" height="48" fill="#fff"/><path d="M19 18 L13 24 L19 30" fill="none" stroke="#000" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M29 18 L35 24 L29 30" fill="none" stroke="#000" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M26 16.5 L22 31.5" fill="none" stroke="#000" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></mask></defs><g fill="currentColor" mask="url(#cvm-code)"><rect x="4" y="8" width="40" height="32" rx="6"/></g></svg>',
  };
  const ICON = { coins: PIC.coins, lock: PIC.lock, pen: PIC.pen, clock: PIC.clock, check: PIC.check, plug: PIC.key, eye: PIC.eye, inbox: PIC.inbox };
  (function iconStyle() {
    if (document.getElementById('cvIconStyle')) return;
    const st = document.createElement('style');
    st.id = 'cvIconStyle';
    st.textContent = '.state .mark { width: 68px; height: 68px; border-radius: 20px; }'
      + '.state .mark svg { width: 38px; height: 38px; display: block; }'
      + '.fold summary .ico { width: 30px; height: 30px; border-radius: 9px; }'
      + '.fold summary .ico svg { width: 18px; height: 18px; display: block; }'
      + '.fold[open] summary .ico { color: var(--text-primary); }'
      + '.cv-foot a { color: var(--text-secondary); text-decoration: underline; text-underline-offset: 2px; }'
      + '.cv-foot a:hover { color: var(--text-primary); }'
      + '.cv-why { margin-top: 10px; font-size: 12px; color: var(--text-muted); }'
      + '.cv-why summary { cursor: pointer; display: list-item; list-style-position: inside; }'
      + '.cv-why .mono { margin-top: 6px; text-align: left; word-break: break-all; font-size: 11px; line-height: 1.5; }'
      + '.cv-amt { display: flex; align-items: stretch; justify-content: center; gap: 8px; margin: 0 auto 12px; max-width: 340px; }'
      + '.cv-amt-in { flex: 1; display: flex; align-items: center; gap: 8px; padding: 0 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-primary); }'
      + '.cv-amt-in:focus-within { border-color: var(--accent); }'
      + '.cv-amt-in input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text-primary); font: 600 22px/1 "JetBrains Mono", monospace; text-align: right; padding: 12px 0; }'
      + '.cv-amt-in .unit { font-size: 12px; font-weight: 600; color: var(--text-muted); }'
      + '.cv-all { padding: 0 16px; border-radius: 12px; border: 1px solid var(--border); background: var(--bg-tertiary); color: var(--text-secondary); font-size: 13px; font-weight: 600; }'
      + '.cv-all.on { border-color: var(--accent); color: var(--accent); background: var(--accent-bg); }'
      + '.cv-amt-note { font-size: 12px; color: var(--text-muted); margin: -4px 0 12px; min-height: 1em; }'
      + '.cv-amt-note.bad { color: var(--error, #c0392b); }';
    document.head.appendChild(st);
  })();
  const q = t => `<span class="q" tabindex="0">?<span class="tip">${t}</span></span>`;
  const fmtDate = ts => {
    const d = new Date(ts);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const fmtDateTime = ts => fmtDate(ts) + ' ' + new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const nameOf = p => p.isYou ? 'You' : p.role;
  // Role a path's signature belongs to, read from the server's plain-English "needs"
  const signerRoles = e => [...new Set(((e && e.needs) || []).map(n => (n.match(/signature from <b>(\w+)<\/b>/) || [])[1]).filter(Boolean))];
  // Latest unlock on a path as a wall-clock estimate (ms), or null when nothing
  // is known to be locked. CLTV above the threshold is a timestamp; below it a
  // DAA score, measured against the node's virtualDaaScore. CSV is relative to
  // the input's DAA score, so it counts from the newest UTXO (every input must
  // pass). 10 DAA per second (DAA_PER_DAY = 864000).
  const DAA_PER_SEC = 10;
  const daaToMs = target => {
    const v = data && data.virtualDaaScore;
    if (v === null || v === undefined) return null;
    return Date.now() + Math.max(0, target - v) / DAA_PER_SEC * 1000;
  };
  const unlockAt = p => {
    const times = [];
    for (const v of ((p.locks && p.locks.cltv) || []).map(Number)) {
      if (v >= LOCK_TIME_THRESHOLD) times.push(v);
      else { const t = daaToMs(v); if (t !== null) times.push(t); }
    }
    const base = data && data.newestUtxoDaa;
    if (base !== null && base !== undefined) {
      for (const v of ((p.locks && p.locks.csv) || []).map(Number)) { const t = daaToMs(base + v); if (t !== null) times.push(t); }
    }
    return times.length ? Math.max(...times) : null;
  };
  // DAA-derived estimates drift with block rate; say "around", not "on"
  const lockIsEstimate = p => ((p.locks && p.locks.csv) || []).length > 0
    || ((p.locks && p.locks.cltv) || []).map(Number).some(v => v < LOCK_TIME_THRESHOLD);

  // "to the workerKey" / "to your wallet" for a path or a proposal
  function payeeText(x) {
    const role = x.payeeRole;
    if (!role) return 'to your wallet';
    const mine = data && data.you && data.you.roles.includes(role);
    return mine ? 'to your wallet' : `to the <b>${esc(role)}</b>`;
  }
  // What the payee receives: outputs[0] when the server says so, else the old sweep figure
  const payoutOf = x => Number(x.payoutSompi != null ? x.payoutSompi : (Number(x.amountSompi) - Number(x.feeSompi)));
  const changeOf = x => Number(x.changeSompi || 0);
  // The thing every signer is signing against, small and mono, above the fold
  function ticketLine(pr) {
    const amt = kas(payoutOf(pr));
    const to = pr.payeeRole ? esc(pr.payeeRole) : short(pr.destination);
    return `<div class="mono" style="font-size:11.5px;margin-top:10px;color:var(--text-muted)">${esc(pr.entry)} · ${amt} KAS → ${to}${changeOf(pr) > 0 ? ' · ' + kas(changeOf(pr)) + ' KAS stays' : ''} · started by ${esc(pr.createdByRole || short(pr.createdBy))} ${fmtDate(pr.createdAt)}${pr.expiresAt ? ' · expires ' + fmtDate(pr.expiresAt) : ''}</div>`;
  }
  // Under a proposal that waits for me: my own paths as the quieter second choice
  function ownOptions(d, s) {
    const alts = s.alts || [];
    if (!alts.length) return '';
    const bal = kas(d.balanceSompi || 0);
    const btn = p => p.sigCount > 1
      ? `<button class="push quiet full" data-propose="${esc(p.name)}"${p.toSelf ? ' data-toself' : ''}>Sign to pay <span class="amt">${bal} KAS</span> ${payeeText(p)} <span style="opacity:.7;font-weight:500">via ${esc(p.name)}</span></button>`
      : `<button class="push quiet full" data-withdraw="${esc(p.name)}"${p.toSelf ? ' data-toself' : ''}>${p.toSelf ? `Merge <span class="amt">${bal} KAS</span> into one coin here` : `Withdraw <span class="amt">${bal} KAS</span> to your wallet`} <span style="opacity:.7;font-weight:500">via ${esc(p.name)}</span></button>`;
    return `<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border-subtle)">
        <div class="deploy-hint" style="margin:0 0 10px;text-align:center">Or, on your own. Every path spends the same coins: if yours lands first, theirs is rebuilt on what is left; take everything and there is nothing to rebuild on.</div>
        ${amountRow(d, alts)}${alts.map(btn).join('')}
      </div>`;
  }
  // "The parks and the accountant are settling pullParks (1 of 2 signed)…" for the notes
  function othersLine(s) {
    const list = (s.others || []).filter(p => p.status === 'open');
    if (!list.length) return '';
    const one = p => `the ${esc(p.signers.map(x => x.role).join(' and '))} ${p.signers.length > 1 ? 'are' : 'is'} settling <b>${esc(p.entry)}</b> (${p.signedCount} of ${p.requiredCount} signed)`;
    return ` Meanwhile ${list.map(one).join('; ')}. Every path spends the same coins: if theirs lands first, yours is rebuilt on what is left and signed again.`;
  }
  function chips(pr) {
    return `<div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:8px">` + pr.signers.map(x =>
      `<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:1px solid var(--border);font-size:12px;${x.signedAt ? 'color:var(--success)' : 'color:var(--text-secondary)'}">${x.signedAt ? '✓' : '·'} ${esc(x.isYou ? 'You' : x.role)} <span style="opacity:.75">${x.signedAt ? 'signed ' + fmtDateTime(x.signedAt) : 'waiting'}</span></span>`).join('') + `</div>`;
  }

  // Decide the viewer's state from the payload
  function situation(d) {
    const bal = d.balanceSompi;
    if (!authToken) return { key: 'noauth' };
    if (!d.you || !d.you.roles.length) return { key: 'readonly' };
    if (bal === null || bal === undefined) return { key: 'checking' };
    if (bal === 0) {
      const lost = (d.proposals || []).find(p => p.status === 'lapsed' && p.overtaken && p.involvesYou);
      if (d.totalFundedSompi > 0 || (d.money && d.money.totalInSompi > 0)) return { key: 'done', lost };
      if (d.funderRole && d.you.isFunder) return { key: 'fund' };
      if (d.funderRole) return { key: 'unfunded-other' };
      return { key: 'unfunded' };
    }
    // A merge-style path only makes sense with two or more coins at the address
    const paths = (d.paths || []).filter(p => !(p.toSelf && d.utxoCount !== null && d.utxoCount !== undefined && d.utxoCount < 2));
    // Proposals: one open per path. Acting beats waiting, waiting beats options; an open
    // proposal that involves my key comes first, then one of mine that was overtaken (its
    // coins went to another path's withdrawal) and can be rebuilt, then my own options with
    // the others' proposals as context.
    const prs = d.proposals || (d.proposal ? [d.proposal] : []);
    const openPrs = prs.filter(p => p.status === 'open');
    const meIn = p => (p.signers || []).find(x => x.isYou);
    const busy = new Set(openPrs.map(p => p.entry));   // paths already being settled by someone
    // What I could do on my own right now, regardless of proposals: offered as the
    // second choice under a proposal that waits for me (the owner can co-sign the
    // payee's pull, or take on his own path; both are his to decide)
    const now0 = Date.now();
    const alts = paths.filter(p => !busy.has(p.name) && ((p.eligible && (unlockAt(p) === null || unlockAt(p) <= now0))
                                                     || (p.unlocksWithMyKey && p.sigCount > 1 && !p.studioCantBuild)));
    const stuckMine = openPrs.find(p => p.signedCount >= p.requiredCount && meIn(p));
    if (stuckMine) return { key: 'p-stuck', pr: stuckMine, mine: true };
    const needsMe = openPrs.find(p => { const m = meIn(p); return m && !m.signedAt; });
    if (needsMe) return { key: 'p-sign', pr: needsMe, alts, others: openPrs.filter(p => p !== needsMe) };
    const overtaken = prs.find(p => p.status === 'lapsed' && p.overtaken && p.rebuildable);
    if (overtaken) return { key: 'p-overtaken', pr: overtaken };
    const waitingMine = openPrs.find(p => meIn(p));
    if (waitingMine) return { key: 'p-signed', pr: waitingMine, alts, others: openPrs.filter(p => p !== waitingMine) };
    const others = openPrs;
    const mine = paths.filter(p => p.eligible);
    if (mine.length) {
      const now = Date.now();
      const open = mine.filter(p => { const t = unlockAt(p); return t === null || t <= now; });
      if (open.length) return { key: 'ready', paths: open, others };
      const soonest = mine.map(unlockAt).filter(Boolean).sort((a, b) => a - b)[0];
      return { key: 'locked', at: soonest, paths: mine, estimate: mine.some(lockIsEstimate), others };
    }
    const multi = paths.filter(p => p.unlocksWithMyKey && p.sigCount > 1 && !p.studioCantBuild && !busy.has(p.name));
    if (multi.length) {
      // Paths whose other signers have opened the link first: those are the live ones
      const score = p => (p.signers || []).filter(x => !x.isYou).every(x => (d.parties || []).some(q => q.address === x.address && q.joined)) ? 0 : 1;
      multi.sort((a, b) => score(a) - score(b));
      const lapsed = prs.find(p => (p.status === 'lapsed' || p.status === 'cancelled') && meIn(p) && !p.overtaken) || null;
      return { key: 'multisig', paths: multi, lapsed, others };
    }
    const stuckOthers = openPrs.find(p => p.signedCount >= p.requiredCount);
    if (stuckOthers) return { key: 'p-stuck', pr: stuckOthers, mine: false };
    const bc = prs.find(p => p.status === 'broadcast' && p.stale);
    if (bc) return { key: 'p-broadcast', pr: bc };
    if (openPrs.length) return { key: 'p-others', pr: openPrs[0] };

    const notyet = paths.filter(p => p.unlocksWithMyKey && p.studioCantBuild);
    if (notyet.length) return { key: 'notyet', paths: notyet };

    const open = paths.filter(p => p.sigCount === 0);
    if (open.length) return { key: 'byhand', paths: open };

    return { key: 'waiting' };
  }

  function stateCard(d, s) {
    const bal = kas(d.balanceSompi || 0);
    const creator = (d.parties || []).find(p => p.isCreator);
    const creatorName = creator ? (creator.isYou ? 'you' : creator.role) : 'the creator';
    const others = (d.parties || []).filter(p => !p.isYou).map(p => '<b>' + esc(p.role) + '</b>');
    let cls = s.key, mark = ICON.inbox, h, lead, act = '', note = '';
    switch (s.key) {
      case 'noauth':
        mark = ICON.plug; h = 'Whose keys are these?';
        lead = `Anyone with this link can read this covenant. Only the keys named inside it can move the money. Connect the wallet that holds one of them.`;
        act = `<button class="push full" id="cvConnectBig">Connect wallet</button>`;
        note = 'Kasware, Kastle, Kaspire and Kasla work here.';
        break;
      case 'readonly':
        mark = ICON.eye; h = 'You can read this, not spend it.';
        lead = `Your wallet (<b>${esc(short(me))}</b>) is not one of the keys named in this covenant. Nothing here is aimed at you.`;
        note = 'If you expected to be a party, disconnect and connect with the account that was named.';
        break;
      case 'checking':
        mark = ICON.clock; h = 'Checking the balance…';
        lead = `The node did not answer in time. The rules and parties below are still right; the amount is not known yet.`;
        act = `<button class="push quiet" data-reload>Try again</button>`;
        break;
      case 'fund': {
        const exp = d.expectedDepositSompi ? kas(d.expectedDepositSompi) : null;
        const who = creatorName === 'you' ? 'You' : 'The ' + esc(creatorName);
        mark = ICON.coins; cls = 'ready'; h = 'Your deposit starts this.';
        lead = `${who} set these terms. ${exp ? `Deposit <b>${exp} KAS</b>` : 'Deposit'} and the rules below hold the money until it is settled.`;
        act = exp
          ? `<button class="push full" data-deposit="${exp}">Deposit <span class="amt">${exp} KAS</span> from your wallet</button>`
          : `<div style="display:flex;gap:8px;align-items:center;justify-content:center;margin-bottom:10px">
               <input class="deploy-input" id="cvDepositAmt" type="number" min="1" step="1" placeholder="Amount" style="max-width:160px;text-align:center;font-size:18px">
               <span style="font-size:12px;font-weight:600;color:var(--text-muted)">KAS</span>
             </div>
             <button class="push full" data-deposit="">Deposit from your wallet</button>`;
        note = 'Sent from your connected wallet, plus the network fee. Once inside, it moves only through the spend paths below.';
        break;
      }
      case 'unfunded-other': {
        const exp = d.expectedDepositSompi ? kas(d.expectedDepositSompi) : null;
        const fr = esc(d.funderRole);
        mark = ICON.inbox; h = `Waiting for the ${fr} to deposit.`;
        lead = `This address is empty. When the <b>${fr}</b> opens this link with their wallet, the page asks them to deposit${exp ? ` <b>${exp} KAS</b>` : ''}.`;
        act = `<button class="push quiet" data-copylink>Copy the link</button>`;
        note = 'Any wallet can also send to the address under "Show me the code".';
        break;
      }
      case 'unfunded':
        mark = ICON.inbox; h = 'Nothing here yet.';
        lead = `This address is empty. Once someone deposits KAS to it, the rules below decide who can take it out.`;
        act = `<button class="push quiet" data-copyaddr>Copy the address</button>`;
        note = 'Any wallet can send to it. The Studio does not need to be involved.';
        break;
      case 'done':
        mark = ICON.check; h = 'Done. The money moved.';
        lead = `<b>${kas(d.money && d.money.totalInSompi > 0 ? d.money.totalInSompi : d.totalFundedSompi)} KAS</b> went through this covenant and the address is empty now. It can be funded again under the same rules.`;
        act = `<a class="push quiet" href="${esc(d.explorerUrl)}" target="_blank" rel="noopener">See it on the explorer</a>`;
        if (s.lost) note = `Your <b>${esc(s.lost.entry)}</b> request for ${kas(payoutOf(s.lost))} KAS was overtaken by ${s.lost.overtaken.direct ? 'a withdrawal' : `the ${esc(s.lost.overtaken.byRole || 'other party')}'s <b>${esc(s.lost.overtaken.entry)}</b>`} on ${fmtDate(s.lost.updatedAt || s.lost.createdAt)}; nothing was left to rebuild on.`;
        break;
      case 'ready':
        mark = ICON.coins; cls = 'ready'; h = 'There is money here for you.';
        lead = s.paths.length === 1
          ? `Your key alone opens this spend path${q('The Studio builds the withdrawal, your wallet signs it, the network pays you. Nobody else has to do anything.')}. ${d.you.isCreator ? 'You created this covenant.' : `Deposited by <b>${esc(creatorName)}</b>.`}`
          : `Your key opens ${s.paths.length} spend paths${q('Each path is a different set of rules. Any of them pays your wallet; pick the one you mean.')}. Pick one:`;
        act = amountRow(d, s.paths) + s.paths.map((p, i) => `<button class="push${i ? ' quiet' : ''} full" data-withdraw="${esc(p.name)}"${p.toSelf ? ' data-toself' : ''}>${p.toSelf ? `Merge <span class="amt">${bal} KAS</span> into one coin here` : `Withdraw <span class="amt">${bal} KAS</span> to your wallet`}${s.paths.length > 1 ? ` <span style="opacity:.7;font-weight:500">via ${esc(p.name)}</span>` : ''}</button>`).join('');
        note = (s.paths.some(p => p.lockLabel) ? `This path carries a lock (${esc(s.paths.map(p => p.lockLabel).filter(Boolean).join('; '))}). If it has not matured, the withdrawal will say so before anything is signed.` : (s.paths.some(p => !p.toSelf) ? 'Take all, or a smaller amount; what you leave stays here under the same rules. The network fee comes off the top.' : 'Usually confirms within a few seconds.')) + othersLine(s);
        break;
      case 'locked': {
        const left = Math.max(0, s.at - Date.now());
        const days = Math.ceil(left / 86400000), hours = Math.max(1, Math.ceil(left / 3600000));
        mark = ICON.lock; h = 'Not yet.';
        lead = `Your spend path opens ${s.estimate ? 'around' : 'on'} <b>${fmtDate(s.at)}</b>. Until then ${others.length ? 'only ' + others.join(' or ') + ' can move the money, under the rules below' : 'the money stays where it is'}.`;
        act = days > 1
          ? `<div class="figure">${days} <small>days to go</small></div>`
          : `<div class="figure">${hours} <small>hour${hours === 1 ? '' : 's'} to go</small></div>`;
        note = s.estimate ? 'Measured in blocks, so the date is an estimate. Come back with this link.' : 'Nothing to do now. Come back with this link.';
        break;
      }
      case 'multisig': {
        const p0 = s.paths[0];
        const othersOf = p => (p.signers || []).filter(x => !x.isYou).map(x => 'the <b>' + esc(x.role || 'other key') + '</b>\'s');
        const o0 = othersOf(p0);
        mark = ICON.pen; cls = 'ready'; h = p0.sigCount === 2 ? 'This takes two keys.' : `This takes ${p0.sigCount} keys.`;
        lead = `Yours and ${o0.length ? (o0.length === 1 ? o0[0] : o0.slice(0, -1).join(', ') + ' and ' + o0[o0.length - 1]) : 'the others\''}. Sign first, and ${o0.length === 1 ? 'the ' + esc(p0.signers.find(x => !x.isYou).role) + ' finishes' : 'the others finish'} it on this page.`;
        act = amountRow(d, s.paths) + s.paths.map((p, i) => `<button class="push${i ? ' quiet' : ''} full" data-propose="${esc(p.name)}"${p.toSelf ? ' data-toself' : ''}>Sign to pay <span class="amt">${bal} KAS</span> ${payeeText(p)}${s.paths.length > 1 ? ` <span style="opacity:.7;font-weight:500">via ${esc(p.name)}</span>` : ''}</button>`).join('');
        note = 'Nothing moves until every key has signed. What you leave stays here under the same rules.' + (s.lapsed ? ` An earlier attempt ${s.lapsed.status === 'cancelled' ? 'was withdrawn' : 'lapsed'} on ${fmtDate(s.lapsed.updatedAt || s.lapsed.createdAt)}; nothing was moved.` : '') + othersLine(s);
        break;
      }
      case 'p-sign': {
        const pr = s.pr;
        const done = pr.signers.filter(x => x.signedAt);
        mark = ICON.pen; cls = 'ready';
        h = done.length ? `The ${esc(done.map(x => x.role).join(' and '))} signed. Your turn.` : 'Your signature is needed.';
        lead = `Signing pays <b>${kas(payoutOf(pr))} KAS</b> ${payeeText(pr)}${changeOf(pr) > 0 ? ` and keeps <b>${kas(changeOf(pr))} KAS</b> here` : ''}.${pr.pre ? ` The ${pr.pre.inputCount} coins here are merged into one first${pr.pre.signerIsYou && !pr.pre.signed ? ', which is a second signature from you' : ''}.` : ''} ${pr.signedCount + 1 + (pr.pre && pr.pre.signerIsYou && !pr.pre.signed ? 1 : 0) >= pr.requiredCount ? 'Yours is the last signature; the money moves when you sign.' : 'Nothing moves until every key has signed.'}`;
        act = `<button class="push full" data-sign-proposal="${esc(pr.id)}">Sign and ${pr.signedCount + 1 >= pr.requiredCount ? 'release' : 'add your part to'} <span class="amt">${kas(payoutOf(pr))} KAS</span></button>` + ownOptions(d, s);
        note = ticketLine(pr) + chips(pr) + othersLine(s);
        break;
      }
      case 'p-signed': {
        const pr = s.pr;
        const waiting = pr.signers.filter(x => !x.signedAt).map(x => esc(x.role));
        mark = ICON.check; h = 'Your part is done.';
        lead = `Waiting for the <b>${waiting.join('</b> and <b>')}</b> to sign. Send them this link; the page does the rest.`;
        act = `<div class="figure">${pr.signedCount} <small>of ${pr.requiredCount} signed</small></div>
               <button class="push quiet" data-copylink>Copy the link</button>` + ownOptions(d, s);
        note = ticketLine(pr) + chips(pr) + `<div style="margin-top:8px"><a href="#" data-unsign="${esc(pr.id)}">Take my signature back</a> (withdraws this attempt)</div>` + othersLine(s);
        break;
      }
      case 'p-overtaken': {
        const pr = s.pr, ov = pr.overtaken;
        const who = ov.direct ? 'Someone' : `The ${esc(ov.byRole || 'other party')}`;
        const amt = pr.amountRequest === 'all' || !pr.amountRequest ? bal : kas(parseKas(pr.amountRequest));
        mark = ICON.clock; cls = 'ready'; h = `${who} went first.`;
        lead = `${ov.direct ? 'A withdrawal' : `Their <b>${esc(ov.entry)}</b> withdrawal`} landed and took the coins this attempt was built on. Nothing of yours moved; <b>${bal} KAS</b> is here now. The same withdrawal can be built again on that, and every key signs again.`;
        act = `<button class="push full" data-rebuild="${esc(pr.id)}">Rebuild: pay <span class="amt">${amt} KAS</span> ${payeeText(pr)}</button>`;
        note = ticketLine(pr) + `<div style="margin-top:8px"><a href="#" data-dismiss="${esc(pr.id)}">Never mind</a> (drop this attempt; the paths are offered again)</div>`;
        break;
      }
      case 'p-stuck': {
        const pr = s.pr;
        const raw = (pr.lastError || '').replace(/^Node rejected the transaction: /, '').replace(/^RPC Server \(remote error\) -> /, '');
        const why = raw ? `<details class="cv-why"><summary>What the network said</summary><div class="mono">${esc(raw)}</div></details>` : '';
        // Script and lock failures are the covenant's own rules: the same tx fails the same way
        const byRules = /failed to verify|verification failed|Number too big|locktime requirement/i.test(raw);
        if (byRules) {
          mark = ICON.lock; h = 'The covenant\'s rules turned this one down.';
          lead = `Everyone signed, but this transaction doesn't meet the covenant's rules, so sending it again won't change the answer. Nothing moved; <b>${bal} KAS</b> is still here.`;
          act = s.mine
            ? `<button class="push full" data-unsign="${esc(pr.id)}">Cancel this attempt</button>`
            : '';
          note = (s.mine ? 'Cancelling clears it for everyone, and the page shows what can be done now.' : 'One of the signers can cancel it; then the page shows what can be done now.')
            + ticketLine(pr) + chips(pr) + why;
        } else {
          mark = ICON.pen; cls = 'ready'; h = 'Everyone signed. It didn\'t go through.';
          lead = raw
            ? `The network didn't take it this time. Nothing moved; sending it again usually works.`
            : `All ${pr.requiredCount} signatures are in, but the transaction was never sent.`;
          act = `<button class="push full" data-rebroadcast="${esc(pr.id)}">Send it again</button>`;
          note = ticketLine(pr) + chips(pr) + why + (s.mine
            ? `<div style="margin-top:8px">If it keeps failing, <a href="#" data-unsign="${esc(pr.id)}">take your signature back</a> and start over; a fresh attempt is built against the chain as it is now.</div>`
            : '');
        }
        break;
      }
      case 'p-others': {
        const pr = s.pr;
        mark = ICON.clock; h = `The ${esc(pr.signers.map(x => x.role).join(' and '))} are settling this.`;
        lead = `${pr.signedCount} of ${pr.requiredCount} signed on <b>${esc(pr.entry)}</b>. Your key is not part of that path; see what is yours under the rules below.`;
        note = ticketLine(pr) + chips(pr);
        break;
      }
      case 'p-broadcast': {
        const pr = s.pr;
        mark = ICON.check; cls = 'done'; h = 'All signed. The money is moving.';
        lead = `<b>${kas(payoutOf(pr))} KAS</b> ${payeeText(pr)} was broadcast. ${changeOf(pr) > 0 ? `<b>${kas(changeOf(pr))} KAS</b> comes back here as one coin.` : 'The balance here will read zero once the network has it.'}`;
        act = pr.txId ? `<a class="push quiet" href="https://explorer.kaspa.org/transactions/${esc(pr.txId)}" target="_blank" rel="noopener">See it on the explorer</a>` : '';
        break;
      }
      case 'notyet': {
        const p0 = s.paths[0], cap = p0.studioCantBuild;
        mark = ICON.clock; h = 'Not enough here for that yet.';
        lead = `<b>${esc(p0.name)}</b> ${esc(cap.text).replace(/(\d[\d,.]*) KAS/, '<b>$1 KAS</b>')}, and only <b>${bal} KAS</b> is here. The Studio won't ask anyone to sign a transaction the network would refuse.`;
        note = 'The money is safe where it is. Once the balance covers it, this page offers the withdrawal.'
          + (s.paths.length > 1 ? ` Same for ${s.paths.slice(1).map(p => '<b>' + esc(p.name) + '</b>').join(', ')}.` : '');
        break;
      }
      case 'byhand': {
        const p0 = s.paths[0];
        mark = ICON.clock; h = 'Anyone can send this on. The Studio can\'t yet.';
        lead = `<b>${bal} KAS</b> is here and <b>${esc(p0.name)}</b> needs no signature: any transaction that pays the pinned recipient is valid. The Studio only builds withdrawals it can sign, so this one is done by hand for now.`;
        note = 'See the rules below for where the money must go.';
        break;
      }
      default:
        mark = ICON.clock; h = 'Nothing for you to do right now.';
        lead = `<b>${bal} KAS</b> is here, but no spend path opens with your key alone. ${others.length ? 'See what ' + others.join(' or ') + ' can do under the rules below.' : ''}`;
        note = 'Your part comes when the other parties act.';
    }
    return `<section class="state ${cls}">
      <div class="mark">${mark}</div>
      <h2>${h}</h2>
      <p class="lead">${lead}</p>
      ${act ? `<div class="act" id="cvAct">${act}</div>` : ''}
      ${note ? `<div class="note">${note}</div>` : ''}
    </section>`;
  }

  function rulesFold(d) {
    const ex = d.explanation || { paths: [] };
    const exByName = {}; for (const p of ex.paths || []) exByName[p.name] = p;
    const myRoles = new Set(d.you ? d.you.roles : []);
    const rows = (d.paths || []).map(p => {
      const e = exByName[p.name] || {};
      const roles = signerRoles(e);
      const needs = (e.needs || []);
      const who = roles.length ? (roles.length === 1 ? `The ${esc(roles[0])}` : roles.map(r => 'the ' + esc(r)).join(' + ')) : (p.sigCount ? 'A signer' : 'Anyone');
      const isYou = roles.some(r => myRoles.has(r));
      const other = needs.filter(n => !/signature from/.test(n));
      let what = `can withdraw${p.sigCount > 1 ? ` with <b>${p.sigCount} signatures</b>` : ''}`;
      what += other.length ? ', if ' + other.join(', and ') + '.' : ' at any time.';
      if (e.other && e.other.length) what += ` Also checks: ${e.other.map(o => '<code style="display:inline">' + esc(o) + '</code>').join(', ')}.`;
      return `<div class="rule"><div class="who${isYou ? ' you' : ''}">${who}</div><div class="what">${what}${p.lockLabel ? `<br><span class="lock">Lock read from the script: ${esc(p.lockLabel)}</span>` : ''}<code>${esc(p.name)}(${(p.inputs || []).map(i => i.type).join(', ')})</code></div></div>`;
    });
    return `<p>${(d.paths || []).length === 1 ? 'One way' : (d.paths || []).length + ' ways'} to move the money, written into the address itself${q('A covenant is a set of spending rules the network enforces. No one, not even the Studio, can move the coins outside these rules.')}:</p>${rows.join('')}`;
  }

  function partiesFold(d) {
    const parties = d.parties || [];
    if (!parties.length) return `<p>No parties are recorded for this covenant.</p>`;
    const rows = parties.map(p => `
      <div class="party${p.isYou ? ' you' : ''}">
        <span class="av">${esc((p.role || '?')[0])}</span>
        <span class="name">${esc(nameOf(p))}<span> · ${esc(p.role)}${p.isCreator ? ', creator' : ''}</span></span>
        <span class="addr mono" title="${esc(p.address)}">${esc(short(p.address))}</span>
        <span class="tag${p.joined ? ' here' : ''}">${p.joined ? 'opened this link' : 'not yet here'}</span>
      </div>`);
    const verdict = !authToken ? `<p style="margin-top:10px">Connect the wallet that holds one of these keys and this page will show what is yours to do.</p>`
      : (d.you && d.you.roles.length) ? `<p style="margin-top:10px">This covenant is in your Studio list${d.you.isCreator ? '' : ' as external'}.</p>`
      : `<p style="margin-top:10px">Your connected wallet (${esc(short(me))}) is not one of them.</p>`;
    return rows.join('') + verdict;
  }

  // The ledger: every deposit the chain showed at this address, every withdrawal the
  // Studio sent, in order. Balance is never read from here.
  function moneyFold(d) {
    const m = d.money;
    const roleOf = a => { const p = (d.parties || []).find(x => x.address === a); return p ? (p.isYou ? 'you' : p.role) : short(a || ''); };
    const rows = [];
    for (const x of m.deposits) rows.push({ at: new Date(x.at).getTime(), html: `<div class="party"><span class="av" style="color:var(--success)">+</span><span class="name">${kas(x.amountSompi)} KAS in<span> · ${x.via === 'studio' ? 'through the Studio' : 'sent directly to the address'}${x.spent ? ', since spent' : ''}</span></span><span class="addr mono"><a href="https://explorer.kaspa.org/transactions/${esc(x.txid)}" target="_blank" rel="noopener">${esc(x.txid.slice(0, 10))}… ↗</a></span><span class="tag">${fmtDate(x.at)}</span></div>` });
    for (const x of m.spends) rows.push({ at: new Date(x.at).getTime(), html: `<div class="party"><span class="av">−</span><span class="name">${kas(x.payoutSompi)} KAS out${x.entry ? ` via <b>${esc(x.entry)}</b>` : ''}<span> · by ${esc(roleOf(x.by))}${Number(x.changeSompi) > 0 ? `, ${kas(x.changeSompi)} KAS kept here` : ''}, fee ${kas(x.feeSompi)} KAS</span></span><span class="addr mono"><a href="https://explorer.kaspa.org/transactions/${esc(x.txid)}" target="_blank" rel="noopener">${esc(x.txid.slice(0, 10))}… ↗</a></span><span class="tag">${fmtDate(x.at)}</span></div>` });
    rows.sort((a, b) => a.at - b.at);
    const n = m.deposits.length;
    const viaText = n ? ` in ${n} deposit${n === 1 ? '' : 's'}${m.depositsDirect && m.depositsViaStudio ? ` (${m.depositsViaStudio} via the Studio, ${m.depositsDirect} sent directly)` : m.depositsDirect ? ' sent directly' : ' via the Studio'}` : '';
    const summary = `<p style="margin:0 0 10px"><b>${kas(m.totalInSompi)} KAS</b> came in${viaText}; <b>${kas(m.totalOutSompi)} KAS</b> went out${m.totalFeeSompi > 0 ? ` (plus ${kas(m.totalFeeSompi)} KAS in network fees)` : ''}. Balance now: ${d.balanceSompi === null || d.balanceSompi === undefined ? 'not known' : '<b>' + kas(d.balanceSompi) + ' KAS</b>'}, read from the chain.</p>`;
    return summary + rows.map(r => r.html).join('') + `<p style="margin-top:10px;font-size:12px;color:var(--text-muted)">Deposits are what the network showed at this address; withdrawals are the ones sent through the Studio. Anything moved by other tools shows as a balance change only.</p>`;
  }

  function codeFold(d) {
    const params = (d.params || []).map(p => { const v = String(p.value || ''); return `<span class="k">${esc(p.name)} <span style="opacity:.6">${esc(p.type)}</span></span><span class="v mono" title="${esc(v)}">${esc(v.length > 48 ? v.slice(0, 20) + '…' + v.slice(-12) : v)}</span>`; }).join('');
    const fundings = (d.fundings || []).map(f => `<a href="https://explorer.kaspa.org/transactions/${esc(f.txid)}" target="_blank" rel="noopener">${esc(f.txid.slice(0, 16))}… ↗</a> ${f.amountSompi ? kas(f.amountSompi) + ' KAS · ' : ''}${fmtDateTime(f.at)}`).join('<br>');
    return `
      <div class="kv">
        <span class="k">Address</span><span class="v mono copyable" id="cvCopyAddr" title="Click to copy">${esc(d.contractAddress)}</span>
        <span class="k">Balance now</span><span class="v">${d.balanceSompi === null || d.balanceSompi === undefined ? 'not known' : kas(d.balanceSompi) + ' KAS'}</span>
        ${d.totalFundedSompi > 0 ? `<span class="k">Deposited</span><span class="v">${kas(d.totalFundedSompi)} KAS in ${d.fundings.length} deposit${d.fundings.length === 1 ? '' : 's'} via the Studio</span>` : ''}
        ${fundings ? `<span class="k">Deposits</span><span class="v mono" style="font-size:11.5px">${fundings}</span>` : ''}
        ${params}
        <span class="k">Created</span><span class="v">${d.createdAt ? fmtDateTime(d.createdAt) : ''}</span>
        <span class="k">Explorer</span><span class="v"><a href="${esc(d.explorerUrl)}" target="_blank" rel="noopener">explorer.kaspa.org ↗</a></span>
        <span class="k">Covenant file</span><span class="v"><a href="/api/share/${encodeURIComponent(token)}/manifest.ksm" download>Download .ksm</a> · <a href="/ksm.html" target="_blank" rel="noopener">what is this?</a></span>
      </div>
      <p>Keep the covenant file. With it and your key you can withdraw using any compatible tool, even if the Studio is gone.</p>
      <p>The exact code compiled into that address. Same code and same keys always give the same address.</p>
      <pre class="src">${esc(d.sourceCode || '')}</pre>`;
  }

  function render() {
    const d = data;
    const s = situation(d);
    const bal = d.balanceSompi;
    const creator = (d.parties || []).find(p => p.isCreator);
    const m = d.money;
    const sub = (bal === null || bal === undefined) ? 'Balance not known'
      : bal > 0 ? `Funded with <b>${kas(bal)} KAS</b>` : ((d.totalFundedSompi > 0 || (m && m.totalInSompi > 0)) ? 'Withdrawn' : 'Not funded');
    main.innerHTML = `
      <div class="cv-title">
        <h1>${esc(d.contractName)}</h1>
        <div class="sub">${sub}${d.createdAt ? ` · created ${fmtDate(d.createdAt)}` : ''}${creator ? ` by ${esc(creator.isYou ? 'you' : creator.role)}` : ''}</div>
      </div>
      ${stateCard(d, s)}
      <div class="folds">
        <details class="fold"><summary><span class="ico">${PIC.rules}</span>What are the rules?<span class="chev">›</span></summary><div class="body">${rulesFold(d)}</div></details>
        <details class="fold"><summary><span class="ico">${PIC.people}</span>Who is involved?<span class="chev">›</span></summary><div class="body">${partiesFold(d)}</div></details>
        ${d.money && (d.money.deposits.length || d.money.spends.length) ? `<details class="fold"><summary><span class="ico">${PIC.coins}</span>What moved?<span class="chev">›</span></summary><div class="body">${moneyFold(d)}</div></details>` : ''}
        <details class="fold"><summary><span class="ico">${PIC.code}</span>Show me the code<span class="chev">›</span></summary><div class="body">${codeFold(d)}</div></details>
      </div>`;

    const copy = document.getElementById('cvCopyAddr');
    if (copy) copy.onclick = function () { navigator.clipboard.writeText(d.contractAddress); const t = this.textContent; this.textContent = 'copied'; setTimeout(() => this.textContent = t, 1200); };
    const big = document.getElementById('cvConnectBig'); if (big) big.onclick = connect;
    const ca = main.querySelector('[data-copyaddr]'); if (ca) ca.onclick = function () { navigator.clipboard.writeText(d.contractAddress); this.textContent = 'Address copied'; setTimeout(() => this.textContent = 'Copy the address', 1500); };
    const rl = main.querySelector('[data-reload]'); if (rl) rl.onclick = () => load();
    bindWithdraw();
    bindDeposit();
    bindProposal();
    bindAmount();
  }

  // ── How much (the field above the Withdraw / Sign-to-pay buttons) ─
  // "All" means everything the path lets out (the server settles the exact figure: the
  // balance minus the fee, or the path's cap). A smaller figure is what the payee gets;
  // the rest minus the fee comes back to this address as a new coin.
  let amountFill = null;   // a figure to put in the field on the next render/restore (from a server hint)
  function amountRow(d, paths) {
    if (!(paths || []).some(p => !p.toSelf)) return '';
    const bal = d.balanceSompi || 0;
    const notes = [];
    for (const p of paths) {
      if (p.toSelf) continue;
      const via = paths.length > 1 ? `<b>${esc(p.name)}</b>` : 'This path';
      if (p.amountExactSompi) notes.push(`${via} pays exactly ${kas(p.amountExactSompi)} KAS at a time.`);
      else if (p.amountMaxSompi) notes.push(`${via} lets at most ${kas(p.amountMaxSompi)} KAS leave per withdrawal.`);
      if (p.amountMinSompi && !p.amountExactSompi) notes.push(`${via} pays out at least ${kas(p.amountMinSompi)} KAS at a time.`);
      if (p.oneCoin && d.utxoCount > 1) notes.push(`${via} takes one coin at a time; the ${kas(bal)} KAS here sits in ${d.utxoCount} coins.`);
    }
    return `<div class="cv-amt">
        <div class="cv-amt-in"><input id="cvAmt" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${kas(bal)}" aria-label="Amount in KAS"><span class="unit">KAS</span></div>
        <button type="button" class="cv-all on" data-all title="Everything the path allows">All</button>
      </div>
      <div class="cv-amt-note" id="cvAmtNote">${notes.join(' ')}</div>`;
  }
  function amountField() { return document.getElementById('cvAmt'); }
  function parseKas(text) {
    const t = String(text || '').trim().replace(/,/g, '');
    if (!/^\d+(\.\d{1,8})?$/.test(t)) return null;
    const [w, f = ''] = t.split('.');
    return Number(w) * 1e8 + Number((f + '00000000').slice(0, 8));
  }
  function amountState() {
    const inp = amountField();
    if (!inp) return { all: true };
    const bal = data.balanceSompi || 0;
    const v = parseKas(inp.value);
    if (v === null) return { bad: 'Enter an amount in KAS, like 2.5' };
    if (v <= 0) return { bad: 'Enter an amount above zero' };
    if (v >= bal || inp.value.trim() === kas(bal)) return { all: true };   // the display rounds to 4 decimals
    return { all: false, sompi: v };
  }
  function bindAmount() {
    const inp = amountField(); if (!inp) return;
    const all = main.querySelector('[data-all]');
    const note = document.getElementById('cvAmtNote');
    const baseNote = note ? note.innerHTML : '';
    const bal = data.balanceSompi || 0;
    if (amountFill !== null) { inp.value = kas(amountFill); amountFill = null; }
    const sync = () => {
      const st = amountState();
      if (all) all.classList.toggle('on', !!st.all);
      if (note && !st.bad) { note.innerHTML = baseNote; note.classList.remove('bad'); }
      const text = st.bad ? '…' : st.all ? kas(bal) : kas(st.sompi);
      main.querySelectorAll('[data-withdraw]:not([data-toself]) .amt, [data-propose]:not([data-toself]) .amt').forEach(el => el.textContent = text + ' KAS');
    };
    inp.oninput = sync;
    inp.onkeydown = e => { if (e.key === 'Enter') { const b = main.querySelector('[data-withdraw]:not([data-toself]), [data-propose]:not([data-toself])'); if (b) b.click(); } };
    if (all) all.onclick = () => { inp.value = kas(bal); sync(); };
    sync();
  }
  function amountNote(msg) {
    const inp = amountField();
    if (inp) inp.dispatchEvent(new Event('input'));   // a snapped value must reach the button labels too
    const note = document.getElementById('cvAmtNote');
    if (note) { note.innerHTML = msg; note.classList.add('bad'); }
    if (inp) inp.focus();
  }
  // The amount for one path, checked against the balance and the path's constant rules.
  // Returns { all } | { amountKas } for the server, or null after showing why not.
  function amountFor(p) {
    if (p.toSelf) return null;   // merge: everything, no amount
    const st = amountState();
    if (st.bad) { amountNote(st.bad); return null; }
    const inp = amountField();
    if (st.all) return { all: true };
    const v = st.sompi;
    if (p.amountExactSompi && v !== Number(p.amountExactSompi)) { if (inp) inp.value = kas(p.amountExactSompi); amountNote(`<b>${esc(p.name)}</b> pays exactly ${kas(p.amountExactSompi)} KAS at a time.`); return null; }
    if (p.amountMaxSompi && v > Number(p.amountMaxSompi)) { if (inp) inp.value = kas(p.amountMaxSompi); amountNote(`<b>${esc(p.name)}</b> lets at most ${kas(p.amountMaxSompi)} KAS leave per withdrawal.`); return null; }
    if (p.amountMinSompi && v < Number(p.amountMinSompi)) { if (inp) inp.value = kas(p.amountMinSompi); amountNote(`<b>${esc(p.name)}</b> pays out at least ${kas(p.amountMinSompi)} KAS at a time.`); return null; }
    return { amountKas: inp.value.trim().replace(/,/g, '') };
  }
  // A relative lock (this.ageDaa) counts from the coin's birth: what stays behind after a
  // partial pull is a NEW coin, so it relocks for the whole period. Say so, in KAS and a
  // date, and make "take all" the easy answer. Resolves to the amount to use, or null.
  function confirmRelock(p, amount) {
    const csv = ((p.locks && p.locks.csv) || []).map(Number);
    if (!csv.length) return Promise.resolve(amount);
    const bal = data.balanceSompi || 0;
    const cap = p.amountMaxSompi ? Number(p.amountMaxSompi) : null;
    const out = amount.all ? (cap !== null && cap < bal ? cap : bal) : parseKas(amount.amountKas);
    const left = bal - out;
    if (left <= 0) return Promise.resolve(amount);
    if (amount.all && cap !== null) return Promise.resolve(amount);   // the cap, not the user, is holding the rest back
    const period = Math.max(...csv);
    const until = daaToMs((data.virtualDaaScore || 0) + period);
    const days = period / 864000;
    const when = until ? fmtDate(until) : `about ${days >= 1 ? days.toFixed(days >= 10 ? 0 : 1) + ' days' : Math.round(period / 36000) + ' hours'} from now`;
    return new Promise(resolve => {
      const box = actionBox();
      box.innerHTML = `
        <div class="cv-flow">
          <div class="cv-receipt" style="border-color:var(--border);background:var(--bg-tertiary)">
            <div class="big">${kas(left)} <small>KAS would stay, and lock again</small></div>
            <div class="deploy-hint" style="margin-top:10px">This path waits ${period.toLocaleString()} blocks (about ${days >= 1 ? days.toFixed(days >= 10 ? 0 : 1) + ' days' : Math.round(period / 36000) + ' hours'}) from the coin's arrival. The ${kas(left)} KAS left here becomes a new coin, so it would not open again until <b>${esc(when)}</b>. Taking everything now avoids that.</div>
          </div>
          <div class="cv-flow-actions">
            <button class="push quiet" data-cancel>Cancel</button>
            <button class="push quiet" data-partial>Take ${kas(out)} KAS, lock the rest</button>
            <button class="push" data-takeall>Take all ${kas(bal)} KAS instead</button>
          </div>
        </div>`;
      box.querySelector('[data-cancel]').onclick = () => { restoreAct(); resolve(null); };
      box.querySelector('[data-partial]').onclick = () => resolve(amount);
      box.querySelector('[data-takeall]').onclick = () => { amountFill = bal; resolve({ all: true }); };
    });
  }

  // ── Withdraw through one path (inside the state card) ─────────────
  let spend = null;
  let stateActHtml = null;   // the buttons to restore on Cancel/Back

  function actionBox() { return document.getElementById('cvAct'); }
  function restoreAct() { const box = actionBox(); if (box && stateActHtml !== null) { box.innerHTML = stateActHtml; bindWithdraw(); bindDeposit(); bindProposal(); bindAmount(); } }
  function bindWithdraw() {
    main.querySelectorAll('[data-withdraw]').forEach(b => b.onclick = () => {
      const p = (data.paths || []).find(x => x.name === b.dataset.withdraw);
      const amount = p && !p.toSelf ? amountFor(p) : null;
      if (p && !p.toSelf && !amount) return;   // the note under the field says why
      stateActHtml = actionBox().innerHTML;
      startWithdraw(b.dataset.withdraw, amount);
    });
  }
  function placeholderFor(t) {
    t = (t || '').toLowerCase();
    return t === 'pubkey' ? 'kaspa:q… or 64-hex pubkey' : t === 'int' ? 'integer' : t === 'temporal' ? 'ms timestamp or ISO date'
         : t === 'string' ? 'text' : t === 'bool' ? 'true / false' : 'hex bytes, or text:… for UTF-8';
  }
  async function startWithdraw(name, amount) {
    const p = (data.paths || []).find(x => x.name === name);
    if (!p) return;
    if (amount) { amount = await confirmRelock(p, amount); if (!amount) return; }
    const box = actionBox();
    const args = (p.inputs || []).filter(i => (i.type || '').toLowerCase() !== 'sig');
    if (!args.length) return buildSpend(name, {}, amount);
    box.innerHTML = `
      <div class="cv-flow">
        <p class="deploy-hint" style="margin:0 0 10px">This path asks for ${args.length === 1 ? 'one value' : args.length + ' values'} before it can be signed.</p>
        ${args.map(i => `<div class="deploy-field">
          <label class="deploy-label">${esc(i.name)} <span class="deploy-type">${esc(i.type)}</span></label>
          <input class="deploy-input" data-arg="${esc(i.name)}" placeholder="${esc(placeholderFor(i.type))}" spellcheck="false">
        </div>`).join('')}
        <div class="cv-flow-actions">
          <button class="push quiet" data-cancel>Cancel</button>
          <button class="push" data-go>Continue</button>
        </div>
      </div>`;
    box.querySelector('[data-cancel]').onclick = restoreAct;
    box.querySelector('[data-go]').onclick = () => {
      const a = {}; box.querySelectorAll('[data-arg]').forEach(inp => a[inp.dataset.arg] = inp.value.trim());
      buildSpend(name, a, amount);
    };
  }

  // Receipt rows shared by the single-signer and the proposal previews
  function moneyRows(x) {
    const partial = changeOf(x) > 0;
    return `<div class="row"><span class="k">From</span><span class="v">${kas(x.inputSompi != null ? x.inputSompi : x.amountSompi)} KAS in ${x.inputCount} coin${x.inputCount > 1 ? 's' : ''} here</span></div>
          ${partial ? `<div class="row"><span class="k">Stays here</span><span class="v">${kas(changeOf(x))} KAS, back into this covenant as one coin</span></div>` : ''}
          <div class="row"><span class="k">Fee</span><span class="v">${kas(x.feeSompi)} KAS${partial ? ' (a second output weighs more)' : ''}</span></div>`;
  }
  function leftoverHint(info) {
    if (!(info.remainingUtxos > 0)) return '';
    return `<div class="deploy-hint">${info.oneCoin ? `This path takes one coin at a time; ${info.remainingUtxos} more coin${info.remainingUtxos > 1 ? 's' : ''} stay${info.remainingUtxos > 1 ? '' : 's'} here for later.` : `${info.remainingUtxos} more coin(s) beyond the ${info.inputCount}-input cap; withdraw again after this confirms.`}</div>`;
  }
  // A refused amount comes back with the figure that would work; put it in the field
  function amountFromError(e) {
    const f = (e && e.flags) || {};
    if ((f.badAmount || f.outputRule) && f.maxSompi) amountFill = Number(f.maxSompi);
    return f.badAmount || f.outputRule;
  }

  async function buildSpend(name, args, amount) {
    const box = actionBox();
    const p = (data.paths || []).find(x => x.name === name);
    box.innerHTML = '<div class="deploy-hint">Preparing the withdrawal…</div>';
    let info;
    try { info = await CA.buildSpend({ contractId: data.contractId, entry: name, args, amount }); }
    catch (e) {
      const amountProblem = amountFromError(e);
      box.innerHTML = fail(e.message || 'Could not build the withdrawal', amountProblem ? 'Not that amount' : undefined);
      if (amountProblem) { const r = box.querySelector('[data-retry]'); if (r) r.remove(); const b = box.querySelector('[data-back]'); if (b) { b.textContent = 'Change the amount'; b.className = 'push'; } }
      return bindRetry(box, name, args, amount);
    }
    spend = info;
    const receive = kas(payoutOf(info));
    box.innerHTML = `
      <div class="cv-flow">
        <div class="cv-receipt">
          <div class="big">${receive} <small>${info.destinationPinned ? (info.destination === info.contractAddress ? 'KAS stays in this covenant' : 'KAS will be paid where the rules say') : 'KAS will arrive in your wallet'}</small></div>
          <div class="row"><span class="k">Path</span><span class="v"><code>${esc(info.entrypoint)}()</code></span></div>
          ${(info.args || []).map(a => `<div class="row"><span class="k">${esc(a.name)}</span><span class="v"><code>${esc(a.value)}</code></span></div>`).join('')}
          ${info.pre ? `<div class="row"><span class="k">First</span><span class="v">${info.pre.inputCount} coins here are merged into one via <code>${esc(info.pre.entrypoint)}()</code> (fee ${kas(info.pre.feeSompi)} KAS); the withdrawal then spends that coin. Two signatures, one after the other.</span></div>` : ''}
          ${moneyRows(info)}
          <div class="row"><span class="k">To</span><span class="v"><code>${esc(info.destination)}</code> <span class="deploy-hint" style="display:inline">${info.destinationPinned ? (info.destination === info.contractAddress ? '(back into this covenant)' : '(the party the rules name)') : "(this session's wallet)"}</span></span></div>
          ${leftoverHint(info)}
        </div>
        <div class="cv-flow-actions">
          <button class="push quiet" data-cancel>Cancel</button>
          <button class="push" data-sign>${connectedWallet === 'kasla' ? 'Sign with Kasla and withdraw' : (info.pre ? 'Sign twice and withdraw' : 'Sign and withdraw')}</button>
        </div>
      </div>`;
    box.querySelector('[data-cancel]').onclick = restoreAct;
    box.querySelector('[data-sign]').onclick = () => signAndBroadcast(box);
  }
  function fail(msg, title) {
    return `<div class="cv-flow"><div class="redeem-error-screen"><div class="redeem-error-title">${esc(title || 'Withdrawal unavailable')}</div><div class="redeem-error-message">${esc(msg)}</div></div>
      <div class="cv-flow-actions"><button class="push quiet" data-back>Back</button><button class="push" data-retry>Try again</button></div></div>`;
  }
  function bindRetry(box, name, args, amount) {
    const b = box.querySelector('[data-back]'); if (b) b.onclick = restoreAct;
    const r = box.querySelector('[data-retry]'); if (r) r.onclick = () => buildSpend(name, args, amount);   // always rebuilds
  }

  async function signAndBroadcast(box) {
    const st = spend; if (!st) return;
    const btn = box.querySelector('[data-sign]'); if (btn) { btn.disabled = true; btn.textContent = 'Signing…'; }
    // Kasla: the click is the launcher. The window must open here, synchronously, or popup
    // blockers refuse it; it is pointed at Kasla's signing page once the request exists.
    const kaslaPopup = connectedWallet === 'kasla' ? openKaslaWindow(null) : null;
    const status = kaslaStatusLine(box, kaslaPopup);
    try {
      const bc = await CA.signAndBroadcast({
        contractId: data.contractId, contractName: data.contractName, spend: st, popup: kaslaPopup,
        onStatus: (m) => { status(m); if (btn && /Broadcasting/.test(m)) btn.textContent = 'Broadcasting…'; }
      });
      const toSelf = bc.toSelf;
      const receive = kas(bc.receiveSompi);
      box.innerHTML = `
        <div class="cv-flow">
          <div class="cv-receipt">
            <div class="big"><span class="ok"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg></span>${receive} <small>${toSelf ? 'KAS merged into one coin at this covenant' : (st.destinationPinned ? 'KAS paid where the rules say' : 'KAS withdrawn to your wallet')}</small></div>
            ${bc.mergeTxId ? `<div class="row"><span class="k">Merge</span><span class="v"><a class="deploy-explorer-link" href="https://explorer.kaspa.org/transactions/${esc(bc.mergeTxId)}" target="_blank" rel="noopener">${esc(bc.mergeTxId.slice(0, 24))}… ↗</a></span></div>` : ''}
            ${bc.changeSompi > 0 ? `<div class="row"><span class="k">Stays here</span><span class="v">${kas(bc.changeSompi)} KAS, as one new coin</span></div>` : ''}
            <div class="row"><span class="k">Transaction</span><span class="v"><a class="deploy-explorer-link" href="https://explorer.kaspa.org/transactions/${esc(bc.txId)}" target="_blank" rel="noopener">${esc(bc.txId.slice(0, 24))}… ↗</a></span></div>
          </div>
          <div class="cv-flow-actions"><button class="push" data-reload>Refresh this page</button></div>
        </div>`;
      const prev = data.balanceSompi;
      box.querySelector('[data-reload]').onclick = function () { this.disabled = true; this.textContent = 'Checking the chain…'; reloadAfterSpend(prev); };
      reloadAfterSpend(prev);
    } catch (err) {
      if (kaslaPopup && !kaslaPopup.closed) { try { kaslaPopup.close(); } catch (_) {} }
      const msg = typeof err === 'string' ? err : (err && err.message) || JSON.stringify(err);
      const merged = err && err.merged;
      box.innerHTML = fail(msg, err && err.code === 4001 ? 'Withdrawal cancelled' : (merged ? 'Merged, not withdrawn' : undefined)).replace('</div></div>', `</div><div class="deploy-hint">${merged ? 'The coins are now one coin at this covenant, still under the same rules. Refresh, then withdraw from it.' : 'Nothing left the covenant unless a transaction id is shown. A rejected transaction moves no funds.'}</div></div>`);
      if (merged) { const r = box.querySelector('[data-retry]'); if (r) { r.textContent = 'Refresh'; r.onclick = () => load(true); } const b = box.querySelector('[data-back]'); if (b) b.onclick = () => load(true); return; }
      bindRetry(box, st.name, st.args, st.amount);
    }
  }

  // A one-line status under the action buttons while Kasla's window is open, with a way
  // to bring that window back if it went behind. Returns a setter; no-op for other wallets.
  function kaslaStatusLine(box, popup) {
    if (!popup) return () => {};
    const acts = box.querySelector('.cv-flow-actions');
    const line = document.createElement('div');
    line.className = 'deploy-hint';
    line.style.marginTop = '10px';
    line.innerHTML = '<span data-status>Opening Kasla…</span> <a href="#" data-focus style="margin-left:8px">Show Kasla window</a>';
    if (acts) acts.insertAdjacentElement('afterend', line); else box.appendChild(line);
    line.querySelector('[data-focus]').onclick = (e) => { e.preventDefault(); if (popup && !popup.closed) { try { popup.focus(); } catch (_) {} } };
    return (m) => { const el = line.querySelector('[data-status]'); if (el) el.textContent = m; };
  }

  // ── Multi-sig: sign first (that is the proposal), the others finish ─
  function bindProposal() {
    main.querySelectorAll('[data-propose]').forEach(b => b.onclick = () => {
      const p = (data.paths || []).find(x => x.name === b.dataset.propose);
      const amount = p && !p.toSelf ? amountFor(p) : null;
      if (p && !p.toSelf && !amount) return;
      stateActHtml = actionBox().innerHTML;
      startProposal(b.dataset.propose, amount);
    });
    main.querySelectorAll('[data-sign-proposal]').forEach(b => b.onclick = () => { stateActHtml = actionBox().innerHTML; signProposal(b.dataset.signProposal); });
    main.querySelectorAll('[data-rebroadcast]').forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = 'Sending…';
      const r = await api(`/api/proposals/${encodeURIComponent(b.dataset.rebroadcast)}/broadcast`, { method: 'POST' });
      if (r.success && r.txId) {
        const box = actionBox();
        box.innerHTML = `<div class="cv-flow"><div class="cv-receipt"><div class="big"><span class="ok">✓</span> <small>Sent</small></div>
          <div class="row"><span class="k">Transaction</span><span class="v"><a class="deploy-explorer-link" href="https://explorer.kaspa.org/transactions/${esc(r.txId)}" target="_blank" rel="noopener">${esc(r.txId.slice(0, 24))}… ↗</a></span></div></div>
          <div class="cv-flow-actions"><button class="push" data-reload>Refresh this page</button></div></div>`;
        const prev = data.balanceSompi;
        box.querySelector('[data-reload]').onclick = function () { this.disabled = true; this.textContent = 'Checking the chain…'; reloadAfterSpend(prev); };
        reloadAfterSpend(prev);
        return;
      }
      load(true);   // the card shows the node's new reason
    });
    main.querySelectorAll('[data-rebuild]').forEach(b => b.onclick = async () => {
      stateActHtml = actionBox().innerHTML;
      const box = actionBox();
      box.innerHTML = '<div class="deploy-hint">Building it again on the coins here now…</div>';
      let r;
      try { r = await api(`/api/proposals/${encodeURIComponent(b.dataset.rebuild)}/rebuild`, { method: 'POST' }); }
      catch (e) { r = { success: false, error: 'Network error: ' + e.message }; }
      if (!r.success) {
        const amountProblem = amountFromError({ flags: r });
        box.innerHTML = fail(r.error || 'Could not rebuild', amountProblem ? 'Not that amount any more' : 'Rebuild unavailable')
          .replace('</div></div>', `</div><div class="deploy-hint">${amountProblem ? 'Less is here than that attempt asked for. Drop it below and start a fresh one for what fits.' : 'Nothing moved.'}</div></div>`);
        const t = box.querySelector('[data-retry]'); if (t) t.remove();
        const bk = box.querySelector('[data-back]'); if (bk) { bk.textContent = 'Back'; bk.onclick = restoreAct; }
        return;
      }
      if (r.existing) { load(); return; }
      signProposal(r.proposal.id, r.proposal);
    });
    const dm = main.querySelector('[data-dismiss]');
    if (dm) dm.onclick = async (e) => {
      e.preventDefault();
      const r = await api(`/api/proposals/${encodeURIComponent(dm.dataset.dismiss)}/withdraw`, { method: 'POST' });
      if (!r.success) alert(r.error || 'Could not drop this attempt');
      load(true);
    };
    const un = main.querySelector('[data-unsign]');
    if (un) un.onclick = async (e) => {
      e.preventDefault();
      if (!confirm('Take your signature back? That withdraws this attempt for everyone; anyone can start a fresh one.')) return;
      const r = await api(`/api/proposals/${encodeURIComponent(un.dataset.unsign)}/withdraw`, { method: 'POST' });
      if (!r.success) alert(r.error || 'Could not withdraw the signature');
      load(true);
    };
  }
  async function startProposal(name, amount) {
    const p = (data.paths || []).find(x => x.name === name);
    if (!p) return;
    if (amount) { amount = await confirmRelock(p, amount); if (!amount) return; }
    const box = actionBox();
    const args = (p.inputs || []).filter(i => (i.type || '').toLowerCase() !== 'sig');
    if (!args.length) return createProposal(name, {}, amount);
    box.innerHTML = `
      <div class="cv-flow">
        <p class="deploy-hint" style="margin:0 0 10px">This path asks for ${args.length === 1 ? 'one value' : args.length + ' values'}. Every signer will see them before signing.</p>
        ${args.map(i => `<div class="deploy-field">
          <label class="deploy-label">${esc(i.name)} <span class="deploy-type">${esc(i.type)}</span></label>
          <input class="deploy-input" data-arg="${esc(i.name)}" placeholder="${esc(placeholderFor(i.type))}" spellcheck="false">
        </div>`).join('')}
        <div class="cv-flow-actions">
          <button class="push quiet" data-cancel>Cancel</button>
          <button class="push" data-go>Continue</button>
        </div>
      </div>`;
    box.querySelector('[data-cancel]').onclick = restoreAct;
    box.querySelector('[data-go]').onclick = () => {
      const a = {}; box.querySelectorAll('[data-arg]').forEach(inp => a[inp.dataset.arg] = inp.value.trim());
      createProposal(name, a, amount);
    };
  }
  async function createProposal(name, args, amount) {
    const box = actionBox();
    box.innerHTML = '<div class="deploy-hint">Preparing the withdrawal…</div>';
    const body = { entry: name, args };
    if (amount && amount.all) body.all = true; else if (amount && amount.amountKas) body.amountKas = String(amount.amountKas);
    let r;
    try { r = await api(`/api/contracts/${data.contractId}/proposals`, { method: 'POST', body: JSON.stringify(body) }); }
    catch (e) { r = { success: false, error: 'Network error: ' + e.message }; }
    if (!r.success) {
      const amountProblem = amountFromError({ flags: r });
      box.innerHTML = fail(r.error || 'Could not start the withdrawal', amountProblem ? 'Not that amount' : 'Withdrawal unavailable');
      if (amountProblem) { const t = box.querySelector('[data-retry]'); if (t) t.remove(); const b = box.querySelector('[data-back]'); if (b) { b.textContent = 'Change the amount'; b.className = 'push'; } }
      return bindProposalRetry(box, () => createProposal(name, args, amount));
    }
    if (r.existing) { load(); return; }   // someone else started one meanwhile; the page shows it
    signProposal(r.proposal.id, r.proposal);
  }
  function bindProposalRetry(box, again) {
    const b = box.querySelector('[data-back]'); if (b) b.onclick = restoreAct;
    const t = box.querySelector('[data-retry]'); if (t) t.onclick = again;
  }
  async function signProposal(pid, pr) {
    const box = actionBox();
    pr = pr || ((data.proposals || (data.proposal ? [data.proposal] : [])).find(x => x.id === pid) || null);
    if (!pr || !pr.txJsonString) { load(); return; }
    const receive = kas(payoutOf(pr));
    const preMine = !!(pr.pre && pr.pre.signerIsYou && !pr.pre.signed);   // I also sign the merge step
    const last = pr.signedCount + 1 + (preMine ? 1 : 0) >= pr.requiredCount;
    box.innerHTML = `
      <div class="cv-flow">
        <div class="cv-receipt">
          <div class="big">${receive} <small>KAS ${payeeText(pr).replace(/<[^>]+>/g, '')}</small></div>
          <div class="row"><span class="k">Path</span><span class="v"><code>${esc(pr.entry)}()</code></span></div>
          ${pr.pre ? `<div class="row"><span class="k">First</span><span class="v">${pr.pre.inputCount} coins are merged into one via <code>${esc(pr.pre.entrypoint || pr.pre.entry)}()</code> (fee ${kas(pr.pre.feeSompi)} KAS), signed by the ${esc(pr.pre.signerIsYou ? 'you' : pr.pre.signerRole || 'owner')}${pr.pre.signed ? ', done' : preMine ? ': that is your second signature here' : ', still to come'}.</span></div>` : ''}
          ${(pr.args || []).map(a => `<div class="row"><span class="k">${esc(a.name)}</span><span class="v"><code>${esc(a.value)}</code></span></div>`).join('')}
          ${moneyRows(pr)}
          <div class="row"><span class="k">To</span><span class="v"><code>${esc(pr.destination)}</code></span></div>
          <div class="row"><span class="k">Signers</span><span class="v">${pr.signers.map(x => (x.signedAt ? '✓ ' : '· ') + esc(x.isYou ? 'you' : x.role)).join(', ')}</span></div>
        </div>
        <div class="cv-flow-actions">
          <button class="push quiet" data-cancel>Cancel</button>
          <button class="push" data-sign>${connectedWallet === 'kasla' ? 'Sign with Kasla' : (preMine ? 'Sign twice' : 'Sign')}${last ? ' and release' : ''}</button>
        </div>
      </div>`;
    box.querySelector('[data-cancel]').onclick = () => { restoreAct(); if ((data.proposals || []).some(x => x.id === pid) || (data.proposal && data.proposal.id === pid)) return; load(); };
    box.querySelector('[data-sign]').onclick = async () => {
      const btn = box.querySelector('[data-sign]'); btn.disabled = true; btn.textContent = 'Signing…';
      const kaslaPopup = connectedWallet === 'kasla' ? openKaslaWindow(null) : null;   // inside the click, see signAndBroadcast
      const status = kaslaStatusLine(box, kaslaPopup);
      try {
        await assertSessionMatchesWallet();
        let preSigned = null;
        if (preMine) {
          status(`Signing the merge (1 of 2)…`); btn.textContent = 'Signing the merge (1 of 2)…';
          const ms = await CA.walletSign(pr.pre.txJsonString, pr.pre.inputCount, {
            popup: kaslaPopup, onStatus: status,
            description: `SilverScript Studio · merge coins at "${String(data.contractName || 'covenant').slice(0, 120)}" via ${pr.pre.entrypoint || pr.pre.entry}()`,
            referenceId: `silverscript:${data.contractId}:proposal:${pid}:merge`
          });
          const mtx = JSON.parse(ms);
          if (!Array.isArray(mtx.inputs) || !mtx.inputs.length) throw new Error('Signed merge has no inputs');
          preSigned = JSON.stringify(mtx);
          btn.textContent = 'Now the withdrawal (2 of 2)…';
        }
        const signedStr = await CA.walletSign(pr.txJsonString, pr.inputCount, {
          popup: kaslaPopup,
          onStatus: status,
          description: `SilverScript Studio · sign withdrawal from "${String(data.contractName || 'covenant').slice(0, 120)}" via ${pr.entry}()`,
          referenceId: `silverscript:${data.contractId}:proposal:${pid}`
        });
        const tx = JSON.parse(signedStr);
        if (!Array.isArray(tx.inputs) || !tx.inputs.length) throw new Error('Signed transaction has no inputs');
        btn.textContent = last ? 'Broadcasting…' : 'Saving your signature…';
        const r = await api(`/api/proposals/${encodeURIComponent(pid)}/sign`, { method: 'POST', body: JSON.stringify(Object.assign({ txJsonString: JSON.stringify(tx) }, preSigned ? { preTxJsonString: preSigned } : {})) });
        if (!r.success) throw new Error(r.error || 'Could not record the signature');
        if (r.complete && r.txId) {
          box.innerHTML = `
            <div class="cv-flow">
              <div class="cv-receipt">
                <div class="big"><span class="ok"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg></span>${receive} <small>KAS released ${payeeText(pr).replace(/<[^>]+>/g, '')}</small></div>
                <div class="row"><span class="k">Transaction</span><span class="v"><a class="deploy-explorer-link" href="https://explorer.kaspa.org/transactions/${esc(r.txId)}" target="_blank" rel="noopener">${esc(r.txId.slice(0, 24))}… ↗</a></span></div>
              </div>
              <div class="cv-flow-actions"><button class="push" data-reload>Refresh this page</button></div>
            </div>`;
          const prev = data.balanceSompi;
          box.querySelector('[data-reload]').onclick = function () { this.disabled = true; this.textContent = 'Checking the chain…'; reloadAfterSpend(prev); };
          reloadAfterSpend(prev);
          return;
        }
        load(true);   // your part is done; the page shows who is left
      } catch (err) {
        if (kaslaPopup && !kaslaPopup.closed) { try { kaslaPopup.close(); } catch (_) {} }
        const msg = typeof err === 'string' ? err : (err && err.message) || JSON.stringify(err);
        box.innerHTML = fail(msg, err && err.code === 4001 ? 'Signature cancelled' : 'Signature not recorded').replace('</div></div>', '</div><div class="deploy-hint">Nothing left the covenant unless a transaction id is shown.</div></div>');
        bindProposalRetry(box, () => signProposal(pid));
      }
    };
  }

  // ── Deposit from the page (the funder's move) ─────────────────────
  // Same sends the Studio makes: extension sendKaspa, or kasperopay on the
  // Kasla account's behalf. The balance is chain truth; confirm-funding only
  // records provenance and is allowed to fail.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function bindDeposit() {
    main.querySelectorAll('[data-deposit]').forEach(b => b.onclick = () => {
      let amt = Number(b.dataset.deposit) || 0;
      if (!amt) {
        const inp = document.getElementById('cvDepositAmt');
        amt = Math.floor(Number(inp && inp.value));
        if (!amt || amt < 1) { if (inp) { inp.focus(); inp.style.borderColor = 'var(--error, #c55)'; } return; }
      }
      stateActHtml = actionBox().innerHTML;
      startDeposit(amt);
    });
    const cl = main.querySelector('[data-copylink]');
    if (cl) cl.onclick = function () { navigator.clipboard.writeText(location.href); this.textContent = 'Link copied'; setTimeout(() => this.textContent = 'Copy the link', 1500); };
  }
  // Kasla approval windows live in covenant-actions.js; the click must open the window.
  function openKaslaWindow(url) { return CA.openKaslaWindow(url); }

  function startDeposit(amountKas) {
    const box = actionBox();
    const ok = CA.wallet.canSend(connectedWallet);
    if (!ok) { box.innerHTML = fail(`Wallet "${connectedWallet || 'none'}" can't send from this page. Connect Kasware, Kastle, Kaspire or Kasla.`, 'Deposit unavailable'); return bindDepositRetry(box, amountKas); }
    if (connectedWallet !== 'kasla') return sendDeposit(box, amountKas);
    // Kasla: this is the launcher. The click opens Kasla's own approval window;
    // nothing is sent until the user approves it there.
    box.innerHTML = `
      <div class="cv-flow">
        <div class="cv-receipt">
          <div class="big">${amountKas} <small>KAS from your Kasla account</small></div>
          <div class="row"><span class="k">To</span><span class="v"><code>${esc(data.contractAddress)}</code></span></div>
          <div class="row"><span class="k">Fee</span><span class="v">network fee on top</span></div>
          <div class="row"><span class="k">Approval</span><span class="v">in Kasla's own window</span></div>
        </div>
        <div class="cv-flow-actions">
          <button class="push quiet" data-cancel>Cancel</button>
          <button class="push" data-go>Continue to Kasla</button>
        </div>
      </div>`;
    box.querySelector('[data-cancel]').onclick = restoreAct;
    box.querySelector('[data-go]').onclick = () => sendDeposit(box, amountKas, openKaslaWindow(null));
  }
  function bindDepositRetry(box, amountKas) {
    const b = box.querySelector('[data-back]'); if (b) b.onclick = restoreAct;
    const r = box.querySelector('[data-retry]'); if (r) r.onclick = () => startDeposit(amountKas);
  }
  async function sendDeposit(box, amountKas, kaslaPopup) {
    box.innerHTML = '<div class="deploy-hint">Waiting for your wallet…</div>';
    try {
      if (connectedWallet === 'kasla') {
        box.innerHTML = `
          <div class="cv-flow">
            <div class="deploy-hint" data-status>Opening Kasla…</div>
            <div class="cv-flow-actions"><button class="push quiet" data-focus>Show Kasla window</button></div>
          </div>`;
        box.querySelector('[data-focus]').onclick = () => { if (kaslaPopup && !kaslaPopup.closed) { try { kaslaPopup.focus(); } catch (_) {} } };
      }
      const { txId, recorded } = await CA.deposit({
        contractId: data.contractId, contractAddress: data.contractAddress, contractName: data.contractName, amountKas,
        popup: kaslaPopup,
        onStatus: (m) => { const el = box.querySelector('[data-status]'); if (el) el.textContent = m; else box.innerHTML = '<div class="deploy-hint">' + esc(m) + '</div>'; }
      });
      box.innerHTML = `
        <div class="cv-flow">
          <div class="cv-receipt">
            <div class="big"><span class="ok"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg></span>${amountKas} <small>KAS deposited</small></div>
            <div class="row"><span class="k">Transaction</span><span class="v"><a class="deploy-explorer-link" href="https://explorer.kaspa.org/transactions/${esc(txId)}" target="_blank" rel="noopener">${esc(String(txId).slice(0, 24))}… ↗</a></span></div>
            ${recorded ? '' : '<div class="deploy-hint">The node has not shown it at this address yet. Refresh in a few seconds; the money is on chain.</div>'}
          </div>
          <div class="cv-flow-actions"><button class="push" data-reload>Refresh this page</button></div>
        </div>`;
      const prev = data.balanceSompi;
      box.querySelector('[data-reload]').onclick = function () { this.disabled = true; this.textContent = 'Checking the chain…'; reloadAfterSpend(prev); };
      reloadAfterSpend(prev);
    } catch (err) {
      if (kaslaPopup && !kaslaPopup.closed) { try { kaslaPopup.close(); } catch (_) {} }
      const msg = typeof err === 'string' ? err : (err && err.message) || JSON.stringify(err);
      box.innerHTML = fail(msg, err && err.code === 4001 ? 'Deposit cancelled' : 'Deposit did not go through');
      bindDepositRetry(box, amountKas);
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────
  loadSession();
  if (typeof window.KasperoConnect !== 'undefined') KasperoConnect.onConnect = onWalletConnected;   // redirect logins
  watchAccountSwitch();
  setTimeout(watchAccountSwitch, 1500);   // extensions inject late sometimes
  renderAuth();
  if (authToken) { pingSession('restore'); joinThenReload(); } else load();
})();

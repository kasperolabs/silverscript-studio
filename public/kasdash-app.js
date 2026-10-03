// kasdash-app.js: a food order settled by the DoorDashEscrow covenant. Marker: kasdash-app-e-2026-10-03
//
// Two modes, one page:
//   simulated (default)  nothing touches a wallet or the chain; the split arithmetic and the code
//                        check (sha256 in the browser) are the real ones.
//   live ("Run it for real")  the customer's wallet deploys a DoorDashEscrow covenant through
//                        /api/deploy (funder role "user") and pays into it through covenant-actions.js;
//                        the code is made on this device and only its sha256 goes into the covenant.
//                        Release: POST /api/kasdash/:token/release { pin } (routes/kasdash.js) builds
//                        and submits the four-output spend; no wallet needed, the code is the key.
//                        Refund: the Studio's own build-spend / signAndBroadcast on `reclaim`.
//   dasher view (?dash=TOKEN#code=...)  what the QR opens on the dasher's phone: one button.
// Drive, map and Dana are always simulated; the money is not, in live mode.
(function () {
  'use strict';
  const CFG = Object.assign({ api: '', merchant: 'kpm_v90br29k', wallets: ['kasware', 'kastle', 'kaspire', 'kasla'],
    rateUsdPerKas: 0.03, salesTax: 0.089, dasherPay: 0.025, irsSetAside: 0.10, refundDays: 30 }, window.KasDash || {});
  const SOMPI = 1e8;
  const $ = (id) => document.getElementById(id);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
  const rnd = (n, abc) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => abc[b % abc.length]).join('');
  const short = (a) => a && a.length > 22 ? a.slice(0, 14) + '…' + a.slice(-6) : (a || '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
  const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const LS_KEY = 'kasdash:order';
  const CA = window.CovenantActions || null;
  if (CA) CA.configure({ api: CFG.api });

  const MENU = [
    { id: 'burger', e: '🍔', bg: '#ffe4d2', n: 'Smash burger', d: 'Double patty, pickles, house sauce', c: 1350 },
    { id: 'shawarma', e: '🌯', bg: '#fff0c7', n: 'Chicken shawarma wrap', d: 'Garlic toum, pickled turnip, fries inside', c: 1200 },
    { id: 'falafel', e: '🧆', bg: '#efe6d2', n: 'Falafel pita', d: 'Tahini, chopped salad, amba', c: 1050 },
    { id: 'fattoush', e: '🥗', bg: '#e0f2d8', n: 'Fattoush bowl', d: 'Crisp pita, sumac, pomegranate', c: 1100 },
    { id: 'fries', e: '🍟', bg: '#fff5c9', n: "Za'atar fries", d: 'With garlic dip', c: 550 },
    { id: 'lemonade', e: '🍋', bg: '#f3f8d0', n: 'Mint lemonade', d: 'Frozen, 16 oz', c: 400 },
    { id: 'cake', e: '🍰', bg: '#fbe2ea', n: 'Cheesecake slice', d: 'Burnt Basque style', c: 650 }
  ];
  const TIPS = [200, 400, 600];
  const PARTIES = [
    { k: 'restaurant', name: "Lou's Kitchen", ic: '🍽️', col: 'var(--rest)', bg: '#fde4df' },
    { k: 'driver', name: 'Dana, your dasher', ic: '🛵', col: 'var(--dash)', bg: '#d7efe9' },
    { k: 'irs', name: 'IRS', ic: '🏢', col: 'var(--irs)', bg: '#e1e5f5' },
    { k: 'stateTax', name: 'Georgia Dept. of Revenue', ic: '🏛️', col: 'var(--state)', bg: '#efe1f2' }
  ];
  const SCALES = [{ v: 1, t: 'Full price' }, { v: 0.1, t: 'Test size: 1/10' }, { v: 0.01, t: 'Test size: 1/100' }];
  const REFUNDS = [{ v: 600, t: '10 minutes (testing)' }, { v: 86400, t: '1 day' }, { v: 2592000, t: '30 days' }];

  const S = {
    screen: 'menu', phase: 'cart',   // phase: cart | held | released | refunded
    cart: {}, tip: 400, customTip: false,
    live: false, scale: 0.1, refundSecs: 600, payTo: { restaurant: '', driver: '', irs: '', stateTax: '' },
    book: [], bookFor: null, other: {},   // the Studio's wallet book (/api/wallets) for the connected wallet
    order: null,                     // live order record (saved in localStorage until finished)
    code: '', pinHash: '', covenant: '', txid: '', explorerUrl: '', stage: 0, run: 0, skip: false
  };

  // ── money: cents for people, sompi for the covenant ──
  const usd = (c) => '$' + (c / 100).toFixed(2);
  const kas = (s) => (s / SOMPI).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Release fee: one P2SH input (~400-byte script, no signature) and four outputs. The node prices the
  // larger of compute mass (~4,000 g here) and KIP-9 storage mass (1e12 / each output), at 100 sompi/g.
  // The covenant forbids change, so whatever is left above the four payouts IS the fee; pay 1.5x.
  const feeFor = (outs) => Math.max(1000000, Math.ceil(Math.max(4000, outs.reduce((a, v) => a + (v > 0 ? 1e12 / v : 0), 0)) * 100 * 1.5));
  function money() {
    const scale = S.live ? S.scale : 1;
    const toSompi = (c) => Math.round(c / 100 / CFG.rateUsdPerKas * scale * SOMPI);
    const sub = MENU.reduce((a, m) => a + m.c * (S.cart[m.id] || 0), 0);
    const tax = Math.round(sub * CFG.salesTax), pay = Math.round(sub * CFG.dasherPay), tip = sub ? S.tip : 0;
    // Everyone gets their full line; both taxes come on top of the order, paid by the customer
    const irs = Math.round((sub + pay + tip) * CFG.irsSetAside);
    const cents = [sub, pay + tip, irs, tax];
    const sompi = cents.map(toSompi);
    const lock = sompi.reduce((a, b) => a + b, 0);
    const fee = feeFor(sompi);
    return { sub, tax, irs, pay, tip, cents, sompi, total: sub + pay + tip + tax + irs, lock, fee, deposit: lock + fee, scale,
      items: MENU.reduce((a, m) => a + (S.cart[m.id] || 0), 0) };
  }
  const cur = () => (S.order && S.order.m) || money();
  const wait = (ms, run) => new Promise((r) => setTimeout(r, reduce || S.skip ? 0 : ms)).then(() => { if (run !== undefined && run !== S.run) throw 'stale'; });

  // ── session (shared with the Studio: kc_* keys) ──
  const me = () => (CA && CA.session.load()) || null;
  function connect(after) {
    if (typeof window.KasperoConnect === 'undefined') return alert('Wallet widget not loaded');
    KasperoConnect.connect({
      merchant: CFG.merchant, wallets: CFG.wallets, theme: 'light', modalTitle: 'Connect to pay for your order',
      onConnect: (d) => { if (CA && d && d.token) CA.session.store(d); if (after) after(); else render(); },
      onCancel: () => {}, onError: (e) => alert('Connection error: ' + e)
    });
  }
  const api = (path, opts) => CA ? CA.api(path, opts) : Promise.resolve({ success: false, error: 'covenant-actions.js did not load' });
  const saveOrder = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(S.order)); } catch (_) {} };
  const forgetOrder = () => { try { localStorage.removeItem(LS_KEY); } catch (_) {} };

  // ── screens ──
  function render() {
    const a = $('app');
    // Top line: only in live mode (real money moving deserves a warning); the simulation says nothing
    const dl = $('demoLine');
    if (dl) {
      dl.hidden = !(S.live || S.order);
      dl.className = 'kd-demo live';
      dl.textContent = 'Live on Kaspa mainnet. Real KAS moves from your wallet into a covenant and out to the four addresses you set. The delivery itself is simulated.';
    }
    if (S.screen === 'menu') a.innerHTML = menuView();
    else if (S.screen === 'cart') a.innerHTML = cartView();
    else if (S.screen === 'dash') a.innerHTML = dasherShell();
    else a.innerHTML = trackView();
    if (S.screen === 'track') paintMap();
    renderPanel();
    if (S.live && S.screen === 'cart') loadBook();
  }

  function top(back) {
    const brand = `<span class="kd-brand">Kas<i>Dash</i>${S.live || S.order ? '<span class="lv">LIVE</span>' : ''}</span>`;
    return `<div class="kd-top">${back ? `<button class="kd-back" data-go="${back}" aria-label="Back">←</button>` : brand}
      <span class="kd-addr">Deliver to<b>Home</b></span></div>`;
  }
  function stepper(id, q) {
    return q ? `<span class="kd-step"><button data-dec="${id}" aria-label="Remove one">−</button><span class="num">${q}</span><button data-inc="${id}" aria-label="Add one">+</button></span>`
             : `<button class="kd-add" data-inc="${id}" aria-label="Add">+</button>`;
  }
  function menuView() {
    const m = money();
    return top() + `
      <div class="kd-hero"><h1>Lou's Kitchen</h1><p>Mediterranean street food</p>
        <div class="kd-pills"><span>4.8 ★</span><span>20 to 30 min</span><span>Pays out on Kaspa</span></div><span class="big" aria-hidden="true">🥙</span></div>
      <h2 class="kd-h2">Popular</h2>
      <ul class="kd-menu">${MENU.map((x) => `<li class="kd-item"><span class="pic" style="background:${x.bg}">${x.e}</span>
        <div><div class="nm">${x.n}</div><div class="ds">${x.d}</div><div class="pr num">${usd(x.c)}</div></div>${stepper(x.id, S.cart[x.id] || 0)}</li>`).join('')}</ul>
      <button class="kd-bar" data-go="cart" ${m.items ? '' : 'disabled'}><span><span class="cnt num">${m.items}</span>View cart</span><span class="num">${usd(m.sub)}</span></button>`;
  }

  function liveProblem(m) {
    if (!CA) return 'The Studio actions (covenant-actions.js) did not load, so live mode cannot run here.';
    const low = m.sompi.findIndex((v) => v < SOMPI);
    if (low >= 0) return `${PARTIES[low].name} would get ${kas(m.sompi[low])} KAS. Each payout needs at least 1 KAS for the network to carry it cheaply; pick a bigger test size or add items.`;
    for (const p of PARTIES) {
      const a = (S.payTo[p.k] || '').trim();
      if (a && !/^kaspa:q[02-9ac-hj-np-z]{55,70}$/.test(a)) return `The address for ${p.name} is not a kaspa:q… address.`;
    }
    return '';
  }
  function liveBlock(m) {
    const s = me();
    const prob = S.live ? liveProblem(m) : '';
    return `<label class="kd-switch"><span><b>Run it for real</b><span>Deploy the covenant on Kaspa mainnet and pay with your wallet</span></span>
        <input type="checkbox" id="liveSw" ${S.live ? 'checked' : ''} aria-label="Run it for real"></label>
      ${S.live ? `<div class="kd-live">
        <div class="who"><span>${s ? `Paying from <span class="mono">${esc(short(s.address))}</span>` : 'No wallet connected'}</span>
          <button class="kd-btn" data-act="${s ? 'disconnect' : 'connect'}">${s ? 'Switch' : 'Connect wallet'}</button></div>
        <div class="row">
          <label>Size<select id="scaleSel">${SCALES.map((x) => `<option value="${x.v}" ${x.v === S.scale ? 'selected' : ''}>${x.t}</option>`).join('')}</select></label>
          <label>Refund if never scanned<select id="refundSel">${REFUNDS.map((x) => `<option value="${x.v}" ${x.v === S.refundSecs ? 'selected' : ''}>${x.t}</option>`).join('')}</select></label>
        </div>
        ${PARTIES.map((p) => payField(p, s)).join('')}
        <p class="kd-note">At ${CFG.rateUsdPerKas} $/KAS${m.scale !== 1 ? `, scaled to ${m.scale === 0.1 ? '1/10' : '1/100'}` : ''}. Wallets come from your Studio wallet book. Leave all four on your connected wallet and every payout comes back to you, minus the network fee.</p>
        ${prob ? `<p class="kd-warn">${esc(prob)}</p>` : ''}
      </div>` : ''}`;
  }
  // One payout destination: a wallet from the book, the connected wallet, or a pasted address
  function payField(p, s) {
    const cur = S.payTo[p.k] || '';
    const book = S.book.filter((w) => /^kaspa:q/.test(w.address || '') && (!s || w.address !== s.address));
    const inBook = book.some((w) => w.address === cur);
    const other = S.other[p.k] || (cur && !inBook && (!s || cur !== s.address));
    const opt = (v, t, sel) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(t)}</option>`;
    return `<label>${p.name} gets paid at<select data-paysel="${p.k}">
        ${opt('', s ? `My connected wallet · ${short(s.address)}` : 'My connected wallet', !cur && !other)}
        ${book.map((w) => opt(w.address, `${w.label || 'Wallet'} · ${short(w.address)}`, cur === w.address && !S.other[p.k])).join('')}
        ${opt('__other', 'Another address…', other)}
      </select>${other ? `<input class="mono" data-payto="${p.k}" value="${esc(cur)}" placeholder="kaspa:q…" autocomplete="off" spellcheck="false" aria-label="${p.name} address">` : ''}</label>`;
  }
  async function loadBook() {
    const s = me(); if (!s || !CA || S.bookFor === s.address) return;
    S.bookFor = s.address;
    try { const r = await api('/api/wallets'); S.book = (r && r.wallets) || []; } catch (_) { S.book = []; }
    if (S.screen === 'cart' && S.live) render();
  }
  function cartView() {
    const m = money();
    const lines = MENU.filter((x) => S.cart[x.id]).map((x) => `<div class="kd-cartline"><span class="e">${x.e}</span><span>${x.n}</span>${stepper(x.id, S.cart[x.id])}<span class="pr num">${usd(x.c * S.cart[x.id])}</span></div>`).join('');
    const pct = (c) => m.sub ? Math.round(c / m.sub * 100) + '%' : '';
    const blocked = !m.items || (S.live && !!liveProblem(m));
    return top('menu') + `<div class="kd-sec">
      <h2 class="kd-h2" style="margin-left:0">Your order</h2>${lines || '<p class="kd-stat">Your cart is empty.</p>'}
      <h2 class="kd-h2" style="margin-left:0">Tip Dana</h2>
      <div class="kd-tips">${TIPS.map((t) => `<button data-tip="${t}" class="${!S.customTip && S.tip === t ? 'on' : ''}">${usd(t).replace('.00', '')}<small>${pct(t)}</small></button>`).join('')}
        <button data-tip="other" class="${S.customTip ? 'on' : ''}">Other<small>${S.customTip ? usd(S.tip) : 'any'}</small></button></div>
      ${S.customTip ? `<label class="kd-custom">$ <input id="customTip" inputmode="decimal" value="${(S.tip / 100).toFixed(2)}" aria-label="Custom tip in dollars"></label>` : ''}
      <p class="kd-tipnote">Dana's pay is ${CFG.dasherPay * 100}% of the food plus your tip, locked with your payment and released to Dana in the same transaction as everyone else.</p>
      ${liveBlock(m)}
      <ul class="kd-sum">
        <li><span>Subtotal</span><b class="num">${usd(m.sub)}</b></li>
        <li><span>Dasher pay ${CFG.dasherPay * 100}%</span><b class="num">${usd(m.pay)}</b></li>
        <li><span>Tip</span><b class="num" data-sum="tip">${usd(m.tip)}</b></li>
        <li><span>Sales tax ${(CFG.salesTax * 100).toFixed(1)}% <span class="why">on the food</span></span><b class="num">${usd(m.tax)}</b></li>
        <li><span>Federal tax ${CFG.irsSetAside * 100}% <span class="why">on food, delivery and tip</span></span><b class="num" data-sum="irs">${usd(m.irs)}</b></li>
        <li><span>Kaspa network fee</span><b class="num" data-sum="fee">${kas(m.fee)} KAS</b></li>
        <li class="tot"><span>Total</span><span class="num">${usd(m.total)}<small>${kas(m.deposit)} KAS</small></span></li>
      </ul>
      <button class="kd-pay ${S.live ? 'live' : ''}" data-act="checkout" ${blocked ? 'disabled' : ''}><span>${S.live ? 'Place order for real' : 'Place order'}</span><span class="num">${S.live ? kas(m.deposit) + ' KAS' : usd(m.total)}</span></button>
      <p class="kd-fine">No service fee. Nobody holds your money in between.</p></div>`;
  }

  // ── the sheet: simulated wallet ──
  function openSheet(html) {
    $('sheet').innerHTML = html; $('sheet').hidden = false; $('sheetBg').hidden = false;
  }
  function closeSheet() { $('sheet').hidden = true; $('sheetBg').hidden = true; }
  function openSimSheet() {
    const m = money();
    S.covenant = 'kaspa:pq' + rnd(61, B32);
    openSheet(`<div class="kd-grab"></div>
      <div class="kd-wal"><span class="lg">K</span>Kasla wants your approval</div>
      <h3 class="num">${kas(m.deposit)} KAS</h3><p class="sub num">${usd(m.total)} for your order at Lou's Kitchen</p>
      <div class="kd-kv">
        <div><span>Locked in</span><span class="mono">${S.covenant}</span></div>
        <div><span>Pays out</span><span>4 parties, when Dana scans your code</span></div>
        <div><span>If nobody scans it</span><span>Back to you after ${CFG.refundDays} days</span></div>
      </div>
      <button class="kd-pay" id="approve" style="margin-top:16px"><span>Approve</span><span>🔒</span></button>
      <button class="kd-cancel" data-act="closeSheet">Cancel</button>`);
    $('approve').focus();
    $('approve').onclick = approveSim;
  }

  const normCode = (s) => String(s).toUpperCase().replace(/[^0-9A-Z]/g, '');
  async function sha256hex(str) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
  }
  const newCode = () => rnd(16, CROCK).match(/.{4}/g).join('-');

  async function approveSim() {
    $('approve').innerHTML = '<span>Signing</span><span class="kd-spin"></span>'; $('approve').disabled = true;
    S.code = newCode();
    S.pinHash = await sha256hex(normCode(S.code));
    await sleep(900);
    closeSheet();
    startTracking();
  }
  function startTracking(atDoor) {
    S.screen = 'track'; S.phase = 'held'; S.stage = atDoor ? 3 : 0; S.skip = false;
    render();
    if (atDoor) { placeDasherAtDoor(); showCode(); return; }
    deliver(++S.run).catch((e) => { if (e !== 'stale') throw e; });
  }

  // ── the sheet: live payment ──
  const STEPS = ['Make your code on this device', 'Sign: write the covenant', 'Pay into the covenant'];
  function liveSheetHtml(m, step, say, err) {
    const s = me();
    return `<div class="kd-grab"></div>
      <div class="kd-wal"><span class="lg live">K</span>Live order on Kaspa mainnet</div>
      <h3 class="num">${kas(m.deposit)} KAS</h3><p class="sub num">${usd(m.total)} at ${m.scale === 1 ? 'full price' : (m.scale === 0.1 ? '1/10' : '1/100') + ' test size'}</p>
      <div class="kd-kv">
        <div><span>From</span><span class="mono">${s ? esc(s.address) : 'connect a wallet'}</span></div>
        ${PARTIES.map((p, i) => `<div><span>${p.name}</span><span class="num">${kas(m.sompi[i])} KAS</span></div>`).join('')}
        <div><span>Network fee</span><span class="num">${kas(m.fee)} KAS</span></div>
        <div><span>If nobody scans the code</span><span>Back to you after ${REFUNDS.find((r) => r.v === S.refundSecs).t.replace(' (testing)', '')}</span></div>
      </div>
      <ol class="kd-steps">${STEPS.map((t, i) => `<li class="${i < step ? 'done' : i === step ? 'now' : ''}"><i>${i < step ? '✓' : i + 1}</i>${t}</li>`).join('')}</ol>
      <p class="kd-say ${err ? 'err' : ''}" id="liveSay">${esc(say || '')}</p>
      ${s ? `<button class="kd-pay live" id="livePay" ${step >= 0 && step < 3 && !err && say ? 'disabled' : ''}><span>${err && S.order ? 'Try paying again' : 'Pay from my wallet'}</span><span class="num">${kas(m.deposit)} KAS</span></button>`
          : `<button class="kd-pay live" data-act="connectSheet"><span>Connect a wallet</span><span>→</span></button>`}
      <button class="kd-cancel" data-act="closeSheet">Cancel</button>
      ${S.order && !S.order.fundTx ? '<button class="kd-cancel" data-act="forget">Forget this unpaid order</button>' : ''}`;
  }
  function openLiveSheet() {
    openSheet(liveSheetHtml(money(), -1, 'Your wallet will ask twice: once to authorize the covenant, once to pay into it.'));
    const b = $('livePay'); if (b) b.onclick = payLive;
  }
  function liveSay(step, say, err) {
    const m = (S.order && S.order.m) || money();
    $('sheet').innerHTML = liveSheetHtml(m, step, say, err);
    const b = $('livePay'); if (b) { b.onclick = S.order && !S.order.fundTx ? retryFund : payLive; if (!err && say && step < 3) b.disabled = true; }
  }
  function retryFund() { const s = me(); if (!s) return connect(() => liveSay(2, 'Connected. Pay into the order.', true)); fundLive(s.walletType === 'kasla' ? CA.openKaslaWindow(null) : null); }

  const SIL = `pragma silverscript ^0.1.0;

// DoorDashEscrow: one deposit, four payouts, released by the customer's code.
contract DoorDashEscrow(
    pubkey restaurant,
    pubkey driver,
    pubkey irs,
    pubkey stateTax,
    pubkey user,
    byte[32] pinHash,
    int restaurantAmount,
    int driverAmount,
    int irsAmount,
    int stateTaxAmount,
    int refundDelayBlocks
) {
    entry release(byte[] pin) {
        require(sha256(pin) == pinHash);
        require(tx.inputs.length == 1);
        require(tx.outputs.length == 4);

        require(tx.outputs[0].scriptPubKey == byte[](new ScriptPubKeyP2PK(restaurant)));
        require(tx.outputs[0].value == restaurantAmount);
        require(tx.outputs[1].scriptPubKey == byte[](new ScriptPubKeyP2PK(driver)));
        require(tx.outputs[1].value == driverAmount);
        require(tx.outputs[2].scriptPubKey == byte[](new ScriptPubKeyP2PK(irs)));
        require(tx.outputs[2].value == irsAmount);
        require(tx.outputs[3].scriptPubKey == byte[](new ScriptPubKeyP2PK(stateTax)));
        require(tx.outputs[3].value == stateTaxAmount);
    }

    entry reclaim(sig userSig) {
        require(checkSig(userSig, user));
        require(this.ageDaa >= refundDelayBlocks);
        require(tx.outputs[0].scriptPubKey == byte[](new ScriptPubKeyP2PK(user)));
    }
}
`;

  async function payLive() {
    const s = me(); if (!s) return connect(openLiveSheet);
    const m = money();
    const prob = liveProblem(m); if (prob) return liveSay(-1, prob, true);
    // Kasla approvals open a window; browsers only allow that inside the click
    const popup = s.walletType === 'kasla' ? CA.openKaslaWindow(null) : null;
    try {
      liveSay(0, 'Making your code…');
      const code = newCode(), pinHash = await sha256hex(normCode(code));
      const active = await CA.wallet.activeExtensionAddress(s.walletType);
      if (active && active !== s.address) throw new Error(`Your wallet is on ${short(active)} but this page is signed in as ${short(s.address)}. Switch back, or reconnect.`);

      liveSay(1, s.walletType === 'kasla' ? 'Writing the covenant…' : 'Sign the authorization in your wallet…');
      const challenge = `SilverScript Studio\nAction: deploy\nContract: DoorDashEscrow\nWallet: ${s.address}\nNonce: ${Date.now()}`;
      let signature = null;
      if (s.walletType === 'kaspire') {
        const r = await window.kaspire.request({ method: 'signMessage', params: { address: s.address, message: challenge } });
        signature = (r && r.signature) ? r.signature : r;
      } else if (s.walletType !== 'kasla') {
        const w = window[s.walletType];
        if (!w || typeof w.signMessage !== 'function') throw new Error(`Wallet "${s.walletType}" is not available for signing. Is the extension installed?`);
        signature = await w.signMessage(challenge);
      }
      liveSay(1, 'Writing the covenant…');
      const to = (k) => (S.payTo[k] || '').trim() || s.address;
      const args = [
        { name: 'restaurant', value: to('restaurant') }, { name: 'driver', value: to('driver') },
        { name: 'irs', value: to('irs') }, { name: 'stateTax', value: to('stateTax') },
        { name: 'user', value: s.address }, { name: 'pinHash', value: pinHash },
        ...['restaurantAmount', 'driverAmount', 'irsAmount', 'stateTaxAmount'].map((n, i) => ({ name: n, value: String(m.sompi[i]) })),
        { name: 'refundDelayBlocks', value: String(S.refundSecs * 10) }
      ];
      const d = await api('/api/deploy', { method: 'POST', body: JSON.stringify({
        source: SIL, constructorArgs: args, amountTkas: 0, funder: { role: 'user', expectedKas: null },
        network: 'mainnet', signature, challenge, walletType: s.walletType }) });
      if (!d || !d.success) throw new Error((d && d.error) || 'Deploy failed');
      if (!d.shareToken || !d.contractId) throw new Error('The covenant was compiled but the Studio did not save it (is the database up?). Nothing was paid.');
      // Saved BEFORE paying: the code exists only here, and without it the money can only be refunded
      S.order = { token: d.shareToken, contractId: d.contractId, address: d.contractAddress, code, pinHash, m,
        payTo: Object.fromEntries(PARTIES.map((p) => [p.k, to(p.k)])), user: s.address, refundSecs: S.refundSecs,
        createdAt: Date.now(), fundTx: null, releaseTx: null, refundTx: null };
      saveOrder();
      await fundLive(popup);
    } catch (e) {
      if (popup && !popup.closed) { try { popup.close(); } catch (_) {} }
      liveSay(S.order ? 2 : -1, e && e.code === 4001 ? 'Cancelled in the wallet. Nothing was paid.' : (e.message || String(e)), true);
    }
  }
  async function fundLive(popup) {
    const s = me(), o = S.order; if (!s || !o) return;
    try {
      liveSay(2, s.walletType === 'kasla' ? 'Approve the payment in the Kasla window…' : 'Approve the payment in your wallet…');
      const r = await CA.deposit({ contractId: o.contractId, contractAddress: o.address, contractName: 'DoorDashEscrow', amountKas: o.m.deposit / SOMPI,
        popup, onStatus: (t) => { const el = $('liveSay'); if (el) el.textContent = t; } });
      o.fundTx = r.txId; o.fundedAt = Date.now(); saveOrder();
      liveSay(3, 'Paid. The covenant holds your order.');
      await sleep(700);
      closeSheet();
      S.code = o.code; S.pinHash = o.pinHash; S.covenant = o.address;
      startTracking();
    } catch (e) {
      liveSay(2, e && e.code === 4001 ? 'Cancelled in the wallet. The covenant exists but holds nothing; you can pay into it again.' : (e.message || String(e)), true);
    }
  }

  // ── the map ──
  const P = { rest: [78, 165], home: [340, 196], irs: [40, 64], state: [228, 230], start: [265, 230], lock: [228, 128] };
  const ROUTE1 = [[265, 230], [115, 230], [115, 165], [78, 165]];
  const ROUTE2 = [[78, 165], [340, 165]];
  function pin(id, [x, y], ic, col, label) {
    return `<g id="${id}" transform="translate(${x},${y})">
      <ellipse cx="0" cy="14" rx="9" ry="3" fill="rgba(0,0,0,.15)"/>
      <circle r="13" fill="${col}" stroke="#fff" stroke-width="2.5"/>
      <text text-anchor="middle" dominant-baseline="central" font-size="13">${ic}</text>
      <text class="lbl" text-anchor="middle" y="28">${label}</text></g>`;
  }
  function paintMap() {
    const xs = [-20, 40, 115, 190, 265, 340, 420], ys = [-20, 35, 100, 165, 230, 310];
    let blocks = '';
    for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++)
      blocks += `<rect class="blk" x="${xs[i] + 6}" y="${ys[j] + 6}" width="${xs[i + 1] - xs[i] - 12}" height="${ys[j + 1] - ys[j] - 12}" rx="5"/>`;
    const streets = xs.slice(1, -1).map((x) => `<line class="st" x1="${x}" y1="-10" x2="${x}" y2="310"/>`).join('') +
      ys.slice(1, -1).map((y) => `<line class="st" x1="-10" y1="${y}" x2="420" y2="${y}"/>`).join('');
    const poly = (pts) => pts.map((p) => p.join(',')).join(' ');
    const m = cur();
    $('mapbox').innerHTML = `<svg class="kd-map" id="map" viewBox="0 0 400 290" role="img" aria-label="Map: Lou's Kitchen, your home, Dana's route">
      ${blocks}<rect class="park" x="196" y="41" width="138" height="53" rx="8"/><ellipse class="water" cx="300" cy="66" rx="22" ry="11"/>${streets}
      <polyline id="r1" class="route" points="${poly(ROUTE1)}"/><polyline id="r2" class="route" points="${poly(ROUTE2)}"/>
      ${pin('pIrs', P.irs, '🏢', 'var(--irs)', 'IRS')}
      ${pin('pState', P.state, '🏛️', 'var(--state)', 'GA Revenue')}
      ${pin('pRest', P.rest, '🍽️', 'var(--rest)', "Lou's Kitchen")}
      ${pin('pHome', P.home, '🏠', 'var(--ink)', 'You')}
      <g id="lock" transform="translate(${P.lock[0]},${P.lock[1]})">
        <rect x="-52" y="-12" width="104" height="24" rx="12" fill="var(--ink)"/>
        <text id="lockTxt" x="0" y="1" text-anchor="middle" dominant-baseline="central" fill="#fff" font-size="10.5" font-weight="600" font-family="Instrument Sans, system-ui, sans-serif">🔒 ${kas(m.deposit)} KAS</text></g>
      <g id="dasher" transform="translate(${P.start[0]},${P.start[1]})"><circle r="12" fill="var(--accent)" stroke="#fff" stroke-width="2.5"/>
        <text text-anchor="middle" dominant-baseline="central" font-size="12">🛵</text></g>
      <g id="fx"></g></svg>`;
  }
  function placeDasherAtDoor() {
    const g = $('dasher'); if (g) g.setAttribute('transform', `translate(${ROUTE2[1][0]},${ROUTE2[1][1]})`);
    ['r1', 'r2'].forEach((id) => $(id) && $(id).classList.add('done'));
  }
  function polyLen(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; }
  function along(pts, t) {
    let d = t * polyLen(pts);
    for (let i = 1; i < pts.length; i++) {
      const s = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (d <= s) { const k = s ? d / s : 0; return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k]; }
      d -= s;
    }
    return pts[pts.length - 1];
  }
  function drive(pts, ms, run) {
    return new Promise((done, fail) => {
      const g = $('dasher'); if (!g) return fail('stale');
      const t0 = performance.now();
      (function step(t) {
        if (run !== S.run) return fail('stale');
        const p = reduce || S.skip ? 1 : Math.min(1, (t - t0) / ms), e = p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        const [x, y] = along(pts, e); g.setAttribute('transform', `translate(${x},${y})`);
        if (p < 1) requestAnimationFrame(step); else done();
      })(t0);
    });
  }
  // coins arc from the lock to a pin, then the amount pops above it
  function coins(from, to, label, color) {
    return new Promise((done) => {
      const fx = $('fx'), NS = 'http://www.w3.org/2000/svg';
      if (!fx) return done();
      const pop = () => {
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('class', 'pop'); t.setAttribute('text-anchor', 'middle'); t.setAttribute('fill', color);
        t.setAttribute('x', to[0]); t.setAttribute('y', to[1] - 20); t.setAttribute('stroke', '#fff'); t.setAttribute('stroke-width', '3'); t.setAttribute('paint-order', 'stroke');
        t.textContent = label; fx.appendChild(t);
        if (!reduce) t.animate([{ transform: 'translateY(8px)', opacity: 0 }, { transform: 'translateY(-6px)', opacity: 1 }], { duration: 380, fill: 'forwards', easing: 'ease-out' });
      };
      if (reduce) { pop(); return done(); }
      const cx = (from[0] + to[0]) / 2, cy = Math.min(from[1], to[1]) - 55, N = 5, ms = 850;
      const list = [];
      for (let k = 0; k < N; k++) {
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('r', 5); c.setAttribute('fill', 'var(--coin)'); c.setAttribute('stroke', '#b57d0e'); c.setAttribute('stroke-width', 1.2); c.style.opacity = 0;
        fx.appendChild(c); list.push(c);
      }
      const t0 = performance.now();
      (function step(t) {
        let alive = false;
        list.forEach((c, k) => {
          const p = Math.max(0, Math.min(1, (t - t0 - k * 90) / ms));
          if (p < 1) alive = true;
          const e = 1 - Math.pow(1 - p, 2), u = 1 - e;
          c.setAttribute('cx', u * u * from[0] + 2 * u * e * cx + e * e * to[0]);
          c.setAttribute('cy', u * u * from[1] + 2 * u * e * cy + e * e * to[1]);
          c.style.opacity = p <= 0 || p >= 1 ? 0 : 1;
        });
        if (alive) requestAnimationFrame(step); else { list.forEach((c) => c.remove()); pop(); done(); }
      })(t0);
    });
  }

  // ── tracking ──
  const STAGES = [
    ['Order confirmed', 'Your payment is locked in a covenant. Nobody can touch it yet, not even us.'],
    ['Preparing your food', "Lou's Kitchen has your order."],
    ['Dana picked it up', 'On the way to you.'],
    ['Dana is at your door', 'Show your code. The scan pays everyone at once.']
  ];
  function trackView() {
    return top() + `<div id="mapbox"></div>
      <div class="kd-card" id="card">${cardBody()}</div>
      <div id="codebox"></div>
      <div class="kd-links" id="links">${S.phase === 'held' ? linksHtml() : ''}</div>`;
  }
  function linksHtml() {
    const skip = S.stage < 3 ? '<button id="skipBtn">Skip to the door</button>' : '<span></span>';
    if (!S.order) return skip + '<button id="noShow">Simulate: Dana never shows</button>';
    const left = Math.max(0, (S.order.fundedAt || S.order.createdAt) + S.order.refundSecs * 1000 - Date.now());
    const txt = left > 0 ? `Refund opens in about ${fmtLeft(left)}` : 'Take my money back';
    return skip + `<button id="reclaim" ${left > 0 ? 'disabled' : ''}>${txt}</button>`;
  }
  const fmtLeft = (ms) => { const m = Math.ceil(ms / 60000); return m < 60 ? m + ' min' : m < 2880 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' days'; };
  function cardBody() {
    const [h, s] = STAGES[S.stage];
    const o = S.order;
    const lock = o
      ? `🔒 <span class="num">${kas(o.m.deposit)} KAS held at</span> <a href="https://explorer.kaspa.org/addresses/${encodeURIComponent(o.address)}" target="_blank" rel="noopener">${esc(short(o.address))}</a>`
      : `🔒 <span class="num">${kas(cur().deposit)} KAS locked until your code is scanned</span>`;
    return `<div class="kd-eta">${h}</div><div class="kd-stat">${s}</div>
      <div class="kd-prog">${[0, 1, 2, 3].map((i) => `<i class="${i < S.stage ? 'on' : i === S.stage ? 'on now' : ''}"></i>`).join('')}</div>
      <div class="kd-dasher"><span class="av">🛵</span><div><b>Dana</b><span>Your dasher${o ? ' (simulated; the money is real)' : ''}</span></div></div>
      <div class="kd-lockline">${lock}</div>`;
  }
  function setStage(n) {
    S.stage = n;
    const c = $('card'); if (c) c.innerHTML = cardBody();
    const l = $('links'); if (l && S.phase === 'held') l.innerHTML = linksHtml();
  }
  async function deliver(run) {
    await wait(1400, run); setStage(1);
    await drive(ROUTE1, 3200, run);
    $('r1') && $('r1').classList.add('done');
    await wait(700, run); setStage(2);
    await drive(ROUTE2, 3800, run);
    $('r2') && $('r2').classList.add('done');
    setStage(3); showCode();
  }
  const dasherUrl = () => `${location.origin}${location.pathname}?dash=${encodeURIComponent(S.order.token)}#code=${encodeURIComponent(S.code)}`;
  function qrSvg(text) {
    if (typeof window.qrcode === 'function') {
      try { const q = window.qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); } catch (_) {}
    }
    // fallback: looks like a QR, carries nothing (the code is printed underneath)
    const N = 25, bits = [];
    let h = S.pinHash || hex(32); while (bits.length < N * N) { for (const ch of h) { const v = parseInt(ch, 16); for (let b = 3; b >= 0; b--) bits.push((v >> b) & 1); } h = h.split('').reverse().join(''); }
    const finder = (x, y) => `<rect x="${x}" y="${y}" width="7" height="7" fill="#10211d"/><rect x="${x + 1}" y="${y + 1}" width="5" height="5" fill="#fff"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3" fill="#10211d"/>`;
    const inF = (x, y) => (x < 8 && y < 8) || (x > N - 9 && y < 8) || (x < 8 && y > N - 9);
    let r = '';
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!inF(x, y) && bits[y * N + x]) r += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    return `<svg viewBox="0 0 ${N} ${N}" shape-rendering="crispEdges"><g fill="#10211d">${r}</g>${finder(0, 0)}${finder(N - 7, 0)}${finder(0, N - 7)}</svg>`;
  }
  function showCode() {
    const live = !!S.order;
    $('codebox').innerHTML = `<div class="kd-code"><span class="qr" aria-label="${live ? 'QR: the dasher link with your code' : 'Code'}">${qrSvg(live ? dasherUrl() : S.code)}</span>
      <div><div class="t">${live ? 'Your code. A real phone can scan this.' : 'Your code, for Dana'}</div><div class="c">${S.code}</div>
      <button class="kd-scan" id="scan">${live ? 'Dana scans it (real)' : 'Dana scans it'}</button>
      ${live ? '<button class="kd-copy" id="copyLink">Copy the dasher link</button>' : ''}
      <div class="kd-check" id="check"></div></div></div>`;
    $('scan').onclick = release;
    if (live) $('copyLink').onclick = () => { navigator.clipboard && navigator.clipboard.writeText(dasherUrl()); $('copyLink').textContent = 'Copied. Anyone with this link can release the payment.'; };
    const l = $('links'); if (l) l.innerHTML = linksHtml();
  }

  async function release() {
    if (S.phase !== 'held') return;
    const run = S.run;
    $('scan').disabled = true; $('scan').textContent = S.order ? 'Sending to the network…' : 'Paying out…';
    const h = await sha256hex(normCode(S.code));
    const chk = $('check');
    if (h !== S.pinHash) { chk.className = 'kd-check err'; chk.textContent = 'code does not match'; return; }
    chk.textContent = `sha256(code) = ${h.slice(0, 20)}… matches the lock`;
    if (S.order) {
      const r = await fetch(`${CFG.api}/api/kasdash/${encodeURIComponent(S.order.token)}/release`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: S.code }) }).then((x) => x.json()).catch((e) => ({ success: false, error: e.message }));
      if (!r.success && !r.released) {
        chk.className = 'kd-check err'; chk.textContent = r.error || 'Release failed';
        $('scan').disabled = false; $('scan').textContent = 'Try again';
        return;
      }
      S.txid = r.txId; S.explorerUrl = r.explorerUrl || (r.txId ? `https://explorer.kaspa.org/transactions/${r.txId}` : '');
      S.order.releaseTx = r.txId; saveOrder();
    } else S.txid = hex(32);
    S.phase = 'released'; renderPanel();
    $('links').innerHTML = '';
    await payoutAnimation(run);
    showReceipt();
  }
  async function payoutAnimation(run) {
    $('lockTxt').textContent = '🔓 releasing';
    $('map').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    await sleep(500);
    const m = cur(), from = P.lock;
    const targets = [P.rest, ROUTE2[1], P.irs, P.state], cols = ['#c63a25', '#06473c', '#2b3a80', '#6f3380'];
    let left = m.deposit;
    for (let i = 0; i < 4; i++) {
      coins(from, targets[i], '+' + usd(m.cents[i]), cols[i]).then(() => markPaid(i));
      left -= m.sompi[i];
      $('lockTxt').textContent = i < 3 ? `🔓 ${kas(left)} KAS` : '🔓 0 KAS';
      await sleep(420);
    }
    await sleep(900);
    if (run !== S.run) return;
    $('lock').style.opacity = '.35';
  }
  function txLine() {
    if (!S.txid) return '';
    return S.order
      ? `<div class="kd-tx">tx <a href="${esc(S.explorerUrl)}" target="_blank" rel="noopener">${esc(S.txid)}</a></div>`
      : `<div class="kd-tx">tx ${S.txid} (simulated)</div>`;
  }
  function showReceipt() {
    const m = cur();
    $('codebox').innerHTML = '';
    $('card').innerHTML = `<div class="kd-eta">Delivered. Everyone's paid.</div><div class="kd-stat">One transaction, four payouts, nobody in the middle.</div>
      ${receipt(m)}${txLine()}<button class="kd-again" data-act="again">Order again</button>`;
    if (S.order) forgetOrder();
  }
  function receipt(m, refunded) {
    if (refunded) return `<ul class="kd-receipt"><li><span class="dot" style="background:var(--ink)"></span><span>Back to you</span><span class="a num">${usd(m.total)}<small>${kas(m.lock)} KAS</small></span></li></ul>`;
    const to = S.order ? S.order.payTo : null;
    return `<ul class="kd-receipt">${PARTIES.map((p, i) => `<li><span class="dot" style="background:${p.col}"></span><span>${p.name}${to ? `<span class="to">${esc(short(to[p.k]))}</span>` : ''}</span><span class="a num">${usd(m.cents[i])}<small>${kas(m.sompi[i])} KAS</small></span></li>`).join('')}</ul>`;
  }
  function markPaid(i) {
    const row = document.querySelector(`.kd-row[data-i="${i}"]`); if (!row) return;
    const t = row.querySelector('.tag'); t.className = 'tag paid'; t.textContent = 'paid';
    row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
  }

  async function noShow() {
    if (S.phase !== 'held') return;
    S.run++; S.phase = 'refunded';
    const m = cur();
    $('links').innerHTML = ''; $('codebox').innerHTML = '';
    const d = $('dasher'); if (d) d.style.opacity = '0';
    $('card').innerHTML = `<div class="kd-eta">${CFG.refundDays} days later…</div><div class="kd-stat">Nobody scanned your code. You sign, and only you can.</div>`;
    renderPanel();
    await sleep(900);
    await refundAnimation(m);
    S.txid = hex(32);
    refundCard(m);
  }
  async function refundAnimation(m) {
    $('lockTxt').textContent = '🔓 refunding';
    await coins(P.lock, P.home, '+' + usd(m.total), '#10211d');
    $('lockTxt').textContent = '🔓 0 KAS'; $('lock').style.opacity = '.35';
  }
  function refundCard(m) {
    $('card').innerHTML = `<div class="kd-eta">Refunded.</div><div class="kd-stat">The restaurant, Dana and the tax offices got nothing, because the code was never read.</div>
      ${receipt(m, true)}${txLine()}<button class="kd-again" data-act="again">Order again</button>`;
  }
  async function reclaimLive() {
    const s = me(), o = S.order; if (!o) return;
    if (!s) return connect(reclaimLive);
    if (s.address !== o.user) return alert(`Only the wallet that paid (${short(o.user)}) can take it back. Connect that one.`);
    const popup = s.walletType === 'kasla' ? CA.openKaslaWindow(null) : null;
    const btn = $('reclaim'); if (btn) { btn.disabled = true; btn.textContent = 'Building the refund…'; }
    try {
      const spend = await CA.buildSpend({ contractId: o.contractId, entry: 'reclaim', args: {} });
      if (btn) btn.textContent = 'Approve the refund in your wallet…';
      const r = await CA.signAndBroadcast({ contractId: o.contractId, contractName: 'DoorDashEscrow', spend, popup, onStatus: (t) => { if (btn) btn.textContent = t; } });
      S.run++; S.phase = 'refunded'; o.refundTx = r.txId; S.txid = r.txId; S.explorerUrl = `https://explorer.kaspa.org/transactions/${r.txId}`;
      $('links').innerHTML = ''; $('codebox').innerHTML = '';
      const d = $('dasher'); if (d) d.style.opacity = '0';
      renderPanel();
      await refundAnimation(o.m);
      refundCard(o.m);
      forgetOrder();
    } catch (e) {
      if (popup && !popup.closed) { try { popup.close(); } catch (_) {} }
      if (btn) { btn.disabled = false; btn.textContent = e && e.code === 4001 ? 'Cancelled. Take my money back' : (e.message || String(e)) + ' (tap to retry)'; }
    }
  }

  // ── the dasher's phone (?dash=TOKEN#code=...) ──
  function dasherShell() { return top() + '<div class="kd-card flat" id="card"><div class="kd-stat">Loading the order…</div></div>'; }
  async function dasherView(token) {
    S.screen = 'dash'; S.live = true; render();
    $('panel').hidden = true;
    const code = decodeURIComponent((location.hash.match(/code=([^&]+)/) || [])[1] || '');
    const r = await fetch(`${CFG.api}/api/kasdash/${encodeURIComponent(token)}`).then((x) => x.json()).catch((e) => ({ success: false, error: e.message }));
    const card = $('card');
    if (!r.success) { card.innerHTML = `<div class="kd-eta">Can't open this order</div><div class="kd-stat">${esc(r.error || 'Unknown error')}</div>`; return; }
    const sompi = PARTIES.map((p) => Number(r.amounts[p.k] || 0));
    const list = `<ul class="kd-receipt">${PARTIES.map((p, i) => `<li><span class="dot" style="background:${p.col}"></span><span>${p.name}<span class="to">${esc(short(r.parties[p.k]))}</span></span><span class="a num">${kas(sompi[i])} KAS</span></li>`).join('')}</ul>`;
    const link = (tx) => `<div class="kd-tx">tx <a href="${r.explorer}/transactions/${tx}" target="_blank" rel="noopener">${esc(tx)}</a></div>`;
    if (r.state === 'released') { card.innerHTML = `<div class="kd-eta">Already paid out</div><div class="kd-stat">This order released its payment.</div>${list}${r.releaseTxid ? link(r.releaseTxid) : ''}`; return; }
    if (r.state !== 'held') { card.innerHTML = `<div class="kd-eta">Nothing to release</div><div class="kd-stat">${r.state === 'unfunded' ? 'The customer has not paid into this order yet.' : 'The money has already left this order (refunded?).'}</div>${list}`; return; }
    card.innerHTML = `<div class="kd-eta">Delivery for this order</div>
      <div class="kd-stat">${kas(Number(r.heldSompi))} KAS is held by the covenant. The customer's code pays these four in one transaction.</div>${list}
      <input class="kd-codein" id="dashCode" value="${esc(code)}" placeholder="the customer's code" autocomplete="off" spellcheck="false" aria-label="Code">
      <button class="kd-pay live" id="dashGo"><span>Delivered: release the payment</span><span>→</span></button>
      <p class="kd-say" id="dashSay"></p>`;
    $('dashGo').onclick = async () => {
      const b = $('dashGo'), say = $('dashSay'); b.disabled = true; say.className = 'kd-say'; say.textContent = 'Sending to the network…';
      const x = await fetch(`${CFG.api}/api/kasdash/${encodeURIComponent(token)}/release`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: $('dashCode').value }) }).then((y) => y.json()).catch((e) => ({ success: false, error: e.message }));
      if (!x.success) { say.className = 'kd-say err'; say.textContent = x.error || 'Release failed'; b.disabled = false; return; }
      card.innerHTML = `<div class="kd-eta">Paid. Thanks, Dana.</div><div class="kd-stat">Four payouts in one transaction.</div>${list}${x.txId ? link(x.txId) : ''}`;
    };
  }

  // ── restore a live order after a reload ──
  async function restore(o) {
    S.order = o; S.live = true; S.code = o.code; S.pinHash = o.pinHash; S.covenant = o.address;
    const r = await fetch(`${CFG.api}/api/kasdash/${encodeURIComponent(o.token)}`).then((x) => x.json()).catch(() => null);
    if (r && r.success && r.state === 'released') {
      S.screen = 'track'; S.phase = 'released'; S.txid = r.releaseTxid || o.releaseTx; S.explorerUrl = S.txid ? `${r.explorer}/transactions/${S.txid}` : '';
      render(); placeDasherAtDoor(); $('lock').style.opacity = '.35'; showReceipt(); return;
    }
    if (r && r.success && r.state === 'held') { startTracking(true); return; }
    if (r && r.success && r.state === 'unfunded') {
      S.screen = 'cart'; render();
      openSheet(''); liveSay(2, 'This order\'s covenant exists but nothing was paid into it yet.', true);
      return;
    }
    if (r && r.success && r.state === 'spent') { forgetOrder(); S.order = null; render(); return; }
    // chain unreadable: show the order at the door; the server decides on release
    startTracking(true);
  }

  // ── the panel ──
  function renderPanel() {
    const m = cur(), empty = !m.items && !S.order;
    const desc = [
      `Your food, in full`,
      `${CFG.dasherPay * 100}% of the food (${usd(m.pay)}) plus your ${usd(m.tip)} tip, in full`,
      `${CFG.irsSetAside * 100}% federal tax on food, delivery and tip, on top`,
      `${(CFG.salesTax * 100).toFixed(1)}% sales tax on the food`
    ];
    const tag = { cart: ['', 'due'], held: ['lock', 'locked'], released: ['paid', 'paid'], refunded: ['no', 'not paid'] }[S.phase];
    const open = document.querySelector('.kd-hood[open]') ? 'open' : '';
    const o = S.order;
    $('panel').innerHTML = `<h2>Where your money goes</h2>
      <p class="lead">${empty ? 'Add something from the menu to see the split.' : 'Every dollar has a destination before you pay. The covenant enforces it.'}</p>
      <div class="kd-stack">${empty ? '' : PARTIES.map((p, i) => `<i style="flex-grow:${m.cents[i]};background:${p.col}"></i>`).join('')}</div>
      <ul class="kd-rows">${PARTIES.map((p, i) => `<li class="kd-row" data-i="${i}"><span class="ic" style="background:${p.bg}">${p.ic}</span>
        <div><span class="n">${p.name}</span><span class="tag ${tag[0]}">${tag[1]}</span><div class="d">${desc[i]}</div></div>
        <div class="v num">${usd(m.cents[i])}<small>${kas(m.sompi[i])} KAS</small></div></li>`).join('')}</ul>
      <div class="kd-pfoot"><span>You pay</span><span class="num">${usd(m.total)}<small>${kas(m.deposit)} KAS incl. ${kas(m.fee)} network fee</small></span></div>
      <p class="kd-how">One covenant holds it all. When Dana scans your code, one transaction pays all four. If nobody ever scans it, you take it back after the refund delay. There is no account in the middle where the money waits.</p>
      <details class="kd-hood" ${open}><summary>Under the hood</summary>
        <p>The contract${o ? ' deployed for this order' : ''}. The values below are baked into its address; change one and it's a different address.</p>
        <pre>${esc(SIL)}</pre>
        <pre>${esc([
          o ? `address           ${o.address}` : '',
          `pinHash           ${S.pinHash || '(made on this device when you pay)'}`,
          `restaurantAmount  ${m.sompi[0]}`, `driverAmount      ${m.sompi[1]}`,
          `irsAmount         ${m.sompi[2]}`, `stateTaxAmount    ${m.sompi[3]}`,
          `refundDelayBlocks ${(o ? o.refundSecs : S.live ? S.refundSecs : CFG.refundDays * 86400) * 10}   (10 blocks per second)`
        ].filter(Boolean).join('\n'))}</pre>
        <p>The code is 16 characters (80 bits) because every party can see pinHash; a 4-digit PIN would be found from it instantly and released early. The covenant takes one coin and allows exactly four outputs, so whatever the deposit holds above the four payouts can only be the network fee.</p>
      </details>`;
  }

  // ── events ──
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.inc) { S.cart[t.dataset.inc] = (S.cart[t.dataset.inc] || 0) + 1; render(); }
    else if (t.dataset.dec) { S.cart[t.dataset.dec] = Math.max(0, (S.cart[t.dataset.dec] || 0) - 1); if (S.screen === 'cart' && !money().items) S.screen = 'menu'; render(); }
    else if (t.dataset.go) { S.screen = t.dataset.go; render(); window.scrollTo({ top: 0 }); }
    else if (t.dataset.tip) {
      if (t.dataset.tip === 'other') S.customTip = true; else { S.customTip = false; S.tip = +t.dataset.tip; }
      render(); if (S.customTip) $('customTip').focus();
    }
    else if (t.dataset.act === 'checkout') { if (S.live) openLiveSheet(); else openSimSheet(); }
    else if (t.dataset.act === 'closeSheet') closeSheet();
    else if (t.dataset.act === 'forget') { forgetOrder(); S.order = null; S.code = ''; S.pinHash = ''; closeSheet(); render(); }
    else if (t.dataset.act === 'connect') connect();
    else if (t.dataset.act === 'connectSheet') connect(openLiveSheet);
    else if (t.dataset.act === 'disconnect') { if (window.KasperoConnect) KasperoConnect.disconnect(); if (CA) CA.session.clear(); connect(); }
    else if (t.dataset.act === 'again') {
      S.run++; forgetOrder();
      Object.assign(S, { screen: 'menu', phase: 'cart', cart: {}, order: null, code: '', pinHash: '', covenant: '', txid: '', explorerUrl: '', stage: 0 });
      history.replaceState(null, '', location.pathname); render(); window.scrollTo({ top: 0 });
    }
    else if (t.id === 'skipBtn') { S.skip = true; t.remove(); }
    else if (t.id === 'noShow') noShow();
    else if (t.id === 'reclaim') reclaimLive();
  });
  $('sheetBg').onclick = closeSheet;
  document.addEventListener('change', (e) => {
    if (e.target.id === 'liveSw') { S.live = e.target.checked; render(); }
    else if (e.target.id === 'scaleSel') { S.scale = Number(e.target.value); render(); }
    else if (e.target.id === 'refundSel') { S.refundSecs = Number(e.target.value); render(); }
    else if (e.target.dataset.payto) { S.payTo[e.target.dataset.payto] = e.target.value.trim(); render(); }
    else if (e.target.dataset.paysel) {
      const k = e.target.dataset.paysel, v = e.target.value;
      if (v === '__other') { S.other[k] = true; S.payTo[k] = ''; render(); const i = document.querySelector(`[data-payto="${k}"]`); if (i) i.focus(); }
      else { S.other[k] = false; S.payTo[k] = v; render(); }
    }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'customTip') return;
    S.tip = Math.max(0, Math.round((parseFloat(e.target.value) || 0) * 100));
    const m = money();
    const set = (k, v) => { const el = document.querySelector(`[data-sum="${k}"]`); if (el) el.textContent = v; };
    set('tip', usd(m.tip)); set('irs', usd(m.irs)); set('fee', kas(m.fee) + ' KAS');
    const tot = document.querySelector('.kd-sum li.tot .num'); if (tot) tot.innerHTML = `${usd(m.total)}<small>${kas(m.deposit)} KAS</small>`;
    const pay = document.querySelector('[data-act="checkout"] .num'); if (pay) pay.textContent = S.live ? kas(m.deposit) + ' KAS' : usd(m.total);
    renderPanel();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(); });
  // the refund countdown on a live order
  setInterval(() => { if (S.order && S.phase === 'held' && $('links')) $('links').innerHTML = linksHtml(); }, 30000);
  if (window.KasperoConnect) KasperoConnect.onConnect = (d) => { if (CA && d && d.token) CA.session.store(d); render(); };

  // ── boot ──
  const q = new URLSearchParams(location.search);
  if (q.get('dash')) { dasherView(q.get('dash')); return; }
  let saved = null; try { saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (_) {}
  if (saved && saved.token && saved.code) restore(saved); else render();
})();

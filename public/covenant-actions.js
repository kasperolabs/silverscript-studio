// covenant-actions.js — the money-moving half of the covenant page, with no DOM in it.
//
// Both /c/<token> (covenant.js) and the freelance deed (freelancer.js) move money the same
// way: the Studio's session (kc_* keys from KasperoConnect), the user's wallet (Kasware,
// Kastle, Kaspire, or a Kasla account approved in Kasla's own window), the Studio's
// build-spend / broadcast / confirm-funding endpoints. This file is that layer. Pages draw
// the buttons and the receipts; this file does the rest and returns plain values or throws
// a readable Error (err.code === 4001 means the user backed out and nothing moved).
//
// Usage:
//   CovenantActions.configure({ api: '', payApi: 'https://kasperopay.com' })
//   const s = CovenantActions.session.load()          // { token, address, walletType } | null
//   const popup = CovenantActions.openKaslaWindow(null) // Kasla only, INSIDE the click handler
//   const { txId } = await CovenantActions.deposit({ contractId, contractAddress, contractName, amountKas, popup, onStatus })
//   const info = await CovenantActions.buildSpend({ contractId, entry, args })
//   const { txId } = await CovenantActions.signAndBroadcast({ contractId, contractName, spend: info, popup, onStatus })
//
// marker: covenant-actions-2026-09-27
// BUILD MARKER: covenant-actions-c2-2026-09-28
(function () {
  'use strict';
  const cfg = { api: '', payApi: 'https://kasperopay.com' };
  function configure(o) { Object.assign(cfg, o || {}); return cfg; }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const short = a => a && a.length > 20 ? a.slice(0, 12) + '…' + a.slice(-6) : (a || '');

  // ── Session (kc_* keys, shared with the Studio and every Studio page) ────────
  function decodeTokenPayload(t) {
    try {
      const part = String(t).split('.')[1];
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
      return JSON.parse(atob(b64));
    } catch (_) { return null; }
  }
  const session = {
    load() {
      const t = localStorage.getItem('kc_token');
      const p = t ? decodeTokenPayload(t) : null;
      if (t && p && p.address && !(p.exp && p.exp * 1000 < Date.now())) {
        return { token: t, address: p.address, walletType: localStorage.getItem('kc_wallet') || null };
      }
      return null;
    },
    store(d) {
      if (!d || !d.token) return null;
      localStorage.setItem('kc_token', d.token);
      if (d.walletType) localStorage.setItem('kc_wallet', d.walletType);
      if (d.user) localStorage.setItem('kc_user', JSON.stringify(d.user));
      return session.load();
    },
    clear() { localStorage.removeItem('kc_token'); localStorage.removeItem('kc_wallet'); localStorage.removeItem('kc_user'); }
  };
  function need() { const s = session.load(); if (!s) throw new Error('Connect a wallet first'); return s; }

  // ── Studio API (Authorization from the session) ─────────────────────────────
  async function api(path, opts) {
    const s = session.load();
    const headers = Object.assign({ 'Content-Type': 'application/json' }, (opts && opts.headers) || {});
    if (s) headers['Authorization'] = 'Bearer ' + s.token;
    const r = await fetch(cfg.api + path, Object.assign({}, opts, { headers }));
    let j; try { j = await r.json(); } catch (_) { j = { success: false, error: 'Bad response from the Studio' }; }
    if (r.status === 401) j = { success: false, error: 'Session expired. Connect your wallet again.' };
    return j;
  }

  // ── Wallets ─────────────────────────────────────────────────────────────────
  // Kaspire is a request-style provider: request({method, params}) instead of named methods.
  function hasKaspire() { return typeof window.kaspire !== 'undefined' && window.kaspire !== null && window.kaspire.isKaspire === true; }
  function kaspireRequest(method, params) { const req = { method }; if (params !== undefined) req.params = params; return window.kaspire.request(req); }
  const wallet = {
    hasKaspire, kaspireRequest,
    canSend(w) { return (w === 'kasware' && !!window.kasware) || (w === 'kastle' && !!window.kastle) || (w === 'kaspire' && hasKaspire()) || w === 'kasla'; },
    canSign(w) { return (w === 'kasware' && !!window.kasware) || (w === 'kaspire' && hasKaspire()) || w === 'kasla'; },   // Kastle signing pending upstream
    async activeExtensionAddress(w) {
      try {
        if (w === 'kasware' && window.kasware) { const a = await window.kasware.getAccounts(); return (a && a[0]) || null; }
        if (w === 'kastle' && window.kastle) { const i = await window.kastle.getAccount(); return (i && i.address) || null; }
        if (w === 'kaspire' && hasKaspire()) { const a = await kaspireRequest('getAccounts'); return (a && a[0]) || null; }
      } catch (_) {}
      return null;
    },
    // The session must follow the wallet's active account, or a spend pays the wrong key.
    async assertSessionMatchesWallet() {
      const s = need();
      const active = await wallet.activeExtensionAddress(s.walletType);
      if (active && active !== s.address) throw new Error(`Your wallet is on ${short(active)} but this session belongs to ${short(s.address)}. Reconnect with the account you want to use.`);
      return s;
    },
    // Fires `handler(nextAddress)` when the extension switches accounts. Returns true if bound.
    watchAccountSwitch(handler) {
      let bound = false;
      const h = (accounts) => { const next = Array.isArray(accounts) ? accounts[0] : (accounts && accounts.address) || null; handler(next); };
      try { if (window.kasware && typeof window.kasware.on === 'function') { window.kasware.on('accountsChanged', h); bound = true; } } catch (_) {}
      try { if (window.kastle && typeof window.kastle.on === 'function') { window.kastle.on('accountsChanged', h); bound = true; } } catch (_) {}
      try { if (hasKaspire() && typeof window.kaspire.on === 'function') { window.kaspire.on('accountsChanged', h); bound = true; } } catch (_) {}
      return bound;
    }
  };

  // ── Kasla per-transaction approval ──────────────────────────────────────────
  // Kasla does not send or sign on an app's say-so. The page creates the request through
  // KasperoPay, the user approves it in a window on Kasla's own origin (which this code can
  // neither read nor script), and the page learns the outcome afterwards by polling.
  // Same shape as an extension wallet: our button, then the wallet's confirm.

  // Must be called inside a click handler; popup blockers refuse windows opened later.
  function openKaslaWindow(url) {
    const w = 480, h = 700;
    const left = Math.max(0, (window.screenX || 0) + ((window.outerWidth || 800) - w) / 2);
    const top = Math.max(0, (window.screenY || 0) + ((window.outerHeight || 600) - h) / 2);
    let popup = null;
    try { popup = window.open(url || 'about:blank', 'kaspero-kasla-approve', `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`); }
    catch (_) { popup = null; }
    if (popup && !url) {
      try {
        popup.document.write('<!DOCTYPE html><html><head><title>Kasla</title><meta name="viewport" content="width=device-width, initial-scale=1">' +
          '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#1a365d;background:#f5f7fa;font-size:16px}</style>' +
          '</head><body><div>Opening Kasla&hellip;</div></body></html>');
        popup.document.close();
      } catch (_) {}
    }
    return popup;
  }
  const cancelled = (m) => { const e = new Error(m); e.code = 4001; return e; };
  function pointPopup(popup, url) {
    if (popup && !popup.closed) { try { popup.location.href = url; } catch (_) { popup = null; } }
    if (!popup || popup.closed) popup = openKaslaWindow(url);
    if (!popup) throw new Error('Your browser blocked the Kasla window. Allow popups for this site and try again.');
    return popup;
  }
  // Polls `check()` until it settles; also listens for Kasla's postMessage nudge.
  function awaitApproval({ popup, kaslaOrigin, matchMessage, check, closedMsg, expiredMsg }) {
    return new Promise((resolve, reject) => {
      const POLL_MS = 2000, CLOSE_GRACE_MS = 8000, TIMEOUT_MS = 10 * 60 * 1000;
      const startedAt = Date.now();
      let closedAt = null, settled = false, timer = null, inFlight = false;
      const finish = (fn, v) => {
        if (settled) return; settled = true;
        clearInterval(timer);
        window.removeEventListener('message', onMessage);
        if (popup && !popup.closed) { try { popup.close(); } catch (_) {} }
        fn(v);
      };
      const run = () => {
        if (inFlight || settled) return;
        inFlight = true;
        check().then(res => {
          if (settled || !res) return;
          if (res.done) finish(resolve, res.value);
          else if (res.error) finish(reject, res.error);
        }).catch(() => {}).then(() => { inFlight = false; });
      };
      const onMessage = (ev) => {
        if (kaslaOrigin && ev.origin !== kaslaOrigin) return;
        const m = ev.data || {};
        if (m.source === 'kaspero-connect' && matchMessage(m)) run();
      };
      window.addEventListener('message', onMessage);
      timer = setInterval(() => {
        if (settled) return;
        if (Date.now() - startedAt > TIMEOUT_MS) return finish(reject, cancelled(expiredMsg));
        if (popup.closed) {
          closedAt = closedAt || Date.now();
          if (Date.now() - closedAt > CLOSE_GRACE_MS) return finish(reject, cancelled(closedMsg));
        }
        run();
      }, POLL_MS);
    });
  }
  const originOf = u => { try { return new URL(u).origin; } catch (_) { return null; } };
  const say = (onStatus, m) => { try { if (onStatus) onStatus(m); } catch (_) {} };
  const bearer = () => 'Bearer ' + ((session.load() || {}).token || '');

  // Resolves to the txid. Rejects with .code = 4001 when the user backs out.
  async function kaslaApprovedSend({ toAddress, amountKas, description, referenceId, popup, onStatus }) {
    const r = await fetch(cfg.payApi + '/pay/kasla/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': bearer() },
      body: JSON.stringify({ to_address: toAddress, amount_kas: amountKas, description, reference_id: referenceId })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.success || !d.approval_url || !d.kasla_payment_id) {
      if (popup && !popup.closed) { try { popup.close(); } catch (_) {} }
      throw new Error(d.error || `Kasla request failed (HTTP ${r.status})`);
    }
    popup = pointPopup(popup, d.approval_url);
    say(onStatus, 'Approve the payment in the Kasla window…');
    return awaitApproval({
      popup, kaslaOrigin: originOf(d.approval_url),
      matchMessage: m => m.payment_id === d.kasla_payment_id,
      check: () => fetch(cfg.payApi + '/pay/kasla/approval/' + encodeURIComponent(d.kasla_payment_id), { headers: { 'Authorization': bearer() } })
        .then(res => res.json()).then(st => {
          if (!st) return null;
          if (st.status === 'completed' && st.transaction_id) return { done: true, value: st.transaction_id };
          if (st.status === 'cancelled') return { error: cancelled(/expired/i.test(st.error_message || '') ? 'Approval request expired' : 'Denied in Kasla — nothing was sent') };
          if (st.status === 'failed') return { error: new Error(st.error_message || 'Kasla could not send the payment') };
          return null;
        }),
      closedMsg: 'Kasla window closed before approval', expiredMsg: 'Approval request expired'
    });
  }

  // Resolves to the signed txJsonString. Kasla never broadcasts; the caller does.
  async function kaslaApprovedSign({ txJsonString, signInputs, description, referenceId, popup, onStatus }) {
    say(onStatus, 'Asking Kasla…');
    const r = await fetch(cfg.payApi + '/pay/kasla/sign-pskt', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': bearer() },
      body: JSON.stringify({ txJsonString, signInputs, description, reference_id: referenceId })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.success || !d.approval_url || !d.request_id) {
      if (popup && !popup.closed) { try { popup.close(); } catch (_) {} }
      throw new Error(d.error || `Kasla signing request failed (HTTP ${r.status})`);
    }
    popup = pointPopup(popup, d.approval_url);
    say(onStatus, 'Review and sign in the Kasla window…');
    return awaitApproval({
      popup, kaslaOrigin: originOf(d.approval_url),
      matchMessage: m => m.request_id === d.request_id,
      check: () => fetch(cfg.payApi + '/pay/kasla/sign-status/' + encodeURIComponent(d.request_id), { headers: { 'Authorization': bearer() } })
        .then(res => res.json()).then(st => {
          if (!st) return null;
          if (st.status === 'signed') return st.txJsonString ? { done: true, value: st.txJsonString } : { error: new Error(st.error_message || 'Kasla signed the transaction but it is no longer available; try again') };
          if (st.status === 'cancelled') return { error: cancelled(/expired/i.test(st.error_message || '') ? 'Signing request expired' : 'Denied in Kasla — nothing was signed') };
          if (st.status === 'failed') return { error: new Error(st.error_message || 'Kasla could not sign the transaction') };
          return null;
        }),
      closedMsg: 'Kasla window closed before signing', expiredMsg: 'Signing request expired'
    });
  }

  // ── Send plain KAS to an address (every wallet) → txid ──────────────────────
  function extractTxId(r) {
    if (!r) return null;
    if (typeof r === 'string') { try { const p = JSON.parse(r); return p.id || p.transactionId || r; } catch (_) { return r.replace(/^"|"$/g, ''); } }
    return r.id || r.transactionId || null;
  }
  async function sendToAddress({ toAddress, amountKas, description, referenceId, popup, onStatus }) {
    const s = await wallet.assertSessionMatchesWallet();
    if (!wallet.canSend(s.walletType)) throw new Error(`Wallet "${s.walletType || 'none'}" can't send from this page. Connect Kasware, Kastle, Kaspire or Kasla.`);
    const sompi = Math.round(amountKas * 1e8);
    let txId = null;
    if (s.walletType === 'kasla') {
      txId = await kaslaApprovedSend({ toAddress, amountKas, description, referenceId, popup, onStatus });
    } else if (s.walletType === 'kaspire') {
      say(onStatus, 'Waiting for your wallet…');
      txId = extractTxId(await kaspireRequest('sendKaspa', { from: s.address, to: toAddress, amountSompi: String(sompi) }));
    } else {
      say(onStatus, 'Waiting for your wallet…');
      txId = extractTxId(await window[s.walletType].sendKaspa(toAddress, sompi, {}));
    }
    if (!txId) throw new Error('The wallet did not return a transaction id');
    return txId;
  }

  // ── Deposit into a covenant, then tell the Studio (chain-verified) ─────────
  async function deposit({ contractId, contractAddress, contractName, amountKas, popup, onStatus }) {
    const txId = await sendToAddress({
      toAddress: contractAddress, amountKas, popup, onStatus,
      description: `SilverScript Studio · fund "${String(contractName || 'covenant').slice(0, 120)}"`,
      referenceId: `silverscript:${contractId}:${contractAddress}`
    });
    say(onStatus, 'Sent. Waiting for the network to see it…');
    let recorded = false;
    for (let i = 0; i < 5 && !recorded; i++) {
      try {
        const r = await api(`/api/contracts/${contractId}/confirm-funding`, { method: 'POST', body: JSON.stringify({ txId }) });
        if (r.success) recorded = true; else if (!r.retryable) break;
      } catch (_) {}
      if (!recorded) await sleep(3000);
    }
    return { txId, recorded };
  }

  // ── Withdraw through one path ───────────────────────────────────────────────
  // Step 1: the Studio builds the unsigned tx (destination is pinned by the rules or is
  // this session's wallet). `amount` is { all: true } or { amountKas: '2.5' } (what the
  // payee receives, in KAS; the rest minus the fee goes back to the covenant); omitted
  // means sweep everything, the pre-amount behaviour. The server bounds it by the chain
  // and the path's rules and refuses before anything is signed. Throws on refusal; the
  // error carries the server's flags (badAmount, maxSompi, outputRule, locked...).
  async function buildSpend({ contractId, entry, args, amount }) {
    const s = need();
    if (!wallet.canSign(s.walletType)) throw new Error('Withdrawals need Kasware, Kaspire or a Kasla account (Kastle signing is pending upstream)');
    const body = { entry, args: args || {} };
    if (amount && amount.all) body.all = true;
    else if (amount && amount.amountKas) body.amountKas = String(amount.amountKas);
    let info;
    try { info = await api(`/api/contracts/${contractId}/build-spend`, { method: 'POST', body: JSON.stringify(body) }); }
    catch (e) { throw new Error('Network error: ' + e.message); }
    if (!info || !info.success) { const err = new Error((info && info.error) || 'Could not build the withdrawal'); err.flags = info || {}; throw err; }
    return Object.assign({ name: entry, args: args || {}, amount: amount || null }, info);
  }
  // The wallet signs every input (SIGHASH_ALL); returns the signed SafeJSON string.
  async function walletSign(txJsonString, inputCount, ctx) {
    const s = need();
    const signInputs = Array.from({ length: inputCount || 1 }, (_, i) => ({ index: i, sighashType: 1 }));
    if (s.walletType === 'kasla') return kaslaApprovedSign(Object.assign({ txJsonString, signInputs }, ctx || {}));
    if (s.walletType === 'kaspire' && hasKaspire()) {
      const signed = await kaspireRequest('signPskt', { sender: s.address, txJsonString, options: { signInputs } });
      return typeof signed === 'string' ? signed : JSON.stringify(signed);
    }
    if (!(s.walletType === 'kasware' && window.kasware)) throw new Error('Signing needs Kasware, Kaspire or a Kasla account (Kastle signing is pending upstream)');
    const signed = await window.kasware.signPskt({ txJsonString, options: { signInputs } });
    return typeof signed === 'string' ? signed : JSON.stringify(signed);
  }
  // Step 2: sign, assemble the sigScripts, broadcast through the Studio's own node.
  // Nothing leaves the covenant unless a txId comes back; a rejected tx moves no funds.
  // Signed SafeJSON → the same tx with each input's full sigScript (prefix + sig push + suffix)
  function assembleSigned(signedStr, prefixHex, suffixHex) {
    const tx = JSON.parse(signedStr);
    if (!Array.isArray(tx.inputs) || !tx.inputs.length) throw new Error('Signed transaction has no inputs');
    const prefix = (prefixHex || '').toLowerCase(), suffix = (suffixHex || '').toLowerCase();
    if (!suffix) throw new Error('build-spend returned no sigScript suffix');
    tx.inputs.forEach((inp, i) => {
      if (!inp.signatureScript || inp.signatureScript.length < 20) throw new Error(`Wallet returned no signature for input ${i}`);
      inp.signatureScript = prefix + inp.signatureScript.toLowerCase() + suffix;
    });
    return tx;
  }
  async function signAndBroadcast({ contractId, contractName, spend, popup, onStatus }) {
    const st = spend;
    const s = await wallet.assertSessionMatchesWallet();
    const toSelf = !!st.contractAddress && st.destination === st.contractAddress;
    // A pinned destination (a party named by the rules, or the covenant itself) is not a mismatch
    if (st.destination !== s.address && !toSelf && !st.destinationPinned) throw new Error('Destination does not match this session; rebuild the withdrawal');
    // Chained: the merge first. Signed and sent on its own; the withdrawal below spends its
    // output. If the merge lands under another id than the withdrawal was built on, stop:
    // the money is merged into one coin at the covenant, nothing lost, and a fresh
    // withdrawal from that coin is the way on.
    let mergeTxId = null;
    if (st.pre) {
      say(onStatus, `Signing the merge (1 of 2): ${st.pre.inputCount} coins into one…`);
      const mergedStr = await walletSign(st.pre.txJsonString, st.pre.inputCount, {
        popup, onStatus,
        description: `SilverScript Studio · merge coins at "${String(contractName || 'covenant').slice(0, 120)}" via ${st.pre.entrypoint}()`,
        referenceId: `silverscript:${contractId}:merge:${st.pre.entrypoint}`
      });
      const mtx = assembleSigned(mergedStr, st.pre.sigScriptPrefixHex, st.pre.sigScriptSuffixHex);
      say(onStatus, 'Merge signed. Sending it…');
      const mb = await api(`/api/contracts/${contractId}/broadcast`, { method: 'POST', body: JSON.stringify({ txJsonString: JSON.stringify(mtx), entry: st.pre.entrypoint }) });
      if (!mb.success || !mb.txId) throw new Error('The merge was not accepted: ' + (mb.error || 'broadcast failed') + '. Nothing moved.');
      mergeTxId = mb.txId;
      if (String(mb.txId).toLowerCase() !== String(st.pre.mergeId || '').toLowerCase()) {
        const e = new Error(`The coins were merged into one (tx ${String(mb.txId).slice(0, 12)}…), but under a different id than the withdrawal was built on. Nothing left the covenant; refresh and withdraw from the merged coin.`);
        e.merged = mb.txId; throw e;
      }
      say(onStatus, 'Merged. Now the withdrawal (2 of 2)…');
    }
    const signedStr = await walletSign(st.txJsonString, st.inputCount, {
      popup, onStatus,
      description: `SilverScript Studio · withdraw from "${String(contractName || 'covenant').slice(0, 120)}" via ${st.entrypoint || st.name}()`,
      referenceId: `silverscript:${contractId}:spend:${st.entrypoint || st.name}`
    });
    const tx = assembleSigned(signedStr, st.sigScriptPrefixHex, st.sigScriptSuffixHex);
    say(onStatus, 'Signed. Broadcasting…');
    const bc = await api(`/api/contracts/${contractId}/broadcast`, { method: 'POST', body: JSON.stringify({ txJsonString: JSON.stringify(tx), entry: st.entrypoint || st.name || null }) });
    if (!bc.success || !bc.txId) { const e = new Error((mergeTxId ? 'The coins were merged, but the withdrawal was not accepted: ' : '') + (bc.error || 'Broadcast failed')); if (mergeTxId) e.merged = mergeTxId; throw e; }
    // Provenance only: the recorded funding coin left, and nothing stayed behind
    if (st.usedRecordedOutpoint && !toSelf && !(Number(st.changeSompi) > 0)) { try { await api(`/api/contracts/${contractId}/redeem-notify`, { method: 'POST', body: JSON.stringify({ txId: bc.txId }) }); } catch (_) {} }
    return { txId: bc.txId, mergeTxId, toSelf, receiveSompi: Number(st.payoutSompi != null ? st.payoutSompi : (Number(st.amountSompi) - Number(st.feeSompi))), changeSompi: Number(st.changeSompi || 0) };
  }

  window.CovenantActions = {
    configure, session, api, wallet, sleep,
    openKaslaWindow, kaslaApprovedSend, kaslaApprovedSign,
    sendToAddress, deposit, buildSpend, walletSign, signAndBroadcast
  };
})();

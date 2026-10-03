// BUILD MARKER: workspace-2026-10-02
/* ═══════════════════════════════════════════════════════
   SilverScript Studio - app.js
   ═══════════════════════════════════════════════════════ */

const App = (() => {
  // ─── State ─────────────────────────────────────────
  let editor = null;
  let monacoReady = false;
  let files = [];          // { id, filename, content, compiled_output, dirty, model }
  let activeFileId = null;
  let snippets = [];
  let snippetsByCategory = {};
  let authToken = localStorage.getItem('kc_token');
  let currentUser = null;
  let connectedWallet = localStorage.getItem('kc_wallet');

  // Kaspire (window.kaspire) is a request-style provider: one request({method, params})
  // entry point instead of named methods like Kasware/Kastle expose.
  function hasKaspire() {
    return typeof window.kaspire !== 'undefined' && window.kaspire !== null && window.kaspire.isKaspire === true;
  }
  function kaspireRequest(method, params) {
    const req = { method };
    if (params !== undefined) req.params = params;
    return window.kaspire.request(req);
  }
  let userPubkey = null;
  let fileIdCounter = 1;
  let consoleMessages = [];
  let bottomPanelVisible = true;
  let snippetCategoryState = {}; // track open/closed

  // ─── Kaspa Address Utilities ────────────────────────
  const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

  function bech32Decode(str) {
    // Kaspa addresses: kaspa:qr... or kaspatest:qr...
    const colonIdx = str.indexOf(':');
    if (colonIdx === -1) return null;
    const data = str.slice(colonIdx + 1).toLowerCase();
    // Find separator (last '1' in standard bech32, but Kaspa uses ':' as separator)
    // Kaspa bech32 has no '1' separator - data starts right after ':'
    const values = [];
    for (let i = 0; i < data.length; i++) {
      const v = BECH32_CHARSET.indexOf(data[i]);
      if (v === -1) return null;
      values.push(v);
    }
    // Strip 8-char checksum
    const words = values.slice(0, values.length - 8);
    // Convert 5-bit words to 8-bit bytes
    let acc = 0, bits = 0;
    const bytes = [];
    for (const w of words) {
      acc = (acc << 5) | w;
      bits += 5;
      while (bits >= 8) {
        bits -= 8;
        bytes.push((acc >> bits) & 0xff);
      }
    }
    // First byte is version (0x00 = Schnorr P2PK, 0x01 = ECDSA)
    if (bytes.length < 33) return null;
    const version = bytes[0];
    const pubkeyBytes = bytes.slice(1, 33);
    return {
      version,
      pubkey: pubkeyBytes.map(b => b.toString(16).padStart(2, '0')).join('')
    };
  }

  function kaspaAddressToPubkey(input) {
    if (!input) return null;
    input = input.trim();
    // Already hex pubkey (64 chars = 32 bytes)
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(input)) {
      return input.replace(/^0x/i, '');
    }
    // Kaspa address
    if (input.startsWith('kaspa:') || input.startsWith('kaspatest:')) {
      const decoded = bech32Decode(input);
      return decoded ? decoded.pubkey : null;
    }
    return null;
  }

  // ─── Init ──────────────────────────────────────────
  async function init() {
    applyTheme();
    await loadMonaco();
    await loadSnippets();
    renderSnippets();
    checkAuth();
    setupKeyboardShortcuts();
    setupContextMenuListeners();
    document.addEventListener('click', handleDropdownOutsideClick);

    // Open files come back per wallet (see Workspace below). A first visit gets the
    // welcome file, unless the link carries a contract (#code= / #open=), which
    // then opens on top of whatever was restored.
    loadWorkspace(!!readImportFromHash());
    const imported = importFromHash();
    window.addEventListener('hashchange', importFromHash);

    logToConsole('SilverScript Studio initialized');
    logToConsole('Mainnet — Covenants++ live (Toccata)');

    if (!imported && startShouldShow()) showStart();
  }

  // ─── Open in Studio (deep link) ─────────────────────
  // Other sites hand the Studio a contract in the URL fragment, which never reaches the server:
  //   #code=<base64url .sil source>[&name=<file name>]        simple form
  //   #open=<base64url JSON {v:1, file, source, args, from}>  with constructor prefills
  // Anything malformed is ignored and the Studio loads normally.
  // Nothing compiles, deploys or signs by itself; args only prefill the deploy form.
  // Marker: open-link-b-2026-09-28
  const IMPORT_MAX_SOURCE = 64 * 1024;
  let lastImportedHash = null;
  // Sites whose links get the "Verified" mark. Matched against the host the browser
  // reports (document.referrer), never against the payload's own "from" label.
  // The name shown comes from this list. Partners must not link with rel="noreferrer".
  const TRUSTED_SOURCES = {
    'kasstacker.org': 'KasStacker'
  };
  function trustedName(host) {
    const h = String(host || '').toLowerCase().replace(/^www\./, '');
    return Object.prototype.hasOwnProperty.call(TRUSTED_SOURCES, h) ? TRUSTED_SOURCES[h] : null;
  }

  function b64urlToUtf8(s) {
    // URLSearchParams turns '+' into ' ', so put it back (tolerates standard base64 too)
    s = String(s || '').replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  function safeImportName(name) {
    let n = String(name || '').trim().split(/[\\/]/).pop()
      .replace(/[^A-Za-z0-9._ -]/g, '').replace(/\s+/g, '_').slice(0, 60);
    n = n.replace(/\.sil$/i, '');
    if (!n || /^\.+$/.test(n)) n = 'imported';
    return n + '.sil';
  }

  function readImportFromHash() {
    const raw = (location.hash || '').replace(/^#/, '');
    if (!raw) return null;
    try {
      const params = new URLSearchParams(raw);
      if (params.has('open')) {
        const p = JSON.parse(b64urlToUtf8(params.get('open')));
        if (!p || typeof p !== 'object' || p.v !== 1 || typeof p.source !== 'string') return null;
        const args = {};
        if (p.args && typeof p.args === 'object' && !Array.isArray(p.args)) {
          for (const [k, v] of Object.entries(p.args)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
            if (typeof v !== 'string' && typeof v !== 'number') continue;
            args[k] = String(v).slice(0, 200);
          }
        }
        return {
          source: p.source,
          name: typeof p.file === 'string' ? p.file : '',
          args: Object.keys(args).length ? args : null,
          from: typeof p.from === 'string' ? p.from.trim().slice(0, 60) : ''
        };
      }
      if (params.has('code')) {
        return { source: b64urlToUtf8(params.get('code')), name: params.get('name') || '', args: null, from: '' };
      }
    } catch { return null; }
    return null;
  }

  function referrerHost() {
    try {
      const u = new URL(document.referrer);
      return u.origin !== location.origin ? u.host : '';
    } catch { return ''; }
  }

  function importFromHash() {
    const hash = location.hash;
    if (!hash || hash === lastImportedHash) return false;
    const imp = readImportFromHash();
    if (!imp) return false;
    const source = imp.source.replace(/\r\n/g, '\n');
    if (!source.trim()) return false;
    if (source.length > IMPORT_MAX_SOURCE) {
      logToConsole('A link carried a contract larger than 64 KB; it was not opened');
      return false;
    }
    lastImportedHash = hash;
    const name = safeImportName(imp.name);
    const already = files.find(f => f.filename === name && (f.model ? f.model.getValue() : f.content) === source);
    if (already) { switchToFile(already.id); return true; }
    addFile(name, source, true, imp.args);
    showImportNotice(name, imp.from, referrerHost());
    logToConsole(`Opened ${name} from a link`);
    return true;
  }

  function showImportNotice(name, from, host) {
    document.getElementById('importNotice')?.remove();
    const area = document.getElementById('editorArea');
    const container = document.getElementById('editorContainer');
    if (!area || !container) return;
    const trusted = trustedName(host);
    let where;
    if (trusted) {
      where = ` from <b>${esc(trusted)}</b> <span title="${esc(host)} is a verified partner site" style="display:inline-block;margin-left:4px;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600;background:var(--accent);color:#fff;vertical-align:1px;">&#10003; Verified</span>`;
    } else if (host) {
      where = ` from <b>${esc(host)}</b>`;
    } else if (from) {
      where = ` from <b>${esc(from)}</b>`;
    } else {
      where = ' opened from a link';
    }
    const el = document.createElement('div');
    el.id = 'importNotice';
    el.style.cssText = 'flex:none;display:flex;align-items:center;gap:12px;padding:8px 14px;'
      + 'background:var(--accent-bg);border-bottom:1px solid var(--border);color:var(--text-primary);font-size:13px;line-height:1.4;';
    el.innerHTML = `<span style="flex:1"><b>${esc(name)}</b>${where}. `
      + `Review the keys and addresses before you deploy.</span>`
      + `<button type="button" aria-label="Dismiss" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:18px;line-height:1;padding:0 2px;">&times;</button>`;
    el.querySelector('button').onclick = () => el.remove();
    area.insertBefore(el, container);
  }

  // ─── Start panel (first-run screen) ────────────────
  // Rule: no session → the panel is the first thing on screen; a connected
  // user lands in the editor. Doors hide it for the visit; File > Start brings
  // it back. Logging out shows it again.
  let startPendingDescribe = false;
  // Grouped by what the person wants, in their words; two shapes per group at most.
  // Mecenas and the pure Simple Covenant stay in the sidebar (withdraw by hand) but not here.
  const START_ART = {
    vault: `<svg viewBox="0 0 64 52" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M25 22 v-8 a9 9 0 0 1 18 0 v8" fill="none" stroke="var(--accent)" stroke-width="4"/><circle cx="34" cy="31" r="13" fill="var(--accent)"/><circle cx="34" cy="31" r="9" fill="var(--bg-primary)"/><path d="M34 25 v6 h5" fill="none" stroke="var(--sp-group)" stroke-width="2.4" stroke-linecap="round"/></svg>`,
    deadman: `<svg viewBox="0 0 64 52" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M20 16 v-7 a7.0 7.0 0 0 1 14 0 v7" fill="none" stroke="var(--accent)" stroke-width="4"/><rect x="14" y="16" width="26" height="20" rx="4" fill="var(--accent)"/><circle cx="27.0" cy="25.0" r="3" fill="var(--bg-primary)"/><rect x="25.8" y="25.0" width="2.4" height="6" fill="var(--bg-primary)"/><path d="M44 26 h5 l3-7 l4 14 l3-7 h4" fill="none" stroke="var(--sp-group)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/><g transform="translate(13,44) scale(0.8)"><circle cx="0" cy="0" r="7" fill="var(--text-muted)"/><circle cx="0" cy="0" r="2.6" fill="var(--bg-primary)"/><rect x="6" y="-2" width="18" height="4" rx="1" fill="var(--text-muted)"/><rect x="12" y="2" width="3.5" height="5" fill="var(--text-muted)"/><rect x="18" y="2" width="3.5" height="4" fill="var(--text-muted)"/></g></svg>`,
    payroll: `<svg viewBox="0 0 64 52" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M12 16 v-7 a7.0 7.0 0 0 1 14 0 v7" fill="none" stroke="var(--accent)" stroke-width="4"/><rect x="6" y="16" width="26" height="20" rx="4" fill="var(--accent)"/><circle cx="19.0" cy="25.0" r="3" fill="var(--bg-primary)"/><rect x="17.8" y="25.0" width="2.4" height="6" fill="var(--bg-primary)"/><g fill="var(--sp-group)"><rect x="42" y="30" width="16" height="4" rx="2"/><rect x="42" y="36" width="16" height="4" rx="2"/><rect x="42" y="24" width="16" height="4" rx="2"/></g><path d="M42 12 l5 5 l10 -10" fill="none" stroke="var(--text-muted)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    escrow: `<svg viewBox="0 0 64 52" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M26 14 v-7 a6.0 6.0 0 0 1 12 0 v7" fill="none" stroke="var(--accent)" stroke-width="4"/><rect x="20" y="14" width="24" height="20" rx="4" fill="var(--accent)"/><circle cx="32.0" cy="23.0" r="3" fill="var(--bg-primary)"/><rect x="30.8" y="23.0" width="2.4" height="6" fill="var(--bg-primary)"/><g transform="translate(6,44) scale(0.8)"><circle cx="0" cy="0" r="7" fill="var(--sp-group)"/><circle cx="0" cy="0" r="2.6" fill="var(--bg-primary)"/><rect x="6" y="-2" width="14" height="4" rx="1" fill="var(--sp-group)"/><rect x="8" y="2" width="3.5" height="5" fill="var(--sp-group)"/><rect x="14" y="2" width="3.5" height="4" fill="var(--sp-group)"/></g><g transform="translate(58,44) scale(-0.8,0.8)"><circle cx="0" cy="0" r="7" fill="var(--sp-group)"/><circle cx="0" cy="0" r="2.6" fill="var(--bg-primary)"/><rect x="6" y="-2" width="14" height="4" rx="1" fill="var(--sp-group)"/><rect x="8" y="2" width="3.5" height="5" fill="var(--sp-group)"/><rect x="14" y="2" width="3.5" height="4" fill="var(--sp-group)"/></g></svg>`,
    htlc: `<svg viewBox="0 0 64 52" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M19 20 v-7 a9 9 0 0 1 18 0 v7" fill="none" stroke="var(--accent)" stroke-width="4"/><rect x="10" y="20" width="36" height="22" rx="4" fill="var(--accent)"/><g fill="var(--bg-primary)"><circle cx="19" cy="31" r="2.6"/><circle cx="28" cy="31" r="2.6"/><circle cx="37" cy="31" r="2.6"/></g><path d="M50 14 l6 6 l-6 6" fill="none" stroke="var(--sp-group)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    p2pk: `<svg viewBox="0 0 64 52" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g transform="translate(16,26) scale(1.15)"><circle cx="0" cy="0" r="7" fill="var(--accent)"/><circle cx="0" cy="0" r="2.6" fill="var(--bg-primary)"/><rect x="6" y="-2" width="32" height="4" rx="1" fill="var(--accent)"/><rect x="26" y="2" width="3.5" height="5" fill="var(--accent)"/><rect x="32" y="2" width="3.5" height="4" fill="var(--accent)"/></g></svg>`,
    p2pkh: `<svg viewBox="0 0 64 52" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g transform="translate(16,26) scale(1.15)"><circle cx="0" cy="0" r="7" fill="var(--accent)"/><circle cx="0" cy="0" r="2.6" fill="var(--bg-primary)"/><rect x="6" y="-2" width="32" height="4" rx="1" fill="var(--accent)"/><rect x="26" y="2" width="3.5" height="5" fill="var(--accent)"/><rect x="32" y="2" width="3.5" height="4" fill="var(--accent)"/></g><rect x="4" y="12" width="26" height="26" rx="6" fill="var(--sp-group)"/><g stroke="var(--bg-primary)" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="18" x2="10" y2="32"/><line x1="22" y1="18" x2="20" y2="32"/><line x1="9" y1="22" x2="24" y2="22"/><line x1="8" y1="28" x2="23" y2="28"/></g></svg>`
  };
  const START_GROUPS = [
    { title: 'Keep money safe until a date', color: '#e8a54e', items: [
      { id: 'timelocked', art: 'vault',   line: 'Locked until a date or a number of days has passed.' },
      { id: 'deadman',    art: 'deadman', line: 'If I stop checking in, my heir can take it.' }
    ]},
    { title: 'Pay someone for work', color: '#f59e42', items: [
      { id: 'payroll',    art: 'payroll', line: 'Locked before the work starts, released when both agree, back to me if it never happens.' },
      { id: 'escrow',     art: 'escrow',  line: 'Either side can release, or both must agree.' }
    ]},
    { title: 'Give it to whoever knows a secret', color: '#6c5ce7', items: [
      { id: 'htlc',       art: 'htlc',    line: 'Claim with the secret before the deadline, or I take it back.' }
    ]},
    { title: 'Just lock it to one key', color: '#4eca8b', items: [
      { id: 'p2pk',       art: 'p2pk',    line: 'One key can spend. The plainest there is.' },
      { id: 'p2pkh',      art: 'p2pkh',   line: 'Same, but the key stays hidden until I spend.' }
    ]}
  ];

  function startShouldShow() {
    return !currentUser;
  }
  function showStart() {
    const el = document.getElementById('startPanel');
    if (!el) return;
    startPickBack();
    startNote('');
    el.classList.add('visible');
  }
  function hideStart() {
    document.getElementById('startPanel')?.classList.remove('visible');
  }
  function startNote(msg) {
    const n = document.getElementById('spNote');
    if (!n) return;
    n.textContent = msg || '';
    n.classList.toggle('visible', !!msg);
  }
  function startBuild() {
    const box = document.getElementById('spTemplates');
    if (!box) return;
    const data = (typeof WIZARD_DATA !== 'undefined') ? WIZARD_DATA : {};
    box.innerHTML = START_GROUPS.map(g => `
      <div class="sp-group" style="--sp-group:${esc(g.color)}">
        <div class="sp-group-title">${esc(g.title)}</div>
        ${g.items.filter(t => data[t.id]).map(t => `
          <button class="sp-tpl" onclick="App.startPickTemplate('${t.id}')">
            <span class="sp-tpl-art">${START_ART[t.art] || ''}</span>
            <span><div class="sp-tpl-name">${esc(data[t.id].title || t.id)}</div><div class="sp-tpl-line">${esc(t.line)}</div></span>
          </button>`).join('')}
      </div>`).join('');
    document.getElementById('spDoors').style.display = 'none';
    document.getElementById('spPick').classList.add('visible');
  }
  function startPickBack() {
    const doors = document.getElementById('spDoors');
    if (doors) doors.style.display = '';
    document.getElementById('spPick')?.classList.remove('visible');
  }
  function startPickTemplate(id) {
    hideStart();
    if (typeof WizardEngine !== 'undefined') WizardEngine.open(id);
  }
  function startDescribe() {
    if (!currentUser) {
      startPendingDescribe = true;   // onWalletConnected opens the AI modal
      startNote('Describe needs a connected wallet. Connecting one now.');
      showLogin();
      return;
    }
    hideStart();
    showAiGenerate();
  }
  function startWrite() {
    hideStart();
    setTimeout(() => editor?.focus(), 50);
  }



  // ─── Monaco Setup ──────────────────────────────────
  function loadMonaco() {
    return new Promise((resolve) => {
      require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' } });
      require(['vs/editor/editor.main'], () => {
        registerSilverScriptLanguage();
        editor = monaco.editor.create(document.getElementById('editorContainer'), {
          language: 'silverscript',
          theme: getMonacoTheme(),
          fontSize: 13.5,
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontLigatures: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          lineNumbers: 'on',
          renderLineHighlight: 'line',
          automaticLayout: true,
          tabSize: 4,
          insertSpaces: true,
          wordWrap: 'off',
          suggest: { showKeywords: true },
          padding: { top: 8 },
          bracketPairColorization: { enabled: true },
          guides: { bracketPairs: true },
        });

        monacoReady = true;
        resolve();
      });
    });
  }

  function registerSilverScriptLanguage() {
    monaco.languages.register({ id: 'silverscript' });

    monaco.languages.setMonarchTokensProvider('silverscript', {
      keywords: [
        'pragma', 'silverscript', 'contract', 'entry', 'function', 'struct',
        'require', 'if', 'else', 'for', 'return', 'constant', 'new',
        'true', 'false', 'console', 'log'
      ],
      typeKeywords: [
        'int', 'temporal', 'bool', 'string', 'pubkey', 'sig', 'datasig', 'byte', 'void', 'State'
      ],
      builtins: [
        'checkSig', 'checkSigEcdsa', 'checkMsgSig', 'checkMsgSigEcdsa', 'blake2b', 'sha256', 'length', 'date',
        'append', 'split', 'slice', 'signed', 'unsigned', 'validateOutputState', 'readInputState', 'readInputStateWithTemplate',
        'ScriptPubKeyP2PK', 'ScriptPubKeyP2SH', 'ScriptPubKeyP2SHFromRedeemScript'
      ],
      introspection: [
        'tx', 'this', 'inputs', 'outputs', 'value', 'scriptPubKey',
        'time', 'locktime', 'version', 'age', 'activeInputIndex',
        'activeScriptPubKey'
      ],
      units: [
        'litras', 'grains', 'kas', 'seconds', 'minutes', 'hours', 'days', 'weeks'
      ],
      operators: [
        '==', '!=', '<=', '>=', '&&', '||', '!', '+', '-', '*', '/', '%',
        '&', '|', '^', '<', '>', '='
      ],
      symbols: /[=><!~?:&|+\-*\/\^%]+/,
      tokenizer: {
        root: [
          // Hex literals
          [/0x[0-9a-fA-F]*/, 'number.hex'],
          // Numbers with units
          [/\b\d[\d_]*(?:e\d+)?\s*(?:litras|grains|kas|seconds|minutes|hours|days|weeks)\b/, 'number'],
          // Numbers
          [/\b\d[\d_]*(?:e\d+)?\b/, 'number'],
          // Byte array types  byte[32]
          [/\bbyte\s*\[\s*\d*\s*\]/, 'type'],
          // Identifiers
          [/[a-zA-Z_]\w*/, {
            cases: {
              '@keywords': 'keyword',
              '@typeKeywords': 'type',
              '@builtins': 'builtin',
              '@introspection': 'variable.predefined',
              '@units': 'number',
              '@default': 'identifier'
            }
          }],
          // Strings
          [/"([^"\\]|\\.)*"/, 'string'],
          [/'([^'\\]|\\.)*'/, 'string'],
          // Comments
          [/\/\/.*$/, 'comment'],
          [/\/\*/, 'comment', '@comment'],
          // Operators
          [/@symbols/, {
            cases: {
              '@operators': 'operator',
              '@default': ''
            }
          }],
          // Delimiters
          [/[{}()\[\]]/, '@brackets'],
          [/[;,.]/, 'delimiter'],
        ],
        comment: [
          [/[^\/*]+/, 'comment'],
          [/\*\//, 'comment', '@pop'],
          [/[\/*]/, 'comment'],
        ]
      }
    });

    // Auto-complete
    monaco.languages.registerCompletionItemProvider('silverscript', {
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn
        };
        const suggestions = [
          ...['pragma silverscript ^0.1.0;', 'contract', 'entry', 'function', 'require', 'if', 'else', 'for', 'return', 'constant', 'new', 'true', 'false'].map(k => ({
            label: k, kind: monaco.languages.CompletionItemKind.Keyword, insertText: k, range
          })),
          ...['int', 'bool', 'string', 'pubkey', 'sig', 'datasig', 'temporal', 'byte', 'byte[]', 'byte[32]', 'byte[65]'].map(t => ({
            label: t, kind: monaco.languages.CompletionItemKind.TypeParameter, insertText: t, range
          })),
          ...['checkSig', 'checkMsgSig', 'blake2b', 'sha256', 'date'].map(f => ({
            label: f, kind: monaco.languages.CompletionItemKind.Function, insertText: f, range
          })),
          { label: 'tx.outputs', kind: monaco.languages.CompletionItemKind.Property, insertText: 'tx.outputs', range },
          { label: 'tx.inputs', kind: monaco.languages.CompletionItemKind.Property, insertText: 'tx.inputs', range },
          { label: 'tx.time', kind: monaco.languages.CompletionItemKind.Property, insertText: 'tx.time', range },
          { label: 'tx.daa', kind: monaco.languages.CompletionItemKind.Property, insertText: 'tx.daa', range },
          { label: 'this.ageDaa', kind: monaco.languages.CompletionItemKind.Property, insertText: 'this.ageDaa', range },
          { label: 'this.activeInputIndex', kind: monaco.languages.CompletionItemKind.Property, insertText: 'this.activeInputIndex', range },
          { label: 'ScriptPubKeyP2PK', kind: monaco.languages.CompletionItemKind.Constructor, insertText: 'ScriptPubKeyP2PK', range },
          { label: 'ScriptPubKeyP2SH', kind: monaco.languages.CompletionItemKind.Constructor, insertText: 'ScriptPubKeyP2SH', range },
          // Snippet: contract skeleton
          {
            label: 'contract-skeleton',
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: 'pragma silverscript ^0.1.0;\n\ncontract ${1:MyContract}(${2}) {\n    entry ${3:spend}(${4:sig s, pubkey pk}) {\n        ${5:require(checkSig(s, pk));}\n    }\n}',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: 'Full contract boilerplate',
            range
          },
          {
            label: 'require-checkSig',
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: 'require(checkSig(${1:s}, ${2:pk}));',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range
          },
          {
            label: 'output-covenant',
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: 'byte[] ${1:recipientSpk} = byte[](new ScriptPubKeyP2PK(${2:recipientPk}));\nrequire(tx.outputs[${3:0}].scriptPubKey == ${1:recipientSpk});',
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range
          }
        ];
        return { suggestions };
      }
    });
  }

  function getMonacoTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'vs' : 'vs-dark';
  }

  function welcomeSource() {
    return `// ═══════════════════════════════════════════════════
// Welcome to SilverScript Studio
// ═══════════════════════════════════════════════════
//
// A covenant is a Kaspa address with rules attached.
// Anyone can send KAS to it. Taking KAS out only works
// if the rules say so. This file is the simplest one:
// one key, one way out.

pragma silverscript ^0.1.0;

// The name is yours. The parameter list is what you
// fill in at deploy time; here it is one public key.
contract HelloKaspa(pubkey owner) {

    // Each "entry" is a spend path: one way to unlock
    // the coins. The arguments are what the spender
    // must provide, here a signature.
    entry spend(sig ownerSig) {

        // The rule. If it fails, the spend is rejected
        // by the network, not by the Studio.
        require(checkSig(ownerSig, owner));
    }
}

// Things to try:
//   Ctrl+B compiles this file.
//   Add a second entry with a different key to give
//   someone else a way out.
//   Deploy from the toolbar to put it on mainnet
//   (costs whatever you deposit, from 1 KAS).
// ═══════════════════════════════════════════════════`;
  }

  // ─── Workspace: open files persist per wallet ──────
  // Saved in localStorage under the connected address (or "anon" before
  // connecting): filenames, contents, wizard hints, which tab is active.
  // Restored on load and on connect; each wallet sees its own set; closing
  // a tab is remembered; a first visit gets welcome.sil. Per browser, not per account.
  let restoringWorkspace = false, wsSaveTimer = null;
  function workspaceKey(addr) { return 'ss_ws:' + (addr || (currentUser && currentUser.address) || 'anon'); }
  function saveWorkspaceNow(key) {
    if (restoringWorkspace) return;
    clearTimeout(wsSaveTimer);
    try {
      const payload = {
        files: files.map(f => ({ filename: f.filename, content: f.model ? f.model.getValue() : f.content, paramHints: f.paramHints || null })),
        active: Math.max(0, files.findIndex(f => f.id === activeFileId)),
        savedAt: Date.now()
      };
      localStorage.setItem(key || workspaceKey(), JSON.stringify(payload));
    } catch (_) { /* quota or private mode: the session still works, it just doesn't persist */ }
  }
  function saveWorkspace() { clearTimeout(wsSaveTimer); wsSaveTimer = setTimeout(() => saveWorkspaceNow(), 300); }
  function loadWorkspace(noWelcome) {
    clearTimeout(wsSaveTimer);
    restoringWorkspace = true;
    try {
      for (const f of files) { try { f.model.dispose(); } catch (_) {} }
      files = []; activeFileId = null;
      if (editor) editor.setModel(null);
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(workspaceKey()) || 'null'); } catch (_) { saved = null; }
      if (!saved || !Array.isArray(saved.files)) {
        if (!noWelcome) addFile('welcome.sil', welcomeSource());
      } else {
        for (const f of saved.files) addFile(f.filename || 'untitled.sil', f.content || '', false, f.paramHints || null);
        const idx = Math.min(Math.max(0, Number(saved.active) || 0), files.length - 1);
        if (files.length) switchToFile(files[idx].id);
      }
      renderFileList(); renderTabs();
    } finally { restoringWorkspace = false; }
  }
  function closeAllFiles() {
    if (!files.length) return;
    for (const f of files) { try { f.model.dispose(); } catch (_) {} }
    files = []; activeFileId = null;
    if (editor) editor.setModel(null);
    renderFileList(); renderTabs();
    saveWorkspaceNow();
    logToConsole('All tabs closed');
  }

  // ─── File Management ───────────────────────────────
  function addFile(filename, content = '', switchTo = true, paramHints = null) {
    const id = fileIdCounter++;
    const model = monaco.editor.createModel(content, 'silverscript');
    model.onDidChangeContent(() => {
      const f = files.find(f => f.id === id);
      if (f) {
        f.content = model.getValue();
        f.dirty = true;
        f.compiled_output = null;
        renderFileList();
        renderTabs();
        saveWorkspace();
      }
    });

    const file = { id, filename, content, dirty: false, compiled_output: null, model, paramHints };
    files.push(file);
    if (switchTo) switchToFile(id);
    renderFileList();
    renderTabs();
    saveWorkspace();
    return file;
  }

  function switchToFile(id) {
    activeFileId = id;
    const f = files.find(f => f.id === id);
    if (f && editor) {
      editor.setModel(f.model);
    }
    hideStart();   // anything that brings a file to the editor wins over the start panel
    renderFileList();
    renderTabs();
    saveWorkspace();
  }

  function closeFile(id) {
    const idx = files.findIndex(f => f.id === id);
    if (idx === -1) return;
    const f = files[idx];
    f.model.dispose();
    files.splice(idx, 1);

    if (activeFileId === id) {
      if (files.length > 0) {
        const nextIdx = Math.min(idx, files.length - 1);
        switchToFile(files[nextIdx].id);
      } else {
        activeFileId = null;
        editor.setModel(null);
      }
    }
    renderFileList();
    renderTabs();
    saveWorkspace();
  }

  function renameFile(id) {
    const f = files.find(f => f.id === id);
    if (!f) return;
    const name = prompt('Rename file:', f.filename);
    if (name && name.trim()) {
      f.filename = name.trim().endsWith('.sil') ? name.trim() : name.trim() + '.sil';
      renderFileList();
      renderTabs();
      saveWorkspace();
    }
  }

  function duplicateFile(id) {
    const f = files.find(f => f.id === id);
    if (!f) return;
    const newName = f.filename.replace('.sil', '_copy.sil');
    addFile(newName, f.content);
  }

  function deleteFile(id) {
    const f = files.find(f => f.id === id);
    if (!f) return;
    if (confirm(`Delete "${f.filename}"?`)) closeFile(id);
  }

  // ─── Rendering ─────────────────────────────────────
  function renderFileList() {
    const el = document.getElementById('fileList');
    if (files.length === 0) {
      el.innerHTML = '<div style="padding:8px;color:var(--text-muted);font-size:11.5px;">No files yet</div>';
      return;
    }
    el.innerHTML = files.map(f => {
      const dotClass = f.compiled_output?.success ? 'compiled' : f.compiled_output?.success === false ? 'error' : f.dirty ? 'dirty' : '';
      const active = f.id === activeFileId ? 'active' : '';
      return `<div class="file-item ${active}" onclick="App.switchToFile(${f.id})" oncontextmenu="App.showFileContextMenu(event, ${f.id})">
        <span class="dot ${dotClass}"></span>
        <span class="name">${esc(f.filename)}</span>
      </div>`;
    }).join('');
  }

  function renderTabs() {
    const el = document.getElementById('tabBar');
    el.innerHTML = files.map(f => {
      const active = f.id === activeFileId ? 'active' : '';
      const dirty = f.dirty ? '<span class="dirty-dot">&bull;</span>' : '';
      return `<div class="tab ${active}" onclick="App.switchToFile(${f.id})">
        <span>${esc(f.filename)}</span>${dirty}
        <button class="close-tab" onclick="event.stopPropagation();App.closeFile(${f.id})">&times;</button>
      </div>`;
    }).join('');
  }

  function renderSnippets() {
    const el = document.getElementById('snippetList');
    const categories = Object.keys(snippetsByCategory).sort((a, b) => {
      const order = ['Start Here', 'Who Can Spend', 'When Can It Be Spent', 'Where Does It Go', 'Complete Contracts', 'My Snippets'];
      return (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b));
    });

    el.innerHTML = categories.map(cat => {
      const isOpen = snippetCategoryState[cat] !== undefined ? snippetCategoryState[cat] : cat === 'Start Here';
      return `<div class="snippet-category">
        <div class="snippet-category-label" onclick="App.toggleSnippetCategory('${esc(cat)}')">
          <span class="arrow ${isOpen ? 'open' : ''}">&#9656;</span>
          ${esc(cat)}
        </div>
        <div style="${isOpen ? '' : 'display:none'}">
          ${snippetsByCategory[cat].map(s =>
            `<div class="snippet-item" onclick="App.previewSnippet(${s.id})" title="${esc(s.description || '')}">${esc(s.name)}</div>`
          ).join('')}
        </div>
      </div>`;
    }).join('');
  }

  function toggleSnippetCategory(cat) {
    const current = snippetCategoryState[cat] !== undefined ? snippetCategoryState[cat] : cat === 'Start Here';
    snippetCategoryState[cat] = !current;
    renderSnippets();
  }

  let sectionState = { snippets: true, wizard: true };

  function toggleSection(section) {
    sectionState[section] = !sectionState[section];
    const el = section === 'snippets'
      ? document.getElementById('snippetList')
      : document.getElementById('wizardContent');
    const header = el?.previousElementSibling;
    if (el) el.classList.toggle('collapsed', !sectionState[section]);
    if (header) header.classList.toggle('collapsed', !sectionState[section]);
  }

  // ─── Snippets ──────────────────────────────────────
  async function loadSnippets() {
    try {
      const res = await fetch('/api/templates');
      const data = await res.json();
      snippets = data.templates || [];
      snippetsByCategory = data.grouped || {};
    } catch (e) {
      logToConsole('Failed to load snippets: ' + e.message);
    }
  }

  function previewSnippet(id) {
    const s = snippets.find(s => s.id === id);
    if (!s) return;

    const isFullContract = s.content.includes('pragma silverscript') && s.content.includes('contract ');

    showModal('snippetPreviewModal');
    document.getElementById('snippetPreviewName').textContent = s.name;
    document.getElementById('snippetPreviewDesc').textContent = s.description || '';
    document.getElementById('snippetPreviewCode').textContent = s.content;

    const actionsEl = document.getElementById('snippetPreviewActions');
    if (isFullContract) {
      actionsEl.innerHTML = `
        <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="App.openSnippetAsFile(${s.id})">Open as New File</button>
      `;
    } else {
      actionsEl.innerHTML = `
        <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
        <button class="btn btn-secondary" onclick="App.openSnippetAsFile(${s.id})">Open as New File</button>
        <button class="btn btn-primary" onclick="App.insertSnippetAtCursor(${s.id})">Insert at Cursor</button>
      `;
    }
  }

  function openSnippetAsFile(id) {
    const s = snippets.find(s => s.id === id);
    if (!s) return;
    const contractMatch = s.content.match(/contract\s+(\w+)/);
    const name = contractMatch ? contractMatch[1].toLowerCase() + '.sil' : 'snippet.sil';
    addFile(name, s.content);
    closeModal();
    logToConsole(`Opened snippet "${s.name}" as new file`);
  }

  function insertSnippetAtCursor(id) {
    const s = snippets.find(s => s.id === id);
    if (!s || !editor) return;
    hideStart();

    const model = editor.getModel();
    const source = model.getValue();
    const insertResult = findSmartInsertPosition(source, editor.getPosition().lineNumber);

    if (!insertResult) {
      logToConsole('Could not find a spend path (entry) to insert into');
      closeModal();
      return;
    }

    const { line: funcCloseLine, indent: funcIndent, funcStartLine } = insertResult;

    // Split snippet lines into declarations (contract-level) and statements (function-level)
    const snippetLines = s.content.split('\n');
    const declTypes = /^\s*(int|temporal|bool|string|pubkey|sig|datasig|byte|bytes)\b/;
    const constDecl = /^\s*(int|temporal|bool|string|pubkey|sig|datasig|byte\S*|bytes)\s+(constant\s+)?\w+\s*=/;

    // A declaration belongs at contract scope if it's a constant or a compile-time value (date literal).
    // Runtime values that reference tx.* or this.* stay inside the function.
    const isContractLevelDecl = (line) => {
      const t = line.trim();
      if (!constDecl.test(t)) return false;
      if (t.includes('constant ')) return true;           // explicit constant
      if (t.includes('tx.') || t.includes('this.')) return false; // runtime introspection
      // Simple literal assignments (int minerFee = 1000) - could go either way.
      // Keep them in function body to be safe.
      if (/=\s*\d+\s*;/.test(t)) return false;
      return false;
    };
    const declarations = [];
    const statements = [];

    for (const rawLine of snippetLines) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('//')) {
        // Comments follow whatever comes next, or go with statements
        statements.push(rawLine);
      } else if (isContractLevelDecl(rawLine)) {
        declarations.push(rawLine);
      } else {
        statements.push(rawLine);
      }
    }

    // Contract body indent = one level less than function body (typically 4 spaces)
    const contractIndent = funcIndent.length > 4
      ? funcIndent.slice(0, funcIndent.length - 4)
      : funcIndent.slice(0, Math.max(0, funcIndent.length - 2));
    // If contractIndent is empty, use 4 spaces as default
    const cIndent = contractIndent || '    ';

    // Monaco applies all edits simultaneously, so we need to be careful about ordering.
    // Insert statements first (they're at a higher line number), then declarations above.
    // This way line numbers don't interfere.
    const edits = [];

    // Statements go inside the function body (before its closing brace)
    const meaningfulStatements = statements.filter(l => l.trim().length > 0);
    if (meaningfulStatements.length > 0) {
      const stmtText = meaningfulStatements.map(l => funcIndent + l.trim()).join('\n') + '\n';
      edits.push({
        range: new monaco.Range(funcCloseLine, 1, funcCloseLine, 1),
        text: stmtText,
        forceMoveMarkers: true
      });
    }

    // Declarations go at contract scope (before the first entry)
    if (declarations.length > 0 && funcStartLine) {
      const declText = declarations.map(l => cIndent + l.trim()).join('\n') + '\n';
      edits.push({
        range: new monaco.Range(funcStartLine, 1, funcStartLine, 1),
        text: declText,
        forceMoveMarkers: true
      });
    }

    if (edits.length === 0) {
      // Nothing to insert (shouldn't happen, but safety)
      closeModal();
      return;
    }

    editor.executeEdits('smart-snippet', edits);

    // Move cursor to the statement insertion point
    const totalAdded = declarations.length + meaningfulStatements.length;
    const finalLine = funcCloseLine + totalAdded - 1;
    editor.setPosition({ lineNumber: finalLine, column: 1 });
    editor.revealLineInCenter(finalLine);
    editor.focus();
    closeModal();
    logToConsole(`Inserted snippet: ${s.name}`);
  }

  /**
   * Parse the source to find the best insertion point for a code fragment.
   * Strategy:
   *   1. Find all entrypoint function bodies by tracking brace depth
   *   2. If cursor is inside a function body, insert before that function's closing }
   *   3. Otherwise, insert before the last entrypoint function's closing }
   * Returns { line, indent } where line is the 1-indexed line number to insert BEFORE,
   * and indent is the whitespace string matching the function body's indentation.
   */
  function findSmartInsertPosition(source, cursorLine) {
    const lines = source.split('\n');
    const functions = []; // { startLine, endLine, bodyIndent }

    let braceDepth = 0;
    let inFunction = false;
    let funcStart = -1;
    let funcBraceDepth = -1;
    let bodyIndent = '        '; // default 8 spaces

    // Pass 1: find all entrypoint function blocks
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').trimStart();

      // Count braces on this line (outside strings - simple heuristic)
      const cleanLine = line.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
      const opens = (cleanLine.match(/\{/g) || []).length;
      const closes = (cleanLine.match(/\}/g) || []).length;

      // Detect entrypoint function start
      if (!inFunction && /(?:^|\s)(?:entry|entrypoint\s+function)\s+\w+\s*\(/.test(trimmed)) {
        inFunction = true;
        funcStart = i;
        // The function brace depth is the depth AFTER this line's opening brace
        funcBraceDepth = braceDepth + opens;
      }

      braceDepth += opens - closes;

      // Detect function body statements to learn indentation
      if (inFunction && braceDepth === funcBraceDepth && opens === 0 && closes === 0 && trimmed.length > 0) {
        const leadingWhitespace = line.match(/^(\s*)/)[1];
        if (leadingWhitespace.length > 0) {
          bodyIndent = leadingWhitespace;
        }
      }

      // Detect function close: depth returned to pre-function level
      if (inFunction && braceDepth < funcBraceDepth) {
        functions.push({
          startLine: funcStart + 1, // 1-indexed
          endLine: i + 1,           // 1-indexed, this is the line with closing }
          bodyIndent
        });
        inFunction = false;
        funcBraceDepth = -1;
        bodyIndent = '        ';
      }
    }

    if (functions.length === 0) return null;

    // Pass 2: find which function the cursor is in
    let targetFunc = null;
    for (const fn of functions) {
      if (cursorLine >= fn.startLine && cursorLine <= fn.endLine) {
        targetFunc = fn;
        break;
      }
    }

    // If cursor isn't in any function, use the last entrypoint function
    if (!targetFunc) {
      targetFunc = functions[functions.length - 1];
    }

    // Insert before the closing brace of the target function
    return {
      line: targetFunc.endLine,
      indent: targetFunc.bodyIndent,
      funcStartLine: targetFunc.startLine
    };
  }

  // Keep insertSnippet for the snippet picker modal (same preview flow)
  function insertSnippet(id) {
    previewSnippet(id);
  }

  function newFromSnippet() {
    showModal('snippetModal');
    const body = document.getElementById('snippetModalBody');
    const categories = Object.keys(snippetsByCategory).sort();
    body.innerHTML = categories.map(cat => `
      <div class="snippet-modal-category">
        <div class="snippet-modal-category-title">${esc(cat)}</div>
        ${snippetsByCategory[cat].map(s => `
          <div class="snippet-modal-item" onclick="App.closeModal(); setTimeout(() => App.previewSnippet(${s.id}), 100);">
            <span class="smi-name">${esc(s.name)}</span>
            <span class="smi-desc">${esc(s.description || '')}</span>
          </div>
        `).join('')}
      </div>
    `).join('');
  }

  // ─── Compile ───────────────────────────────────────
  async function compile() {
    const f = files.find(f => f.id === activeFileId);
    if (!f) return logToConsole('No file open to compile');

    logToConsole(`Compiling ${f.filename}...`);

    try {
      const res = await fetch('/api/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: f.content })
      });
      const data = await res.json();
      f.compiled_output = data;
      f.dirty = false;
      renderFileList();
      renderTabs();
      renderCompilerOutput(data);
      renderHexInspector(data);

      if (data.success) {
        logToConsole(`Compiled ${f.filename}: ${data.contractName} (${data.scriptSize} bytes)`);
      } else {
        logToConsole(`Compilation failed: ${data.errors.length} error(s)`);
      }
    } catch (e) {
      logToConsole('Compile error: ' + e.message);
    }
  }

  function renderCompilerOutput(data) {
    const el = document.getElementById('panelCompiler');
    if (data.success) {
      el.innerHTML = `
        <div class="compile-section">
          <span class="compile-success">&#10003; Compiled successfully</span>
        </div>
        <div class="compile-section">
          <span class="compile-label">Contract:</span>
          <span class="compile-value">${esc(data.contractName)}</span>
          &nbsp;&nbsp;
          <span class="compile-label">Size:</span>
          <span class="compile-value">${data.scriptSize} bytes</span>
        </div>
        ${data.abi.contractParams.length > 0 ? `
        <div class="compile-section">
          <div class="compile-section-title">Constructor Parameters</div>
          ${data.abi.contractParams.map(p => `<div class="abi-function"><span class="fn-params">${esc(p.type)}</span> <span class="fn-name">${esc(p.name)}</span></div>`).join('')}
        </div>` : ''}
        <div class="compile-section">
          <div class="compile-section-title">Entrypoint Functions (ABI)</div>
          ${data.abi.functions.map(fn => `
            <div class="abi-function">
              <span class="fn-name">${esc(fn.name)}</span><span class="fn-params">(${fn.params.map(p => p.type + ' ' + p.name).join(', ')})</span>
            </div>
          `).join('')}
        </div>
        <div class="compile-section">
          <div class="compile-section-title">Script Hash</div>
          <div style="color:var(--text-secondary);word-break:break-all;font-size:11px;">${esc(data.scriptHash)}</div>
        </div>
        ${data.warnings.length > 0 ? `
        <div class="compile-section">
          <div class="compile-section-title">Warnings</div>
          ${data.warnings.map(w => `<div class="compile-warning">Line ${w.line}: ${esc(w.message)}</div>`).join('')}
        </div>` : ''}
      `;
    } else {
      el.innerHTML = `
        <div class="compile-section">
          <span class="compile-error">&#10007; Compilation failed</span>
        </div>
        <div class="compile-section">
          ${data.errors.map(e => `
            <div class="error-item compile-error" onclick="App.goToLine(${e.line})">
              <span class="error-line">Line ${e.line}${e.column ? ':' + e.column : ''}:</span> ${esc(e.message)}
            </div>
          `).join('')}
        </div>
        ${data.warnings && data.warnings.length > 0 ? `
        <div class="compile-section">
          <div class="compile-section-title">Warnings</div>
          ${data.warnings.map(w => `<div class="compile-warning">Line ${w.line}: ${esc(w.message)}</div>`).join('')}
        </div>` : ''}
      `;
    }
    switchPanelTab('compiler');
  }

  function renderHexInspector(data) {
    const el = document.getElementById('panelHex');
    if (data.success && data.script) {
      const hex = data.script.startsWith('0x') ? data.script.slice(2) : data.script;
      // Format in groups of 2 (bytes), 16 per line
      let formatted = '';
      for (let i = 0; i < hex.length; i += 2) {
        if (i > 0 && (i / 2) % 16 === 0) formatted += '\n';
        else if (i > 0) formatted += ' ';
        formatted += hex.slice(i, i + 2);
      }
      el.innerHTML = `<div class="hex-display"><pre>${formatted}</pre></div>
        <div style="margin-top:8px;color:var(--text-muted);font-size:11px;">${data.scriptSize} bytes total</div>`;
    } else {
      el.innerHTML = '<div class="panel-placeholder">No compiled output</div>';
    }
  }

  function clearOutput() {
    document.getElementById('panelCompiler').innerHTML = '<div class="panel-placeholder">Compile a file to see output (Ctrl+B)</div>';
    document.getElementById('panelHex').innerHTML = '<div class="panel-placeholder">Compile a file to inspect hex output</div>';
  }

  function goToLine(line) {
    if (editor) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: 1 });
      editor.focus();
    }
  }

  // ─── Console ───────────────────────────────────────
  function logToConsole(msg) {
    const time = new Date().toLocaleTimeString();
    consoleMessages.push({ time, msg });
    const el = document.getElementById('consoleLog');
    el.innerHTML += `<div class="console-entry"><span class="console-time">${time}</span>${esc(msg)}</div>`;
    el.scrollTop = el.scrollHeight;
  }

  // ─── Deploy ────────────────────────────────────────
  let deployState = null; // holds current deploy data between steps

async function showDeploy() {
  if (!currentUser) {
    logToConsole('Connect a wallet to deploy contracts');
    return;
  }
  const f = files.find(f => f.id === activeFileId);

  if (!f) {
    document.getElementById('deployTitle').textContent = 'Deploy Contract';
    document.getElementById('deployModalBody').innerHTML = `
      <div class="deploy-section">
        <div class="deploy-info" style="color:var(--text-secondary)">
          Open a <code>.sil</code> file in the editor and compile it first (Ctrl+B),
          then come back here to deploy.
        </div>
      </div>`;
    document.getElementById('deployModalFooter').innerHTML = `
      <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>`;
    showModal('deployModal');
    return;
  }

  // Auto-compile if needed
  if (!f.compiled_output || !f.compiled_output.success) {
    logToConsole(`Auto-compiling ${f.filename} before deploy...`);
    await compile();
    const compiled = files.find(x => x.id === activeFileId);
    if (!compiled || !compiled.compiled_output || !compiled.compiled_output.success) {
      logToConsole('Fix compilation errors before deploying');
      return;
    }
  }

  const fc = files.find(x => x.id === activeFileId);
  deployState = {
    source: fc.content,
    contractName: fc.compiled_output.contractName,
    params: fc.compiled_output.abi.contractParams || [],
    functions: fc.compiled_output.abi.functions || [],
    amountTkas: null,
    funderRole: null,        // null = me, now; else a pubkey param name (they deposit through the link)
    _funderTouched: false
  };

  // Load wallet book
  await loadWalletBook();

  // Get connected wallet address for autofill
  let connectedAddr = '';
  if (connectedWallet === 'kasware' && typeof window.kasware !== 'undefined') {
    try {
      const accounts = await window.kasware.getAccounts();
      if (accounts && accounts.length > 0) connectedAddr = accounts[0];
    } catch (e) { /* silent */ }
  } else if (connectedWallet === 'kastle' && typeof window.kastle !== 'undefined') {
    try {
      const info = await window.kastle.getAccount();
      if (info && info.address) connectedAddr = info.address;
    } catch (e) { /* silent */ }
  } else if (connectedWallet === 'kaspire' && hasKaspire()) {
    try {
      const accounts = await kaspireRequest('getAccounts');
      if (accounts && accounts.length > 0) connectedAddr = accounts[0];
    } catch (e) { /* silent */ }
  } else if (currentUser?.address) {
    connectedAddr = currentUser.address;
  }

  // Check for wizard-provided constructor param hints
  const hints = fc.paramHints || {};


  // Separate params into groups
  const pubkeyParams = deployState.params.filter(p => p.type === 'pubkey');
  const intParams = deployState.params.filter(p => p.type === 'int');
  const otherParams = deployState.params.filter(p => p.type !== 'pubkey' && p.type !== 'int');

  const body = document.getElementById('deployModalBody');
  let html = '';

  // ── Contract header ────────────────────────────────────────────
  html += `
    <div class="deploy-section" style="border-bottom:none; padding-bottom:0; margin-bottom:12px;">
      <div class="deploy-contract-name">${esc(deployState.contractName)}</div>
      <div class="deploy-info">
        ${deployState.functions.length} spend path${deployState.functions.length !== 1 ? 's' : ''}
        · ${deployState.params.length} parameter${deployState.params.length !== 1 ? 's' : ''}
      </div>
      <div class="deploy-hint">The name above is visible to anyone holding the covenant link.</div>
    </div>`;

  // ── Parties section (pubkey params) ────────────────────────────
  if (pubkeyParams.length > 0) {
    html += `
      <div class="deploy-section">
        <div class="deploy-section-label">
          Parties <span class="deploy-section-count">${pubkeyParams.length}</span>
        </div>
        <div class="deploy-section-card">`;

    const stripPrefix = (a) => a ? a.replace(/^kaspa(test)?:/, '') : '';

    for (const p of pubkeyParams) {
      const hintAddr = hints[p.name] || '';
      const hintWallet = hintAddr
        ? walletBook.find(w => stripPrefix(w.address) === stripPrefix(hintAddr))
        : null;

      if (hintAddr) {
        // ── State 1 or 2: Wizard provided a value ──────────────
        if (hintWallet) {
          // State 1: Matched a wallet book entry → show wallet chip
          html += `
            <div class="deploy-field">
              <label class="deploy-label">
                ${esc(p.name)} <span class="deploy-type-badge type-pubkey">pubkey</span>
              </label>
              <div class="deploy-hint-chip" id="chip-${esc(p.name)}">
                <div class="dhc-avatar" style="background:${esc(hintWallet.color || '#666')}">${esc((hintWallet.label || '?')[0].toUpperCase())}</div>
                <span class="dhc-name">${esc(hintWallet.label)}${hintWallet.is_self ? ' (me)' : ''}</span>
                                <span class="dhc-key" title="${esc(hintWallet.address)}">${esc(hintAddr)}</span>
                <button class="dhc-clear" onclick="App.clearParamHint('${esc(p.name)}')" title="Change">✕</button>
              </div>
              <div class="deploy-param-selector" id="selector-${esc(p.name)}" style="display:none;">
                ${renderWalletDropdown(p.name, hintWallet)}
                <div class="deploy-paste-fallback" id="paste-${esc(p.name)}">
                  <input type="text" class="deploy-input deploy-input-wide"
                    id="deploy-param-${esc(p.name)}-paste"
                    placeholder="kaspa:… or kaspatest:… or hex pubkey"
                    oninput="document.getElementById('deploy-param-${esc(p.name)}').value = this.value"
                    data-param-name="${esc(p.name)}" data-param-type="pubkey">
                  <div class="deploy-hint">Paste a Kaspa address or 32-byte hex pubkey</div>
                </div>
              </div>
              <input type="hidden" id="deploy-param-${esc(p.name)}"
                value="${esc(hintWallet.address)}"
                data-param-name="${esc(p.name)}" data-param-type="pubkey">
            </div>`;
        } else {
          // State 2: Raw address not in wallet book → show address chip
          html += `
            <div class="deploy-field">
              <label class="deploy-label">
                ${esc(p.name)} <span class="deploy-type-badge type-pubkey">pubkey</span>
              </label>
              <div class="deploy-hint-chip" id="chip-${esc(p.name)}">
                <div class="dhc-avatar" style="background:var(--text-muted)">?</div>
                <span class="dhc-key">${esc(hintAddr)}</span>
                <button class="dhc-clear" onclick="App.clearParamHint('${esc(p.name)}')" title="Change">✕</button>
              </div>
              <div class="deploy-param-selector" id="selector-${esc(p.name)}" style="display:none;">
                ${renderWalletDropdown(p.name, null)}
                <div class="deploy-paste-fallback" id="paste-${esc(p.name)}">
                  <input type="text" class="deploy-input deploy-input-wide"
                    id="deploy-param-${esc(p.name)}-paste"
                    placeholder="kaspa:… or kaspatest:… or hex pubkey"
                    oninput="document.getElementById('deploy-param-${esc(p.name)}').value = this.value"
                    data-param-name="${esc(p.name)}" data-param-type="pubkey">
                  <div class="deploy-hint">Paste a Kaspa address or 32-byte hex pubkey</div>
                </div>
              </div>
              <input type="hidden" id="deploy-param-${esc(p.name)}"
                value="${esc(hintAddr)}"
                data-param-name="${esc(p.name)}" data-param-type="pubkey">
            </div>`;
        }
      } else {
        // ── State 3: No hint → standard wallet dropdown ────────
        const selfWallet = walletBook.find(w => w.is_self);
        const defaultWallet = selfWallet || walletBook[0] || null;

        html += `
          <div class="deploy-field">
            <label class="deploy-label">
              ${esc(p.name)} <span class="deploy-type-badge type-pubkey">pubkey</span>
            </label>
            ${renderWalletDropdown(p.name, defaultWallet)}
            <div class="deploy-paste-fallback" id="paste-${esc(p.name)}">
              <input type="text" class="deploy-input deploy-input-wide"
                id="deploy-param-${esc(p.name)}-paste"
                placeholder="kaspa:… or kaspatest:… or hex pubkey"
                oninput="document.getElementById('deploy-param-${esc(p.name)}').value = this.value"
                data-param-name="${esc(p.name)}" data-param-type="pubkey">
              <div class="deploy-hint">Paste a Kaspa address or 32-byte hex pubkey</div>
            </div>
            <input type="hidden" id="deploy-param-${esc(p.name)}"
              value="${defaultWallet ? esc(defaultWallet.address) : esc(connectedAddr)}"
              data-param-name="${esc(p.name)}" data-param-type="pubkey">
          </div>`;
      }
    }

    if (connectedAddr && walletBook.length === 0) {
      html += `<div class="deploy-hint" style="color:var(--accent)">
        ✓ Using your connected wallet. Add more wallets via "Manage wallets" to assign different parties.
      </div>`;
    }

    html += `</div></div>`;
  }

  // ── Amounts section (int params) ───────────────────────────────
  if (intParams.length > 0) {
    html += `
      <div class="deploy-section">
        <div class="deploy-section-label">
          Amounts <span class="deploy-section-count">${intParams.length}</span>
        </div>
        <div class="deploy-section-card">`;

  for (const p of intParams) {
      html += renderDeployField(p, hints[p.name] || '');
    }

    html += `</div></div>`;
  }

  // ── Other params (bool, byte[], string, etc) ───────────────────
  if (otherParams.length > 0) {
    html += `
      <div class="deploy-section">
        <div class="deploy-section-label">
          Other Parameters <span class="deploy-section-count">${otherParams.length}</span>
        </div>
        <div class="deploy-section-card">`;

    for (const p of otherParams) {
      html += renderDeployField(p, hints[p.name] || '');
    }

    html += `</div></div>`;
  }

  // ── Deposit section: who puts the money in, and how much ────────
  html += renderDepositSection(pubkeyParams);

  // ── Entrypoints (read-only info) ───────────────────────────────
  if (deployState.functions.length > 0) {
    html += `
      <div class="deploy-section" style="border-bottom:none;">
        <div class="deploy-section-label">Entrypoint Functions</div>
        <div class="deploy-section-card">
          ${deployState.functions.map(fn => `
            <div class="deploy-abi-fn">
              <span class="fn-name">${esc(fn.name)}</span>
              <span class="fn-params">(${(fn.inputs || fn.params || []).map(p => p.type + ' ' + p.name).join(', ')})</span>
            </div>
          `).join('')}
        </div>
      </div>`;
  }

  body.innerHTML = html;
  body.scrollTop = 0;
  bindFunderDefault(body);

  document.getElementById('deployModalFooter').innerHTML = `
    <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
    <button class="btn btn-primary" id="deployBtn" onclick="App.deployContract()">
      Deploy →
    </button>`;

  document.getElementById('deployTitle').textContent = `Deploy: ${deployState.contractName}`;
  showModal('deployModal');
  updateDeployHints();

  // Close dropdowns on outside click
  document.addEventListener('click', handleDropdownOutsideClick);
}

function handleDropdownOutsideClick(e) {
  if (!e.target.closest('.wallet-dropdown-wrap')) {
    document.querySelectorAll('.wallet-dropdown-panel').forEach(p => p.classList.remove('show'));
    document.querySelectorAll('.wallet-dropdown-trigger').forEach(t => t.classList.remove('open'));
  }
}


function clearParamHint(paramName) {
  // Hide the chip
  const chip = document.getElementById('chip-' + paramName);
  if (chip) chip.style.display = 'none';

  // Show the wallet selector
  const selector = document.getElementById('selector-' + paramName);
  if (selector) selector.style.display = '';

  // Clear the hidden input so user must pick
  const hidden = document.getElementById('deploy-param-' + paramName);
  if (hidden) hidden.value = '';

  // Default to self-wallet if available
  const selfWallet = walletBook.find(w => w.is_self);
  const fallback = selfWallet || walletBook[0] || null;
  if (fallback) {
    selectWalletForParam(paramName, fallback.id);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Wallet dropdown renderer
// ═══════════════════════════════════════════════════════════════════
// handlers (optional): { select, paste, manage } — JS strings for the item / paste / manage
// clicks, so the wizard can reuse this exact dropdown with its own callbacks.
function renderWalletDropdown(paramName, selectedWallet, handlers) {
  const h = handlers || {};
  const onSelect = h.select || 'App.selectWalletForParam';
  const onPaste  = h.paste  || `App.togglePasteForParam('${esc(paramName)}')`;
  const onManage = h.manage || 'App.openWalletDrawer()';
  if (walletBook.length === 0) {
    // No wallets saved — show plain text input with a prompt to add
    return `
      <div class="wallet-dropdown-wrap">
        <div class="wallet-dropdown-trigger" onclick="${onManage}" style="cursor:pointer;">
          <span class="wdt-placeholder">No wallets saved — click to add</span>
          <span class="wdt-chevron">→</span>
        </div>
      </div>`;
  }

  const triggerContent = selectedWallet
    ? `<div class="wdt-avatar" style="background:${esc(selectedWallet.color || '#666')}">${esc((selectedWallet.label || '?')[0].toUpperCase())}</div>
       <span class="wdt-name">${esc(selectedWallet.label)}</span>
       <span class="wdt-addr">${truncAddr(selectedWallet.address)}</span>`
    : `<span class="wdt-placeholder">Select a wallet…</span>`;

    let items = '';
    const sorted = [...walletBook].sort((a, b) => (b.is_self ? 1 : 0) - (a.is_self ? 1 : 0));
        for (const w of sorted) {
    const isSel = selectedWallet && w.id === selectedWallet.id;
    items += `
      <div class="wdp-item ${isSel ? 'selected' : ''}"
           onclick="${onSelect}('${esc(paramName)}', ${w.id})">
        <div class="wdp-avatar" style="background:${esc(w.color || '#666')}">${esc((w.label || '?')[0].toUpperCase())}</div>
        <span class="wdp-name">${esc(w.label)}${w.is_self ? ' (me)' : ''}</span>
        <span class="wdp-addr">${truncAddr(w.address, true)}</span>
        ${isSel ? '<span class="wdp-check">✓</span>' : ''}
      </div>`;
  }

  return `
    <div class="wallet-dropdown-wrap">
      <div class="wallet-dropdown-trigger" id="trigger-${esc(paramName)}" tabindex="0"
           onclick="App.toggleWalletDropdown('${esc(paramName)}')">
        ${triggerContent}
        <span class="wdt-chevron">▾</span>
      </div>
      <div class="wallet-dropdown-panel" id="dropdown-${esc(paramName)}">
        <div class="wdp-list">${items}</div>
        <div class="wdp-divider"></div>
        <div class="wdp-action" onclick="${onPaste}">
          <span class="wdp-action-icon">↳</span> Paste address directly
        </div>
        <div class="wdp-action wdp-action-secondary" onclick="${onManage}">
          <span class="wdp-action-icon">⚙</span> Manage wallets
        </div>
      </div>
    </div>`;
}

function truncAddr(addr, shortForm) {
  if (!addr) return '';
  // Remove prefix for short form
  if (shortForm) {
    const parts = addr.split(':');
    const base = parts.length > 1 ? parts[1] : addr;
    if (base.length > 12) return base.slice(0, 4) + '…' + base.slice(-4);
    return base;
  }
  // Keep prefix for full form
  if (addr.length > 24) {
    const parts = addr.split(':');
    if (parts.length > 1) {
      const prefix = parts[0] + ':';
      const base = parts[1];
      return prefix + base.slice(0, 4) + '…' + base.slice(-4);
    }
    return addr.slice(0, 10) + '…' + addr.slice(-4);
  }
  return addr;
}


// ═══════════════════════════════════════════════════════════════════
// Dropdown interaction handlers
// ═══════════════════════════════════════════════════════════════════
function toggleWalletDropdown(paramName) {
  const panel = document.getElementById('dropdown-' + paramName);
  const trigger = document.getElementById('trigger-' + paramName);
  if (!panel || !trigger) return;

  const isOpen = panel.classList.contains('show');

  // Close all dropdowns first
  document.querySelectorAll('.wallet-dropdown-panel').forEach(p => p.classList.remove('show'));
  document.querySelectorAll('.wallet-dropdown-trigger').forEach(t => t.classList.remove('open'));

  if (!isOpen) {
    panel.classList.add('show');
    trigger.classList.add('open');
  }
}

function selectWalletForParam(paramName, walletId) {
  const wallet = walletBook.find(w => w.id === walletId);
  if (!wallet) return;

  // Update the hidden input value
  const hidden = document.getElementById('deploy-param-' + paramName);
  if (hidden) hidden.value = wallet.address;
  applyFunderDefault();

  // Update trigger display
  const trigger = document.getElementById('trigger-' + paramName);
  if (trigger) {
    trigger.innerHTML = `
      <div class="wdt-avatar" style="background:${esc(wallet.color || '#666')}">${esc((wallet.label || '?')[0].toUpperCase())}</div>
      <span class="wdt-name">${esc(wallet.label)}${wallet.is_self ? ' (me)' : ''}</span>
      <span class="wdt-addr">${truncAddr(wallet.address)}</span>
      <span class="wdt-chevron">▾</span>`;
  }

  // Update selection state in dropdown
  const panel = document.getElementById('dropdown-' + paramName);
  if (panel) {
    panel.querySelectorAll('.wdp-item').forEach(item => {
      item.classList.remove('selected');
      const check = item.querySelector('.wdp-check');
      if (check) check.remove();
    });
    // Find and select the right item (by onclick attribute match)
    panel.querySelectorAll('.wdp-item').forEach(item => {
      if (item.getAttribute('onclick')?.includes(walletId.toString())) {
        item.classList.add('selected');
        const check = document.createElement('span');
        check.className = 'wdp-check';
        check.textContent = '✓';
        item.appendChild(check);
      }
    });
  }

  // Close dropdown
  document.querySelectorAll('.wallet-dropdown-panel').forEach(p => p.classList.remove('show'));
  document.querySelectorAll('.wallet-dropdown-trigger').forEach(t => t.classList.remove('open'));

  // Hide paste fallback if open
  const paste = document.getElementById('paste-' + paramName);
  if (paste) paste.classList.remove('show');

  updateDeployHints();
}

function togglePasteForParam(paramName) {
  // Close dropdown
  document.querySelectorAll('.wallet-dropdown-panel').forEach(p => p.classList.remove('show'));
  document.querySelectorAll('.wallet-dropdown-trigger').forEach(t => t.classList.remove('open'));

  const paste = document.getElementById('paste-' + paramName);
  if (paste) {
    paste.classList.toggle('show');
    if (paste.classList.contains('show')) {
      const input = paste.querySelector('input');
      if (input) input.focus();
    }
  }
}

// ── Wallet book state ────────────────────────────────────────────
let walletBook = [];        // cached array of { id, label, address, pubkey_hex, color, is_self }
let walletBookLoaded = false;
let walletBookError = null;   // last fetch error, shown in the drawer

// Color palette for wallet avatars
const WALLET_COLORS = [
  '#4a7c59', '#7c4a6d', '#4a6d7c', '#7c6d4a', '#6d4a7c',
  '#5a6d4a', '#4a5a7c', '#7c5a4a', '#4a7c6d', '#6d5a7c'
];

function nextWalletColor() {
  const usedColors = walletBook.map(w => w.color);
  return WALLET_COLORS.find(c => !usedColors.includes(c)) || WALLET_COLORS[walletBook.length % WALLET_COLORS.length];
}

// ── Load wallet book from API ────────────────────────────────────
async function loadWalletBook(forceRefresh) {
  if (walletBookLoaded && !forceRefresh) return walletBook;
  try {
    const res = await fetch('/api/wallets', {
      headers: { 'Authorization': 'Bearer ' + (authToken || '') }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Failed to load wallets (HTTP ${res.status})`);
    }
    const data = await res.json();
    walletBook = data.wallets || [];
    walletBookLoaded = true;
    walletBookError = null;

    // Auto-seed: if no wallets exist and user is connected, create "Me"
    if (walletBook.length === 0 && currentUser?.address) {
      try {
        await addWallet('Me', currentUser.address);
        // addWallet already calls loadWalletBook(true), but we set the flag
        // to avoid infinite loop — it won't re-enter because walletBook.length > 0 now
      } catch (e) {
        console.warn('Auto-seed wallet failed:', e.message);
      }
    }
  } catch (e) {
    console.warn('Wallet book load failed:', e.message);
    walletBookError = e.message;   // keep whatever was loaded before; the drawer shows the error
  }
  return walletBook;
}

// ── Add wallet via API ───────────────────────────────────────────
async function addWallet(label, address) {
  const color = nextWalletColor();
  const res = await fetch('/api/wallets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (authToken || '')
    },
    body: JSON.stringify({ label, address, color })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to add wallet');
  }
  const data = await res.json();
  await loadWalletBook(true);
  return data;
}

// ── Delete wallet via API ────────────────────────────────────────
async function deleteWallet(id) {
  const res = await fetch(`/api/wallets/${id}`, {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + (authToken || '') }
  });
  if (!res.ok) throw new Error('Failed to delete wallet');
  await loadWalletBook(true);
}

// ── Rename wallet via API ────────────────────────────────────────
async function renameWallet(id, label) {
  const res = await fetch(`/api/wallets/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (authToken || '')
    },
    body: JSON.stringify({ label })
  });
  if (!res.ok) throw new Error('Failed to rename wallet');
  await loadWalletBook(true);
}

  // ── Deposit section: who deposits, and how much ───────────────────────────
  // "Me, now" sends from the connected wallet right after deploy (today's flow).
  // A party deposits later through the covenant link; the page then asks them
  // for the amount entered here (optional: blank lets them choose).
  const FUNDER_ROLE_HINT = /client|sender|funder|depositor|payer|buyer|owner|employer/i;
  // One party (or none): the deployer deposits, no choice to make.
  function renderDepositSection(pubkeyParams) {
    const parties = pubkeyParams || [];
    const who = parties.length > 1 ? `
        <div class="deploy-field">
          <label class="deploy-label">Who deposits</label>
          <select class="deploy-input deploy-input-wide" id="deploy-funder" onchange="App.selectFunder(this.value)">
            <option value="self">Me, now, from my wallet</option>
          </select>
        </div>` : '';
    return `
    <div class="deploy-section">
      <div class="deploy-section-label">${parties.length > 1 ? 'Deposit' : 'Funding'}</div>
      <div class="deploy-section-card">${who}
        <div class="deploy-field" style="margin-bottom:0;">
          <label class="deploy-label" id="deploy-funding-label">Lock in contract</label>
          <div class="deploy-amount-group">
            <input type="number" id="deploy-funding-input"
              placeholder="Amount" min="1" step="1"
              oninput="App.selectTkas(this.value)">
            <span class="deploy-amount-unit">KAS</span>
          </div>
          <div class="deploy-hint" id="deploy-tkas-hint">
            You can always fund more later.
          </div>
        </div>
        <div class="deploy-funding-bar">
          <span class="dfb-label" id="deploy-total-label">Total locked at deploy</span>
          <span class="dfb-value" id="deploy-total-value">—</span>
        </div>
      </div>
    </div>`;
  }

  function selectFunder(value) {
    if (!deployState) return;
    deployState.funderRole = value && value !== 'self' ? value : null;
    deployState._funderTouched = true;
    if (deployState.funderRole) clearTimeout(_balCheckTimer);
    updateDeployHints();
  }

  // Default: the party whose name says "payer" (client, sender, funder, ...)
  // when the key entered for it is not the connected wallet; otherwise me.
  // Re-run on every party edit until the user picks explicitly.
  function applyFunderDefault() {
    if (!deployState) return;
    refreshFunderOptions();
    if (deployState._funderTouched) { updateDeployHints(); return; }
    const sel = document.getElementById('deploy-funder');
    if (!sel) return;
    const hinted = hintedFunder();
    const role = hinted && hinted.isMine === false ? hinted.name : null;
    deployState.funderRole = role;
    sel.value = role || 'self';
    updateDeployHints();
  }
  // Is this pubkey param's key the connected wallet? null when unresolvable.
  function paramIsMine(name) {
    const mine = (kaspaAddressToPubkey(currentUser?.address || '') || '').toLowerCase();
    const el = document.getElementById('deploy-param-' + name);
    const theirs = (kaspaAddressToPubkey((el && el.value) || '') || '').toLowerCase();
    return mine && theirs ? mine === theirs : null;
  }
  // How the depositor reads in hints: "you" or "the client"
  function funderLabel() {
    const r = deployState && deployState.funderRole;
    if (!r) return 'you';
    return paramIsMine(r) ? 'you' : 'the ' + r;
  }
  // Rebuild the option labels from the keys as entered: my own role reads
  // "Me, later", everyone else "The <role>, later". Keeps the selection.
  function refreshFunderOptions() {
    const sel = document.getElementById('deploy-funder');
    if (!sel || !deployState) return;
    const parties = deployState.params.filter(p => p.type === 'pubkey');
    const others = parties.filter(p => paramIsMine(p.name) !== true).map(p => p.name);
    const seen = others.length === 1 ? `the ${others[0]} has` : 'the other parties have';
    const current = sel.value || 'self';
    sel.innerHTML = `<option value="self">Me, now, from my wallet</option>` + parties.map(p => paramIsMine(p.name)
      ? `<option value="${esc(p.name)}">Me, later, once ${esc(seen)} seen the terms</option>`
      : `<option value="${esc(p.name)}">The ${esc(p.name)}, later, through the covenant link</option>`).join('');
    sel.value = current;
    if (sel.value !== current) sel.value = 'self';
  }
  // The first pubkey param whose name says "payer", with its key compared to the
  // connected wallet by pubkey (so a pasted hex key compares too). isMine is
  // null when either side can't be resolved.
  function hintedFunder() {
    if (!deployState) return null;
    if (deployState.params.filter(p => p.type === 'pubkey').length < 2) return null;
    for (const p of deployState.params) {
      if (p.type !== 'pubkey' || !FUNDER_ROLE_HINT.test(p.name)) continue;
      return { name: p.name, isMine: paramIsMine(p.name) };
    }
    return null;
  }
  function bindFunderDefault(body) {
    applyFunderDefault();
    if (body._funderBound) return;
    body._funderBound = true;
    body.addEventListener('input', e => {
      const t = e.target;
      if (t && t.dataset && t.dataset.paramType === 'pubkey') applyFunderDefault();
    });
  }

  // MAINNET: update these
  // ── KAS picker ────────────────────────────────────────────────────────────
  function selectTkas(raw) {
                if (!deployState) return;
                const input = document.getElementById('deploy-funding-input');
                if (input) input.classList.remove('input-error');
                if (raw === '' || raw === null || raw === undefined) {
                        deployState.amountTkas = null;   // no amount — never assume one
                        updateDeployHints();
                        return;
                }
                let n = Math.floor(Number(raw));
                if (!Number.isFinite(n) || n < 1) n = null;   // invalid → treated as empty
                deployState.amountTkas = n;
                updateDeployHints();
        }

  // ── Per-param KAS picker (for amount/value/pledge constructor params) ──────
        // An amount typed in KAS ("2.5") lands in the hidden field as sompi, by string math
        function selectParamKas(paramName, text) {
                const hiddenInput = document.getElementById(`deploy-param-${paramName}`);
                if (hiddenInput) hiddenInput.value = kasTextToSompi(text);
                updateDeployHints();
        }
        function selectParamTkas(paramName, tkas) { selectParamKas(paramName, String(tkas)); }
        // Days typed for a relative lock land as a DAA block count (mainnet ~10 blocks/s)
        // ── Password ⇄ hex for byte[32] deploy params ─────────────────────────
        function setHashMode(paramName, pw) {
          const id = `deploy-param-${paramName}`;
          const hex = document.getElementById(id), box = document.getElementById(id + '-pw');
          if (!hex || !box) return;
          const opts = hex.parentElement.querySelectorAll('.enc-toggle .enc-opt');
          if (opts.length === 2) { opts[0].classList.toggle('enc-on', pw); opts[1].classList.toggle('enc-on', !pw); }
          box.style.display = pw ? '' : 'none';
          hex.readOnly = pw;
          hex.placeholder = pw ? 'SHA-256 appears here' : '0x hex bytes (32 bytes)';
          if (pw) { hex.value = ''; box.value = ''; box.focus(); } else { box.value = ''; hex.focus(); }
        }
        async function hashParamInput(paramName, text) {
          const hex = document.getElementById(`deploy-param-${paramName}`);
          if (!hex) return;
          // Trimmed, the same as the spend side (the server trims every argument)
          if (!text.trim()) { hex.value = ''; return; }
          const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.trim()));
          const box = document.getElementById(`deploy-param-${paramName}-pw`);
          if (box && box.value !== text) return;   // a later keystroke already took over
          hex.value = '0x' + [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
        }

        function selectParamDays(paramName, text) {
                const hiddenInput = document.getElementById(`deploy-param-${paramName}`);
                const d = Number(String(text).trim());
                if (hiddenInput) hiddenInput.value = Number.isFinite(d) && d > 0 ? String(Math.round(d * 864000)) : '';
                updateDeployHints();
        }
        // A date/time typed for an absolute lock (tx.time) lands as ms since the epoch, read as UTC
        function selectParamDate(paramName, text) {
                const hiddenInput = document.getElementById(`deploy-param-${paramName}`);
                const t = text ? Date.parse(text + (/(Z|[+-]\d\d:\d\d)$/.test(text) ? '' : 'Z')) : NaN;
                if (hiddenInput) hiddenInput.value = Number.isFinite(t) ? String(t) : '';
                updateDeployHints();
        }
        function kasTextToSompi(text) {
                const t = String(text || '').trim().replace(/,/g, '');
                if (!/^\d{1,12}(\.\d{1,8})?$/.test(t)) return '';
                const [w, f = ''] = t.split('.');
                return (BigInt(w) * 100000000n + BigInt((f + '00000000').slice(0, 8))).toString();
        }
        function sompiToKasText(v) {
                let n; try { n = BigInt(String(v).trim() || '0'); } catch (_) { return ''; }
                const w = n / 100000000n, f = (n % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
                return f ? `${w}.${f}` : `${w}`;
        }
        // What an int constructor parameter means, read from how the source uses it:
        //   kas    — compared or combined with tx.outputs[i].value / tx.inputs[i].value (or a local built from them)
        //   blocks — compared with this.ageDaa (a relative lock; entered in days)
        //   ms     — compared with tx.time (an absolute lock; entered as a UTC date)
        //   daa    — compared with tx.daa (an absolute DAA score)
        //   int    — anything else
        // Falls back to the parameter's name when the source says nothing.
        function intParamKind(name, source) {
                const src = String(source || '');
                const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const stmtsWith = re => src.split(/[;{}]/).filter(st => re.test(st));
                const uses = stmtsWith(new RegExp('\\b' + esc + '\\b'));
                if (uses.length) {
                        // Locals assigned from a money expression are money too (int left = current - tx.outputs[0].value)
                        const money = new Set();
                        let grew = true;
                        while (grew) {
                                grew = false;
                                for (const st of src.split(/[;{}]/)) {
                                        const m = st.match(/\bint\s+(\w+)\s*=\s*([\s\S]+)$/);
                                        if (!m || money.has(m[1])) continue;
                                        if (/\.value\b/.test(m[2]) || [...money].some(v => new RegExp('\\b' + v + '\\b').test(m[2]))) { money.add(m[1]); grew = true; }
                                }
                        }
                        const isMoney = st => /\.value\b/.test(st) || [...money].some(v => new RegExp('\\b' + v + '\\b').test(st));
                        if (uses.some(st => /this\.ageDaa\b/.test(st))) return 'blocks';
                        if (uses.some(st => /\btx\.time\b/.test(st))) return 'ms';
                        if (uses.some(st => /\btx\.daa\b/.test(st))) return 'daa';
                        if (uses.some(isMoney)) return 'kas';
                }
                if (/time|timeout|lock|period|duration|days/i.test(name)) return 'blocks';
                if (/amount|value|pledge|cap|budget|price|fee|limit|deposit|payout|salary|wage|rent|max|min/i.test(name)) return 'kas';
                return 'int';
        }

  // ── Update deploy hints (funding description + payments math) ──────────────
  function updateDeployHints() {
    if (!deployState) return;

    const fundingTkas = deployState.amountTkas || 0;

    // Check for pledge — either a constructor param (manual code) or a constant in source (wizard)
    let pledgeTkas = 0;
    for (const p of deployState.params) {
      if (p.type === 'int' && /amount|value|pledge/i.test(p.name) && intParamKind(p.name, deployState.source) === 'kas') {
        const el = document.getElementById(`deploy-param-${p.name}`);
        if (el) pledgeTkas = parseInt(el.value) / 100000000;
      }
    }
    // Fall back: parse "int constant pledge = <litras>;" from source
    if (!pledgeTkas && deployState.source) {
      const m = deployState.source.match(/int\s+constant\s+pledge\s*=\s*(\d+)/);
      if (m) pledgeTkas = parseInt(m[1]) / 100000000;
    }

    const hint = document.getElementById('deploy-tkas-hint');
    const fLabel = document.getElementById('deploy-funding-label');
    const tLabel = document.getElementById('deploy-total-label');
    const other = deployState.funderRole;
    const who = funderLabel();   // 'you' or 'the client'
    const isMe = who === 'you';
    if (fLabel) fLabel.textContent = !other ? 'Lock in contract' : isMe ? 'Deposit later' : 'Ask them for';
    if (tLabel) tLabel.textContent = other ? `Deposited later by ${who}` : 'Total locked at deploy';
    if (other) {
      if (hint) hint.textContent = isMe
        ? (fundingTkas > 0
          ? `Nothing leaves your wallet now. You deposit ${fundingTkas} KAS from the covenant link once the others have seen it.`
          : `Nothing leaves your wallet now. You deposit from the covenant link; the amount is up to you then.`)
        : (fundingTkas > 0
          ? `Nothing leaves your wallet now. The ${other} is asked for ${fundingTkas} KAS when they open the covenant link.`
          : `Nothing leaves your wallet now. Leave blank and the ${other} chooses the amount on the covenant link.`);
      const totalEl0 = document.getElementById('deploy-total-value');
      if (totalEl0) totalEl0.textContent = fundingTkas > 0 ? `${fundingTkas} KAS` : 'their choice';
      const btn0 = document.getElementById('deployBtn');
      if (btn0 && btn0.dataset.balBlocked) { delete btn0.dataset.balBlocked; btn0.disabled = false; btn0.textContent = 'Deploy →'; }
      return;
    }
    if (hint) {
      if (pledgeTkas > 0 && fundingTkas >= pledgeTkas) {
        const payments = Math.floor(fundingTkas / pledgeTkas);
        hint.textContent = `${fundingTkas} KAS total ÷ ${pledgeTkas} KAS per payment = ~${payments} payment${payments !== 1 ? 's' : ''}. You can always send more KAS to the contract later.`;
      } else if (pledgeTkas > 0 && fundingTkas < pledgeTkas) {
        hint.textContent = `Funding is less than one payment — increase funding or lower the per-payment amount.`;
      } else {
                if (fundingTkas > 0) {
          hint.textContent = `${fundingTkas} KAS will be locked in this contract`;
        } else {
          hint.textContent = 'Enter a whole number of KAS (minimum 1)';
        }
      }
    }
        // Update the funding bar total
  const totalEl = document.getElementById('deploy-total-value');
  if (totalEl) totalEl.textContent = fundingTkas > 0 ? `${fundingTkas} KAS` : '—';

  // Mainnet: pre-flight balance check (debounced) — only once an amount exists
  if (fundingTkas > 0) {
    scheduleBalanceCheck(fundingTkas);
  } else {
    const btn = document.getElementById('deployBtn');
    if (btn && btn.dataset.balBlocked) {
      delete btn.dataset.balBlocked;
      btn.disabled = false;
      btn.textContent = 'Deploy to Mainnet →';
    }
  }
  }

// ── User-pays deploy: balance pre-flight, wallet funding, on-chain confirm ──
  let _lastDeployData = null;
  const FEE_BUFFER_KAS = 0.05;

  async function checkDeployBalance(requiredKas) {
    if (!currentUser?.address || !authToken) return { ok: false, reason: 'not-connected' };
    try {
      const resp = await fetch('/api/balances', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: [currentUser.address] })
      });
      const ct = resp.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return { ok: true, unknown: true };
      const data = await resp.json();
      if (!data.success || !data.balances) return { ok: true, unknown: true };
      const sompi = Number(data.balances[currentUser.address] ?? 0);
      const haveKas = sompi / 1e8;
      const needKas = requiredKas + FEE_BUFFER_KAS;
      return { ok: haveKas >= needKas, haveKas, needKas };
    } catch (_) { return { ok: true, unknown: true }; }
  }

  let _balCheckTimer = null;
  function scheduleBalanceCheck(requiredKas) {
    clearTimeout(_balCheckTimer);
    _balCheckTimer = setTimeout(() => runBalanceCheck(requiredKas), 400);
  }

  async function runBalanceCheck(requiredKas) {
    const btn  = document.getElementById('deployBtn');
    const hint = document.getElementById('deploy-tkas-hint');
    if (!btn || !currentUser?.address) return;
    if (deployState && deployState.funderRole) return;   // nothing leaves this wallet
    const bal = await checkDeployBalance(requiredKas);
    if (bal.unknown) return;
    if (bal.ok) {
      if (btn.dataset.balBlocked) {
        delete btn.dataset.balBlocked;
        btn.disabled = false;
        btn.textContent = 'Deploy to Mainnet →';
        if (hint) updateDeployHints();
      }
    } else {
      btn.disabled = true;
      btn.dataset.balBlocked = '1';
      btn.textContent = 'Insufficient balance';
      if (hint) hint.textContent = `Insufficient balance: need ~${bal.needKas.toFixed(2)} KAS (incl. fee buffer), your wallet has ${bal.haveKas.toFixed(4)} KAS`;
    }
  }

  async function fundContractFromWallet(contractAddress, amountKas, meta = {}) {
    const sompi = Math.round(amountKas * 1e8);
    if (connectedWallet === 'kasware' && window.kasware) {
      return await window.kasware.sendKaspa(contractAddress, sompi, {});
    }
    if (connectedWallet === 'kastle' && window.kastle) {
      return await window.kastle.sendKaspa(contractAddress, sompi, {});
    }
    if (connectedWallet === 'kaspire' && hasKaspire()) {
      // amountSompi must be a base-10 integer string; resolves to the txid string
      return await kaspireRequest('sendKaspa', {
        from: currentUser?.address,
        to: contractAddress,
        amountSompi: String(sompi)
      });
    }
    if (connectedWallet === 'kasla') {
      // Hosted wallet: the Studio's modal is the launcher (its click opens the Kasla
      // window), Kasla's own page is the approval. Nothing moves until that page says so.
      const popup = await confirmKaslaSend(contractAddress, amountKas);
      if (!popup) throw new Error('Cancelled — nothing was sent');
      // description → the memo Kasla shows on the transaction; reference_id → Kasla metadata
      const name = (meta.name || 'covenant').toString().slice(0, 120);
      const txid = await kaslaApprovedSend({
        toAddress: contractAddress,
        amountKas,
        description: `SilverScript Studio · fund "${name}"`,
        referenceId: `silverscript:${meta.contractId || 0}:${contractAddress}`,
        popup: popup === true ? null : popup,
        onStatus: (m) => logToConsole(m)
      });
      return { id: txid };
    }
    throw new Error(`Wallet "${connectedWallet}" can't send payments from the Studio yet`);
  }

  // ── Kasla per-transaction approval ─────────────────────────────────────
  // Kasla no longer sends on an app's say-so. The Studio creates the request through
  // KasperoPay, the user approves it in a window on Kasla's own origin (the Studio can
  // neither read nor script that window), and the Studio learns the txid afterwards by
  // polling. Same shape as an extension wallet: our button, then the wallet's confirm.
  const KASPERO_PAY_API = 'https://kasperopay.com';

  // Must be called inside a click handler; popup blockers refuse windows opened later.
  function openKaslaWindow(url) {
    const w = 480, h = 700;
    const left = Math.max(0, (window.screenX || 0) + ((window.outerWidth || 800) - w) / 2);
    const top = Math.max(0, (window.screenY || 0) + ((window.outerHeight || 600) - h) / 2);
    let popup = null;
    try {
      popup = window.open(url || 'about:blank', 'kaspero-kasla-approve',
        `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`);
    } catch (_) { popup = null; }
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

  // Creates the request, points the window at Kasla's approval page, waits for the
  // outcome. Resolves to the txid. Rejects with .code = 4001 when the user backs out.
  async function kaslaApprovedSend({ toAddress, amountKas, description, referenceId, popup, onStatus }) {
    const cancelled = (m) => { const e = new Error(m || 'Cancelled — nothing was sent'); e.code = 4001; return e; };
    const say = (m) => { try { if (onStatus) onStatus(m); } catch (_) {} };

    const r = await fetch(KASPERO_PAY_API + '/pay/kasla/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (authToken || '') },
      body: JSON.stringify({ to_address: toAddress, amount_kas: amountKas, description, reference_id: referenceId })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.success || !d.approval_url || !d.kasla_payment_id) {
      if (popup && !popup.closed) { try { popup.close(); } catch (_) {} }
      throw new Error(d.error || `Kasla request failed (HTTP ${r.status})`);
    }

    let kaslaOrigin = null;
    try { kaslaOrigin = new URL(d.approval_url).origin; } catch (_) {}

    if (popup && !popup.closed) {
      try { popup.location.href = d.approval_url; } catch (_) { popup = null; }
    }
    if (!popup || popup.closed) popup = openKaslaWindow(d.approval_url);
    if (!popup) throw new Error('Your browser blocked the Kasla window. Allow popups for this site and try again.');

    say('Approve the payment in the Kasla window…');

    return new Promise((resolve, reject) => {
      const POLL_MS = 2000, CLOSE_GRACE_MS = 8000, TIMEOUT_MS = 10 * 60 * 1000;
      const startedAt = Date.now();
      let closedAt = null, settled = false, timer = null;

      const finish = (fn, v) => {
        if (settled) return; settled = true;
        clearInterval(timer);
        window.removeEventListener('message', onMessage);
        if (popup && !popup.closed) { try { popup.close(); } catch (_) {} }
        fn(v);
      };

      const check = () => fetch(KASPERO_PAY_API + '/pay/kasla/approval/' + encodeURIComponent(d.kasla_payment_id), {
        headers: { 'Authorization': 'Bearer ' + (authToken || '') }
      })
        .then(res => res.json())
        .then(st => {
          if (settled || !st) return;
          if (st.status === 'completed' && st.transaction_id) finish(resolve, st.transaction_id);
          else if (st.status === 'cancelled') finish(reject, cancelled(/expired/i.test(st.error_message || '') ? 'Approval request expired' : 'Denied in Kasla — nothing was sent'));
          else if (st.status === 'failed') finish(reject, new Error(st.error_message || 'Kasla could not send the payment'));
        })
        .catch(() => {});

      const onMessage = (ev) => {
        if (kaslaOrigin && ev.origin !== kaslaOrigin) return;
        const m = ev.data || {};
        if (m.source === 'kaspero-connect' && m.payment_id === d.kasla_payment_id) check();
      };
      window.addEventListener('message', onMessage);

      timer = setInterval(() => {
        if (settled) return;
        if (Date.now() - startedAt > TIMEOUT_MS) return finish(reject, cancelled('Approval request expired'));
        if (popup.closed) {
          closedAt = closedAt || Date.now();
          if (Date.now() - closedAt > CLOSE_GRACE_MS) return finish(reject, cancelled('Kasla window closed before approval'));
        }
        check();
      }, POLL_MS);
    });
  }

  // ── Kasla confirm modal ────────────────────────────────────────────────
  // For sends it is the launcher: its Continue click opens the Kasla window (openWindow)
  // and resolves with the window handle. For signing it is still the confirmation itself.
  let _kaslaConfirmResolve = null;
  let _kaslaConfirmOpensWindow = false;
  function confirmKaslaAction({ title, intro, rows, note, button, openWindow }) {
    return new Promise((resolve) => {
      if (_kaslaConfirmResolve) _kaslaConfirmResolve(false);
      _kaslaConfirmResolve = resolve;
      _kaslaConfirmOpensWindow = !!openWindow;
      const modal = document.getElementById('kaslaConfirmModal');
      const body = document.getElementById('kaslaConfirmBody');
      const btn = document.getElementById('kaslaConfirmBtn');
      if (!modal || !body || !btn) { _kaslaConfirmResolve = null; resolve(false); return; }
      const h3 = modal.querySelector('.modal-header h3');
      if (h3) h3.textContent = title || 'Confirm with Kasla';
      body.innerHTML = `
        <p style="margin:0 0 12px;">${intro}</p>
        <div class="deploy-section-card" style="margin-bottom:12px;">
          ${rows.map(([label, html]) => `<div class="deploy-detail"><span class="deploy-detail-label">${label}</span> ${html}</div>`).join('')}
        </div>
        <p style="margin:0;color:var(--text-muted);font-size:12px;">${note}</p>`;
      btn.textContent = button;
      // Always paint above whichever modal asked (deploy, redeem, ...): last in
      // the DOM wins among equal z-indexes, and the inline z-index beats them.
      modal.style.zIndex = '530';
      document.body.appendChild(modal);
      showModal('kaslaConfirmModal');
    });
  }

  function confirmKaslaSend(toAddress, amountKas) {
    return confirmKaslaAction({
      title: 'Fund with Kasla',
      intro: 'Kasla will ask you to approve this payment in its own window:',
      rows: [
        ['Amount:', `<strong>${amountKas} KAS</strong> + network fee`],
        ['From:', esc(formatAddress(currentUser?.address || ''))],
        ['To (covenant):', `<code style="word-break:break-all;">${esc(toAddress)}</code>`]
      ],
      note: 'Nothing is sent until you approve it in Kasla. Funds can only leave the covenant through its own spend paths.',
      button: 'Continue to Kasla',
      openWindow: true
    });
  }

  function kaslaConfirmAnswer(yes) {
    const r = _kaslaConfirmResolve;
    const wantsWindow = _kaslaConfirmOpensWindow;
    _kaslaConfirmResolve = null;
    _kaslaConfirmOpensWindow = false;
    // Open here, inside the click, before anything async
    const popup = (yes && wantsWindow) ? openKaslaWindow(null) : null;
    const modal = document.getElementById('kaslaConfirmModal');
    if (modal) modal.classList.remove('visible');
    if (!document.querySelector('.modal.visible')) {
      document.getElementById('modalOverlay').classList.remove('visible');
    }
    if (r) r(yes ? (popup || true) : false);
  }

  function extractTxId(sendResult) {
    if (!sendResult) return null;
    if (typeof sendResult === 'string') {
      try { const p = JSON.parse(sendResult); return p.id || p.transactionId || sendResult; }
      catch (_) { return sendResult.replace(/^"|"$/g, ''); }
    }
    return sendResult.id || sendResult.transactionId || null;
  }

  async function confirmFunding(contractId, txId) {
    for (let i = 0; i < 5; i++) {
      try {
        const cRes = await fetch(`/api/contracts/${contractId}/confirm-funding`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (authToken || '') },
          body: JSON.stringify({ txId })
        });
        const d = await cRes.json();
        if (d.success) return d;
        if (!d.retryable) return null;
      } catch (_) { /* transient */ }
      await new Promise(r => setTimeout(r, 3000));
    }
    return null;
  }

  async function fundAndConfirm(contractId, contractAddress, amountKas) {
    let txId = null;
    try {
      const sendResult = await fundContractFromWallet(contractAddress, amountKas, {
        contractId, name: _lastDeployData?.contractName
      });
      txId = extractTxId(sendResult);
    } catch (fundErr) {
      const msg = typeof fundErr === 'string' ? fundErr : (fundErr?.message || String(fundErr));
      logToConsole(`Funding not sent: ${msg}`);
      return { state: 'cancelled' };
    }
    const confirmed = await confirmFunding(contractId, txId);
    return confirmed
      ? { state: 'funded', txId, explorerUrl: confirmed.explorerUrl }
      : { state: 'pending', txId };
  }

  async function retryFund(contractId, contractAddress, amountKas) {
    logToConsole('Requesting funding from wallet…');
    const r = await fundAndConfirm(contractId, contractAddress, amountKas);
    if (r.state === 'cancelled') { logToConsole('Funding cancelled again — contract remains unfunded.'); return; }
    if (r.state === 'funded') {
      logToConsole(`✅ Funded: ${r.txId}`);
      showDeployResult({ ..._lastDeployData, funded: true, txId: r.txId, explorerUrl: r.explorerUrl });
    } else {
      showDeployResult({ ..._lastDeployData, funded: false, txId: r.txId, pendingVerification: true });
    }
  }

  async function retryConfirm(contractId, txId) {
    logToConsole('Re-checking funding on-chain…');
    const d = await confirmFunding(contractId, txId);
    if (d) {
      logToConsole('✅ Funding verified');
      showDeployResult({ ..._lastDeployData, funded: true, txId, explorerUrl: d.explorerUrl });
    } else {
      logToConsole('Still not visible in the UTXO index — funds are safe; try again shortly.');
    }
  }

function renderDeployField(param, prefillValue) {
  const id = `deploy-param-${esc(param.name)}`;
  const pre = prefillValue !== undefined && prefillValue !== null ? String(prefillValue) : '';
  let inputHtml = '';
  let hint = '';

  const typeBadgeClass = param.type === 'int' ? 'type-int'
    : param.type === 'bool' ? 'type-bool'
    : 'type-default';

  switch (param.type) {
    case 'int': {
      // The hidden field always holds what the contract sees (sompi, blocks, ms, a score);
      // the visible one speaks the user's units. Prefills (wizard hints) are contract units.
      const kind = intParamKind(param.name, deployState && deployState.source);
      if (kind === 'blocks') {
        const preDays = pre ? String(Math.round(Number(pre) / 864000 * 100) / 100) : '';
        inputHtml = `
          <input type="hidden" id="${id}" value="${esc(pre)}"
            data-param-name="${esc(param.name)}" data-param-type="${esc(param.type)}">
          <div class="deploy-amount-group">
            <input type="number" placeholder="30" min="0" step="any"
              value="${esc(preDays)}"
              oninput="App.selectParamDays('${esc(param.name)}', this.value)">
            <span class="deploy-amount-unit">days</span>
          </div>`;
        hint = 'Waiting time after each deposit, in days. Stored as a block count (about 864,000 blocks per day on mainnet), so the date is an estimate.';
      } else if (kind === 'ms') {
        const preIso = pre && Number(pre) > 0 ? new Date(Number(pre)).toISOString().slice(0, 16) : '';
        inputHtml = `
          <input type="hidden" id="${id}" value="${esc(pre)}"
            data-param-name="${esc(param.name)}" data-param-type="${esc(param.type)}">
          <div class="deploy-amount-group">
            <input type="datetime-local" value="${esc(preIso)}"
              oninput="App.selectParamDate('${esc(param.name)}', this.value)">
            <span class="deploy-amount-unit">UTC</span>
          </div>`;
        hint = 'The date and time (UTC) after which this path opens.';
      } else if (kind === 'daa') {
        inputHtml = `<input type="number" id="${id}" class="deploy-input"
          placeholder="0" value="${esc(pre)}" min="0" step="1"
          data-param-name="${esc(param.name)}" data-param-type="${esc(param.type)}">`;
        hint = 'A DAA score (block height). The path opens once the chain passes it.';
      } else if (kind === 'kas') {
        const preKas = pre ? sompiToKasText(pre) : '';
        inputHtml = `
          <input type="hidden" id="${id}" value="${esc(pre)}"
            data-param-name="${esc(param.name)}" data-param-type="${esc(param.type)}">
          <div class="deploy-amount-group">
            <input type="number" placeholder="Amount" min="0" step="any" inputmode="decimal"
              value="${esc(preKas)}"
              oninput="App.selectParamKas('${esc(param.name)}', this.value)">
            <span class="deploy-amount-unit">KAS</span>
          </div>`;
        hint = 'In KAS; decimals are fine (2.5). The contract stores it in sompi.';
      } else {
        inputHtml = `<input type="number" id="${id}" class="deploy-input"
          placeholder="0" value="${esc(pre)}"
          data-param-name="${esc(param.name)}" data-param-type="${esc(param.type)}">`;
        hint = 'A plain whole number; the source does not compare it with amounts or locks.';
      }
      break;
    }
    case 'bool':
      inputHtml = `<select id="${id}" class="deploy-input"
        data-param-name="${esc(param.name)}" data-param-type="${esc(param.type)}">
        <option value="true" ${pre === 'true' ? 'selected' : ''}>true</option>
        <option value="false" ${pre === 'false' ? 'selected' : ''}>false</option>
      </select>`;
      break;
    case 'byte[32]': {
      // A 32-byte value is often the hash of a password/PIN. In Password mode the user
      // types the password, the browser hashes it (SHA-256) into the field below, and
      // only the hash leaves the browser. Hex mode takes the 32 bytes directly.
      ensureEncStyle();
      const pw = !pre && /hash|digest|commit/i.test(param.name);
      const n = esc(param.name);
      inputHtml = `
        <div class="enc-toggle">
          <button type="button" class="enc-opt${pw ? ' enc-on' : ''}" onclick="App.setHashMode('${n}', true)">Password</button>
          <button type="button" class="enc-opt${pw ? '' : ' enc-on'}" onclick="App.setHashMode('${n}', false)">Hex</button>
        </div>
        <input type="text" id="${id}-pw" class="deploy-input deploy-input-wide" placeholder="the password or PIN"
          autocomplete="off" spellcheck="false" style="${pw ? '' : 'display:none;'}"
          oninput="App.hashParamInput('${n}', this.value)">
        <input type="text" id="${id}" class="deploy-input deploy-input-wide enc-hash"
          placeholder="${pw ? 'SHA-256 appears here' : '0x hex bytes (32 bytes)'}" value="${esc(pre)}" ${pw ? 'readonly' : ''}
          data-param-name="${n}" data-param-type="${esc(param.type)}">`;
      hint = 'Password: type it above; the Studio stores only its SHA-256, computed in your browser. Whoever spends types the same password, exactly (capitals count; spaces at the ends are ignored). Hex: 32 bytes as 64 hex characters.';
      break;
    }
    default:
      inputHtml = `<input type="text" id="${id}" class="deploy-input deploy-input-wide"
        placeholder="${param.type === 'string' ? 'text value' : '0x hex bytes'}"
        value="${esc(pre)}"
        data-param-name="${esc(param.name)}" data-param-type="${esc(param.type)}">`;
      hint = param.type.startsWith('byte') ? 'Hex-encoded bytes (with or without 0x prefix).' : '';
  }

  return `
    <div class="deploy-field">
      <label class="deploy-label">
        ${esc(param.name)} <span class="deploy-type-badge ${typeBadgeClass}">${esc(param.type)}</span>
      </label>
      ${inputHtml}
      ${hint ? `<div class="deploy-hint">${hint}</div>` : ''}
    </div>`;
}


// ═══════════════════════════════════════════════════════════════════
// Wallet Drawer
// ═══════════════════════════════════════════════════════════════════
function openWalletDrawer() {
  // Close any open deploy dropdowns
  document.querySelectorAll('.wallet-dropdown-panel').forEach(p => p.classList.remove('show'));
  document.querySelectorAll('.wallet-dropdown-trigger').forEach(t => t.classList.remove('open'));

  document.getElementById('walletDrawerBackdrop').classList.add('show');
  document.getElementById('walletDrawer').classList.add('open');
  if (!currentUser) {
    document.getElementById('walletDrawerBody').innerHTML = '<div class="we-empty" style="padding:14px 4px 18px;font-size:12.5px;color:var(--text-secondary);line-height:1.5;">Connect a wallet to keep an address book.</div>';
    return;
  }
  document.getElementById('walletDrawerBody').innerHTML = '<div class="we-empty" style="padding:14px 4px 18px;font-size:12.5px;color:var(--text-secondary);line-height:1.5;">Loading…</div>';
  loadWalletBook(true).then(() => renderWalletDrawerBody());
}

function closeWalletDrawer() {
  document.getElementById('walletDrawerBackdrop').classList.remove('show');
  document.getElementById('walletDrawer').classList.remove('open');
}

function renderWalletDrawerBody() {
  const container = document.getElementById('walletDrawerBody');
  let html = '';

  if (walletBookError) html += `<div class="we-empty" style="padding:14px 4px 18px;font-size:12.5px;color:var(--text-secondary);line-height:1.5;" style="color:var(--error)">Could not load your wallets: ${esc(walletBookError)}</div>`;
  else if (!walletBook.length) html += `<div class="we-empty" style="padding:14px 4px 18px;font-size:12.5px;color:var(--text-secondary);line-height:1.5;">No saved wallets yet. Add the people you make covenants with below.</div>`;

  for (const w of walletBook) {
    html += `
      <div class="we-card" id="we-card-${w.id}">
        <div class="we-avatar" style="background:${esc(w.color || '#666')}">${esc((w.label || '?')[0].toUpperCase())}</div>
        <div class="we-info">
          <div class="we-name">
            ${esc(w.label)}
            ${w.is_self ? '<span class="we-you-badge">you</span>' : ''}
          </div>
          <div class="we-addr">${esc(w.address)}</div>
        </div>
        <div class="we-actions">
          <button title="Copy address" onclick="navigator.clipboard.writeText('${esc(w.address)}'); this.textContent='copied'; setTimeout(()=>this.textContent='copy',1000);">copy</button>
          <button title="Rename" onclick="App._renameWalletPrompt(${w.id}, '${esc(w.label)}')">rename</button>
          ${!w.is_self ? `<button class="we-delete" title="Remove from your wallet book" onclick="App._deleteWalletConfirm(${w.id}, '${esc(w.label)}')">&times;</button>` : ''}
        </div>
      </div>`;
  }

  // Add wallet form
  html += `
    <div class="we-add-form" id="weAddForm">
      <div class="we-form-row">
        <label>Name</label>
        <input type="text" id="weAddLabel" placeholder="e.g. Alice, Test Wallet 2…" maxlength="60">
      </div>
      <div class="we-form-row">
        <label>Address</label>
        <input type="text" id="weAddAddress" class="mono-input" placeholder="kaspa:… or kaspatest:… or hex pubkey">
        <div class="we-form-hint">Public key will be resolved from Kaspa addresses automatically.</div>
      </div>
      <div id="weAddError" style="color:var(--error);font-size:12px;margin-top:6px;display:none;"></div>
      <div class="we-form-actions">
        <button class="we-form-btn we-form-btn-primary" onclick="App._addWalletSubmit()">Save wallet</button>
      </div>
    </div>`;

  container.innerHTML = html;
}

async function _addWalletSubmit() {
  const label = document.getElementById('weAddLabel')?.value.trim();
  const address = document.getElementById('weAddAddress')?.value.trim();
  const errEl = document.getElementById('weAddError');

  if (!label || !address) {
    if (errEl) { errEl.textContent = 'Name and address are required.'; errEl.style.display = 'block'; }
    return;
  }

  const dup = walletBook.find(w => w.address.toLowerCase() === address.toLowerCase());
  if (dup) {
    if (errEl) { errEl.textContent = `That address is already saved as "${dup.label}".`; errEl.style.display = 'block'; }
    return;
  }

  try {
    if (errEl) errEl.style.display = 'none';
    const saved = await addWallet(label, address);
    renderWalletDrawerBody();
    if (deployState) refreshDeployDropdowns();
    logToConsole(`Wallet "${label}" saved`);
    // Opened from a wizard field: hand the new wallet to that field and close.
    const takenByWizard = (typeof WizardEngine !== 'undefined' && WizardEngine.walletBookChanged)
      ? WizardEngine.walletBookChanged(saved) : false;
    // Opened from the deploy modal: close so the refreshed dropdowns are visible. Otherwise stay and show the list.
    if (deployState || takenByWizard) closeWalletDrawer();
  } catch (e) {
    if (errEl) { errEl.textContent = e.message; errEl.style.display = 'block'; }
  }
}

async function _deleteWalletConfirm(id, label) {
  if (!confirm(`Remove "${label}" from your wallet book? The wallet itself is not affected.`)) return;
  try {
    await deleteWallet(id);
    renderWalletDrawerBody();
    if (deployState) refreshDeployDropdowns();
    logToConsole(`Wallet "${label}" deleted`);
  } catch (e) {
    logToConsole('Failed to delete wallet: ' + e.message);
  }
}

async function _renameWalletPrompt(id, currentLabel) {
  const newLabel = prompt('Rename wallet:', currentLabel);
  if (!newLabel || newLabel.trim() === currentLabel) return;
  try {
    await renameWallet(id, newLabel.trim());
    renderWalletDrawerBody();
    if (deployState) refreshDeployDropdowns();
  } catch (e) {
    logToConsole('Failed to rename wallet: ' + e.message);
  }
}

// Refresh all wallet dropdowns in the deploy modal without full re-render
function refreshDeployDropdowns() {
  if (!deployState) return;
  const pubkeyParams = deployState.params.filter(p => p.type === 'pubkey');
  for (const p of pubkeyParams) {
    const wrap = document.getElementById('trigger-' + p.name)?.closest('.wallet-dropdown-wrap');
    if (!wrap) continue;

    // Preserve currently selected value
    const hidden = document.getElementById('deploy-param-' + p.name);
    const currentAddr = hidden?.value || '';
    const currentWallet = walletBook.find(w => w.address === currentAddr) || walletBook.find(w => w.is_self) || walletBook[0] || null;

    if (hidden && currentWallet) hidden.value = currentWallet.address;

    // Re-render the dropdown wrapper
    const newHtml = renderWalletDropdown(p.name, currentWallet);
    wrap.outerHTML = newHtml;
  }
}


  // ── deployContract ─────────────────────────────────────────────────────────
  // Calls /api/deploy - server compiles, funds from Studio wallet, returns result.
  // No wallet interaction on the client side.
  async function deployContract() {
    if (!deployState) return;

    const btn = document.getElementById('deployBtn');
    btn.disabled = true;
    btn.textContent = 'Deploying…';

    // Collect constructor args
    const constructorArgs = [];
    for (const p of deployState.params) {
      const el = document.getElementById(`deploy-param-${p.name}`);
      if (!el) {
        logToConsole(`Missing input for parameter: ${p.name}`);
        btn.disabled = false;
        btn.textContent = 'Deploy to Mainnet →';
        return;
      }
      constructorArgs.push({ type: p.type, value: el.value.trim() });
    }

    // Validate funding amount — no defaults on mainnet. When another party
    // deposits later the amount is optional (what the page asks them for).
    const amountKas = deployState.amountTkas;
    const otherFunds = !!deployState.funderRole;
    if (!otherFunds && (!Number.isInteger(amountKas) || amountKas < 1)) {
      const amtInput = document.getElementById('deploy-funding-input');
      if (amtInput) { amtInput.classList.add('input-error'); amtInput.focus(); }
      logToConsole('Enter a whole-number funding amount of at least 1 KAS before deploying');
      btn.disabled = false;
      btn.textContent = 'Deploy to Mainnet →';
      return;
    }
    // The depositor must match the key: a party can't be asked to deposit
    // with your own key, and a contract whose payer is someone else can't be
    // funded by you "now" (the money would sit under their rules, not yours).
    {
      let stop = null;
      if (!otherFunds) {
        const h = hintedFunder();
        if (h && h.isMine === false && /client|sender|funder|depositor|payer|buyer|employer/i.test(h.name)) {
          stop = `The ${h.name} is not your wallet. If they are the one paying, set "Who deposits" to "The ${h.name}, later"; if you are, enter your own key as ${h.name}.`;
        }
      }
      if (stop) {
        logToConsole(stop);
        const sel = document.getElementById('deploy-funder'); if (sel) sel.focus();
        btn.disabled = false;
        btn.textContent = 'Deploy to Mainnet →';
        return;
      }
    }

    // Validate pubkey fields aren't empty
    for (let i = 0; i < deployState.params.length; i++) {
      if (deployState.params[i].type === 'pubkey' && !constructorArgs[i].value) {
        logToConsole(`Parameter "${deployState.params[i].name}" requires a public key or Kaspa address`);
        btn.disabled = false;
        btn.textContent = 'Deploy to Mainnet →';
        return;
      }
    }

    // ── Pre-deploy safety checks ────────────────────────────────
    if (!deployState._safetyShown) {
      const warnings = _runPreDeploySafetyChecks(
        deployState.source,
        deployState.functions,
        deployState.params,
        constructorArgs,
        currentUser?.address
      );
      if (warnings.length > 0) {
        const hadCritical = _showSafetyWarnings(warnings, constructorArgs);
        if (hadCritical) {
          // First click with critical warnings — stop here, user must click again
          return;
        }
        // Info-only warnings: show them but don't block
      }
    }
    // Clear safety state so it re-checks if user changes params and re-deploys
    deployState._safetyShown = false;

        try {
      // ── Wallet must be connected ────────────────────────────────────────────
      if (!connectedWallet || !authToken || !currentUser?.address) {
        logToConsole('Connect your wallet before deploying (top-right button)');
        btn.disabled = false;
        btn.textContent = 'Deploy to Mainnet →';
        return;
      }

      // Deploy authorization: extension wallets sign a challenge; Kasla is a
      // hosted account with no extension, so its session token stands in and
      // the server verifies it with kasperopay.
      await assertSessionMatchesWallet();
      const walletAddress = currentUser.address;
      const challenge = `SilverScript Studio\nAction: deploy\nContract: ${deployState.contractName}\nWallet: ${walletAddress}\nNonce: ${Date.now()}`;
      let signature = null;
      if (connectedWallet === 'kaspire') {
        btn.textContent = 'Sign in wallet…';
        if (!hasKaspire()) {
          logToConsole('Kaspire not available for signing — is the extension installed?');
          btn.disabled = false;
          btn.textContent = 'Deploy to Mainnet →';
          return;
        }
        // Kaspire returns { address, signature }
        const sres = await kaspireRequest('signMessage', { address: walletAddress, message: challenge });
        signature = (sres && sres.signature) ? sres.signature : sres;
      } else if (connectedWallet !== 'kasla') {
        btn.textContent = 'Sign in wallet…';
        const walletObj = window[connectedWallet];
        if (!walletObj || typeof walletObj.signMessage !== 'function') {
          logToConsole(`Wallet "${connectedWallet}" not available for signing — is the extension installed?`);
          btn.disabled = false;
          btn.textContent = 'Deploy to Mainnet →';
          return;
        }
        signature = await walletObj.signMessage(challenge);
      }

      btn.textContent = 'Compiling…';

      const res = await fetch('/api/deploy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (authToken || '')
        },
        body: JSON.stringify({
          source: deployState.source,
          constructorArgs,
          amountTkas: otherFunds ? 0 : amountKas,
          funder: { role: deployState.funderRole, expectedKas: otherFunds ? amountKas : null },
          network: 'testnet',
                  signature,
          challenge,
          walletType: connectedWallet
        })
      });

      const data = await res.json();

      if (res.status === 429) {
        logToConsole('Deploy limit reached - you can deploy up to 3 contracts per hour');
        btn.disabled = false;
        btn.textContent = 'Deploy to Mainnet →';
        showDeployRateLimit();
        return;
      }

      if (!data.success) {
        logToConsole('Deploy error: ' + data.error);
        btn.disabled = false;
        btn.textContent = 'Deploy to Mainnet →';
        return;
      }

      // ── Success - show result ───────────────────────────────────────────────
      logToConsole(`✅ Compiled: ${data.contractName} → ${data.contractAddress}`);
      _lastDeployData = data;

      if (!data.requiresFunding && data.contractId) {
        logToConsole(`Created. The ${data.funderRole} deposits through the covenant link.`);
        showDeployResult({ ...data, awaitingOther: true });
        btn.disabled = false;
        btn.textContent = 'Deploy to Mainnet →';
        return;
      }

      if (data.requiresFunding && data.contractId) {
        btn.textContent = 'Confirm in wallet…';
        const r = await fundAndConfirm(data.contractId, data.contractAddress, data.amountKas ?? data.amountTkas);
        if (r.state === 'cancelled') {
          logToConsole('Funding cancelled — contract created but not funded.');
          showDeployResult({ ...data, funded: false, fundingCancelled: true });
        } else if (r.state === 'funded') {
          logToConsole(`✅ Funded: ${r.txId}`);
          showDeployResult({ ...data, funded: true, txId: r.txId, explorerUrl: r.explorerUrl });
        } else {
          logToConsole(`⚠ Funding sent (tx ${r.txId ? r.txId.slice(0,16) : '?'}…) — verification pending.`);
          showDeployResult({ ...data, funded: false, txId: r.txId, pendingVerification: true });
        }
        btn.disabled = false;
        btn.textContent = 'Deploy to Mainnet →';
      } else if (data.requiresFunding && !data.contractId) {
        logToConsole('⚠ Contract compiled but not saved — funding skipped. Retry the deploy.');
        showDeployResult({ ...data, funded: false, fundingCancelled: true });
      } else {
        showDeployResult(data);
      }

    } catch (e) {
      logToConsole('Deploy error: ' + e.message);
      btn.disabled = false;
      btn.textContent = 'Deploy to Mainnet →';
    }
  }

  // ── Covenant file (.ksm): everything needed to withdraw without the Studio ──
  function ksmUrl(token) { return token ? `/api/share/${encodeURIComponent(token)}/manifest.ksm` : null; }
  // After deploy: one section that asks, once and plainly, to keep a copy. The button
  // glows once (a single burst), then sits still; styles injected here so style.css
  // doesn't change.
  function ensureEncStyle() {
    if (document.getElementById('encToggleStyle')) return;
    const st = document.createElement('style');
    st.id = 'encToggleStyle';
    st.textContent = `
      .enc-toggle { display: inline-flex; gap: 2px; padding: 2px; margin: 0 0 6px; border-radius: 6px; border: 1px solid var(--border, rgba(128,128,128,.3)); }
      .enc-opt { font: inherit; font-size: 11px; padding: 3px 10px; border: 0; border-radius: 4px; background: transparent; color: var(--text-secondary, inherit); cursor: pointer; }
      .enc-opt.enc-on { background: var(--accent, #c8a44e); color: #1a1c24; font-weight: 600; }
      .enc-hash[readonly] { opacity: .75; font-family: 'JetBrains Mono', monospace; font-size: 11px; }`;
    document.head.appendChild(st);
  }
  // Spend args of type byte[N]: Text (a password, sent as UTF-8) or Hex. byte[] defaults to Text.
  function _encToggle(btn, enc) {
    const field = btn.closest('.deploy-field');
    const inp = field && field.querySelector('input[data-arg]');
    if (!inp) return;
    inp.dataset.enc = enc;
    inp.placeholder = enc === 'text' ? 'password or text, typed exactly' : 'hex bytes';
    field.querySelectorAll('.enc-opt').forEach(b => b.classList.toggle('enc-on', b === btn));
    inp.focus();
  }

  function ensureKsmNudgeStyle() {
    if (document.getElementById('ksmNudgeStyle')) return;
    const st = document.createElement('style');
    st.id = 'ksmNudgeStyle';
    st.textContent = `
      .ksm-nudge-text { font-size: 12.5px; line-height: 1.5; color: var(--text-secondary); margin: 0 0 10px; }
      .ksm-btn { display: inline-flex; align-items: center; gap: 8px; padding: 9px 16px; border-radius: 8px;
        border: 1px solid var(--accent); background: var(--accent-bg); color: var(--accent);
        font-weight: 600; font-size: 13px; text-decoration: none; cursor: pointer;
        transition: background .15s, color .15s; }
      .ksm-btn:hover { background: var(--accent); color: #1a1c24; }
      [data-theme="light"] .ksm-btn:hover { background: #d9ad48; border-color: #d9ad48; }
      .ksm-btn.ksm-burst { animation: ksmBurst 1.3s ease-out .5s 1 both; }
      .ksm-btn.ksm-saved { border-color: var(--success); color: var(--success); background: transparent; }
      .ksm-more { display: inline-block; margin-left: 12px; font-size: 12px; color: var(--text-muted); }
      @keyframes ksmBurst {
        0%   { box-shadow: 0 0 0 0 rgba(200,164,78,.65); }
        60%  { box-shadow: 0 0 0 16px rgba(200,164,78,0); }
        100% { box-shadow: 0 0 0 0 rgba(200,164,78,0); }
      }
      @media (prefers-reduced-motion: reduce) { .ksm-btn.ksm-burst { animation: none; } }`;
    document.head.appendChild(st);
  }

  function ksmSection(data) {
    const u = ksmUrl(data.shareToken);
    if (!u) return '';
    ensureKsmNudgeStyle();
    return `
      <div class="deploy-section">
        <div class="deploy-section-title">Your copy of this covenant</div>
        <p class="ksm-nudge-text">Save it now and keep it with your records. Whoever moves these coins later, here in the Studio or with any other tool, will need this file to build the transaction.</p>
        <a href="${esc(u)}" download class="ksm-btn ksm-burst"
           onclick="this.classList.remove('ksm-burst'); this.classList.add('ksm-saved'); this.lastElementChild.textContent = 'Downloaded';">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <span>Download your copy (.ksm)</span>
        </a>
        <a href="/ksm.html" target="_blank" rel="noopener" class="ksm-more">What's in it?</a>
      </div>`;
  }

  // ── showDeployResult ───────────────────────────────────────────────────────
  // The covenant page link, on every deploy result: copy it, or open it yourself
  function shareSection(data, title) {
    const link = data.shareToken ? `${location.origin}/c/${data.shareToken}` : null;
    if (!link) return '';
    return `
      <div class="deploy-section">
        <div class="deploy-section-title">${esc(title || 'Covenant page')}</div>
        <div class="deploy-address" onclick="navigator.clipboard.writeText('${esc(link)}'); App.logToConsole('Link copied');">
          ${esc(link)}<span class="deploy-copy-hint">click to copy</span>
        </div>
        <div style="margin-top:8px;display:flex;gap:12px;flex-wrap:wrap;">
          <a href="${esc(link)}" target="_blank" rel="noopener" class="deploy-explorer-link">Open the covenant page ↗</a>
        </div>
        <div class="deploy-hint">Anyone with the link can read the terms; only the keys named in the covenant can move the money.</div>
      </div>`;
  }

  function showDeployResult(data) {
    const body = document.getElementById('deployModalBody');
    body.scrollTop = 0;
    const explorerAddr = `https://explorer.kaspa.org/addresses/${data.contractAddress}`;
    const explorerTx   = data.txId ? `https://explorer.kaspa.org/transactions/${data.txId}` : null;
    const shareLink = data.shareToken ? `${location.origin}/c/${data.shareToken}` : null;

    // ── State: another party deposits through the link ──
    if (data.awaitingOther) {
      const link = data.shareToken ? `${location.origin}/c/${data.shareToken}` : null;
      const meLater = !!data.funderRole && paramIsMine(data.funderRole) === true;
      const ask = data.expectedDepositSompi ? `${Number(data.expectedDepositSompi) / 1e8} KAS` : (meLater ? 'an amount of your choice' : 'the amount they choose');
      body.innerHTML = `
        <div class="deploy-section">
          <div class="deploy-contract-name">${esc(data.contractName)}</div>
          <div class="deploy-success">✅ Created. ${meLater ? 'Not funded yet.' : `Waiting for the ${esc(data.funderRole)} to deposit.`}</div>
        </div>
        <div class="deploy-section">
          <div class="deploy-section-title">${meLater ? 'Share this link' : 'Send them this link'}</div>
          ${link ? `<div class="deploy-address" onclick="navigator.clipboard.writeText('${esc(link)}'); App.logToConsole('Link copied');">
            ${esc(link)}<span class="deploy-copy-hint">click to copy</span>
          </div>
          <div style="margin-top:8px;display:flex;gap:12px;flex-wrap:wrap;"><a href="${esc(link)}" target="_blank" rel="noopener" class="deploy-explorer-link">Open the covenant page ↗</a></div>` : `<div class="deploy-hint">Open the covenant in My Contracts and use "Share with parties".</div>`}
          <div class="deploy-hint">${meLater
            ? `The other parties can read the terms there. When you open it with this wallet, the page asks you to deposit ${esc(ask)}. Nothing has left your wallet.`
            : `When the ${esc(data.funderRole)} opens it with their wallet, the page asks them to deposit ${esc(ask)}. Nothing has left your wallet.`}</div>
        </div>
        <div class="deploy-section">
          <div class="deploy-section-title">Contract Address</div>
          <div class="deploy-address" onclick="navigator.clipboard.writeText('${esc(data.contractAddress)}'); App.logToConsole('Address copied');">
            ${esc(data.contractAddress)}<span class="deploy-copy-hint">click to copy</span>
          </div>
          <div style="margin-top:8px;"><a href="${explorerAddr}" target="_blank" rel="noopener" class="deploy-explorer-link">View on Explorer ↗</a></div>
        </div>
        ${ksmSection(data)}`;
      document.getElementById('deployModalFooter').innerHTML = `
        <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        ${link ? `<button class="btn btn-primary" onclick="navigator.clipboard.writeText('${esc(link)}'); App.logToConsole('Link copied'); this.textContent='Copied';">Copy the link</button>` : ''}`;
      return;
    }

    // ── State: user cancelled the wallet funding popup ──
    if (data.fundingCancelled) {
      body.innerHTML = `
        <div class="deploy-section">
          <div class="deploy-contract-name">${esc(data.contractName)}</div>
          <div class="deploy-warning">⚠ Contract created — not funded</div>
        </div>
        <div class="deploy-section">
          <div class="deploy-section-title">Contract Address</div>
          <div class="deploy-address" onclick="navigator.clipboard.writeText('${esc(data.contractAddress)}'); App.logToConsole('Address copied');">
            ${esc(data.contractAddress)}<span class="deploy-copy-hint">click to copy</span>
          </div>
          <div class="deploy-hint">Compile succeeded and the address is derived, but no KAS was sent. The contract holds nothing until funded.</div>
        </div>
        ${shareSection(data)}
        ${ksmSection(data)}
        <div class="deploy-actions">
          <button class="btn btn-primary" onclick="App.retryFund(${data.contractId}, '${esc(data.contractAddress)}', ${Number(data.amountKas ?? data.amountTkas) || 0})">
            Fund now — ${Number(data.amountKas ?? data.amountTkas) || 0} KAS →
          </button>
          <a href="${explorerAddr}" target="_blank" rel="noopener" class="deploy-explorer-link">View on Explorer ↗</a>
        </div>`;
      return;
    }

    // ── State: funding sent, on-chain verification pending ──
    if (data.pendingVerification) {
      body.innerHTML = `
        <div class="deploy-section">
          <div class="deploy-contract-name">${esc(data.contractName)}</div>
          <div class="deploy-pending">⏳ Funding sent — verifying on-chain…</div>
        </div>
        <div class="deploy-section">
          <div class="deploy-section-title">Contract Address</div>
          <div class="deploy-address">${esc(data.contractAddress)}</div>
          ${data.txId ? `<div class="deploy-detail"><span class="deploy-detail-label">Funding tx:</span>
            <a href="https://explorer.kaspa.org/transactions/${esc(data.txId)}" target="_blank" rel="noopener" class="deploy-explorer-link">${esc(data.txId.slice(0, 24))}… ↗</a></div>` : ''}
          <div class="deploy-hint">Your KAS left the wallet; the UTXO index just hasn't caught up. Funds are safe on-chain.</div>
        </div>
        ${ksmSection(data)}
        <div class="deploy-actions">
          <button class="btn btn-primary" onclick="App.retryConfirm(${data.contractId}, '${esc(data.txId || '')}')">Check again</button>
        </div>`;
      return;
    }

    body.innerHTML = `
      <div class="deploy-section">
        <div class="deploy-contract-name">${esc(data.contractName)}</div>
        <div class="deploy-success">✅ Deployed to Mainnet</div>
      </div>

      <div class="deploy-section">
        <div class="deploy-section-title">Contract Address</div>
        <div class="deploy-address" onclick="navigator.clipboard.writeText('${esc(data.contractAddress)}'); App.logToConsole('Address copied');">
          ${esc(data.contractAddress)}
          <span class="deploy-copy-hint">click to copy</span>
        </div>
        <div style="margin-top:8px;">
          <a href="${explorerAddr}" target="_blank" rel="noopener" class="deploy-explorer-link">
            View contract on Explorer ↗
          </a>
        </div>
      </div>

      ${shareSection(data, 'Share with the parties')}

      ${ksmSection(data)}

      ${data.txId ? `
      <div class="deploy-section">
        <div class="deploy-section-title">Funding Transaction</div>
        <div class="deploy-detail">
          <span class="deploy-detail-label">Amount:</span> ${data.amountKas ?? data.amountTkas} KAS funded from your wallet
        </div>
        <div class="deploy-detail deploy-mono" style="font-size:11px;word-break:break-all;">
          ${esc(data.txId)}
        </div>
        <div style="margin-top:8px;">
          <a href="${explorerTx}" target="_blank" rel="noopener" class="deploy-explorer-link">
            View funding tx on Explorer ↗
          </a>
        </div>
      </div>` : `
      <div class="deploy-section">
        <div class="deploy-section-title">Funding</div>
        <div class="deploy-info" style="color:var(--warning)">
          ⚠️ Contract address derived but funding transaction failed: ${esc(data.fundingError || 'unknown error')}.<br>
          The contract address is valid - contact support to get it funded manually.
        </div>
      </div>`}

      <div class="deploy-section">
        <div class="deploy-section-title">Script Details</div>
        <div class="deploy-detail"><span class="deploy-detail-label">Size:</span> ${data.scriptSize} bytes</div>
        <div class="deploy-detail"><span class="deploy-detail-label">Hash:</span> <span class="deploy-mono">${esc(data.scriptHash)}</span></div>
        <div class="deploy-detail"><span class="deploy-detail-label">Network:</span> Mainnet</div>
      </div>

      <div class="deploy-section" style="background:var(--surface-2);border-radius:6px;padding:12px;">
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.6;">
          <strong>What just happened:</strong> Your compiled contract was hashed, a P2SH address was derived, and you funded it with KAS from your own wallet.
          View it in <strong>Contracts → My Contracts</strong> to see the full details, spend conditions, and source code.
        </div>
      </div>`;

    document.getElementById('deployModalFooter').innerHTML = `
      <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
      ${shareLink
        ? `<button class="btn btn-primary" onclick="window.open('${esc(shareLink)}', '_blank')">Open the covenant page ↗</button>`
        : `<button class="btn btn-primary" onclick="window.open('${explorerAddr}', '_blank')">View on Explorer ↗</button>`}`;
  }

  // ── showDeployRateLimit ────────────────────────────────────────────────────
  function showDeployRateLimit() {
    const body = document.getElementById('deployModalBody');
    body.innerHTML = `
      <div class="deploy-section">
        <div class="deploy-info" style="color:var(--warning)">
          ⏱️ Deploy limit reached.<br>
          You can deploy up to <strong>3 contracts per hour</strong> during the testnet period.
          Try again in a little while.
        </div>
      </div>`;
    document.getElementById('deployModalFooter').innerHTML = `
      <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>`;
  }

  // ─── Theme ─────────────────────────────────────────
  function applyTheme() {
    const theme = localStorage.getItem('ss_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('ss_theme', next);
    if (editor) {
      monaco.editor.setTheme(next === 'dark' ? 'vs-dark' : 'vs');
    }
  }

  // ─── Bottom Panel ──────────────────────────────────
  function toggleBottomPanel() {
    bottomPanelVisible = !bottomPanelVisible;
    document.getElementById('bottomPanel').classList.toggle('collapsed', !bottomPanelVisible);
    document.getElementById('bottomPanelToggle').classList.toggle('collapsed', !bottomPanelVisible);
    if (editor) editor.layout();
  }

  function switchPanelTab(tab) {
    document.querySelectorAll('.panel-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.getElementById('panelCompiler').style.display = tab === 'compiler' ? '' : 'none';
    document.getElementById('panelHex').style.display = tab === 'hex' ? '' : 'none';
    document.getElementById('panelConsole').style.display = tab === 'console' ? '' : 'none';
  }

  // ─── Modals ────────────────────────────────────────
  function showModal(id) {
    document.getElementById('modalOverlay').classList.add('visible');
    const modal = document.getElementById(id);
    modal.classList.add('visible');
    modal.scrollTop = 0;
    const body = modal.querySelector('.modal-body');
    if (body) body.scrollTop = 0;
  }

  function closeModal() {
    const visibleModals = Array.from(document.querySelectorAll('.modal.visible'));
    if (visibleModals.length > 1) {
      // Multiple modals stacked — close only the topmost (last opened)
      visibleModals[visibleModals.length - 1].classList.remove('visible');
    } else {
      // Single modal or none — close everything including overlay
      document.getElementById('modalOverlay').classList.remove('visible');
      visibleModals.forEach(m => m.classList.remove('visible'));
    }
  }

  // ─── Context Menu ──────────────────────────────────
  function showFileContextMenu(e, fileId) {
    e.preventDefault();
    e.stopPropagation();
    const menu = document.getElementById('contextMenu');
    menu.innerHTML = `
      <button onclick="App.switchToFile(${fileId}); App.hideContextMenu();">Open</button>
      <button onclick="App.renameFile(${fileId}); App.hideContextMenu();">Rename</button>
      <button onclick="App.duplicateFile(${fileId}); App.hideContextMenu();">Duplicate</button>
      <div class="separator"></div>
      <button onclick="App.compileFileById(${fileId}); App.hideContextMenu();">Compile</button>
      <button onclick="App.downloadFileById(${fileId}); App.hideContextMenu();">Download .sil</button>
      <div class="separator"></div>
      <button onclick="App.deleteFile(${fileId}); App.hideContextMenu();" style="color:var(--error)">Delete</button>
    `;
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.classList.add('visible');
  }

  function hideContextMenu() {
    document.getElementById('contextMenu').classList.remove('visible');
  }

  function setupContextMenuListeners() {
    document.addEventListener('click', hideContextMenu);
    document.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('.file-item')) hideContextMenu();
    });
  }

  // ─── Auth ──────────────────────────────────────────
  // Decode the JWT payload the widget hands us (no signature check here — the
  // server does that). Redirect-style logins (Kasla) may come back with a token
  // but no user object, so the address in the token is the fallback identity.
  function decodeTokenPayload(token) {
    try {
      const part = String(token).split('.')[1];
      if (!part) return null;
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
      return JSON.parse(atob(b64));
    } catch (_) { return null; }
  }

  function userFromToken(token, user) {
    const u = (user && typeof user === 'object') ? { ...user } : {};
    if (!u.address) {
      const payload = decodeTokenPayload(token);
      if (!payload || !payload.address) return null;
      u.address = payload.address;
      if (!u.publicKey && payload.publicKey) u.publicKey = payload.publicKey;
      if (!u.userId && payload.userId) u.userId = payload.userId;
    }
    return u;
  }

  // Single entry point for "the widget says we're connected" — used by the
  // modal callback, the post-redirect callback, and the page-load restore.
  function onWalletConnected(data) {
    if (!data || !data.token) return;
    const user = userFromToken(data.token, data.user);
    if (!user) {
      logToConsole('Connected, but the session token carries no wallet address — please reconnect');
      return;
    }
    const prevKey = workspaceKey();
    authToken = data.token;
    connectedWallet = data.walletType || localStorage.getItem('kc_wallet') || null;
    currentUser = user;
    userPubkey = currentUser.publicKey || currentUser.profile?.public_key || null;
    localStorage.setItem('kc_user', JSON.stringify(currentUser));
    if (workspaceKey() !== prevKey) { saveWorkspaceNow(prevKey); if (editor) loadWorkspace(); }
    renderAuth();
    pingSession('connect');
    logToConsole(`Connected via ${connectedWallet || 'account'}: ${formatAddress(currentUser.address)}`);
    if (userPubkey) logToConsole('Public key available for contract deployment');
    hideStart();
    if (startPendingDescribe) { startPendingDescribe = false; showAiGenerate(); }
  }

  // ── Session must follow the wallet's active account ──────────────
  // A withdrawal pays the session's address, so a session minted for one
  // account and a wallet now on another would pay the wrong party. Two
  // guards: drop the session when the extension switches accounts, and
  // compare accounts right before anything is signed.
  async function activeExtensionAddress() {
    try {
      if (connectedWallet === 'kasware' && window.kasware) {
        const a = await window.kasware.getAccounts();
        return (a && a[0]) || null;
      }
      if (connectedWallet === 'kastle' && window.kastle) {
        const i = await window.kastle.getAccount();
        return (i && i.address) || null;
      }
      if (connectedWallet === 'kaspire' && hasKaspire()) {
        const a = await kaspireRequest('getAccounts');
        return (a && a[0]) || null;
      }
    } catch (_) {}
    return null;   // hosted account (Kasla) or unknown: nothing to compare
  }

  async function assertSessionMatchesWallet() {
    if (!currentUser) throw new Error('Not connected');
    const active = await activeExtensionAddress();
    if (active && active !== currentUser.address) {
      throw new Error(`Your wallet is on ${formatAddress(active)} but this session belongs to ${formatAddress(currentUser.address)}. Reconnect with the account you want to use.`);
    }
  }

  let _accountWatchBound = false;
  function watchAccountSwitch() {
    if (_accountWatchBound) return;
    const handler = (accounts) => {
      const next = Array.isArray(accounts) ? accounts[0] : (accounts && accounts.address) || null;
      if (!currentUser || !next || next === currentUser.address) return;
      logToConsole(`Wallet switched to ${formatAddress(next)} — session for ${formatAddress(currentUser.address)} ended, please reconnect`);
      logout();
      showLogin();
    };
    try { if (window.kasware && typeof window.kasware.on === 'function') { window.kasware.on('accountsChanged', handler); _accountWatchBound = true; } } catch (_) {}
    try { if (window.kastle && typeof window.kastle.on === 'function') { window.kastle.on('accountsChanged', handler); _accountWatchBound = true; } } catch (_) {}
    try { if (hasKaspire() && typeof window.kaspire.on === 'function') { window.kaspire.on('accountsChanged', handler); _accountWatchBound = true; } } catch (_) {}
  }

  async function checkAuth() {
    // Catch a connect that lands after this runs (redirect logins resolve async)
    if (typeof window.KasperoConnect !== 'undefined') {
      KasperoConnect.onConnect = onWalletConnected;
    }
    watchAccountSwitch();
    setTimeout(watchAccountSwitch, 1500);   // extensions inject late sometimes

    const kcToken = localStorage.getItem('kc_token');
    const kcWallet = localStorage.getItem('kc_wallet');
    const kcUserStr = localStorage.getItem('kc_user');

    if (kcToken) {
      let stored = null;
      try { stored = kcUserStr ? JSON.parse(kcUserStr) : null; } catch (_) { stored = null; }
      const user = userFromToken(kcToken, stored);
      if (user) {
        currentUser = user;
        authToken = kcToken;
        connectedWallet = kcWallet;
        userPubkey = currentUser.publicKey || currentUser.profile?.public_key || null;
        if (!kcUserStr) localStorage.setItem('kc_user', JSON.stringify(currentUser));
        logToConsole(`Session restored: ${formatAddress(currentUser.address)} via ${kcWallet || 'account'}`);
        pingSession('restore');
      }
    }
    renderAuth();
  }

  // ── Presence ping: the Studio's own record of who is here ────────
  // connect = a sign-in; restore/heartbeat = "this tab is open". Every two
  // minutes while signed in, and again when the tab comes back to the front.
  let _pingTimer = null;
  function pingSession(event) {
    if (!authToken) return;
    fetch('/api/session/ping', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: event || 'heartbeat', walletType: connectedWallet || null, page: 'studio' })
    }).catch(() => {});
    if (!_pingTimer) _pingTimer = setInterval(() => pingSession('heartbeat'), 120000);
  }
  function stopPing() { if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; } }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pingSession('heartbeat'); });

  function formatAddress(addr) {
    if (!addr) return '';
    if (addr.length > 20) return addr.slice(0, 12) + '…' + addr.slice(-6);
    return addr;
  }

  function renderAuth() {
    const el = document.getElementById('authArea');
    if (currentUser && authToken) {
      const displayName = currentUser.username || currentUser.email || formatAddress(currentUser.address) || 'Connected';
      const walletBadge = connectedWallet ? `<span class="wallet-badge">${connectedWallet}</span>` : '';
      el.innerHTML = `${walletBadge}<span class="user-name">${esc(displayName)}</span><button onclick="App.logout()">Disconnect</button>`;
    } else {
      el.innerHTML = `<button onclick="App.showLogin()">Connect Wallet</button>`;
    }

    // Gate AI Generate and Contracts menu behind wallet auth
    const aiBtn = document.querySelector('.ai-menu-btn');
    const contractsMenu = document.querySelector('.contracts-menu');
    if (currentUser && authToken) {
      if (aiBtn) aiBtn.style.display = '';
      if (contractsMenu) contractsMenu.style.display = '';
    } else {
      if (aiBtn) aiBtn.style.display = 'none';
      if (contractsMenu) contractsMenu.style.display = 'none';
    }
  }

  async function showLogin() {
    if (typeof window.KasperoConnect === 'undefined') {
      logToConsole('KasperoConnect widget not loaded');
      return;
    }

    KasperoConnect.connect({
      merchant: 'kpm_v90br29k',
      wallets: ['kasware', 'kastle', 'kaspire', 'kasla'],
      theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
      modalTitle: 'Connect to SilverScript Studio',
      onConnect: onWalletConnected,
      onCancel: function() {
        logToConsole('Wallet connection cancelled');
      },
      onError: function(err) {
        logToConsole('Connection error: ' + err);
      }
    });
  }

  function logout() {
    stopPing();
    saveWorkspaceNow();            // this wallet's tabs come back on the next connect
    authToken = null;
    currentUser = null;
    connectedWallet = null;
    userPubkey = null;
    if (typeof window.KasperoConnect !== 'undefined') {
      KasperoConnect.disconnect();
    }
    if (editor) loadWorkspace();   // the not-connected set (welcome on a first visit)
    renderAuth();
    logToConsole('Disconnected');
    showStart();
  }

  function getUserPubkey() {
    return userPubkey;
  }

  // ─── Editor Actions ────────────────────────────────
  function editorAction(action) {
    if (!editor) return;
    switch (action) {
      case 'undo': editor.trigger('menu', 'undo'); break;
      case 'redo': editor.trigger('menu', 'redo'); break;
      case 'find': editor.trigger('menu', 'actions.find'); break;
      case 'replace': editor.trigger('menu', 'editor.action.startFindReplaceAction'); break;
      case 'comment': editor.trigger('menu', 'editor.action.commentLine'); break;
    }
    editor.focus();
  }

  // ─── File Operations ───────────────────────────────
  function newFile() {
    addFile('untitled.sil', '');
  }

  function loadFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.sil';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!file.name.endsWith('.sil')) {
        logToConsole('Only .sil files are supported');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        addFile(file.name, reader.result);
        logToConsole(`Opened ${file.name}`);
      };
      reader.onerror = () => logToConsole('Failed to read file');
      reader.readAsText(file);
    };
    input.click();
  }

  // ─── Open a covenant file (.ksm) ────────────────────────────────────
  // Read it, let the server verify it and say what the Studio knows, open the source
  // in the editor, and offer "Add to My Contracts" only to a wallet that is a party.
  let _ksmPending = null;   // the file text, for the add call

  function openKsm() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ksm,.json';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => _ksmInspect(String(reader.result || ''), file.name);
      reader.onerror = () => logToConsole('Failed to read file');
      reader.readAsText(file);
    };
    input.click();
  }

  async function _ksmInspect(text, fileName) {
    try { JSON.parse(text); }
    catch (_) { logToConsole(`${fileName} is not a covenant file (not JSON)`); return; }
    _ksmPending = text;
    const title = document.getElementById('redeemTitle');
    const body = document.getElementById('redeemModalBody');
    const footer = document.getElementById('redeemModalFooter');
    title.textContent = 'Covenant file';
    body.innerHTML = `<div class="contracts-loading"><div class="contracts-spinner"></div><span>Checking ${esc(fileName)}…</span></div>`;
    footer.innerHTML = `<button class="btn btn-secondary" onclick="App.closeModal()">Close</button>`;
    showModal('redeemModal');

    let data;
    try {
      const r = await fetch('/api/ksm/inspect', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authToken ? { 'Authorization': 'Bearer ' + authToken } : {}),
        body: JSON.stringify({ manifest: text })
      });
      data = await r.json();
    } catch (e) {
      body.innerHTML = `<div class="deploy-section"><div class="deploy-warning">Could not reach the Studio: ${esc(e.message)}</div></div>`;
      return;
    }
    if (!data.success) {
      body.innerHTML = `
        <div class="deploy-section">
          <div class="deploy-warning">⚠ ${esc(data.error || 'This file could not be read')}</div>
          ${(data.errors || []).length ? `<ul class="ksm-errs" style="margin:10px 0 0 18px;font-size:12px;color:var(--text-secondary);">${data.errors.map(x => `<li style="word-break:break-all">${esc(x)}</li>`).join('')}</ul>` : ''}
        </div>`;
      logToConsole(`${fileName}: ${data.error || 'not usable'}`);
      return;
    }

    const sm = data.summary, st = data.studio, you = data.you;
    title.textContent = sm.name || 'Covenant file';
    if (sm.hasSource) {
      const fname = String(sm.name || 'covenant').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) + '.sil';
      addFile(fname, sm.source);
      logToConsole(`Opened ${fileName}: verified, source loaded as ${fname}`);
    } else {
      logToConsole(`Opened ${fileName}: verified (no source in the file)`);
    }

    const myAddr = you && you.address;
    const roles = you ? you.roles : [];
    const partyNames = sm.parties.map(p => p.role).filter((v, i, a) => a.indexOf(v) === i);
    const rolesText = list => list.map(r => `<b>${esc(r)}</b>`).join(' and ');
    let verdict = '', action = '';
    if (st.yours) {
      verdict = `<div class="deploy-success">✅ Already in your covenants.</div>`;
      action = st.shareUrl ? `<button class="btn btn-primary" onclick="window.open('${esc(st.shareUrl)}', '_blank')">Open the covenant page ↗</button>` : '';
    } else if (!myAddr) {
      verdict = `<div class="deploy-info">Verified: this file matches its address on ${esc(sm.network)}.${st.exists ? ' This covenant is already in the Studio.' : ''} Connect the wallet that is one of its parties (${esc(partyNames.join(', ') || 'none listed')}) to add it to your covenants.</div>`;
      action = `<button class="btn btn-primary" onclick="App.closeModal(); App.showLogin();">Connect wallet</button>`;
    } else if (st.exists && st.party) {
      verdict = `<div class="deploy-info">This covenant is already in the Studio, and your wallet is the ${rolesText(roles.length ? roles : ['party'])} in it.</div>`;
      action = `<button class="btn btn-primary" onclick="App._ksmAdd(this)">Add to my covenants</button>`;
    } else if (st.exists) {
      verdict = `<div class="deploy-warning">This is someone else's covenant. It is already in the Studio, and your wallet (${esc(truncAddr(myAddr, true))}) is not one of its parties.</div>
        <div class="deploy-hint">You can read it; the source is open in the editor${sm.hasSource ? '' : ' (this file has none)'}.</div>`;
    } else if (roles.length) {
      verdict = `<div class="deploy-info">Verified. Your wallet is the ${rolesText(roles)} in this covenant, and it isn't in the Studio yet.</div>`;
      action = `<button class="btn btn-primary" onclick="App._ksmAdd(this)">Add to My Contracts</button>`;
    } else {
      verdict = `<div class="deploy-warning">This is someone else's covenant. Its parties are ${esc(partyNames.join(', ') || 'not listed')}, and your wallet (${esc(truncAddr(myAddr, true))}) is not one of them.</div>
        <div class="deploy-hint">You can read it; the source is open in the editor${sm.hasSource ? '' : ' (this file has none)'}. Only a party can add it to their covenants.</div>`;
    }

    const paths = sm.paths.map(p => {
      const bits = [`${p.sigCount} signature${p.sigCount === 1 ? '' : 's'}${p.signers && p.signers.length ? ' (' + p.signers.map(esc).join(', ') + ')' : ''}`];
      if (p.lockLabel) bits.push(esc(p.lockLabel));
      if (p.payTo) bits.push('pays only to ' + esc(truncAddr(p.payTo, true)));
      return `<div class="deploy-detail"><span class="deploy-mono">${esc(p.name)}(${p.params.map(x => esc(x.type)).join(', ')})</span> · ${bits.join(' · ')}</div>`;
    }).join('');
    const parties = sm.parties.map(p => `<div class="deploy-detail"><span class="deploy-detail-label">${esc(p.role)}${p.creator ? ' (creator)' : ''}:</span> <span class="deploy-mono" style="font-size:11px">${esc(p.address)}</span>${myAddr && p.address === myAddr ? ' <b>· you</b>' : ''}</div>`).join('');

    body.innerHTML = `
      <div class="deploy-section">${verdict}</div>
      <div class="deploy-section">
        <div class="deploy-section-title">Address</div>
        <div class="deploy-address" onclick="navigator.clipboard.writeText('${esc(sm.address)}'); App.logToConsole('Address copied');">${esc(sm.address)}<span class="deploy-copy-hint">click to copy</span></div>
        <div style="margin-top:8px;"><a href="https://explorer.kaspa.org/addresses/${esc(sm.address)}" target="_blank" rel="noopener" class="deploy-explorer-link">View on Explorer ↗</a></div>
      </div>
      <div class="deploy-section">
        <div class="deploy-section-title">Spend paths</div>
        ${paths}
      </div>
      ${parties ? `<div class="deploy-section"><div class="deploy-section-title">Parties</div>${parties}</div>` : ''}
      ${(sm.warnings || []).length ? `<div class="deploy-section" style="border-bottom:none;"><div class="deploy-section-title">Notes</div>${sm.warnings.map(w => `<div class="deploy-hint">${esc(w)}</div>`).join('')}</div>` : ''}`;
    footer.innerHTML = `<button class="btn btn-secondary" onclick="App.closeModal()">Close</button>${action}`;
  }

  async function _ksmAdd(btn) {
    if (!_ksmPending || !authToken) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    let data;
    try {
      const r = await fetch('/api/ksm/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
        body: JSON.stringify({ manifest: _ksmPending })
      });
      data = await r.json();
    } catch (e) { data = { success: false, error: e.message }; }
    const body = document.getElementById('redeemModalBody');
    const footer = document.getElementById('redeemModalFooter');
    if (!data.success) {
      if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
      body.insertAdjacentHTML('afterbegin', `<div class="deploy-section"><div class="deploy-warning">⚠ ${esc(data.error || 'Could not add it')}</div></div>`);
      return;
    }
    _ksmPending = null;
    const headline = data.added ? 'Added to your covenants.' : data.joined ? 'Added: you joined it as a party.' : 'Already in your covenants.';
    body.innerHTML = `
      <div class="deploy-section">
        <div class="deploy-success">✅ ${headline}</div>
        <div class="deploy-hint">It is in My Contracts now, with its own covenant page. Withdrawals and signing work the same as for covenants you deployed here.</div>
      </div>`;
    footer.innerHTML = `
      <button class="btn btn-secondary" onclick="App.closeModal(); App.showMyContracts();">My Contracts</button>
      ${data.shareUrl ? `<button class="btn btn-primary" onclick="window.open('${esc(data.shareUrl)}', '_blank')">Open the covenant page ↗</button>` : ''}`;
    logToConsole(headline);
  }

  function saveFile() {
    const f = files.find(f => f.id === activeFileId);
    if (f) {
      f.dirty = false;
      renderFileList();
      renderTabs();
      logToConsole(`Saved ${f.filename}`);
    }
  }

  function downloadSil() {
    const f = files.find(f => f.id === activeFileId);
    if (!f) return;
    downloadText(f.filename, f.content);
  }

  function downloadFileById(id) {
    const f = files.find(f => f.id === id);
    if (f) downloadText(f.filename, f.content);
  }

  function compileFileById(id) {
    if (activeFileId !== id) switchToFile(id);
    setTimeout(compile, 50);
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

/* ═══════════════════════════════════════════════════════
   AI Contract Generator — Frontend Functions (with message)
      ═══════════════════════════════════════════════════════ */

  // ─── AI Generate (Conversational v2) ────────────────
  let aiGeneratedCode = '';
  let aiConversation = [];   // { role: 'user'|'assistant', content }
  let aiGenerating = false;

  function showAiGenerate() {
    if (!currentUser) {
      logToConsole('Connect a wallet to use AI Generate');
      return;
    }
    // Reset state
    aiGeneratedCode = '';
    aiConversation = [];
    aiGenerating = false;
    document.getElementById('aiPromptInput').value = '';
    document.getElementById('aiError').style.display = 'none';
    document.getElementById('aiCodePanel').style.display = 'none';
    document.getElementById('aiUseCodeBtn').style.display = 'none';
    document.getElementById('aiPreviewCode').textContent = '';
    document.getElementById('aiWelcome').style.display = '';
    document.getElementById('aiMessages').innerHTML = '';
    document.getElementById('aiSendBtn').disabled = false;
    document.getElementById('aiSendBtnIcon').style.display = '';
    document.getElementById('aiSendSpinner').style.display = 'none';
    showModal('aiModal');
    setTimeout(() => document.getElementById('aiPromptInput').focus(), 100);
  }

  function aiSuggest(btn) {
    document.getElementById('aiPromptInput').value = btn.textContent;
    aiGenerate();
  }

  function aiToggleSuggestions(toggleBtn) {
    const box = document.getElementById('aiSuggestions');
    const isOpen = box.classList.toggle('open');
    toggleBtn.classList.toggle('open', isOpen);
  }

  function sanitizeAiCode(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let code = raw.trim();
    code = code.replace(/^```(?:silverscript|sil|javascript|js)?\s*\n?/i, '');
    code = code.replace(/\n?```\s*$/i, '');
    // No tag stripping: `<` / `>` are comparisons here, and the code is shown with textContent
    if (!code.includes('pragma') && !code.includes('contract') && !code.startsWith('//')) return null;
    return code.trim();
  }

  function _addChatMessage(role, text) {
    // Hide welcome on first message
    document.getElementById('aiWelcome').style.display = 'none';
    const container = document.getElementById('aiMessages');
    const div = document.createElement('div');
    div.className = 'ai-v2-msg ' + role;
    div.textContent = text;
    container.appendChild(div);
    // Scroll chat to bottom
    const chatArea = document.getElementById('aiChatArea');
    chatArea.scrollTop = chatArea.scrollHeight;
    return div;
  }

  function _setAiSending(busy) {
    aiGenerating = busy;
    const btn = document.getElementById('aiSendBtn');
    btn.disabled = busy;
    document.getElementById('aiSendBtnIcon').style.display = busy ? 'none' : '';
    document.getElementById('aiSendSpinner').style.display = busy ? 'inline-block' : 'none';
  }

  async function aiGenerate() {
    const input = document.getElementById('aiPromptInput');
    const prompt = input.value.trim();
    if (!prompt || aiGenerating) return;
    if (prompt.length > 5000) {
      showAiError('Description too long — keep it under 1000 words.');
      return;
    }
    document.getElementById('aiError').style.display = 'none';

    // Add user message to chat
    _addChatMessage('user', prompt);
    aiConversation.push({ role: 'user', content: prompt });
    input.value = '';
    input.style.height = 'auto';

    // Show thinking indicator
    const thinkingEl = _addChatMessage('thinking', 'Generating');
    _setAiSending(true);

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
        body: JSON.stringify({ messages: aiConversation })
      });

      const data = await res.json();

      // Remove thinking indicator
      thinkingEl.remove();

      if (!res.ok || data.error) {
        showAiError(data.error || 'Generation failed — try again');
        // Remove last user message from conversation since it failed
        aiConversation.pop();
        return;
      }

      // Show AI message in chat
      if (data.message) {
        _addChatMessage('assistant', data.message);
      }

      // Track assistant response in conversation
      const assistantContent = (data.message || '') + (data.code ? '\n---CODE---\n' + data.code : '');
      if (assistantContent.trim()) {
        aiConversation.push({ role: 'assistant', content: assistantContent });
      }

      // Update code panel if we got code
      if (data.code) {
        const clean = sanitizeAiCode(data.code);
        if (clean) {
          aiGeneratedCode = clean;
          document.getElementById('aiPreviewCode').textContent = clean;
          document.getElementById('aiCodePanel').style.display = '';
          document.getElementById('aiUseCodeBtn').style.display = '';
          logToConsole('AI generated a contract — review it in the modal');
        }
      }
    } catch (err) {
      thinkingEl.remove();
      showAiError('Network error — check your connection');
      aiConversation.pop();
      console.error('AI generate error:', err);
    } finally {
      _setAiSending(false);
      input.focus();
    }
  }

  function aiUseCode() {
    if (!aiGeneratedCode) return;
    const nameMatch = aiGeneratedCode.match(/contract\s+([A-Za-z_]\w*)/);
    const name = nameMatch ? nameMatch[1].toLowerCase() : 'generated';
    const safeName = name.replace(/[^a-z0-9_]/g, '');
    const filename = (safeName || 'generated') + '.sil';

    closeModal();
    addFile(filename, aiGeneratedCode);
    logToConsole('AI contract loaded into ' + filename + ' — review, edit, then compile');
  }

  function showAiError(msg) {
    const el = document.getElementById('aiError');
    el.textContent = msg;
    el.style.display = 'block';
  }

  // ─── Help Modals ───────────────────────────────────
  // ─── My Contracts Panel ──────────────────
  // Cached contracts from last fetch - used by redeployContract(id)
  let _savedContracts = [];

  // Chain is truth: a covenant address is reusable, so a past withdrawal
  // (redeemedAt) never makes it terminal. Live balance decides; the DB only
  // fills in while balances are still loading.
  function _contractStatus(c) {
    if (c._liveBalance === undefined) return 'unknown';        // chain not answered yet (or RPC failed)
    if (c._liveBalance >= 1000000) return 'funded';            // 1000000 sompi = 0.01 KAS
    return c.redeemedAt ? 'redeemed' : 'empty';                // 'redeemed' = withdrawn, balance zero
  }

  function _formatDeployedAt(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  }


// ─── STEP 1: Add _isSpendable() ─────────────────────────────────
// Paste right after _contractStatus() (around line 2182)

  function _isSpendable(c) {
    // External covenant (I'm a party, not the deployer): only if an entry checks my key.
    // Minimal gate; the rules engine (locks, thresholds, proposals) is the next item.
    // Deployer status is not a spend path either: if every entry checks someone
    // else's key, the button stays off for the deployer too.
    const noPath = c.hasSpendPath === false ||
      (c.hasSpendPath === undefined && c.relation === 'external' && !(c.mySpendPaths || []).length);
    if (noPath) return { spendable: false, reason: 'Not your spend path' };
    const status = _contractStatus(c);
    if (status === 'unknown')  return { spendable: false, reason: 'Balance not loaded yet' };
    if (status === 'redeemed') return { spendable: false, reason: 'Withdrawn (balance is zero)' };
    if (status !== 'funded')   return { spendable: false, reason: 'Not funded' };

    const src = c.sourceCode || '';

    // Relative lock. v1: this.ageDaa >= N blocks (~10 per second on mainnet).
    // Legacy tn12-era sources: this.age >= N units.
    const daaMatch = src.match(/this\.ageDaa\s*>=\s*(\d[\d_]*)/);
    const ageMatch = daaMatch || src.match(/this\.age\s*>=\s*(\d+)\s*(days?|hours?|minutes?|seconds?|weeks?)/);
    if (ageMatch) {
      const lockNum = parseInt(ageMatch[1].replace(/_/g, ''));
      const lockUnit = daaMatch ? 'daa' : ageMatch[2].replace(/s$/, '');
      const unitToSec = { day: 86400, hour: 3600, minute: 60, second: 1, week: 604800, daa: 0.1 };
      const lockSecs = lockNum * (unitToSec[lockUnit] || 1);
      const deployDate = new Date(c.deployedAt);
      const elapsedSecs = (Date.now() - deployDate.getTime()) / 1000;
      if (elapsedSecs < lockSecs) {
        const remainDays = Math.ceil((lockSecs - elapsedSecs) / 86400);
        return { spendable: false, reason: 'Unlocks in ' + remainDays + 'd' };
      }
    }

    // Absolute time lock: date("...")
    const dateMatch = src.match(/date\("([^"]+)"\)/);
    if (dateMatch) {
      const lockDate = new Date(dateMatch[1]);
      if (Date.now() < lockDate.getTime()) {
        const remainDays = Math.ceil((lockDate.getTime() - Date.now()) / 86400000);
        return { spendable: false, reason: 'Unlocks in ' + remainDays + 'd' };
      }
    }

    return { spendable: true, reason: null };
  }


// ════════════════════════════════════════════════════════════════════════════
// showMyContracts() — Show Contracts Table
// ════════════════════════════════════════════════════════════════════════════
  // ── State for table sort/filter (lives in App closure) ─────────────
  let _mcSort = { col: 'status', dir: 'asc' };   // status = the ready order (see _mcReadiness)
  let _mcSearch = '';
  let _mcFilterStatus = 'all';   // legacy, unused since the tabs
  let _mcTab = 'all';            // all | spendable | locked | shared | kcc20 | empty
  let _mcExpandedId = null;
  let _mcShowArchived = false;
  let _mcPage = 1;
  let _mcPageSize = 10;

  async function showMyContracts(expandId) {
    if (!authToken) {
      logToConsole('Connect your wallet to view deployed contracts');
      return;
    }
    const body = document.getElementById('contractsModalBody');
    body.innerHTML = '<div class="contracts-loading"><div class="contracts-spinner"></div><span>Loading contracts...</span></div>';
    showModal('contractsModal');

    try {
      const fetchUrl = _mcShowArchived ? '/api/contracts?include_archived=true' : '/api/contracts';
      const res = await fetch(fetchUrl, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      const data = await res.json();

      if (!data.success) {
        body.innerHTML = `<div class="contracts-empty">Failed to load contracts: ${esc(data.error || 'Unknown error')}</div>`;
        return;
      }

      if (!data.contracts || data.contracts.length === 0) {
        body.innerHTML = `
          <div class="contracts-empty">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            <div class="contracts-empty-title">No contracts yet</div>
            <div class="contracts-empty-sub">Deploy a contract to see it here</div>
          </div>`;
        return;
      }

      // Server already deduplicates by address, but keep full list for lookups
      _savedContracts = data.contracts;

      // Reset expand state on fresh load
      _mcExpandedId = null;

      // Paint from the server's snapshot (no node wait), then ask for a fresh check
      _mcApplyStatuses(data.contracts, null, data.serverNow);

      // Render the full table UI
      _renderContractsTable(body, data.contracts);

      // One batched chain check for every row; rows that moved flash once
      _mcRefresh();
      _mcStartAutoRefresh();

      // Open straight onto one covenant (used after joining via a share link)
      if (expandId) {
        const target = data.contracts.find(c => c.id === expandId || (c.allIds || []).includes(expandId));
        if (target) {
          _mcSearch = ''; _mcTab = 'all'; _mcPage = 1;
          _mcRebuildRows(data.contracts);
          showContractDetail(target.id);
        }
      }

    } catch (err) {
      body.innerHTML = `<div class="contracts-empty">Network error: ${esc(err.message)}</div>`;
    }
  }

  // ── Snapshot (CONTRACT_STATUS) → row fields ─────────────────────
  // c.status is the server's dated copy of the chain (null = not checked yet).
  // _liveBalance stays the field the rest of the page reads.
  let _mcSkew = 0;                 // server clock minus ours, so "ago" and "in" agree with the server
  let _mcLastCheck = null;         // newest checkedAt across rows
  let _mcNodeError = null;
  let _mcRefreshing = false;
  let _mcAutoTimer = null;
  const _mcNow = () => Date.now() + _mcSkew;

  function _mcApplyStatuses(contracts, refresh, serverNow) {
    if (serverNow) _mcSkew = Number(serverNow) - Date.now();
    for (const c of contracts) {
      if (refresh) {
        if (refresh.statuses && refresh.statuses[c.contractAddress]) c.status = refresh.statuses[c.contractAddress];
        if (refresh.proposals) c.openProposals = refresh.proposals[c.contractAddress] || [];
        c._checkDone = true;
      }
      if (c.status) {
        c._liveBalance = c.status.balanceSompi;
        if (!_mcLastCheck || c.status.checkedAt > _mcLastCheck) _mcLastCheck = c.status.checkedAt;
      }
    }
  }

  function _mcAgo(ms) {
    const s = Math.max(0, Math.round((_mcNow() - ms) / 1000));
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    if (h < 48) return h + ' h ago';
    return Math.round(h / 24) + ' days ago';
  }
  function _mcIn(ms) {
    const s = Math.max(0, Math.round((ms - _mcNow()) / 1000));
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min';
    if (s < 172800) return Math.round(s / 3600) + ' h';
    return Math.round(s / 86400) + ' days';
  }

  function _mcUpdateCheckedLine() {
    const el = document.getElementById('mcChecked');
    if (!el) return;
    if (_mcRefreshing && !_mcLastCheck) { el.textContent = 'checking the chain…'; return; }
    let t = _mcLastCheck ? 'checked ' + _mcAgo(_mcLastCheck) : 'not checked yet';
    if (_mcNodeError) t += ' · node unreachable, showing the last check';
    el.textContent = t;
  }

  async function _mcRefresh() {
    const container = document.getElementById('contractsModalBody');
    const contracts = container && container._mcContracts;
    if (!contracts || _mcRefreshing || !authToken) return;
    _mcRefreshing = true;
    _mcUpdateCheckedLine();
    try {
      const resp = await fetch('/api/contracts/refresh', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: '{}'
      });
      const ct = resp.headers.get('content-type') || '';
      if (!ct.includes('application/json')) { _mcNodeError = 'HTTP ' + resp.status; return; }
      const data = await resp.json();
      if (!data.success) { _mcNodeError = data.error || 'refresh failed'; return; }
      _mcNodeError = data.nodeError || null;
      const before = _mcVisibleIds();
      _mcApplyStatuses(contracts, data, data.serverNow);
      const moved = new Set(data.moved || []);
      const order = _mcFilterAndSort(contracts).map(c => c.id);
      if (before.join(',') !== order.join(',')) {
        _mcRebuildRows(contracts);                              // something changed place
        if (_mcExpandedId) _loadContractHistory(_mcExpandedId);
        _mcFlash(contracts, moved);
      } else {
        _mcPatchRows(contracts, moved);
      }
    } catch (err) {
      _mcNodeError = err.message;
    } finally {
      _mcRefreshing = false;
      _mcUpdateCheckedLine();
    }
  }

  // Ids of every row the filter keeps, in the order shown
  function _mcVisibleIds() {
    const container = document.getElementById('contractsModalBody');
    const contracts = container && container._mcContracts;
    return contracts ? _mcFilterAndSort(contracts).map(c => c.id) : [];
  }
  function _mcFlash(contracts, moved) {
    for (const c of contracts) {
      if (!moved.has(c.contractAddress)) continue;
      const row = document.getElementById(`mc-row-${c.id}`);
      if (row && row.animate)
        row.animate([{ backgroundColor: 'rgba(212, 175, 55, 0.28)' }, { backgroundColor: 'transparent' }], { duration: 1800, easing: 'ease-out' });
    }
  }

  // Replace visible rows in place (an open detail row and its history stay as they are)
  function _mcPatchRows(contracts, moved) {
    for (const c of contracts) {
      const row = document.getElementById(`mc-row-${c.id}`);
      if (!row) continue;
      const tmp = document.createElement('tbody');
      tmp.innerHTML = _mcRenderRow(c).trim();
      const fresh = tmp.firstElementChild;
      if (!fresh) continue;
      row.replaceWith(fresh);
      if (moved.has(c.contractAddress) && fresh.animate)
        fresh.animate([{ backgroundColor: 'rgba(212, 175, 55, 0.28)' }, { backgroundColor: 'transparent' }], { duration: 1800, easing: 'ease-out' });
    }
  }

  // While My Contracts is open: the "checked … ago" line ticks every 30 s and the
  // chain is asked every 60 s (the server skips rows its own watcher checked recently)
  function _mcStartAutoRefresh() {
    clearInterval(_mcAutoTimer);
    let n = 0;
    _mcAutoTimer = setInterval(() => {
      const modal = document.getElementById('contractsModal');
      if (!modal || !modal.classList.contains('visible')) { clearInterval(_mcAutoTimer); _mcAutoTimer = null; return; }
      n++;
      if (n % 2 === 0) _mcRefresh(); else _mcUpdateCheckedLine();
    }, 30000);
  }

  // Where a row stands for me, for the default order:
  //   0 ready   money here and a path of mine open now (largest first)
  //   1 locked  money here, my soonest path opens later (soonest first)
  //   2 others  money here, no path of mine at all (largest first)
  //   3 empty   nothing here, or never checked (newest first)
  function _mcReadiness(c) {
    const bal = c._liveBalance;
    if (bal === undefined || bal < 1000000) return { group: 3, wait: 0, bal: bal || 0 };
    const mine = Array.isArray(c.myPaths) ? c.myPaths
      : (c.hasSpendPath === false ? [] : (c.mySpendPaths || []));
    if (!mine.length) return { group: 2, wait: 0, bal };
    const opens = c.status && c.status.opensAt;
    if (!opens) {
      const sp = _isSpendable(c);                           // before the first check: the source estimate
      return sp.spendable ? { group: 0, wait: 0, bal } : { group: 1, wait: Infinity, bal };
    }
    const now = _mcNow();
    let wait = Infinity;
    for (const name of mine) {
      const o = opens[name];
      const w = !o ? 0 : (o.at === null ? Infinity : Math.max(0, o.at - now));
      if (w < wait) wait = w;
    }
    return wait === 0 ? { group: 0, wait: 0, bal } : { group: 1, wait, bal };
  }
  // Tabs. One tab per contract, first match wins: a covenant ID (KCC20) → no balance
  // (Empty) → someone else's covenant I'm a party of (Shared With You) → none of my
  // paths open yet (Time Locked) → Spendable. A covenant of mine with money but no path
  // for my key, or one the node hasn't answered for yet, shows under All only.
  const MC_TABS = [
    { key: 'all',       label: 'All' },
    { key: 'spendable', label: 'Spendable' },
    { key: 'locked',    label: 'Time Locked' },
    { key: 'shared',    label: 'Shared With You' },
    { key: 'kcc20',     label: 'KCC20' },
    { key: 'empty',     label: 'Empty' },
  ];
  function _mcCategory(c) {
    if (c.covenantId) return 'kcc20';
    const st = _contractStatus(c);
    if (st === 'redeemed' || st === 'empty') return 'empty';
    if (c.relation === 'external') return 'shared';
    if (st === 'unknown') return 'other';
    const r = _mcReadiness(c);
    if (r.group === 0) return 'spendable';
    if (r.group === 1) return 'locked';
    return 'other';
  }
  // A covenant-ID row: a real KCC-20 token once its program declares KCC20State,
  // until then the launchpad's genesis test covenant.
  function _mcKind(c) {
    if (!c.covenantId) return null;
    return /KCC20State/.test(c.sourceCode || '') ? 'KCC-20' : 'Genesis';
  }
  function _mcRenderTabs(contracts) {
    const el = document.getElementById('mcTabs');
    if (!el) return;
    const base = contracts.filter(c => _mcShowArchived ? !!c.archivedAt : !c.archivedAt);
    const counts = { all: base.length };
    for (const c of base) { const k = _mcCategory(c); counts[k] = (counts[k] || 0) + 1; }
    el.innerHTML = MC_TABS.map(t =>
      `<button class="mc-tab${_mcTab === t.key ? ' mc-tab-active' : ''}" role="tab" aria-selected="${_mcTab === t.key}" onclick="App._mcSetTab('${t.key}')">${t.label}<span class="mc-tab-count">${counts[t.key] || 0}</span></button>`
    ).join('');
  }
  function _mcSetTab(key) {
    _mcTab = key; _mcPage = 1;
    const container = document.getElementById('contractsModalBody');
    if (container && container._mcContracts) _mcRebuildRows(container._mcContracts);
  }

  function _mcReadyCompare(a, b) {
    const ra = _mcReadiness(a), rb = _mcReadiness(b);
    if (ra.group !== rb.group) return ra.group - rb.group;
    if (ra.group === 1 && ra.wait !== rb.wait) return ra.wait - rb.wait;
    if (ra.group === 3) return new Date(b.deployedAt) - new Date(a.deployedAt);
    return rb.bal - ra.bal;
  }

  // Lock cell from the snapshot: the soonest path still closed, by name
  function _mcLockFromStatus(c) {
    const opens = c.status && c.status.opensAt;
    if (!opens) return null;
    const list = Object.entries(opens);
    if (!list.length) return null;
    const now = _mcNow();
    const closed = list.filter(([, o]) => o.at !== null && o.at > now).sort((a, b) => a[1].at - b[1].at);
    const waiting = list.filter(([, o]) => o.at === null);
    if (closed.length) {
      const [name, o] = closed[0];
      const when = new Date(o.at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `<span class="mc-lock-pending" title="${esc(name)} opens ${esc(when)}">${esc(name)} in ${_mcIn(o.at)}</span>`;
    }
    if (waiting.length && !(c.status.utxoCount > 0)) {
      const [name, o] = waiting[0];
      const d = o.waitDays !== null && o.waitDays !== undefined ? (o.waitDays >= 1 ? (+o.waitDays.toFixed(1)) + 'd' : Math.round(o.waitDays * 24) + 'h') : '';
      return `<span class="mc-cell-muted" title="${esc(name)} counts from each deposit">${esc(name)}: ${d} after a deposit</span>`;
    }
    return '<span class="mc-lock-done">✓ Open</span>';
  }

 async function _mcFetchLiveBalances(contracts) {
    // Collect unique addresses
    const addressSet = new Set();
    for (const c of contracts) addressSet.add(c.contractAddress);
    // Chain is truth: poll every covenant on this network, whether or not the
    // DB knows of a deposit (coins can arrive without going through the Studio).
    const addresses = [...addressSet].filter(addr => typeof addr === 'string' && addr.startsWith('kaspa:'));
    if (addresses.length === 0) return;

    try {
      const resp = await fetch('/api/balances', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ addresses })
      });

      // Handle non-JSON responses (nginx 429, 502, etc.)
      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        console.warn(`[Balance] Non-JSON response (${resp.status})`);
        return;
      }

      const data = await resp.json();
      if (!data.success || !data.balances) return;

      // Apply balances to contracts
      for (const c of contracts) {
        const bal = data.balances[c.contractAddress];
        if (bal !== null && bal !== undefined) {
          c._liveBalance = bal;
        }
      }

      // Update all visible cells
      for (const [addr, bal] of Object.entries(data.balances)) {
        if (bal !== null) _mcUpdateBalanceCell(addr, bal);
      }
    } catch (err) {
      console.warn('[Balance] Batch fetch failed:', err.message);
    }
  }

  function _mcUpdateBalanceCell(address, balanceSompi) {
    const rows = document.querySelectorAll('.mc-row');
    for (const row of rows) {
      if (row.dataset.address !== address) continue;

      // Update balance cell
      const balCell = row.querySelector('.mc-td-locked');
      if (balCell) {
        const tkas = balanceSompi / 1e8;
        if (tkas >= 0.01) {
          const display = tkas >= 1000 ? (tkas / 1000).toFixed(1) + 'K' :
                          tkas >= 1 ? tkas.toFixed(2) :
                          tkas.toFixed(4);
          balCell.innerHTML = `<span class="mc-cell-bright">${display} KAS</span>`;
        } else {
          balCell.innerHTML = `<span class="mc-cell-muted">0 KAS</span>`;
        }
        balCell.classList.remove('mc-balance-loading');
      }

      // Update status badge
      const statusCell = row.querySelector('.mc-td-status');
      if (statusCell) {
        const wasRedeemed = row.dataset.redeemed === 'true';
        if (balanceSompi >= 1000000) {
          statusCell.innerHTML = '<span class="mc-status-badge mc-status-funded">Active</span>';
        } else if (wasRedeemed) {
          statusCell.innerHTML = '<span class="mc-status-badge mc-status-archived">Withdrawn</span>';
        } else {
          statusCell.innerHTML = '<span class="mc-status-badge mc-status-unfunded">Empty</span>';
        }
      }
    }
  }

  // Age lock cell (approximation from source; the rules engine in the spend
  // flow is the authority). v1: this.ageDaa >= N blocks (~864,000/day).
  // Legacy tn12 sources: this.age >= N units. Absolute: date("...").
  function _mcAgeLockHtml(src, c) {
    const daaMatch  = src.match(/this\.ageDaa\s*>=\s*(\d[\d_]*)/);
    const ageMatch  = daaMatch ? null : src.match(/this\.age\s*>=\s*(\d+)\s*(days?|hours?|minutes?|seconds?|weeks?)/);
    const dateMatch = src.match(/date\("([^"]+)"\)/);
    let lockDays = null;
    if (daaMatch) {
      lockDays = parseInt(daaMatch[1].replace(/_/g, ''), 10) / 864000;
    } else if (ageMatch) {
      const unitToDays = { day: 1, hour: 1/24, minute: 1/1440, second: 1/86400, week: 7 };
      lockDays = parseInt(ageMatch[1], 10) * (unitToDays[ageMatch[2].replace(/s$/, '')] || 1);
    }
    if (lockDays !== null) {
      const elapsedDays = (Date.now() - new Date(c.deployedAt).getTime()) / 86400000;
      if (elapsedDays >= lockDays) return '<span class="mc-lock-done">✓ Matured</span>';
      const pct = Math.min(100, Math.round((elapsedDays / lockDays) * 100));
      return `
          <div class="mc-lock-inline" title="~${Math.round(lockDays * 864000).toLocaleString()} blocks, measured from the deposit">
            <div class="mc-lock-bar"><div class="mc-lock-fill" style="width:${pct}%"></div></div>
            <span class="mc-lock-text">${Math.floor(elapsedDays)}/${Math.ceil(lockDays)}d</span>
          </div>`;
    }
    if (dateMatch) {
      const lockDate = new Date(dateMatch[1]);
      if (Date.now() >= lockDate.getTime()) return '<span class="mc-lock-done">✓ Unlocked</span>';
      return `<span class="mc-lock-pending">${Math.ceil((lockDate.getTime() - Date.now()) / 86400000)}d left</span>`;
    }
    return '<span class="mc-cell-muted">—</span>';
  }

  function _mcRenderRow(c) {
    const status = _contractStatus(c);
    const src = c.sourceCode || '';
    const isExpanded = _mcExpandedId === c.id;

    // ── Status badge ────────────────────────────────────────────────
    const statusMap = {
      funded:   { label: 'Active',   cls: 'mc-status-funded' },
      redeemed: { label: 'Withdrawn', cls: 'mc-status-archived' },
      empty:    { label: 'Empty',    cls: 'mc-status-unfunded' },
      unknown:  { label: c._checkDone ? 'Not checked' : 'Checking…', cls: 'mc-status-archived' },
    };
    let st = statusMap[status] || statusMap.unknown;
    if (status === 'funded') {
      const r = _mcReadiness(c);
      st = r.group === 0 ? { label: 'Ready', cls: 'mc-status-funded' }
         : r.group === 1 ? { label: 'Locked', cls: 'mc-status-archived' }
         : { label: 'Not yours', cls: 'mc-status-archived' };
    }

    // ── Balance display ─────────────────────────────────────────────
    let balanceHtml;
    let balanceLoadingClass = '';
    if (c._liveBalance !== undefined) {
      // Live balance available
      const tkas = c._liveBalance / 1e8;
      if (tkas >= 0.01) {
        const display = tkas >= 1000 ? (tkas / 1000).toFixed(1) + 'K' :
                        tkas >= 1 ? tkas.toFixed(2) :
                        tkas.toFixed(4);
        balanceHtml = `<span class="mc-cell-bright">${display} KAS</span>`;
      } else {
        balanceHtml = `<span class="mc-cell-muted">0 KAS</span>`;
      }
    } else if (c._checkDone) {
      // Chain is truth: never a 0 we didn't read
      balanceHtml = `<span class="mc-cell-muted" title="The node has not answered for this address yet">not checked yet</span>`;
    } else {
      balanceHtml = `<span class="mc-cell-muted" title="Waiting for the node">…</span>`;
      balanceLoadingClass = ' mc-balance-loading';
    }
    if (c.status && c.status.checkedAt) {
      const moved = c.status.movedAt ? ' · last moved ' + _mcAgo(c.status.movedAt) : '';
      balanceHtml = `<span title="Checked ${esc(_mcAgo(c.status.checkedAt))}${esc(moved)}">${balanceHtml}</span>`;
    }

    // ── Age lock (snapshot first; source reading only before the first check) ──
    const ageLockHtml = _mcLockFromStatus(c) || _mcAgeLockHtml(src, c);

    // ── Open proposals: whose turn ──────────────────────────────────
    const props = c.openProposals || [];
    let proposalBadge = '';
    if (props.length) {
      const mine = props.find(p => p.you === 'sign');
      const p0 = mine || props[0];
      proposalBadge = mine
        ? `<span class="mc-relation-badge" title="${esc(p0.entry)}: ${p0.signedCount} of ${p0.requiredCount} signed">your turn to sign</span>`
        : `<span class="mc-relation-badge" title="${esc(p0.entry)}: waiting on ${esc((p0.waitingOn || []).join(', '))}">${p0.signedCount}/${p0.requiredCount} signed</span>`;
    }

    // ── Created date ────────────────────────────────────────────────
    const createdDisplay = _mcFormatDate(c.deployedAt);

    // ── Truncated address ───────────────────────────────────────────
    const addr = c.contractAddress;
    const colonIdx = addr.indexOf(':');
    const prefix = addr.slice(0, colonIdx + 1);
    const rest = addr.slice(colonIdx + 1);
    const truncated = prefix + rest.slice(0, 5) + '…' + rest.slice(-5);

    // ── Relation badge (external = party via share link, with my role) ──
    const isExternal = c.relation === 'external';
    const relationBadge = isExternal
      ? `<span class="mc-relation-badge" title="Shared with you: you are ${esc((c.myRoles || []).join(', ') || 'a party')}">external${(c.myRoles || []).length ? ' · ' + esc(c.myRoles.join(', ')) : ''}</span>`
      : '';

    // ── Kind badge for covenant-ID rows (archive lives on the details page now) ──
    const kind = _mcKind(c);
    const kindBadge = kind ? `<span class="mc-kind-badge mc-kind-${kind === 'KCC-20' ? 'kcc20' : 'genesis'}" title="Covenant ID ${esc(c.covenantId)}">${kind}</span>` : '';
    // ── Funding count badge (shows if multiple fundings) ────────────
    const fundingCount = (c.fundingHistory || []).length;
    const fundingBadge = fundingCount > 1
      ? `<span class="mc-funding-count" title="${fundingCount} funding transactions">${fundingCount}×</span>`
      : '';

    return `
      <tr class="mc-row${isExpanded ? ' mc-row-expanded' : ''} mc-row-${status}" id="mc-row-${c.id}"
          data-address="${esc(addr)}" data-redeemed="${!!c.redeemedAt}"
          onclick="App.showContractDetail(${c.id})" title="Open details">
        <td class="mc-td mc-td-name">
          ${_mcTypeIcon(src)}
          <span class="mc-name">${esc(c.contractName)}</span>
          ${kindBadge}
          ${relationBadge}
          ${proposalBadge}
          ${fundingBadge}
        </td>
        <td class="mc-td mc-td-status">
          <span class="mc-status-badge ${st.cls}">${st.label}</span>
        </td>
        <td class="mc-td mc-td-locked${balanceLoadingClass}">${balanceHtml}</td>
        <td class="mc-td mc-td-agelock">${ageLockHtml}</td>
        <td class="mc-td mc-td-created">${createdDisplay}</td>
        <td class="mc-td mc-td-address" title="${esc(addr)}">
          <span class="mc-addr-text">${truncated}</span>
        </td>
      </tr>`;
  }

  // ── Main render ────────────────────────────────────────────────────
function _renderContractsTable(container, contracts) {
    // ── Toolbar ──────────────────────────────────────────────────────
    let html = `
      <div class="mc-toolbar">
        <div class="mc-toolbar-left">
          <span class="mc-count">${contracts.length}</span>
          <span class="mc-cell-muted" id="mcChecked" style="margin-left:10px;font-size:11px;"></span>
        </div>
        <div class="mc-toolbar-right">
          <div class="mc-search-wrap">
            <svg class="mc-search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="text" class="mc-search" id="mcSearch" placeholder="Search contracts..." value="${esc(_mcSearch)}" />
          </div>
          <button class="mc-archive-toggle${_mcShowArchived ? ' mc-archive-toggle-active' : ''}" id="mcArchiveToggle" title="${_mcShowArchived ? 'Showing archived contracts' : 'Show archived contracts'}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
            Archived
          </button>
        </div>
      </div>
      <div class="mc-tabs" id="mcTabs" role="tablist" aria-label="Contract categories"></div>`;

    // ── Table (empty tbody — _mcRebuildRows populates it) ───────────
    html += `<div class="mc-table-wrap"><table class="mc-table"><thead><tr>`;

    const columns = [
      { key: 'name',    label: 'Name',     sortable: true },
      { key: 'status',  label: 'Status',   sortable: true },
      { key: 'locked',  label: 'Balance',  sortable: true },
      { key: 'agelock', label: 'Age Lock',  sortable: false },
      { key: 'created', label: 'Created',  sortable: true },
      { key: 'address', label: 'Address',  sortable: false },
    ];

    for (const col of columns) {
      const isActive = _mcSort.col === col.key;
      const sortAttr = col.sortable ? ` onclick="App._mcSortBy('${col.key}')" style="cursor:pointer;"` : '';
      const sortIcon = col.sortable
        ? `<span class="mc-sort-icon${isActive ? ' mc-sort-active' : ''}">${isActive ? (_mcSort.dir === 'asc' ? '▲' : '▼') : '⇅'}</span>`
        : '';
      html += `<th class="mc-th mc-th-${col.key}"${sortAttr}>${col.label}${sortIcon}</th>`;
    }
    html += `</tr></thead><tbody id="mcTableBody"></tbody></table></div>`;

    // ── Pagination footer ───────────────────────────────────────────
    html += `<div class="mc-footer" id="mcFooter"></div>`;

    container.innerHTML = html;

    // ── Wire up events ──────────────────────────────────────────────
    const searchEl = document.getElementById('mcSearch');

    // Debounced search
    let searchTimer;
    searchEl.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        _mcSearch = searchEl.value;
        _mcPage = 1;
        _mcRebuildRows(contracts);
      }, 150);
    });


    // Archive toggle — re-fetches from server since archived contracts aren't in the current data set
    const archiveToggle = document.getElementById('mcArchiveToggle');
    archiveToggle.addEventListener('click', () => {
      _mcShowArchived = !_mcShowArchived;
      showMyContracts(); // re-fetch with or without archived
    });

    // Store contracts ref for sort rebuilds, then populate via _mcRebuildRows
    container._mcContracts = contracts;
    _mcPage = 1;
    _mcRebuildRows(contracts);
    _mcUpdateCheckedLine();
  }

  // ── Rebuild just the table body (called on search/filter/sort change) ─
  function _mcRebuildRows(contracts) {
          const tbody = document.getElementById('mcTableBody');
          if (!tbody) return;
          const filtered = _mcFilterAndSort(contracts);

          // Pagination
          const totalPages = Math.max(1, Math.ceil(filtered.length / _mcPageSize));
          if (_mcPage > totalPages) _mcPage = totalPages;
          const startIdx = (_mcPage - 1) * _mcPageSize;
          const pageItems = filtered.slice(startIdx, startIdx + _mcPageSize);

          if (filtered.length === 0) {
                tbody.innerHTML = `<tr><td colspan="6" class="mc-empty-row">${_mcSearch ? 'No contracts match your search' : _mcTab !== 'all' ? 'Nothing here right now' : 'No contracts deployed yet'}</td></tr>`;
          } else {
                let html = '';
                for (const c of pageItems) {
                  html += _mcRenderRow(c);
                  if (_mcExpandedId === c.id) {
                        html += _mcRenderExpanded(c);
                  }
                }
                tbody.innerHTML = html;
          }

          _mcRenderTabs(contracts);

          // Update count
          const countEl = document.querySelector('.mc-count');
          if (countEl) countEl.textContent = filtered.length;

          // Update sort header highlights
          document.querySelectorAll('.mc-th').forEach(th => {
                const icon = th.querySelector('.mc-sort-icon');
                if (!icon) return;
                const col = th.className.match(/mc-th-(\w+)/)?.[1];
                const isActive = _mcSort.col === col;
                icon.classList.toggle('mc-sort-active', isActive);
                icon.textContent = isActive ? (_mcSort.dir === 'asc' ? '▲' : '▼') : '⇅';
          });

          // Update footer / pagination
          _mcRenderPagination(filtered.length, totalPages, startIdx, pageItems.length);
        }

        // ── NEW: Render pagination footer ───────────────────────────────────
        function _mcRenderPagination(totalCount, totalPages, startIdx, pageCount) {
          const footer = document.getElementById('mcFooter');
          if (!footer) return;

          const from = totalCount === 0 ? 0 : startIdx + 1;
          const to = startIdx + pageCount;

          let html = `
                <div class="mc-footer-info">
                  <span class="mc-footer-range">${from}–${to}</span> of ${totalCount} contracts
                </div>`;

          if (totalPages > 1) {
                html += `<div class="mc-pagination">`;

                // Prev button
                html += `<button class="mc-page-btn" onclick="App._mcGoToPage(${_mcPage - 1})" ${_mcPage <= 1 ? 'disabled' : ''}>‹</button>`;

                // Page buttons — show at most 7 buttons with ellipsis
                const maxButtons = 7;
                let pages = [];
                if (totalPages <= maxButtons) {
                  for (let i = 1; i <= totalPages; i++) pages.push(i);
                } else {
                  pages.push(1);
                  if (_mcPage > 3) pages.push('...');
                  const start = Math.max(2, _mcPage - 1);
                  const end = Math.min(totalPages - 1, _mcPage + 1);
                  for (let i = start; i <= end; i++) pages.push(i);
                  if (_mcPage < totalPages - 2) pages.push('...');
                  pages.push(totalPages);
                }

                for (const p of pages) {
                  if (p === '...') {
                        html += `<span class="mc-page-ellipsis">…</span>`;
                  } else {
                        html += `<button class="mc-page-btn${p === _mcPage ? ' mc-page-active' : ''}" onclick="App._mcGoToPage(${p})">${p}</button>`;
                  }
                }

                // Next button
                html += `<button class="mc-page-btn" onclick="App._mcGoToPage(${_mcPage + 1})" ${_mcPage >= totalPages ? 'disabled' : ''}>›</button>`;
                html += `</div>`;
          }

          footer.innerHTML = html;
        }

        // ── "Go to page" handler ─────────────────────────────────────────
        function _mcGoToPage(page) {
          _mcPage = page;
          const container = document.getElementById('contractsModalBody');
          if (container._mcContracts) _mcRebuildRows(container._mcContracts);
          // Scroll table to top on page change
          const wrap = document.querySelector('.mc-table-wrap');
          if (wrap) wrap.scrollTop = 0;
        }

  // ── Filter + sort logic ───────────────────────────────────────────
  function _mcFilterAndSort(contracts) {
    let data = [...contracts];

    // Archived filter: when toggle is active, show ONLY archived; otherwise exclude them
    if (_mcShowArchived) {
      data = data.filter(c => !!c.archivedAt);
    } else {
      data = data.filter(c => !c.archivedAt);
    }

    // Search
    if (_mcSearch) {
      const q = _mcSearch.toLowerCase();
      data = data.filter(c =>
        c.contractName.toLowerCase().includes(q) ||
        c.contractAddress.toLowerCase().includes(q)
      );
    }

    // Status filter
    if (_mcTab !== 'all') {
      data = data.filter(c => _mcCategory(c) === _mcTab);
    }

    // Sort
    data.sort((a, b) => {
      const dir = _mcSort.dir === 'asc' ? 1 : -1;
      switch (_mcSort.col) {
        case 'name':    return dir * a.contractName.localeCompare(b.contractName);
        case 'status':  return dir * _mcReadyCompare(a, b);
        case 'locked': {
                  const aVal = a._liveBalance !== undefined ? a._liveBalance : (a.amountTkas || 0) * 1e8;
                  const bVal = b._liveBalance !== undefined ? b._liveBalance : (b.amountTkas || 0) * 1e8;
                  return dir * (aVal - bVal);
                }
        case 'created': return dir * (new Date(a.deployedAt) - new Date(b.deployedAt));
        default: return 0;
      }
    });

    return data;
  }

  // ── Sort handler (called from onclick on th) ──────────────────────
  function _mcSortBy(col) {
    if (_mcSort.col === col) {
      _mcSort.dir = _mcSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      _mcSort = { col, dir: 'asc' };
    }
    const container = document.getElementById('contractsModalBody');
    if (container._mcContracts) _mcRebuildRows(container._mcContracts);
  }

  // ── On-chain activity panel ─────────────────────────────────
  async function _loadContractHistory(contractId) {
    const el = document.getElementById(`mc-history-${contractId}`);
    if (!el) return;
    try {
      const res = await fetch(`/api/contracts/${contractId}/history`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      const data = await res.json();
      const box = document.getElementById(`mc-history-${contractId}`);
      if (!box) return; // row collapsed meanwhile
      if (!data.success) {
        box.innerHTML = `<span class="mc-history-loading">${esc(data.error || 'History unavailable')}</span>`;
        return;
      }
      if (!data.events.length) {
        box.innerHTML = `<span class="mc-history-loading">No on-chain activity yet</span>`;
        return;
      }
      box.innerHTML = data.events.map(e => {
        const kas = (Number(e.amountSompi) / 1e8).toFixed(4).replace(/\.?0+$/, '');
        const sign = e.direction === 'deposit' ? '+' : '−';
        const cls = e.direction === 'deposit' ? 'mc-h-in' : 'mc-h-out';
        const label = e.direction === 'deposit'
          ? (e.viaStudio ? 'Deposit · via Studio' : 'Deposit')
          : 'Withdrawal';
        const when = e.time ? new Date(e.time).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
        return `
          <div class="mc-h-row">
            <span class="mc-h-amount ${cls}">${sign}${kas} KAS</span>
            <span class="mc-h-label">${label}${e.accepted ? '' : ' · pending'}</span>
            <span class="mc-h-when">${when}</span>
            <a href="https://explorer.kaspa.org/transactions/${esc(e.txId)}" target="_blank" rel="noopener"
               class="mc-h-tx" onclick="event.stopPropagation();">${esc(e.txId.slice(0, 8))}… ↗</a>
          </div>`;
      }).join('');
    } catch (err) {
      const box = document.getElementById(`mc-history-${contractId}`);
      if (box) box.innerHTML = `<span class="mc-history-loading">Could not load activity</span>`;
    }
  }

  // ── Toggle row expand ─────────────────────────────────────────────
  function _mcToggleExpand(id) {
    _mcExpandedId = _mcExpandedId === id ? null : id;
    const container = document.getElementById('contractsModalBody');
    if (container._mcContracts) _mcRebuildRows(container._mcContracts);
    if (_mcExpandedId === id) _loadContractHistory(id);
  }

  // ── Archive / Unarchive a contract ─────────────────────────────────
  async function _mcArchiveContract(id, archive, btnEl) {
    const endpoint = archive ? `/api/contracts/${id}/archive` : `/api/contracts/${id}/unarchive`;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (!data.success) {
        logToConsole('Archive failed: ' + (data.error || 'Unknown error'));
        return;
      }

      // Fade out the row, then rebuild
      const row = document.getElementById(`mc-row-${id}`);
      if (row) {
        row.style.transition = 'opacity 0.3s ease';
        row.style.opacity = '0';
        // Also fade the expanded row if open
        if (_mcExpandedId === id) {
          const expandedRow = row.nextElementSibling;
          if (expandedRow && expandedRow.classList.contains('mc-expanded-row')) {
            expandedRow.style.transition = 'opacity 0.3s ease';
            expandedRow.style.opacity = '0';
          }
          _mcExpandedId = null;
        }
        setTimeout(() => {
          // Update the cached contract data
          const c = _savedContracts.find(x => x.id === id);
          if (c) c.archivedAt = archive ? new Date().toISOString() : null;
          // Also update in the container's contract list
          const container = document.getElementById('contractsModalBody');
          if (container._mcContracts) {
            const cc = container._mcContracts.find(x => x.id === id);
            if (cc) cc.archivedAt = archive ? new Date().toISOString() : null;
            _mcRebuildRows(container._mcContracts);
          }
          logToConsole(archive ? 'Contract archived' : 'Contract unarchived');
        }, 300);
      }
    } catch (err) {
      logToConsole('Archive error: ' + err.message);
    }
  }

  function _mcArchiveFromDetail(id, archive) {
    closeModal();
    _mcArchiveContract(id, archive);
  }

  // ── Contract type icon (SVG, uses currentColor for theme compat) ──
  function _mcTypeIcon(src) {
    // Detect type from source code patterns
    const hasMultiSig = (src.match(/checkSig/g) || []).length > 1;
    const hasCovenant = /tx\.outputs\[/.test(src);
    const hasTimeLock = /this\.age(?:Daa)?\s*>=|date\(/.test(src);

    if (hasMultiSig || /arbitrat/i.test(src)) {
      // Escrow / multi-party
      return '<svg class="mc-type-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
    }
    if (hasTimeLock && !hasCovenant) {
      // Timelock
      return '<svg class="mc-type-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
    }
    if (hasCovenant) {
      // Covenant
      return '<svg class="mc-type-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
    }
    // Generic contract
    return '<svg class="mc-type-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>';
  }

  // ── Render a single table row ─────────────────────────────────────
function _mcRenderExpanded(c) {
    const src = c.sourceCode || '';
    const explorerAddr = `https://explorer.kaspa.org/addresses/${c.contractAddress}`;

    // ── Age lock progress bar (full version for expand) ─────────────
    let ageLockBar = '';
    // v1: this.ageDaa >= N blocks (~864,000/day). Legacy: this.age >= N units.
    const daaMatch = src.match(/this\.ageDaa\s*>=\s*(\d[\d_]*)/);
    const ageMatch = daaMatch || src.match(/this\.age\s*>=\s*(\d+)\s*(days?|hours?|minutes?|seconds?|weeks?)/);
    const dateMatch = src.match(/date\("([^"]+)"\)/);

    if (ageMatch) {
      const unitToDays = { day: 1, hour: 1/24, minute: 1/1440, second: 1/86400, week: 7 };
      const lockDays = daaMatch
        ? parseInt(daaMatch[1].replace(/_/g, ''), 10) / 864000
        : parseInt(ageMatch[1], 10) * (unitToDays[ageMatch[2].replace(/s$/, '')] || 1);
      const deployDate = new Date(c.deployedAt);
      const now = new Date();
      const elapsedDays = (now - deployDate) / 86400000;
      const pct = Math.min(100, Math.round((elapsedDays / lockDays) * 100));
      const remain = Math.max(0, Math.ceil(lockDays - elapsedDays));
      const done = elapsedDays >= lockDays;

      ageLockBar = `
        <div class="mc-exp-row">
          <span class="mc-exp-label">Age Lock</span>
          <div class="mc-exp-progress">
            <div class="mc-exp-bar"><div class="mc-exp-fill${done ? ' mc-exp-fill-done' : ''}" style="width:${pct}%"></div></div>
            <span class="mc-exp-hint">${done ? '✓ Matured' : pct + '% — ' + remain + 'd remaining'}</span>
          </div>
        </div>`;
    } else if (dateMatch) {
      const lockDate = new Date(dateMatch[1]);
      const now = new Date();
      const done = now >= lockDate;
      const remainDays = done ? 0 : Math.ceil((lockDate - now) / 86400000);
      ageLockBar = `
        <div class="mc-exp-row">
          <span class="mc-exp-label">Time Lock</span>
          <span class="mc-exp-hint">${done ? '✓ Unlocked' : remainDays + ' days remaining — ' + dateMatch[1]}</span>
        </div>`;
    }

    // ── Entrypoint pills ────────────────────────────────────────────
    const entrypoints = src.match(/\b(?:entry|entrypoint\s+function)\s+(\w+)/g) || [];
    const fnNames = entrypoints.map(e => e.trim().split(/\s+/).pop());
    const fnPills = fnNames.length > 0
      ? `<div class="mc-exp-row">
          <span class="mc-exp-label">Functions</span>
          <div class="mc-exp-pills">${fnNames.map(n => `<span class="mc-fn-pill">${esc(n)}()</span>`).join('')}</div>
        </div>`
      : '';

    // ── Activity — live from chain, loaded on expand ──────────────
    const fundingHistoryHtml = `
        <div class="mc-exp-row mc-exp-funding-history">
          <span class="mc-exp-label">Activity</span>
          <div class="mc-history" id="mc-history-${c.id}"><span class="mc-history-loading">Loading on-chain activity…</span></div>
        </div>`;

    const spend = _isSpendable(c);
    const partiesHtml = _partiesRowHtml(c);
    const shareBtn = c.shareToken ? `
              <button class="mc-btn-secondary" onclick="event.stopPropagation(); App.copyShareLink(${c.id}, this);" title="Copy the link the other parties open to join this covenant">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                Share with parties
              </button>` : '';

    return `
      <tr class="mc-expanded-row" onclick="event.stopPropagation();">
        <td colspan="6" class="mc-expanded-cell">
          <div class="mc-exp-panel">

            <div class="mc-exp-row">
              <span class="mc-exp-label">Address</span>
              <code class="mc-exp-address">${esc(c.contractAddress)}</code>
              <button class="mc-btn-copy" onclick="event.stopPropagation(); navigator.clipboard.writeText('${esc(c.contractAddress)}'); this.textContent='Copied!'; setTimeout(()=>this.textContent='Copy',1500);">Copy</button>
            </div>

            ${ageLockBar}
            ${fnPills}
            ${partiesHtml}
            ${fundingHistoryHtml}

            <div class="mc-exp-actions">
              <button class="mc-btn-primary" onclick="event.stopPropagation(); App.showContractDetail(${c.id});">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                Details
              </button>
              <button class="mc-btn-secondary" onclick="event.stopPropagation(); App.openContractInEditor(${c.id});">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
                Open in Editor
              </button>
              <a href="${explorerAddr}" target="_blank" rel="noopener" class="mc-btn-secondary mc-btn-link" onclick="event.stopPropagation();">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
               Explorer ↗
               </a>${shareBtn}${c.shareToken ? `
              <a href="${esc(ksmUrl(c.shareToken))}" download class="mc-btn-secondary mc-btn-link" onclick="event.stopPropagation();" title="The covenant as a file: with it and your key you can withdraw using any compatible tool, even without the Studio">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                .ksm
              </a>` : ''}
               <button class="mc-btn-spend${spend.spendable ? '' : ' mc-btn-spend-disabled'}"
                 onclick="event.stopPropagation(); ${spend.spendable ? `App.redeemContract(${c.id});` : ''}"
                 ${spend.spendable ? '' : 'disabled'}
                 ${spend.reason ? `title="${esc(spend.reason)}"` : ''}>
                 <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 7l-5-5-5 5"/></svg>
                 Spend${spend.reason && !spend.spendable ? ' · ' + esc(spend.reason) : ''}
               </button>
             </div>
          </div>
        </td>
      </tr>`;
  }

  // ── Parties (participants) ────────────────────────────────────────
  function _partyChip(p) {
    const short = formatAddress(p.address);
    return `<span class="mc-party${p.isYou ? ' mc-party-you' : ''}" title="${esc(p.address)}">
        <span class="mc-party-role">${esc(p.role)}</span>
        <span class="mc-party-addr">${esc(short)}</span>${p.isYou ? '<span class="mc-party-tag">you</span>' : ''}${p.isCreator ? '<span class="mc-party-tag mc-party-tag-creator">creator</span>' : ''}
      </span>`;
  }

  function _partiesRowHtml(c) {
    const parties = c.parties || [];
    if (!parties.length) return '';
    return `
        <div class="mc-exp-row">
          <span class="mc-exp-label">Parties</span>
          <div class="mc-exp-pills">${parties.map(_partyChip).join('')}</div>
        </div>`;
  }

  function shareLinkFor(c) {
    return c && c.shareToken ? `${location.origin}/c/${c.shareToken}` : null;
  }

  function copyShareLink(contractId, btn) {
    const c = _savedContracts.find(x => x.id === contractId);
    const link = shareLinkFor(c);
    if (!link) return logToConsole('No share link for this covenant yet (run the participants backfill)');
    navigator.clipboard.writeText(link).then(() => {
      logToConsole('Share link copied: ' + link);
      if (btn) { const t = btn.innerHTML; btn.innerHTML = 'Link copied'; setTimeout(() => { btn.innerHTML = t; }, 1500); }
    }).catch(() => logToConsole('Copy failed. Link: ' + link));
  }

  // ── Short date formatter ──────────────────────────────────────────
  function _mcFormatDate(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now - d;
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return diffDays + 'd ago';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }


 function openContractInEditor(contractId) {
    const c = _savedContracts.find(x => x.id === contractId);
    if (!c) return logToConsole('Contract not found');

    const source = c.sourceCode || c.source;
    if (!source) return logToConsole('Source code not available for this contract');

    const filename = c.contractName.replace(/[^a-zA-Z0-9_-]/g, '') + '.sil';
    addFile(filename, source);
    closeModal();
    logToConsole(`Opened ${c.contractName} in editor — edit parameters and deploy a new instance`);
  }

  // ── redeployContract ─────────────────────────────────────────────────────────
  function redeployContract(contractId) {
    const c = _savedContracts.find(x => x.id === contractId);
    if (!c) return logToConsole('Contract not found');
    if (!c.sourceCode && !c.source) return logToConsole('Source code not available for this contract');

    const paramDefs = (c.abi && c.abi.contractParams) || [];
    const savedValues = {};
    for (const p of (c.params || [])) savedValues[p.name] = p.value;

    deployState = {
      source: c.sourceCode || c.source,
      contractName: c.contractName,
      params: paramDefs,
      amountTkas: null,
      functions: (c.abi && c.abi.functions) || [],
      funderRole: null,
      _funderTouched: false
    };

    closeModal();

    const body = document.getElementById('deployModalBody');
    const hasParams = deployState.params.length > 0;

    let html = `
      <div class="deploy-section">
        <div class="deploy-contract-name">${esc(deployState.contractName)}</div>
        <div class="deploy-info">Re-deploying from saved record. Parameters pre-filled — adjust if needed.</div>
      </div>`;

    if (hasParams) {
      html += `<div class="deploy-section">
        <div class="deploy-section-title">Constructor Parameters</div>
        <div class="deploy-section-desc">These values are baked into the compiled bytecode and cannot be changed after deployment.</div>`;
      for (const p of deployState.params) {
        html += renderDeployField(p, savedValues[p.name]);
      }
      html += `</div>`;
    }

    // Deposit — same section as the deploy flow (who deposits, how much)
    html += renderDepositSection(deployState.params.filter(p => p.type === 'pubkey'));

    if (deployState.functions.length > 0) {
      html += `
        <div class="deploy-section">
          <div class="deploy-section-title">Entrypoint Functions (ABI)</div>
          <div class="deploy-section-desc">How funds can be spent from this contract after deployment.</div>
          ${deployState.functions.map(fn => `
            <div class="deploy-abi-fn">
              <span class="fn-name">${esc(fn.name)}</span>
              <span class="fn-params">(${(fn.inputs || fn.params || []).map(p => p.type + ' ' + p.name).join(', ')})</span>
            </div>
          `).join('')}
        </div>`;
    }

    html += `
      <div class="deploy-section">
        <div class="deploy-detail">
          <span class="deploy-detail-label">Network:</span>
          <span class="deploy-network-badge">Mainnet</span>

        </div>
      </div>`;

    body.innerHTML = html;
    body.scrollTop = 0;
    bindFunderDefault(body);

    document.getElementById('deployModalFooter').innerHTML = `
      <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
      <button class="btn btn-primary" id="deployBtn" onclick="App.deployContract()">
        Deploy to Mainnet →
      </button>`;

    document.getElementById('deployTitle').textContent = `Re-deploy: ${deployState.contractName}`;
    showModal('deployModal');
    updateDeployHints();
  }

  // ── redeemContract ────────────────────────────────────────────────────────────
  // Opens a dedicated redeem modal with progress stepper and success screen
  async function redeemContract(contractId) {
    const c = _savedContracts.find(x => x.id === contractId);
    if (!c) return logToConsole('Contract not found in cache');

    // Show the redeem modal with contract info
    const body = document.getElementById('redeemModalBody');
    const footer = document.getElementById('redeemModalFooter');
    document.getElementById('redeemTitle').textContent = `Redeem: ${c.contractName}`;

    const explorerAddr = `https://explorer.kaspa.org/addresses/${c.contractAddress}`;

    body.innerHTML = `
      <div class="deploy-section">
        <div class="deploy-contract-name">${esc(c.contractName)}</div>
        <div class="deploy-info">
          Withdraw funds from this contract to your connected wallet.
          You'll sign a spend transaction — the contract's conditions must be met.
        </div>
      </div>

      <div class="deploy-section">
        <div class="deploy-section-title">Contract Address</div>
        <div class="deploy-address" onclick="navigator.clipboard.writeText('${esc(c.contractAddress)}'); App.logToConsole('Address copied');">
          ${esc(c.contractAddress)}
          <span class="deploy-copy-hint">click to copy</span>
        </div>
      </div>

      ${(c.params || []).length > 0 ? `
      <div class="deploy-section">
        <div class="deploy-section-title">Constructor Parameters</div>
        ${c.params.map(p => {
          const val = String(p.value || '');
          return `
          <div class="deploy-detail">
            <span class="deploy-detail-label">${esc(p.name)}</span>
            <span class="deploy-type">${esc(p.type)}</span>
            <span class="deploy-mono">${esc(val.length > 24 ? val.slice(0, 10) + '…' + val.slice(-6) : val)}</span>
          </div>`;
        }).join('')}
      </div>` : ''}

      ${(c.abi?.functions || []).length > 0 ? `
      <div class="deploy-section">
        <div class="deploy-section-title">Spend Functions</div>
        ${c.abi.functions.map(fn => `
          <div class="deploy-abi-fn">
            <span class="fn-name">${esc(fn.name)}</span>
            <span class="fn-params">(${(fn.inputs || fn.params || []).map(p => (p.type || '') + ' ' + (p.name || '')).join(', ')})</span>
          </div>
        `).join('')}
      </div>` : ''}

      <div class="deploy-section" style="border-bottom:none;">
        <div class="deploy-detail">
          <span class="deploy-detail-label">Network:</span>
          <span class="deploy-network-badge">Mainnet</span>
        </div>
        <div class="deploy-detail">
          <span class="deploy-detail-label">Status:</span>
          <span style="color:#4eca8b;font-weight:500;">Funded</span>
        </div>
      </div>`;

    footer.innerHTML = `
      <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
      <button class="btn btn-primary" id="redeemBtn" onclick="App._executeRedeem(${contractId})">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;vertical-align:-2px;"><path d="M12 2v20M2 12h20"/></svg>
        Redeem to Wallet
      </button>`;

    showModal('redeemModal');
  }

  // ── The working spend flow: build → sign (Kasware) → assemble → broadcast ──
  let _spendState = null;

  // ── Path picker + argument form (multi-path covenants, or paths with args) ──
  function _renderPathForm(contractId, info, selectedEntry, errorMsg) {
    const body = document.getElementById('redeemModalBody');
    const footer = document.getElementById('redeemModalFooter');
    const paths = info.paths || [];
    const eligible = paths.filter(p => p.eligible);
    const chosen = selectedEntry || (eligible[0] && eligible[0].name) || null;

    const argRow = (p, inp) => {
      const t = (inp.type || '').toLowerCase();
      if (t === 'sig') return `<div class="deploy-detail"><span class="deploy-detail-label">${esc(inp.name)}</span> <span class="deploy-type">sig</span> <span class="deploy-hint">your wallet signs this</span></div>`;
      if (t.startsWith('byte[')) {
        ensureEncStyle();
        const enc = t === 'byte[]' ? 'text' : 'hex';
        return `<div class="deploy-field">
          <label class="deploy-label">${esc(inp.name)} <span class="deploy-type">${esc(inp.type)}</span></label>
          <div class="enc-toggle">
            <button type="button" class="enc-opt${enc === 'text' ? ' enc-on' : ''}" onclick="event.preventDefault(); App._encToggle(this, 'text')">Password / text</button>
            <button type="button" class="enc-opt${enc === 'hex' ? ' enc-on' : ''}" onclick="event.preventDefault(); App._encToggle(this, 'hex')">Hex</button>
          </div>
          <input type="text" class="deploy-input" data-path="${esc(p.name)}" data-arg="${esc(inp.name)}" data-enc="${enc}"
            placeholder="${enc === 'text' ? 'password or text, typed exactly' : 'hex bytes'}" autocomplete="off" spellcheck="false">
        </div>`;
      }
      const ph = t === 'pubkey' ? 'kaspa:q… or 64-hex pubkey'
             : t === 'int' ? 'integer' : t === 'temporal' ? 'ms timestamp or ISO date'
             : t === 'string' ? 'text' : t === 'bool' ? 'true / false'
             : 'hex bytes, or text:… for UTF-8';
      return `<div class="deploy-field">
          <label class="deploy-label">${esc(inp.name)} <span class="deploy-type">${esc(inp.type)}</span></label>
          <input type="text" class="deploy-input" data-path="${esc(p.name)}" data-arg="${esc(inp.name)}" placeholder="${esc(ph)}" spellcheck="false">
        </div>`;
    };

    body.innerHTML = `
      <div class="deploy-section">
        <div class="deploy-section-title">Choose a spend path</div>
        ${errorMsg ? `<div class="deploy-error" style="margin-bottom:8px;">${esc(errorMsg)}</div>` : ''}
        ${paths.map(p => `
          <label class="sp-path${p.eligible ? '' : ' sp-path-disabled'}${p.name === chosen ? ' sp-path-selected' : ''}">
            <input type="radio" name="spendPath" value="${esc(p.name)}" ${p.eligible ? '' : 'disabled'} ${p.name === chosen ? 'checked' : ''}
                   onchange="App._spendPathChanged()">
            <div class="sp-path-body">
              <div class="sp-path-head"><span class="deploy-mono">${esc(p.name)}(${(p.inputs || []).map(i => esc(i.type) + ' ' + esc(i.name)).join(', ')})</span>
                ${p.unlocksWithMyKey ? '<span class="mc-party-tag">your key</span>' : ''}</div>
              ${p.lockLabel ? `<div class="deploy-hint">Lock: ${esc(p.lockLabel)}</div>` : ''}
              ${!p.eligible && p.reason ? `<div class="deploy-hint sp-path-reason">${esc(p.reason)}</div>` : ''}
              <div class="sp-path-args" data-for="${esc(p.name)}" style="${p.name === chosen ? '' : 'display:none;'}">
                ${(p.inputs || []).map(inp => argRow(p, inp)).join('')}
              </div>
            </div>
          </label>`).join('')}
      </div>
      <div class="deploy-section" style="border-bottom:none;">
        <div class="deploy-hint">The whole balance at the covenant is swept to your wallet through the chosen path. The network enforces the path's conditions; a rejected transaction moves nothing.</div>
      </div>`;
    footer.innerHTML = `
      <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="App._submitPathForm(${contractId})" ${eligible.length ? '' : 'disabled'}>Continue →</button>`;
  }

  function _spendPathChanged() {
    const sel = document.querySelector('input[name="spendPath"]:checked');
    document.querySelectorAll('.sp-path').forEach(el => el.classList.toggle('sp-path-selected', !!sel && el.querySelector('input').value === sel.value));
    document.querySelectorAll('.sp-path-args').forEach(el => { el.style.display = (sel && el.dataset.for === sel.value) ? '' : 'none'; });
  }

  function _submitPathForm(contractId) {
    const sel = document.querySelector('input[name="spendPath"]:checked');
    if (!sel) return;
    const args = {};
    document.querySelectorAll(`.deploy-input[data-path="${CSS.escape(sel.value)}"]`).forEach(inp => {
      args[inp.dataset.arg] = inp.dataset.enc === 'text' ? 'text:' + inp.value.trim() : inp.value.trim();
    });
    _executeRedeem(contractId, sel.value, args);
  }

  async function _executeRedeem(contractId, entry, args) {
    const body = document.getElementById('redeemModalBody');
    const footer = document.getElementById('redeemModalFooter');
    _spendState = null;

    try {
      body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">Preparing withdrawal…</div>';
      footer.innerHTML = '';

      const kaswareOk = connectedWallet === 'kasware' && !!window.kasware;
      const kaspireOk = connectedWallet === 'kaspire' && hasKaspire();
      const kaslaOk = connectedWallet === 'kasla' && !!authToken;
      if (!kaswareOk && !kaspireOk && !kaslaOk) {
        throw new Error('Withdrawals currently require Kasware, Kaspire or a Kasla account (Kastle support is next)');
      }

      const res = await fetch(`/api/contracts/${contractId}/build-spend`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(entry ? { entry, args: args || {} } : {})
      });
      const info = await res.json();

      // Needs a choice or arguments: show the form (with the reason when a submitted form failed)
      if (!info.success && (info.choosePath || info.badArgs)) {
        return _renderPathForm(contractId, info, entry || null, (info.badArgs && entry) ? info.error : null);
      }
      if (!info.success && info.notEligible) {
        if ((info.paths || []).some(p => p.eligible)) return _renderPathForm(contractId, info, null, info.error);
        body.innerHTML = `
          <div class="deploy-section">
            <div class="redeem-info-banner"><div><strong>No spend path you can use alone right now.</strong> ${esc(info.error || '')}</div></div>
          </div>
          <div class="deploy-section">
            <div class="deploy-section-title">Spend paths</div>
            ${(info.paths || []).map(p => `
              <div class="deploy-detail">
                <span class="deploy-mono">${esc(p.name)}(${(p.inputs || []).map(i => esc(i.type) + ' ' + esc(i.name)).join(', ')})</span>
                ${p.reason ? `<span class="deploy-hint"> · ${esc(p.reason)}</span>` : ''}
              </div>`).join('')}
          </div>`;
        footer.innerHTML = `<button class="btn btn-secondary" onclick="App.closeModal()">Close</button>`;
        return;
      }
      if (!info.success) throw new Error(info.error || 'Failed to build the spend');

      _spendState = { contractId, ...info };
      const amountKas = (Number(info.amountSompi) / 1e8).toFixed(4);
      const feeKas = (Number(info.feeSompi) / 1e8).toFixed(4);
      const receiveKas = ((Number(info.amountSompi) - Number(info.feeSompi)) / 1e8).toFixed(4);

      body.innerHTML = `
        <div class="redeem-hero">
          <div class="redeem-hero-amount">${receiveKas} <span class="redeem-hero-unit">KAS</span></div>
          <div class="redeem-hero-label">will arrive in your wallet</div>
        </div>
        <div class="deploy-section">
          <div class="deploy-detail"><span class="deploy-detail-label">Spend path:</span> <span class="deploy-mono">${esc(info.entrypoint)}()</span></div>
          ${(info.args || []).map(a => `<div class="deploy-detail"><span class="deploy-detail-label">${esc(a.name)}:</span> <span class="deploy-mono" style="font-size:11px;word-break:break-all;">${esc(a.value)}</span></div>`).join('')}
          <div class="deploy-detail"><span class="deploy-detail-label">Withdrawing:</span> ${amountKas} KAS (fee ${feeKas} KAS)</div>
          <div class="deploy-detail"><span class="deploy-detail-label">To:</span> <span class="deploy-mono" style="font-size:11px;">${esc(info.destination)}</span> <span class="deploy-hint">(this session's wallet)</span></div>
          <div class="deploy-detail"><span class="deploy-detail-label">Deposits:</span> sweeping ${info.inputCount} UTXO${info.inputCount > 1 ? 's' : ''} in one transaction</div>
          ${info.remainingUtxos > 0 ? `<div class="deploy-hint" style="margin-top:6px;">${info.remainingUtxos} more UTXO${info.remainingUtxos > 1 ? 's' : ''} beyond the ${info.inputCount}-input cap — withdraw again after this confirms.</div>` : ''}
        </div>
        <div class="deploy-section" style="border-bottom:none;">
          <div class="deploy-hint">${connectedWallet === 'kasla' ? 'Your Kasla account signs the spend' : 'Your wallet signs the spend'}; the contract's conditions are enforced by the network.
          If a condition isn't met (e.g. a time lock still active), the network rejects the transaction and nothing moves.</div>
        </div>`;

      footer.innerHTML = `
        <button class="btn btn-secondary" onclick="App.closeModal()">Cancel</button>
        <button class="btn btn-primary" id="redeemSignBtn" onclick="App._signAndBroadcastSpend()">Sign & Withdraw →</button>`;

    } catch (err) {
      console.error('[Spend] Full error:', err);
      logToConsole('❌ Withdraw error: ' + (err?.message || String(err)));
      body.innerHTML = `
        <div class="redeem-error-screen">
          <div class="redeem-error-title">Withdrawal Unavailable</div>
          <div class="redeem-error-message">${esc(err?.message || String(err))}</div>
        </div>`;
      _lastSpendRequest = { contractId, entry: entry || null, args: args || null };
      footer.innerHTML = `
        <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        <button class="btn btn-primary" onclick="App._retrySpend()">Try Again</button>`;
    }
  }

  // Try Again always rebuilds through build-spend (never replays a rejected tx)
  let _lastSpendRequest = null;
  function _retrySpend() {
    const r = _lastSpendRequest;
    if (r) _executeRedeem(r.contractId, r.entry, r.args);
  }

  async function _signAndBroadcastSpend() {
    const st = _spendState;
    if (!st) return;
    const body = document.getElementById('redeemModalBody');
    const footer = document.getElementById('redeemModalFooter');
    const btn = document.getElementById('redeemSignBtn');
    const signInputs = Array.from({ length: st.inputCount || 1 }, (_, i) => ({ index: i, sighashType: 1 }));
    if (btn) { btn.disabled = true; btn.textContent = connectedWallet === 'kasla' ? 'Signing with Kasla…' : 'Sign in wallet…'; }

    try {
      // 0. The output pays the session's address; make sure the signer is that account.
      await assertSessionMatchesWallet();
      // The output pays this session's wallet, or the covenant itself (merge-style paths)
      const toSelf = !!st.contractAddress && st.destination === st.contractAddress;
      if (st.destination && currentUser && st.destination !== currentUser.address && !toSelf)
        throw new Error('Destination does not match this session; rebuild the withdrawal');

      // 1. Sign every covenant input.
      //    Kasware: extension popup. Kasla: hosted account, so the Studio asks for
      //    approval itself, then kasperopay proxies to Kasla's sign-pskt endpoint
      //    (same shape as Kasware's signPskt, same 41<sig>01 signatureScript back).
      //    Kaspire: same signPskt shape plus a `sender`; signs only, never broadcasts.
      let signedStr;
      if (connectedWallet === 'kasla') {
        const receiveKas = ((Number(st.amountSompi) - Number(st.feeSompi)) / 1e8).toFixed(4);
        const approved = await confirmKaslaAction({
          title: 'Sign withdrawal with Kasla',
          intro: 'Your Kasla account is about to sign a withdrawal:',
          rows: [
            ['Amount:', `<strong>${receiveKas} KAS</strong> to your address`],
            ['Spend path:', `<span class="deploy-mono">${esc(st.entrypoint || '')}()</span>`],
            ['From (covenant):', `<code style="word-break:break-all;">${esc(st.contractAddress || '')}</code>`]
          ],
          note: 'Kasla only signs. The Studio broadcasts through its own node, and the network enforces the covenant\'s conditions.',
          button: 'Sign'
        });
        if (!approved) throw new Error('Cancelled — nothing was signed');
        const r = await fetch('https://kasperopay.com/pay/kasla/sign-pskt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (authToken || '') },
          body: JSON.stringify({ txJsonString: st.txJsonString, signInputs })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.success || !d.txJsonString) {
          const retry = r.status === 429 && r.headers.get('Retry-After') ? ` (retry in ${r.headers.get('Retry-After')}s)` : '';
          throw new Error((d.error || `Kasla signing failed (HTTP ${r.status})`) + retry);
        }
        signedStr = d.txJsonString;
      } else if (connectedWallet === 'kaspire') {
        const signed = await kaspireRequest('signPskt', {
          sender: currentUser.address,
          txJsonString: st.txJsonString,
          options: { signInputs }
        });
        signedStr = typeof signed === 'string' ? signed : JSON.stringify(signed);
      } else {
        const signed = await window.kasware.signPskt({
          txJsonString: st.txJsonString,
          options: { signInputs }
        });
        signedStr = typeof signed === 'string' ? signed : JSON.stringify(signed);
      }
      const tx = JSON.parse(signedStr);
      if (!Array.isArray(tx.inputs) || !tx.inputs.length)
        throw new Error('Signed transaction has no inputs');

      // 2. Assemble every input's final sigScript:
      //    <args before the sig> <wallet sig push> <args after the sig> <dispatch tag (v1)> <redeem script>
      //    The server encoded everything but the signature (prefix/suffix); the
      //    wallet returned just the 41<sig>01 push for each input.
      const prefix = (st.sigScriptPrefixHex || '').toLowerCase();
      const suffix = (st.sigScriptSuffixHex || '').toLowerCase();
      if (!suffix) throw new Error('build-spend returned no sigScript suffix');
      tx.inputs.forEach((input, idx) => {
        if (!input.signatureScript || input.signatureScript.length < 20)
          throw new Error(`Wallet returned no signature for input ${idx}`);
        input.signatureScript = prefix + input.signatureScript.toLowerCase() + suffix;
      });
      const finalJson = JSON.stringify(tx);

      // 3. Broadcast through our own node (the wallet only signs). The node's
      //    verdict comes back verbatim, and the same JSON is logged server-side.
      if (btn) btn.textContent = 'Broadcasting…';
      const bcRes = await fetch(`/api/contracts/${st.contractId}/broadcast`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ txJsonString: finalJson })
      });
      const bc = await bcRes.json().catch(() => ({}));
      if (!bcRes.ok || !bc.success) throw new Error(bc.error || `Broadcast failed (HTTP ${bcRes.status})`);
      const txId = bc.txId;
      if (!txId) throw new Error('Broadcast returned no transaction id');

      // 4. Mark redeemed (best-effort; only when we spent this row's recorded outpoint)
      if (st.usedRecordedOutpoint && !toSelf) {
        try {
          await fetch(`/api/contracts/${st.contractId}/redeem-notify`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ txId })
          });
        } catch (_) { /* non-fatal */ }
      }

      logToConsole(`✅ Withdrawn — tx ${txId.slice(0, 16)}…`);
      const receiveKas = ((Number(st.amountSompi) - Number(st.feeSompi)) / 1e8).toFixed(4);
      body.innerHTML = `
        <div class="redeem-hero">
          <div class="redeem-hero-amount">✅ ${receiveKas} <span class="redeem-hero-unit">KAS</span></div>
          <div class="redeem-hero-label">${toSelf ? 'merged into one coin at this covenant' : 'withdrawn to your wallet'}</div>
        </div>
        <div class="deploy-section" style="border-bottom:none;">
          <div class="deploy-detail"><span class="deploy-detail-label">Transaction:</span>
            <a href="https://explorer.kaspa.org/transactions/${esc(txId)}" target="_blank" rel="noopener" class="deploy-explorer-link">${esc(txId.slice(0, 24))}… ↗</a>
          </div>
          ${st.remainingUtxos > 0 ? `<div class="deploy-hint" style="margin-top:8px;">${st.remainingUtxos} more UTXO${st.remainingUtxos > 1 ? 's remain' : ' remains'} at this contract — withdraw again once this confirms.</div>` : ''}
        </div>`;
      footer.innerHTML = `<button class="btn btn-primary" onclick="App.closeModal(); App.showMyContracts();">Done</button>`;

    } catch (err) {
      console.error('[Spend] Sign/broadcast error:', err);
      const msg = typeof err === 'string' ? err : (err?.message || JSON.stringify(err));
      logToConsole('❌ Withdraw failed: ' + msg);
      body.innerHTML = `
        <div class="redeem-error-screen">
          <div class="redeem-error-title">Withdrawal Failed</div>
          <div class="redeem-error-message">${esc(msg)}</div>
          <div class="deploy-hint" style="margin-top:10px;">Nothing left your contract unless the transaction above was accepted. A rejected transaction moves no funds.</div>
        </div>`;
      _lastSpendRequest = { contractId: st.contractId, entry: st.entrypoint || null, args: Object.fromEntries((st.args || []).map(a => [a.name, a.value])) };
      footer.innerHTML = `
        <button class="btn btn-secondary" onclick="App.closeModal()">Close</button>
        <button class="btn btn-primary" onclick="App._retrySpend()">Try Again</button>`;
    }
  }


  // ── Contract Detail Modal ──────────────────────────────────────────────────
  function showContractDetail(contractId) {
    const c = _savedContracts.find(x => x.id === contractId);
    if (!c) return logToConsole('Contract not found');

    const body = document.getElementById('redeemModalBody');
    const footer = document.getElementById('redeemModalFooter');
    document.getElementById('redeemTitle').textContent = c.contractName;

    const status = _contractStatus(c);
    const explorerAddr = `https://explorer.kaspa.org/addresses/${c.contractAddress}`;
    const explorerTx = c.fundingTxid ? `https://explorer.kaspa.org/transactions/${c.fundingTxid}` : null;

    // ── Analyze source code for smart display ────────────────────────────────
    const src = c.sourceCode || '';
    const conditions = _analyzeContract(src, c);

    // ── Status hero ──────────────────────────────────────────────────────────
    const statusColor = { funded: '#4eca8b', redeemed: '#a0a0a0', empty: '#e8a54e', failed: '#e8a54e', unknown: '#a0a0a0' }[status] || '#a0a0a0';
    const statusIcon = {
      funded: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
      redeemed: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-5"/></svg>',
      failed: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
    }[status];
    const statusLabel = { funded: 'Funded & Active', redeemed: 'Withdrawn', empty: 'Empty', failed: 'Unfunded', unknown: 'Checking balance…' }[status] || 'Checking balance…';

    let html = `
      <div class="cd-header">
        <div class="cd-status" style="color:${statusColor}">
          ${statusIcon}
          <span>${statusLabel}</span>
        </div>
        <div class="cd-deployed">${_formatDeployedAt(c.deployedAt)}</div>
      </div>`;

    // ── Spend conditions (the smart part) ────────────────────────────────────
    if (conditions.length > 0) {
      html += `<div class="deploy-section">
        <div class="deploy-section-title">Spend Conditions</div>
        <div class="cd-conditions">
          ${conditions.map(cond => `
            <div class="cd-condition">
              <div class="cd-condition-icon">${cond.icon}</div>
              <div class="cd-condition-info">
                <div class="cd-condition-label">${cond.label}</div>
                <div class="cd-condition-detail">${cond.detail}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>`;
    }

    // ── Contract amounts (parsed from source) ──────────────────────────────
    const amountItems = [];
    // Pledge: "int constant pledge = <litras>;" or constructor param
    const pledgeConstMatch = src.match(/int\s+constant\s+pledge\s*=\s*(\d+)/);
    if (pledgeConstMatch) {
      const pledgeLitras = parseInt(pledgeConstMatch[1]);
      const pledgeKas = pledgeLitras / 100000000;
      amountItems.push({ label: 'Pledge per payment', value: pledgeKas + ' KAS', icon: '💰' });
    } else {
      // Check constructor params for pledge
      const pledgeParam = (c.params || []).find(p => /pledge|amount/i.test(p.name) && p.type === 'int');
      if (pledgeParam && pledgeParam.value) {
        const pledgeLitras = parseInt(pledgeParam.value);
        if (pledgeLitras >= 100000000) {
          amountItems.push({ label: 'Pledge per payment', value: (pledgeLitras / 100000000) + ' KAS', icon: '💰' });
        } else {
          amountItems.push({ label: 'Pledge per payment', value: pledgeLitras.toLocaleString() + ' litras', icon: '💰' });
        }
      }
    }
    // Funding amount from DB (if available) or fallback
    if (c._liveBalance !== undefined) {
      const liveKas = (c._liveBalance / 1e8).toFixed(4).replace(/\.?0+$/, '') || '0';
      amountItems.push({ label: 'Current balance', value: liveKas + ' KAS', icon: '💎' });
    }
    if (c.amountTkas) {
      amountItems.push({ label: 'Total deposited', value: c.amountTkas + ' KAS', icon: '🏦' });
      // Show payments estimate if both are available
      if (pledgeConstMatch) {
        const pledgeKas = parseInt(pledgeConstMatch[1]) / 100000000;
        if (pledgeKas > 0) {
          const payments = Math.floor(c.amountTkas / pledgeKas);
          amountItems.push({ label: 'Estimated payments', value: '~' + payments + ' payment' + (payments !== 1 ? 's' : ''), icon: '🔄' });
        }
      }
    }

    if (amountItems.length > 0) {
      html += `<div class="deploy-section">
        <div class="deploy-section-title">Contract Amounts</div>
        <div class="cd-conditions">
          ${amountItems.map(item => `
            <div class="cd-condition">
              <div class="cd-condition-icon">${item.icon}</div>
              <div class="cd-condition-info">
                <div class="cd-condition-label">${item.label}</div>
                <div class="cd-condition-detail"><strong>${item.value}</strong></div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>`;
    }

    // ── Covenant ID (KIP-20): the coin's identity, stable across state changes ──
    if (c.covenantId) {
      const kind = _mcKind(c);
      html += `
        <div class="deploy-section">
          <div class="deploy-section-title">Covenant ID <span class="mc-kind-badge mc-kind-${kind === 'KCC-20' ? 'kcc20' : 'genesis'}">${kind}</span></div>
          <div class="deploy-address" onclick="navigator.clipboard.writeText('${esc(c.covenantId)}'); App.logToConsole('Covenant ID copied');">
            ${esc(c.covenantId)}
            <span class="deploy-copy-hint">click to copy</span>
          </div>
          <div class="cd-parties-note">${kind === 'KCC-20'
            ? 'This token is identified by its covenant ID. Its address changes every time it moves; the ID never does.'
            : 'A test covenant from the launchpad: the coin was born with this ID. It holds KAS, not tokens.'}</div>
        </div>`;
    }

    // ── Activity (live from chain) ───────────────────────────────────────────
    html += `
      <div class="deploy-section">
        <div class="deploy-section-title">Activity</div>
        <div class="mc-history" id="mc-history-${c.id}"><span class="mc-history-loading">Loading on-chain activity…</span></div>
      </div>`;

    // ── Contract address ─────────────────────────────────────────────────────
    html += `
      <div class="deploy-section">
        <div class="deploy-section-title">Contract Address</div>
        <div class="deploy-address" onclick="navigator.clipboard.writeText('${esc(c.contractAddress)}'); App.logToConsole('Address copied');">
          ${esc(c.contractAddress)}
          <span class="deploy-copy-hint">click to copy</span>
        </div>
      </div>`;

    // ── Entrypoint functions ─────────────────────────────────────────────────
    const fns = (c.abi?.functions || []);
    if (fns.length > 0) {
      html += `
        <div class="deploy-section">
          <div class="deploy-section-title">Spend paths</div>
          ${fns.map(fn => `
            <div class="cd-function">
              <span class="cd-fn-keyword">entry</span>
              <span class="cd-fn-name">${esc(fn.name)}</span><span class="cd-fn-params">(${(fn.inputs || fn.params || []).map(p => '<span class="cd-fn-type">' + esc(p.type || '') + '</span> ' + esc(p.name || '')).join(', ')})</span>
            </div>
          `).join('')}
        </div>`;
    }

    // ── Parties ──────────────────────────────────────────────────────────────
    if ((c.parties || []).length > 0) {
      html += `
        <div class="deploy-section">
          <div class="deploy-section-title">Parties${c.relation === 'external' ? ' <span class="mc-relation-badge">external</span>' : ''}</div>
          <div class="cd-parties">${c.parties.map(_partyChip).join('')}</div>
          ${(c.hasSpendPath === false || (c.hasSpendPath === undefined && c.relation === 'external' && !(c.mySpendPaths || []).length))
            ? '<div class="cd-parties-note">No spend path of this covenant checks your key. You can watch it here; withdrawing is not your move.</div>'
            : (c.mySpendPaths || []).length
              ? '<div class="cd-parties-note">Your key unlocks: ' + c.mySpendPaths.map(n => '<code>' + esc(n) + '()</code>').join(', ') + '</div>'
              : ''}
        </div>`;
    }

    // ── Constructor parameters ────────────────────────────────────────────────
    if ((c.params || []).length > 0) {
      html += `
        <div class="deploy-section">
          <div class="deploy-section-title">Constructor Parameters</div>
          ${c.params.map(p => {
            const val = String(p.value || '');
            const display = val.length > 32 ? val.slice(0, 12) + '\u2026' + val.slice(-8) : val;
            return '<div class="cd-param"><span class="cd-param-type">' + esc(p.type) + '</span><span class="cd-param-name">' + esc(p.name) + '</span><span class="cd-param-eq">=</span><span class="cd-param-val" title="' + esc(val) + '">' + esc(display) + '</span></div>';
          }).join('')}
        </div>`;
    }

    // ── Funding info ─────────────────────────────────────────────────────────
    if (c.fundingTxid) {
      html += `
        <div class="deploy-section">
          <div class="deploy-section-title">Funding</div>
          <div class="deploy-detail deploy-mono" style="font-size:11px;word-break:break-all;">
            ${esc(c.fundingTxid)}
          </div>
          <div style="margin-top:6px;">
            <a href="${explorerTx}" target="_blank" rel="noopener" class="deploy-explorer-link">View funding tx \u2197</a>
          </div>
        </div>`;
    }

    // ── Source code ───────────────────────────────────────────────────────────
    if (src) {
      html += `
        <div class="deploy-section" style="border-bottom:none;">
          <div class="deploy-section-title">Source Code</div>
          <pre class="cd-source">${esc(src)}</pre>
        </div>`;
    }

    body.innerHTML = html;

    // Actions: the tools on the left, the two things people come here for on the right
    const spend = _isSpendable(c);
    const isArchived = !!c.archivedAt, isExternal = c.relation === 'external';
    const pageLink = shareLinkFor(c);
    footer.innerHTML = `
      <div class="cd-actions">
        <div class="cd-actions-tools">
          <button class="btn btn-secondary btn-sm" onclick="App.openContractInEditor(${c.id})">Open in Editor</button>
          <a class="btn btn-secondary btn-sm cd-link" href="${explorerAddr}" target="_blank" rel="noopener">Explorer \u2197</a>
          ${c.shareToken ? `<button class="btn btn-secondary btn-sm" onclick="App.copyShareLink(${c.id}, this)" title="Copy the link the other parties open to join this covenant">Copy share link</button>` : ''}
          ${c.shareToken ? `<a class="btn btn-secondary btn-sm cd-link" href="${esc(ksmUrl(c.shareToken))}" download title="The covenant as a file: with it and your key you can withdraw using any compatible tool, even without the Studio">.ksm</a>` : ''}
          ${isExternal ? '' : `<button class="btn btn-secondary btn-sm" onclick="App._mcArchiveFromDetail(${c.id}, ${!isArchived})">${isArchived ? 'Unarchive' : 'Archive'}</button>`}
        </div>
        <div class="cd-actions-main">
          ${pageLink ? `<a class="btn btn-secondary cd-link" href="${esc(pageLink)}" target="_blank" rel="noopener">Covenant page \u2197</a>` : ''}
          <button class="btn btn-primary" ${spend.spendable ? `onclick="App.redeemContract(${c.id})"` : 'disabled'} ${spend.reason ? `title="${esc(spend.reason)}"` : ''}>Spend${!spend.spendable && spend.reason ? ' \u00b7 ' + esc(spend.reason) : ''}</button>
        </div>
      </div>`;

    showModal('redeemModal');
    _loadContractHistory(c.id);
  }

  // ═══════════════════════════════════════════════════════════════════
// Pre-Deploy Safety Checks
// ═══════════════════════════════════════════════════════════════════
// Called by deployContract() after constructor args are collected,
// before wallet signing. Returns an array of warning objects.
//
// Each warning: { severity: 'critical'|'info', label: string, detail: string }

function _runPreDeploySafetyChecks(source, functions, params, constructorArgs, deployerAddress) {
  const warnings = [];
  const fns = functions || [];
  const src = source || '';

  // Resolve deployer's pubkey hex from their wallet address
  const deployerPubkey = kaspaAddressToPubkey(deployerAddress);

  // Resolve constructor arg pubkey values to hex for comparison
  const constructorPubkeys = [];
  for (let i = 0; i < params.length; i++) {
    if (params[i].type === 'pubkey' && constructorArgs[i]) {
      const hex = kaspaAddressToPubkey(constructorArgs[i].value);
      if (hex) constructorPubkeys.push({ name: params[i].name, hex: hex.toLowerCase() });
    }
  }

  // ── Helper: parse function bodies from source ──────────────────
  // Returns [{ name, body }] for each entrypoint
  function parseFunctionBodies() {
    const bodies = [];
    const re = /\b(?:entry|entrypoint\s+function)\s+(\w+)\s*\([^)]*\)\s*\{/g;
    let match;
    while ((match = re.exec(src)) !== null) {
      const name = match[1];
      const start = match.index + match[0].length;
      let depth = 1;
      let i = start;
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
      }
      bodies.push({ name, body: src.slice(start, i - 1) });
    }
    return bodies;
  }

  const fnBodies = parseFunctionBodies();

  // ── Check 1: Anyone-can-spend (no checkSig anywhere) ──────────
  const hasCheckSig = /checkSig\s*\(/.test(src);
  if (!hasCheckSig) {
    warnings.push({
      severity: 'critical',
      label: 'Anyone Can Spend',
      detail: 'No signature verification found. Anyone who knows this contract address can spend its funds.'
    });
  }

  // ── Check 2: No signature parameter in any entrypoint ─────────
  // (catches the case where checkSig exists in a helper but no
  //  entrypoint actually accepts a sig to pass to it)
  if (hasCheckSig) {
    const anySigParam = fns.some(fn =>
      (fn.inputs || fn.params || []).some(p => p.type === 'sig')
    );
    if (!anySigParam) {
      warnings.push({
        severity: 'critical',
        label: 'No Signature Input',
        detail: 'Contract uses checkSig but no entrypoint accepts a signature parameter. Spend paths may be unusable.'
      });
    }
  }

  // ── Check 3: Deployer not in any spend path ───────────────────
  if (deployerPubkey && constructorPubkeys.length > 0) {
    const deployerHex = deployerPubkey.toLowerCase();
    const deployerInContract = constructorPubkeys.some(cp => cp.hex === deployerHex);
    if (!deployerInContract) {
      warnings.push({
        severity: 'critical',
        label: 'Deployer Not in Contract',
        detail: 'Your wallet\'s public key doesn\'t match any pubkey parameter. You may not be able to spend from this contract.'
      });
    }
  }

  // ── Check 4: Unsatisfiable conditions (require(false)) ────────
  const blackholeFns = [];
  for (const fb of fnBodies) {
    if (/require\s*\(\s*false\s*\)/.test(fb.body) || /require\s*\(\s*0\s*\)/.test(fb.body)) {
      blackholeFns.push(fb.name);
    }
  }
  if (blackholeFns.length > 0 && blackholeFns.length === fnBodies.length) {
    warnings.push({
      severity: 'critical',
      label: 'Provably Unspendable',
      detail: 'Every spend path contains require(false). Funds sent to this contract can never be recovered.'
    });
  } else if (blackholeFns.length > 0) {
    warnings.push({
      severity: 'info',
      label: 'Dead Path: ' + blackholeFns.join(', '),
      detail: blackholeFns.length === 1
        ? 'Function <strong>' + esc(blackholeFns[0]) + '</strong> contains require(false) and will always fail.'
        : 'Functions ' + blackholeFns.map(n => '<strong>' + esc(n) + '</strong>').join(', ') + ' contain require(false) and will always fail.'
    });
  }

  // ── Check 5: Single spend path (no fallback) ──────────────────
  if (fns.length === 1) {
    warnings.push({
      severity: 'info',
      label: 'Single Spend Path',
      detail: 'This contract has one entrypoint with no fallback. If its conditions can\'t be met, funds are locked permanently.'
    });
  }

  // ── Check 6: No reclaim path ──────────────────────────────────
  // Relevant when there's a timelock or multi-party setup but the
  // deployer doesn't have their own dedicated spend path
  if (deployerPubkey && fns.length > 1 && hasCheckSig) {
    const deployerHex = deployerPubkey.toLowerCase();
    // Find which constructor param matches the deployer
    const deployerParam = constructorPubkeys.find(cp => cp.hex === deployerHex);
    if (deployerParam) {
      // Check if any function body references the deployer's param in a checkSig
      const deployerHasPath = fnBodies.some(fb =>
        new RegExp('checkSig\\s*\\(\\s*\\w+\\s*,\\s*' + deployerParam.name + '\\s*\\)').test(fb.body)
      );
      if (!deployerHasPath) {
        warnings.push({
          severity: 'info',
          label: 'No Reclaim Path',
          detail: 'Your key (<strong>' + esc(deployerParam.name) + '</strong>) is in the contract but isn\'t used in any checkSig. You may not be able to reclaim funds if the counterparty disappears.'
        });
      }
    }
  }

  return warnings;
}


// ═══════════════════════════════════════════════════════════════════
// UI: Render safety warnings into the deploy modal
// ═══════════════════════════════════════════════════════════════════
//
// Call this from deployContract() after collecting args. If it
// returns true, the user still needs to acknowledge — don't proceed.

function _showSafetyWarnings(warnings, constructorArgs) {
  if (!warnings.length) return false; // no warnings, proceed

  const hasCritical = warnings.some(w => w.severity === 'critical');

  // Build warnings HTML
  let html = '<div class="deploy-safety-panel">';
  html += '<div class="deploy-safety-header">'
    + (hasCritical ? '⚠ Review Before Deploying' : 'Heads Up')
    + '</div>';

        for (const w of warnings) {
                const cls = w.severity === 'critical' ? 'deploy-safety-critical' : 'deploy-safety-info';
                let extra = '';
                if (w.label === 'Provably Unspendable') {
                  extra = `<label class="deploy-safety-ack">
                        <input type="checkbox" id="ack-unspendable"
                          onchange="document.getElementById('deployBtn').disabled = !this.checked">
                        I understand these funds will be permanently unrecoverable
                  </label>`;
                }
                html += `<div class="deploy-safety-item ${cls}">
                  <div class="deploy-safety-label">${esc(w.label)}</div>
                  <div class="deploy-safety-detail">${w.detail}</div>
                  ${extra}
                </div>`;
          }
  html += '</div>';

  // Insert above the footer
  const body = document.getElementById('deployModalBody');
  // Remove any previous warning panel
  const prev = body.querySelector('.deploy-safety-panel');
  if (prev) prev.remove();
  body.insertAdjacentHTML('beforeend', html);

  // Scroll the panel into view
  const panel = body.querySelector('.deploy-safety-panel');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Change button to "Deploy Anyway" and store that we've shown warnings
  const btn = document.getElementById('deployBtn');
  btn.textContent = hasCritical ? 'Deploy Anyway →' : 'Deploy →';
  btn.disabled = false;

  // Mark that warnings have been acknowledged on next click
  deployState._safetyShown = true;
  deployState._safetyArgs = constructorArgs;

  // If unspendable warning present, button stays disabled until checkbox
  const hasUnspendable = warnings.some(w => w.label === 'Provably Unspendable');
  btn.disabled = hasUnspendable;

  return hasCritical; // true = had critical warnings, first click shows them
}

  // ── Source code analyzer — extracts human-readable spend conditions ────────
  function _analyzeContract(src, contract) {
    const conditions = [];

    // Signature requirements
    const sigChecks = src.match(/checkSig\(\s*(\w+)\s*,\s*(\w+)\s*\)/g) || [];
    if (sigChecks.length > 0) {
      const keyNames = sigChecks.map(m => {
        const match = m.match(/checkSig\(\s*\w+\s*,\s*(\w+)\s*\)/);
        return match ? match[1] : 'key';
      });
      const unique = [...new Set(keyNames)];
      conditions.push({
        icon: '\ud83d\udd10',
        label: 'Signature Required',
        detail: unique.length === 1
          ? 'Must be signed by <strong>' + esc(unique[0]) + '</strong>'
          : 'Requires signature from: ' + unique.map(k => '<strong>' + esc(k) + '</strong>').join(' or ')
      });
    }

    // Absolute time lock: date("...")
    const dateMatch = src.match(/date\("([^"]+)"\)/);
    if (dateMatch) {
      const lockDate = new Date(dateMatch[1]);
      const now = new Date();
      const diff = lockDate - now;
      let timeStr;
      if (diff <= 0) {
        timeStr = '<span style="color:#4eca8b;">\u2713 Unlocked</span> (deadline passed)';
      } else {
        const days = Math.floor(diff / 86400000);
        const hours = Math.floor((diff % 86400000) / 3600000);
        const mins = Math.floor((diff % 3600000) / 60000);
        if (days > 0) timeStr = '<strong>' + days + 'd ' + hours + 'h</strong> remaining';
        else if (hours > 0) timeStr = '<strong>' + hours + 'h ' + mins + 'm</strong> remaining';
        else timeStr = '<strong>' + mins + ' minutes</strong> remaining';
      }
      conditions.push({
        icon: '\u23f0',
        label: 'Time Lock: ' + dateMatch[1],
        detail: timeStr
      });
    }

    // Relative lock. v1: this.ageDaa >= N blocks. Legacy: this.age >= N units.
    const daaMatch = src.match(/this\.ageDaa\s*>=\s*(\d[\d_]*)/);
    const ageMatch = daaMatch || src.match(/this\.age\s*>=\s*(\d+)\s*(days?|hours?|minutes?|seconds?|weeks?)/);
    if (daaMatch) {
      const blocks = parseInt(daaMatch[1].replace(/_/g, ''));
      const approxDays = blocks / 864000;
      const human = approxDays >= 1 ? Math.round(approxDays * 10) / 10 + ' days' : Math.round(blocks / 36000 * 10) / 10 + ' hours';
      conditions.push({
        icon: '\u23f3',
        label: 'Age Lock: ~' + human,
        detail: 'UTXO must age <strong>' + blocks.toLocaleString() + ' blocks</strong> (about ' + human + ') before it can be spent'
      });
    } else if (ageMatch) {
      conditions.push({
        icon: '\u23f3',
        label: 'Age Lock: ' + ageMatch[1] + ' ' + ageMatch[2],
        detail: 'UTXO must age <strong>' + ageMatch[1] + ' ' + ageMatch[2] + '</strong> before it can be spent'
      });
    }

    // Covenant — output destination enforcement
    const covenantMatch = src.match(/tx\.outputs\[/);
    if (covenantMatch) {
      const spkMatch = src.match(/ScriptPubKeyP2PK\(\s*(\w+)\s*\)/);
      conditions.push({
        icon: '\ud83d\udce8',
        label: 'Covenant (Output Enforcement)',
        detail: spkMatch
          ? 'Funds must go to <strong>' + esc(spkMatch[1]) + '</strong>\u2019s address'
          : 'Transaction outputs are validated by the contract'
      });
    }

    // Multi-path detection
    const entrypoints = src.match(/\b(?:entry|entrypoint\s+function)\s+(\w+)/g) || [];
    if (entrypoints.length > 1) {
      const names = entrypoints.map(e => e.trim().split(/\s+/).pop());
      conditions.push({
        icon: '\ud83d\udd00',
        label: names.length + ' Spend Paths',
        detail: names.map(n => '<strong>' + esc(n) + '</strong>').join(', ')
      });
    }

    // Hash puzzle
    if (src.includes('sha256(') || (src.includes('blake2b(') && src.includes('== '))) {
      // Only if it's not just a pkh check
      if (!src.includes('blake2b(pk)') && !src.includes('blake2b(byte[](pk))')) {
        conditions.push({
          icon: '#\ufe0f\u20e3',
          label: 'Hash Puzzle',
          detail: 'Requires knowledge of a secret preimage'
        });
      }
    }

    if (conditions.length === 0) {
      conditions.push({
        icon: '\ud83d\udcdc',
        label: 'Custom Contract',
        detail: 'Review the source code for spend conditions'
      });
    }

    return conditions;
  }

  function showReference() {
    showModal('infoModal');
    document.getElementById('infoTitle').textContent = 'SilverScript Quick Reference';
    document.getElementById('infoBody').innerHTML = `<div class="info-content">
      <h4>Data Types</h4>
      <table><tr><th>Type</th><th>Description</th></tr>
      <tr><td><code>int</code></td><td>64-bit signed integer</td></tr>
      <tr><td><code>bool</code></td><td>Boolean (true/false)</td></tr>
      <tr><td><code>string</code></td><td>UTF-8 string</td></tr>
      <tr><td><code>pubkey</code></td><td>Public key (32 bytes)</td></tr>
      <tr><td><code>sig</code></td><td>Signature (65 bytes)</td></tr>
      <tr><td><code>byte[N]</code></td><td>Fixed-size byte array</td></tr>
      </table>
      <h4>Built-in Functions</h4>
      <table><tr><th>Function</th><th>Description</th></tr>
      <tr><td><code>checkSig(sig, pubkey)</code></td><td>Verify signature</td></tr>
      <tr><td><code>blake2b(data)</code></td><td>BLAKE2b hash (Kaspa-native)</td></tr>
      <tr><td><code>sha256(data)</code></td><td>SHA-256 hash</td></tr>
      <tr><td><code>date("YYYY-MM-DDThh:mm:ss")</code></td><td>Date to timestamp</td></tr>
      </table>
      <h4>Transaction Introspection</h4>
      <table><tr><th>Field</th><th>Description</th></tr>
      <tr><td><code>tx.inputs[i].value</code></td><td>Input value at index</td></tr>
      <tr><td><code>tx.outputs[i].value</code></td><td>Output value at index</td></tr>
      <tr><td><code>tx.outputs[i].scriptPubKey</code></td><td>Output script</td></tr>
      <tr><td><code>tx.time</code></td><td>Transaction time (temporal, ms) for absolute locks</td></tr>
      <tr><td><code>tx.daa</code></td><td>Transaction DAA score for absolute block-height locks</td></tr>
      <tr><td><code>this.ageDaa</code></td><td>UTXO age in blocks (DAA score, about 864,000 per day)</td></tr>
      <tr><td><code>this.activeInputIndex</code></td><td>Current input index</td></tr>
      </table>
      <h4>Units</h4>
      <p>Value: <code>litras</code>, <code>grains</code>, <code>kas</code></p>
      <p>Time: <code>seconds</code>, <code>minutes</code>, <code>hours</code>, <code>days</code>, <code>weeks</code> (temporal, only with <code>tx.time</code>; relative locks use <code>this.ageDaa</code> block counts)</p>
      <h4>Covenant Constructors</h4>
      <p><code>new ScriptPubKeyP2PK(pubkey)</code> - Create P2PK output script (34 bytes)</p>
      <p><code>new ScriptPubKeyP2SH(byte[32])</code> - Create P2SH output script (35 bytes)</p>
    </div>`;
  }

  function showShortcuts() {
    showModal('infoModal');
    document.getElementById('infoTitle').textContent = 'Keyboard Shortcuts';
    document.getElementById('infoBody').innerHTML = `<div class="info-content">
      <table>
      <tr><th>Shortcut</th><th>Action</th></tr>
      <tr><td><code>Ctrl+B</code> / <code>F5</code></td><td>Compile current file</td></tr>
      <tr><td><code>Ctrl+N</code></td><td>New file</td></tr>
      <tr><td><code>Ctrl+O</code></td><td>Open .sil file</td></tr>
      <tr><td><code>Ctrl+D</code></td><td>Deploy contract</td></tr>
      <tr><td><code>Ctrl+/</code></td><td>Toggle comment</td></tr>
      <tr><td><code>Ctrl+F</code></td><td>Find</td></tr>
      <tr><td><code>Ctrl+H</code></td><td>Replace</td></tr>
      <tr><td><code>Ctrl+\`</code></td><td>Toggle bottom panel</td></tr>
      </table>
    </div>`;
  }

  function showAbout() {
    showModal('infoModal');
    document.getElementById('infoTitle').textContent = 'About SilverScript Studio';
    document.getElementById('infoBody').innerHTML = `<div class="info-content">
      <p><strong>SilverScript Studio</strong> is a browser IDE for writing, compiling, and deploying Kaspa covenants: spending rules locked onto coins, written in SilverScript.</p>
      <p>SilverScript is a high-level language inspired by CashScript that compiles to native Kaspa Script. Every covenant is a set of spend paths; the network only accepts a spend that satisfies one of them. There is no global state, just rules on individual UTXOs.</p>
      <p>Running on <strong>Kaspa Mainnet</strong>. Covenants++ live since the <strong>Toccata hardfork</strong> (June 30, 2026).</p>
      <p style="margin-top:12px;color:var(--text-muted);">Built by Kaspero Labs</p>
    </div>`;
  }

  // ─── Keyboard Shortcuts ────────────────────────────
  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+B - Compile
      if (e.ctrlKey && e.key === 'b') { e.preventDefault(); compile(); }
      // F5 - Compile
      if (e.key === 'F5') { e.preventDefault(); compile(); }
      // Ctrl+N - New file
      if (e.ctrlKey && e.key === 'n') { e.preventDefault(); newFile(); }
      // Ctrl+O - Open .sil file
      if (e.ctrlKey && !e.shiftKey && e.key === 'o') { e.preventDefault(); loadFile(); }
      // Ctrl+D - Deploy
      if (e.ctrlKey && !e.shiftKey && e.key === 'd') { e.preventDefault(); showDeploy(); }
      // Ctrl+` - Toggle panel
      if (e.ctrlKey && e.key === '`') { e.preventDefault(); toggleBottomPanel(); }
      // Escape - close modals
      if (e.key === 'Escape') closeModal();
    });
  }

  // ─── Helpers ───────────────────────────────────────
  function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── Start ─────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);

  // ─── Public API ────────────────────────────────────
  return {
    newFile, loadFile, openKsm, _ksmAdd, newFromSnippet, saveFile, downloadSil,
    compile, clearOutput, goToLine,
    addFile, logToConsole,
    switchToFile, closeFile, renameFile, duplicateFile, deleteFile,
    insertSnippet, insertSnippetAtCursor, openSnippetAsFile, previewSnippet,
    toggleSnippetCategory, toggleSection,
    editorAction, toggleTheme, toggleBottomPanel, switchPanelTab,
    closeAllFiles, showDeploy, selectTkas, selectFunder, selectParamTkas, selectParamKas, selectParamDays, selectParamDate, setHashMode, hashParamInput, deployContract, showDeployResult, showDeployRateLimit,
    retryFund, retryConfirm, kaslaConfirmAnswer,
    showMyContracts, showContractDetail, redeployContract, redeemContract, _executeRedeem, _signAndBroadcastSpend, showReference, showShortcuts, showAbout, showLogin, logout,
    copyShareLink, _spendPathChanged, _submitPathForm, _retrySpend, _encToggle,
    showFileContextMenu, hideContextMenu,
    closeModal, openContractInEditor,
    compileFileById, downloadFileById,
        _mcSortBy, _mcToggleExpand, _mcArchiveContract, _mcGoToPage, _mcSetTab, _mcArchiveFromDetail,
    getUserPubkey, kaspaAddressToPubkey,
        _mcFetchLiveBalances, _mcUpdateBalanceCell, _mcRefresh,
    showAiGenerate, aiGenerate, aiUseCode, aiSuggest, aiToggleSuggestions,
    showStart, startBuild, startPickBack, startPickTemplate, startDescribe, startWrite,
        openWalletDrawer, closeWalletDrawer, selectWalletForParam, clearParamHint,
        togglePasteForParam, toggleWalletDropdown, _addWalletSubmit,
        _deleteWalletConfirm, _renameWalletPrompt, walletBook,
        loadWalletBook, getWalletBook: () => walletBook, renderWalletDropdown, truncAddr,
         _runPreDeploySafetyChecks, _showSafetyWarnings
  };
})();

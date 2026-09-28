// Relative date defaults so wizard dates can never go stale
function isoDaysFromNow(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 19);
}

// Relative locks in SilverScript v1 are measured in DAA score (block count),
// not wall-clock time: `this.ageDaa >= N`. Kaspa mainnet produces ~10 blocks
// per second, so one day is about 864,000 DAA. Calibrate against the explorer
// if the rate ever changes (Toccata activation: June 30, 2026 at DAA 474,165,565).
const DAA_PER_DAY = 864000;
function daysToDaa(days, fallback) {
  const d = parseInt(days, 10);
  return (Number.isFinite(d) && d > 0 ? d : (fallback || 1)) * DAA_PER_DAY;
}

/* ═══════════════════════════════════════════════════════
   SilverScript Studio — Wizard Data
   Rich multi-step content for each contract builder
   ═══════════════════════════════════════════════════════ */

const WIZARD_DATA = {

  // ────────────────────────────────────────────────────
  // 1. PAY TO PUBLIC KEY (P2PK)
  // ────────────────────────────────────────────────────
  p2pk: {
    id: 'p2pk',
    title: 'Pay to Public Key',
    subtitle: 'P2PK',
    icon: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
    color: '#4eca8b',

    steps: [
      // ── Step 1: What ──
      {
        type: 'explain',
        title: 'What is Pay to Public Key?',
        content: {
          analogy: {
            icon: '🔐',
            title: 'Think of it like a safety deposit box',
            text: 'You lock funds inside a box that can only be opened with <em>one specific key</em>. Only the person who holds the matching private key can sign a transaction to unlock and spend these coins.'
          },
          bullets: [
            { icon: '⚡', text: '<strong>The simplest covenant possible</strong> — one key, one lock. If the signature is valid, the coins move.' },
            { icon: '🏗️', text: '<strong>Building block for everything else</strong> — every advanced covenant (escrows, vaults, recurring payments) starts with this pattern at its core.' },
            { icon: '🌐', text: '<strong>Native to Kaspa</strong> — P2PK is how most Kaspa transactions already work under the hood. This covenant just writes the rule down.' }
          ],
          whoUsesThis: 'Anyone sending or receiving KAS. If you\'ve ever made a Kaspa transaction, you\'ve used P2PK without knowing it.'
        }
      },
      // ── Step 2: How ──
      {
        type: 'diagram',
        title: 'How it works',
        content: {
          flow: [
            { label: 'Sender', desc: 'Creates a UTXO locked to recipient\'s public key', icon: '👤' },
            { label: 'Contract', desc: 'Holds the pubkey — only a valid signature unlocks it', icon: '📜' },
            { label: 'Recipient', desc: 'Provides signature from private key to spend', icon: '🔑' },
            { label: 'Spent', desc: 'Funds move to recipient\'s wallet', icon: '✅' }
          ],
          codePreview: `// The core logic is just one line:
require(checkSig(s, pk));
// "Does this signature match this public key?"
// If yes → funds are released
// If no  → transaction is rejected`,
          concepts: [
            { term: 'pubkey', definition: 'A public key (32 bytes). This is the "lock" — it\'s safe to share publicly.' },
            { term: 'sig', definition: 'A signature (65 bytes). This is the "key" — it proves you own the private key without revealing it.' },
            { term: 'checkSig()', definition: 'Built-in function that cryptographically verifies a signature matches a public key.' }
          ]
        }
      },
      // ── Step 3: Configure ──
      {
        type: 'configure',
        title: 'Configure your contract',
        fields: [
          {
            name: 'contractName',
            label: 'Contract name',
            type: 'text',
            default: 'PayToPublicKey',
            hint: 'A descriptive name — this becomes the contract identifier',
            validate: 'identifier'
          },
          {
            name: 'ownerPubkey',
            paramName: 'owner',
            label: 'Owner public key',
            type: 'text',
            default: '',
            hint: 'Connect a wallet to auto-fill, or paste a 32-byte hex public key',
            placeholder: 'Kaspa address or public key',
            validate: 'pubkey'
          },
          {
            name: 'addTimeLock',
            label: 'Add a time lock?',
            type: 'select',
            options: [
              { value: 'none', label: 'No — spendable immediately' },
              { value: 'age', label: 'Yes — require coins to age first' }
            ],
            default: 'none',
            hint: 'A time lock prevents spending until a period has passed. Useful for savings or vesting.'
          },
          {
            name: 'ageDays',
            label: 'Minimum age (days)',
            type: 'number',
            default: '1',
            hint: 'How many days the coins must sit before they can be spent.',
            showIf: { field: 'addTimeLock', value: 'age' },
            max: 4000  // this.ageDaa must stay below 2^32 (about 4,970 days)
          }
        ]
      },
      // ── Step 4: Review ──
      {
        type: 'review',
        title: 'Review & Create'
      }
    ],

    generate: (v) => {
      const age = v.addTimeLock === 'age'
        ? `\n        // Time lock — coins must age before spending\n        require(this.ageDaa >= ${daysToDaa(v.ageDays, 1)}); // ~${parseInt(v.ageDays) || 1} days`
        : '';
      return `pragma silverscript ^0.1.0;

// ${v.contractName}
// Pay to Public Key — the simplest covenant.
// Only the owner's signature can unlock the funds.

contract ${v.contractName}(pubkey owner) {

    // The only spend path — owner signs to withdraw
    entry spend(sig ownerSig) {
        require(checkSig(ownerSig, owner));${age}
    }
}`;
    },

    annotations: (v) => [
      { line: 'pragma', text: 'Version declaration — tells the compiler which SilverScript version to use' },
      { line: 'contract', text: `Your contract "${v.contractName}" takes one constructor parameter: the owner's public key` },
      { line: 'entry', text: 'The spend path — this is the only way to unlock the funds' },
      { line: 'checkSig', text: 'Cryptographic signature verification — the core security check' },
      ...(v.addTimeLock === 'age' ? [{ line: 'this.ageDaa', text: `Coins must be about ${v.ageDays} day(s) old before spending (measured in blocks: ${daysToDaa(v.ageDays, 1).toLocaleString()} DAA)` }] : [])
    ]
  },

  // ────────────────────────────────────────────────────
  // 2. PAY TO PUBLIC KEY HASH (P2PKH)
  // ────────────────────────────────────────────────────
  p2pkh: {
    id: 'p2pkh',
    title: 'Pay to Key Hash',
    subtitle: 'P2PKH',
    icon: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"/><path d="M12 8v4l3 3"/></svg>`,
    color: '#5b9ef5',

    steps: [
      {
        type: 'explain',
        title: 'What is Pay to Key Hash?',
        content: {
          analogy: {
            icon: '🕵️',
            title: 'Like a P.O. Box with an alias',
            text: 'Instead of posting your real address (public key) for everyone to see, you post a <em>hash</em> of it. When you want to collect, you show your real address to prove the hash matches. More private than P2PK.'
          },
          bullets: [
            { icon: '🔒', text: '<strong>Enhanced privacy</strong> — the public key is only revealed at spend time, not when the coins are locked.' },
            { icon: '🛡️', text: '<strong>Quantum-safer</strong> — until you spend, your pubkey stays hidden behind a hash. This gives some protection against future quantum computers.' },
            { icon: '📦', text: '<strong>Standard pattern</strong> — P2PKH is the default transaction type in Bitcoin and many UTXO chains. You\'re learning a universal concept.' }
          ],
          whoUsesThis: 'Anyone who wants better privacy. The hash keeps your public key hidden until you actually need to spend.'
        }
      },
      {
        type: 'diagram',
        title: 'How it works',
        content: {
          flow: [
            { label: 'Lock', desc: 'Store BLAKE2b hash of recipient\'s public key', icon: '#️⃣' },
            { label: 'Verify', desc: 'Spender reveals their pubkey — hash must match', icon: '🔍' },
            { label: 'Sign', desc: 'Spender provides signature matching the revealed pubkey', icon: '✍️' },
            { label: 'Spent', desc: 'Both checks pass → funds released', icon: '✅' }
          ],
          codePreview: `// Two-step verification:
require(blake2b(byte[](pk)) == pkh);  // 1. Does the pubkey hash match?
require(checkSig(s, pk));      // 2. Is the signature valid?`,
          concepts: [
            { term: 'blake2b()', definition: 'Kaspa\'s native hash function. Faster than SHA-256. Takes any data and produces a fixed 32-byte fingerprint.' },
            { term: 'byte[32] pkh', definition: 'A 32-byte "public key hash" — the fingerprint of someone\'s public key, used as their identifier.' },
            { term: 'Two checks', definition: 'First verify the pubkey matches the stored hash, then verify the signature. Both must pass.' }
          ]
        }
      },
      {
        type: 'configure',
        title: 'Configure your contract',
        fields: [
          {
            name: 'contractName',
            label: 'Contract name',
            type: 'text',
            default: 'P2PKH',
            hint: 'A descriptive name for this contract',
            validate: 'identifier'
          },
		  {
            name: 'pubkeyHash',
            paramName: 'pkh',
            label: 'Owner address',
            type: 'pubkey_hash',
            default: '',
            hint: 'Your BLAKE2b public key hash will be computed automatically.',
            validate: 'pubkey_hash'
          }
        ]
      },
      {
        type: 'review',
        title: 'Review & Create'
      }
    ],

    generate: (v) => `pragma silverscript ^0.1.0;

// ${v.contractName}
// Pay to Public Key Hash — enhanced privacy.
// The public key stays hidden until spend time.
// Spender must reveal their pubkey and prove it
// hashes to the stored value, then sign.

contract ${v.contractName}(byte[32] pkh) {

    // Spend path — reveal pubkey and sign
    entry spend(pubkey pk, sig s) {
        // Step 1: Verify the revealed pubkey matches the stored hash
        require(blake2b(byte[](pk)) == pkh);

        // Step 2: Verify the signature matches the revealed pubkey
        require(checkSig(s, pk));
    }
}`,

    annotations: (v) => [
      { line: 'pragma', text: 'Version declaration' },
      { line: 'byte[32] pkh', text: 'Constructor stores the hash of the owner\'s public key (32 bytes)' },
      { line: 'blake2b', text: 'Verify the revealed public key hashes to the stored value' },
      { line: 'checkSig', text: 'Then verify the signature matches that public key' }
    ]
  },

  // ────────────────────────────────────────────────────
  // 3. TIME-LOCKED VAULT
  // ────────────────────────────────────────────────────
  timelocked: {
    id: 'timelocked',
    title: 'Time-Locked Vault',
    subtitle: 'Vault',
    icon: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    color: '#e8a54e',

    steps: [
      {
        type: 'explain',
        title: 'What is a Time-Locked Vault?',
        content: {
          analogy: {
            icon: '🏦',
            title: 'A safe with a timer',
            text: 'Imagine locking money in a safe that <em>physically cannot be opened</em> until a set date. No one — not even you — can access the funds early. The blockchain enforces the lock.'
          },
          bullets: [
            { icon: '⏰', text: '<strong>Absolute lock</strong> — "Cannot spend before June 1st, 2026." The transaction timestamp must be after the deadline.' },
            { icon: '⏳', text: '<strong>Relative lock</strong> — "Must wait 30 days after deposit." The coins must age before they\'re spendable. Kaspa measures this age in blocks (DAA score), about 864,000 per day.' },
            { icon: '💎', text: '<strong>Use cases</strong> — Savings goals, token vesting, future-dated payments, preventing panic selling.' }
          ],
          whoUsesThis: 'HODLers, DAOs with vesting schedules, or anyone who wants to commit funds to a future date.'
        }
      },
      {
        type: 'diagram',
        title: 'How it works',
        content: {
          flow: [
            { label: 'Deposit', desc: 'Funds are locked with a time condition', icon: '🔒' },
            { label: 'Wait', desc: 'Time passes — the lock hasn\'t expired yet', icon: '⏳' },
            { label: 'Unlock', desc: 'Time condition met — owner can now sign', icon: '🔓' },
            { label: 'Withdraw', desc: 'Owner\'s signature + time check both pass', icon: '💰' }
          ],
          codePreview: `// Absolute time lock:
require(tx.time >= date("2026-06-01T00:00:00"));

// OR relative time lock:
require(this.ageDaa >= 25920000); // ~30 days

// Plus signature check
require(checkSig(ownerSig, owner));`,
          concepts: [
            { term: 'tx.time', definition: 'The transaction\'s locktime field. Must be >= the deadline for the transaction to be valid.' },
            { term: 'this.ageDaa', definition: 'How many blocks (DAA score) have passed since this UTXO was created. Kaspa mines about 10 blocks a second, so 864,000 DAA is roughly one day. Enables relative locks.' },
            { term: 'date()', definition: 'Converts a human-readable date string to a temporal value (milliseconds since 1970) for comparison with tx.time.' }
          ]
        }
      },
      {
        type: 'configure',
        title: 'Configure your vault',
        fields: [
          {
            name: 'contractName',
            label: 'Contract name',
            type: 'text',
            default: 'TimeLocked',
            validate: 'identifier'
          },
          {
            name: 'ownerPubkey',
            paramName: 'owner',
            label: 'Owner public key',
            type: 'text',
            default: '',
            hint: 'Only this key can withdraw after the lock expires',
            placeholder: 'Kaspa address or public key',
            validate: 'pubkey'
          },
          {
            name: 'lockType',
            label: 'Lock type',
            type: 'select',
            options: [
              { value: 'absolute', label: 'Absolute — locked until a specific date' },
              { value: 'relative', label: 'Relative — locked for N days after deposit' }
            ],
            default: 'absolute',
            hint: 'Absolute = "can\'t spend before June 2026." Relative = "must wait 30 days after receiving."'
          },
          {
            name: 'lockDate',
            label: 'Lock until',
            type: 'datetime',
            default: isoDaysFromNow(30),
            hint: 'Funds cannot be spent until after this date and time.',
            showIf: { field: 'lockType', value: 'absolute' }
          },
          {
            name: 'lockDays',
            label: 'Lock duration (days)',
            type: 'number',
            default: '30',
            hint: 'Number of days the coins must age before spending.',
            showIf: { field: 'lockType', value: 'relative' },
            max: 4000  // this.ageDaa must stay below 2^32 (about 4,970 days)
          }
        ]
      },
      {
        type: 'review',
        title: 'Review & Create'
      }
    ],

    generate: (v) => {
      const isAbsolute = v.lockType === 'absolute';
      const timeLine = isAbsolute
        ? `        // Absolute time lock — cannot withdraw before this date\n        temporal lockUntil = date("${v.lockDate || isoDaysFromNow(30)}");\n        require(tx.time >= lockUntil);`
        : `        // Relative time lock — coins must age before spending\n        require(this.ageDaa >= ${daysToDaa(v.lockDays, 30)}); // ~${parseInt(v.lockDays) || 30} days`;
      const lockDesc = isAbsolute
        ? `Locked until ${v.lockDate || isoDaysFromNow(30)}.`
        : `Coins must age ${parseInt(v.lockDays) || 30} days before withdrawal.`;
      return `pragma silverscript ^0.1.0;

// ${v.contractName}
// Time-Locked Vault — funds cannot be spent until
// a time condition is met. ${lockDesc}
// No one can access the funds early, not even the owner.

contract ${v.contractName}(pubkey owner) {

    // The only spend path — owner signs after the lock expires
    entry withdraw(sig ownerSig) {
        require(checkSig(ownerSig, owner));
${timeLine}
    }
}`;
    },

    annotations: (v) => [
      { line: 'pragma', text: 'Version declaration' },
      { line: 'contract', text: `"${v.contractName}" — funds locked to one owner with a time condition` },
      { line: 'checkSig', text: 'Only the owner can withdraw (signature required)' },
      ...(v.lockType === 'absolute'
        ? [{ line: 'date(', text: `Locked until ${v.lockDate} — no early withdrawals possible` },
           { line: 'tx.time', text: 'Transaction timestamp must be after the deadline' }]
        : [{ line: 'this.ageDaa', text: `Coins must age about ${v.lockDays} days (${daysToDaa(v.lockDays, 30).toLocaleString()} blocks) before they can be spent` }])
    ]
  },

  // ────────────────────────────────────────────────────
  // 4. TWO-PARTY ESCROW
  // ────────────────────────────────────────────────────
  escrow: {
    id: 'escrow',
    title: 'Two-Party Escrow',
    subtitle: 'Escrow',
    icon: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    color: '#c87dd4',

    steps: [
      {
        type: 'explain',
        title: 'What is a Two-Party Escrow?',
        content: {
          analogy: {
            icon: '🤝',
            title: 'Like buying something on eBay with a twist',
            text: 'You send money into a <em>neutral covenant</em>: coins with rules attached. The seller can claim it anytime by proving their identity. But if they never deliver? After a timeout, <em>you get your money back automatically</em>. No middleman needed.'
          },
          bullets: [
            { icon: '✅', text: '<strong>Two spend paths</strong> — the recipient can claim anytime, OR the sender reclaims after a timeout.' },
            { icon: '⏰', text: '<strong>Automatic refund</strong> — if the recipient never claims, the sender gets their money back. No disputes needed.' },
            { icon: '🔐', text: '<strong>Trustless</strong> — neither party can cheat. The contract enforces the rules. No escrow agent, no fees.' }
          ],
          whoUsesThis: 'Peer-to-peer trades, freelance payments, marketplace transactions — anywhere two parties need to exchange value safely.'
        }
      },
      {
        type: 'diagram',
        title: 'How it works',
        content: {
          flow: [
            { label: 'Deposit', desc: 'Sender locks funds with both pubkeys + timeout', icon: '💰' },
            { label: 'Path A', desc: 'Recipient claims with signature (anytime)', icon: '✅' },
            { label: 'OR', desc: '', icon: '↕️' },
            { label: 'Path B', desc: 'Sender reclaims after timeout expires', icon: '🔄' }
          ],
          codePreview: `// Path A: Recipient can claim anytime
entry claim(sig recipientSig) {
    require(checkSig(recipientSig, recipient));
}

// Path B: Sender reclaims after timeout
entry reclaim(sig senderSig) {
    require(checkSig(senderSig, sender));
    require(this.ageDaa >= 6048000); // ~7 days
}`,
          concepts: [
            { term: 'Two spend paths', definition: 'A covenant can have several ways to unlock. Each is an `entry` with its own conditions; whoever spends picks one path and must satisfy all of its rules.' },
            { term: 'Timeout', definition: 'A safety net for the sender. If the recipient never claims, the sender can reclaim after the timeout.' },
            { term: 'Trustless', definition: 'Neither party needs to trust the other. The covenant enforces the rules; the network rejects any spend that breaks them.' }
          ]
        }
      },
      {
        type: 'configure',
        title: 'Configure your escrow',
        fields: [
          {
            name: 'contractName',
            label: 'Contract name',
            type: 'text',
            default: 'Escrow',
            validate: 'identifier'
          },
          {
            name: 'senderPubkey',
            paramName: 'sender',
            label: 'Sender public key',
            type: 'text',
            default: '',
            hint: 'The sender who deposits funds and can reclaim after timeout',
            placeholder: 'Kaspa address or public key',
            validate: 'pubkey'
          },
          {
            name: 'recipientPubkey',
            paramName: 'recipient',
            label: 'Recipient public key',
            type: 'text',
            default: '',
            hint: 'The recipient who can claim the funds anytime',
            placeholder: 'Kaspa address or public key',
            validate: 'pubkey'
          },
          {
            name: 'timeoutType',
            label: 'Timeout type',
            type: 'select',
            options: [
              { value: 'relative', label: 'Relative — days after deposit' },
              { value: 'absolute', label: 'Absolute — specific date' }
            ],
            default: 'relative'
          },
          {
            name: 'timeoutDays',
            label: 'Timeout (days)',
            type: 'number',
            default: '7',
            hint: 'After this many days, the sender can reclaim if recipient hasn\'t claimed.',
            showIf: { field: 'timeoutType', value: 'relative' },
            max: 4000  // this.ageDaa must stay below 2^32 (about 4,970 days)
          },
          {
            name: 'timeoutDate',
            label: 'Timeout date',
            type: 'datetime',
            default: isoDaysFromNow(30),
            hint: 'After this date, the sender can reclaim the funds.',
            showIf: { field: 'timeoutType', value: 'absolute' }
          }
        ]
      },
      {
        type: 'review',
        title: 'Review & Create'
      }
    ],

    generate: (v) => {
      const isRelative = v.timeoutType === 'relative';
      const timeCheck = isRelative
        ? `// Timeout — contract must age before sender can reclaim\n        require(this.ageDaa >= ${daysToDaa(v.timeoutDays, 7)}); // ~${parseInt(v.timeoutDays) || 7} days`
        : `// Timeout — sender can only reclaim after this date\n        require(tx.time >= date("${v.timeoutDate || isoDaysFromNow(30)}"));`;
      const timeDesc = isRelative
        ? `after ${parseInt(v.timeoutDays) || 7} days`
        : `after ${v.timeoutDate || isoDaysFromNow(30)}`;
      return `pragma silverscript ^0.1.0;

// ${v.contractName}
// Two-Party Escrow — trustless exchange between
// a sender and recipient. The recipient can claim
// anytime. If they never do, the sender reclaims
// ${timeDesc}. No middleman needed.

contract ${v.contractName}(pubkey sender, pubkey recipient) {

    // ── Path A: Recipient Claims ─────────────────────
    // The recipient can claim funds at any time
    // by providing their signature.
    entry claim(sig recipientSig) {
        require(checkSig(recipientSig, recipient));
    }

    // ── Path B: Sender Reclaims After Timeout ────────
    // If the recipient never claims, the sender can
    // get their money back after the timeout.
    entry reclaim(sig senderSig) {
        require(checkSig(senderSig, sender));
        ${timeCheck}
    }
}`;
    },

    annotations: (v) => [
      { line: 'pragma', text: 'Version declaration' },
      { line: 'contract', text: 'Takes two pubkeys: sender and recipient' },
      { line: 'function claim', text: 'Path A — recipient can claim anytime with a valid signature' },
      { line: 'function reclaim', text: 'Path B — sender\'s safety net, available after the timeout' },
      ...(v.timeoutType === 'relative'
        ? [{ line: 'this.ageDaa', text: `Sender must wait about ${v.timeoutDays} days (${daysToDaa(v.timeoutDays, 7).toLocaleString()} blocks) before reclaiming` }]
        : [{ line: 'tx.time', text: `Sender can reclaim after ${v.timeoutDate}` }])
    ]
  },

  // ────────────────────────────────────────────────────
  // 5. RECURRING PAYMENT (MECENAS)
  // ────────────────────────────────────────────────────
  mecenas: {
    id: 'mecenas',
    title: 'Recurring Payment',
    subtitle: 'Mecenas',
    icon: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`,
    color: '#4ecac2',

    steps: [
      {
        type: 'explain',
        title: 'What is a Recurring Payment?',
        content: {
          analogy: {
            icon: '💸',
            title: 'Like automated payroll, but on-chain',
            text: 'A contract holds a pool of funds and releases a fixed <em>pledge</em> to a beneficiary on a schedule. Anyone can trigger the payment — the contract does the math. Remaining funds stay locked for the next payment.'
          },
          bullets: [
            { icon: '🛠️', text: '<strong>Withdraw by hand for now</strong> — the Studio\'s Withdraw button can\'t yet build the pledge-out-plus-change transaction this covenant requires. You can deploy and fund it here; paying out means assembling the transaction yourself.' },
            { icon: '🔄', text: '<strong>Self-sustaining</strong> — each payment automatically sends change back to the contract for the next cycle.' },
            { icon: '👥', text: '<strong>Anyone can trigger</strong> — the beneficiary (or any third party) can trigger the payment once the period elapses.' },
            { icon: '🛡️', text: '<strong>Funder keeps control</strong> — the person who funded the contract can reclaim all remaining funds at any time.' },
            { icon: '📐', text: '<strong>Covenant-powered</strong> — uses transaction introspection to enforce output destinations and amounts.' }
          ],
          whoUsesThis: 'DAOs paying contributors, subscription services, charity pledges, any scenario requiring periodic automated payments.'
        }
      },
      {
        type: 'diagram',
        title: 'How it works',
        content: {
          flow: [
            { label: 'Funded', desc: 'Contract loaded with total amount', icon: '🏦' },
            { label: 'Trigger', desc: 'Anyone calls receive() after period elapses', icon: '▶️' },
            { label: 'Split', desc: 'Pledge → recipient, remainder → back to contract', icon: '✂️' },
            { label: 'Repeat', desc: 'Next period starts, or funder reclaims', icon: '🔄' }
          ],
          codePreview: `// Enforce: first output goes to recipient
require(tx.outputs[0].scriptPubKey == byte[](new ScriptPubKeyP2PK(recipient)));

// Calculate change
int changeValue = currentValue - pledge - minerFee;

// If enough left: split. Otherwise: send everything.
if (changeValue <= pledge + minerFee) {
    require(tx.outputs[0].value == currentValue - minerFee);
} else {
    require(tx.outputs[0].value == pledge);
    // Send change back to THIS contract
    require(tx.outputs[1].scriptPubKey == tx.inputs[this.activeInputIndex].scriptPubKey);
}`,
          concepts: [
            { term: 'Covenant', definition: 'A contract that controls WHERE the funds go, not just WHO can spend them. It inspects the transaction\'s outputs.' },
            { term: 'Self-referencing', definition: 'The contract sends change back to itself using tx.inputs[this.activeInputIndex].scriptPubKey.' },
            { term: 'Pledge', definition: 'The fixed amount paid to the beneficiary each period.' }
          ]
        }
      },
      {
        type: 'configure',
        title: 'Configure your recurring payment',
        fields: [
          {
            name: 'contractName',
            label: 'Contract name',
            type: 'text',
            default: 'RecurringPayment',
            validate: 'identifier'
          },
	      {
            name: 'funderPubkey',
            paramName: 'funderKey',
            label: 'Funder public key',
            type: 'text',
            default: '',
            hint: 'Your key — lets you cancel and reclaim remaining funds at any time',
            placeholder: 'Kaspa address or public key',
            validate: 'pubkey'
          },
          {
            name: 'recipientPubkey',
            paramName: 'recipient',
            label: 'Recipient public key',
            type: 'text',
            default: '',
            hint: 'Who receives the periodic payments',
            placeholder: 'Kaspa address or public key',
            validate: 'pubkey'
          },
          {
			name: 'pledgeAmount',
			label: 'Payment amount per period (KAS)',
			type: 'number',
			default: '10',
			hint: 'How much is sent to the recipient each period, in whole KAS.',
			placeholder: '10',
			min: 1,
			max: 500
          },
          {
            name: 'periodDays',
            label: 'Days between payments',
            type: 'number',
            default: '30',
            hint: 'Minimum wait time between payouts. Prevents the contract from being drained instantly.',
            max: 4000  // this.ageDaa must stay below 2^32 (about 4,970 days)
          }
        ]
      },
      {
        type: 'review',
        title: 'Review & Create'
      }
    ],

    generate: (v) => {
      const periodDays = parseInt(v.periodDays) || 30;
      // Convert KAS to litras (1 KAS = 100,000,000 litras)
      const kasAmount = parseFloat(v.pledgeAmount) || 1;
      const litrasAmount = Math.round(kasAmount * 100000000);
      return `pragma silverscript ^0.1.0;

// ${v.contractName}
// Recurring Payment (Mecenas) — releases a fixed
// pledge to the recipient on a schedule. Anyone can
// trigger the payment once the period elapses.
// Remaining funds stay locked for the next cycle.
//
// NOTE: withdraw by hand for now. The Studio's Withdraw
// button does not yet build the pledge + change transaction
// this covenant requires; deploy and fund here, pay out
// with your own transaction.

contract ${v.contractName}(pubkey recipient, pubkey funderKey) {
    int constant pledge = ${litrasAmount}; // ${kasAmount} KAS
    int constant MINER_FEE = 1000;

    // ── Path A: Trigger Payment ──────────────────────
    // Anyone can call this after the waiting period.
    // Sends the pledge to recipient, change back to contract.
    entry receive() {
        // Enforce waiting period between payments
        require(this.ageDaa >= ${daysToDaa(periodDays)}); // ~${periodDays} days

        // First output must go to recipient
        byte[] recipientScript = byte[](new ScriptPubKeyP2PK(recipient));
        require(tx.outputs[0].scriptPubKey == recipientScript);

        int currentValue = tx.inputs[this.activeInputIndex].value;
        int changeValue = currentValue - pledge - MINER_FEE;

        // If not enough for another pledge, send everything
        if (changeValue <= pledge + MINER_FEE) {
            require(tx.outputs[0].value == currentValue - MINER_FEE);
        } else {
            // Send pledge to recipient, change back to contract
            require(tx.outputs[0].value == pledge);
            require(tx.outputs[1].scriptPubKey == tx.inputs[this.activeInputIndex].scriptPubKey);
            require(tx.outputs[1].value == changeValue);
        }
    }

    // ── Path B: Funder Reclaims ──────────────────────
    // Funder can cancel and reclaim at any time.
    entry reclaim(sig funderSig) {
        require(checkSig(funderSig, funderKey));
    }
}`;
    },

    annotations: (v) => [
      { line: 'pragma', text: 'Version declaration' },
      { line: 'contract', text: 'Recipient, funder, and pledge amount are baked in as constants' },
      { line: 'constant pledge', text: `Fixed payment of ${parseFloat(v.pledgeAmount) || 1} KAS per period, stored in litras` },
      { line: 'receive', text: 'Anyone can call this to trigger a payment to the recipient' },
      { line: 'ScriptPubKeyP2PK', text: 'Covenant: forces the first output to go to the recipient\'s address' },
      { line: 'changeValue', text: 'Math: subtract pledge and miner fee from current balance' },
      { line: 'reclaim', text: 'Safety valve — the funder can reclaim all remaining funds at any time' }
    ]
  },

  // ────────────────────────────────────────────────────
  // 6. SIMPLE COVENANT
  // ────────────────────────────────────────────────────
  covenant: {
    id: 'covenant',
    title: 'Simple Covenant',
    subtitle: 'Covenant',
    icon: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
    color: '#e85454',

    steps: [
      {
        type: 'explain',
        title: 'What is a Covenant?',
        content: {
          analogy: {
            icon: '📮',
            title: 'Like an envelope that can only go to one address',
            text: 'Normal contracts check WHO can spend. Covenants check WHERE the money goes. The contract <em>inspects the transaction itself</em> and enforces that funds are sent to specific destinations with specific amounts.'
          },
          bullets: [
            { icon: '🛠️', text: '<strong>Pure covenant: withdraw by hand for now</strong> — with no signature required, the Studio has nothing to sign and can\'t yet build the transaction for you. Choose "require owner signature" below and the Withdraw button works as usual.' },
            { icon: '🔍', text: '<strong>Transaction introspection</strong> — the contract reads the outputs of the spending transaction and validates them.' },
            { icon: '🎯', text: '<strong>Enforced destinations</strong> — you can guarantee funds go to a specific address, no matter who triggers the spend.' },
            { icon: '🧱', text: '<strong>The foundation of DeFi</strong> — covenants enable DEXes, payment channels, vaults, and any contract that controls fund flow.' },
            { icon: '🆕', text: '<strong>Coming to Kaspa</strong> — covenant support activates with the May 2026 hardfork. You\'re building for the future.' }
          ],
          whoUsesThis: 'DeFi protocols, payment processors, treasury management — anything that needs guaranteed fund routing.'
        }
      },
      {
        type: 'diagram',
        title: 'How it works',
        content: {
          flow: [
            { label: 'Contract', desc: 'Holds funds + knows the required destination', icon: '📜' },
            { label: 'Spend TX', desc: 'Someone creates a transaction spending the UTXO', icon: '📝' },
            { label: 'Inspect', desc: 'Contract checks: does output[0] go to the right address?', icon: '🔍' },
            { label: 'Enforce', desc: 'If destination matches → approved. Otherwise → rejected.', icon: '✅' }
          ],
          codePreview: `// Build the expected output script
byte[] recipientSpk = byte[](new ScriptPubKeyP2PK(recipient));

// Enforce: first output MUST go to recipient
require(tx.outputs[0].scriptPubKey == recipientSpk);

// Optionally enforce minimum value
require(tx.outputs[0].value >= 10000 litras);`,
          concepts: [
            { term: 'ScriptPubKeyP2PK', definition: 'Constructs a P2PK locking script from a public key. This is what an "address" looks like at the script level.' },
            { term: 'tx.outputs[i]', definition: 'Access the i-th output of the spending transaction. You can read its .scriptPubKey and .value.' },
            { term: 'Covenant vs Lock', definition: 'A lock checks who can spend. A covenant checks how they spend. Covenants are strictly more powerful.' }
          ]
        }
      },
      {
        type: 'configure',
        title: 'Configure your covenant',
        fields: [
          {
            name: 'contractName',
            label: 'Contract name',
            type: 'text',
            default: 'SimpleCovenant',
            validate: 'identifier'
          },
          {
            name: 'recipientPubkey',
            paramName: 'recipient',
            label: 'Recipient public key',
            type: 'text',
            default: '',
            hint: 'The public key where funds MUST be sent',
            placeholder: 'Kaspa address or public key',
            validate: 'pubkey'
          },
          {
            name: 'addMinValue',
            label: 'Enforce minimum output value?',
            type: 'select',
            options: [
              { value: 'none', label: 'No — any amount is fine' },
              { value: 'yes', label: 'Yes — require minimum amount' }
            ],
            default: 'none',
            hint: 'Ensure the recipient gets at least a minimum amount in the output.'
          },
          {
            name: 'minValue',
            label: 'Minimum value (litras)',
            type: 'number',
            default: '10000',
            hint: '1 KAS = 100,000,000 litras. The output must contain at least this much.',
            showIf: { field: 'addMinValue', value: 'yes' }
          },
          {
            name: 'addSigCheck',
            label: 'Require a signature to spend?',
            type: 'select',
            options: [
              { value: 'none', label: 'No — anyone can trigger (pure covenant)' },
              { value: 'yes', label: 'Yes — require owner signature too' }
            ],
            default: 'none',
            hint: 'A pure covenant lets anyone trigger the spend as long as the outputs are correct, but the Studio can\'t build that transaction yet (withdraw by hand for now). With the owner signature, Withdraw works from the Studio.'
          }
        ]
      },
      {
        type: 'review',
        title: 'Review & Create'
      }
    ],

    generate: (v) => {
      const minVal = v.addMinValue === 'yes'
        ? `\n\n        // Enforce minimum output amount\n        require(tx.outputs[0].value >= ${parseInt(v.minValue) || 10000} litras);`
        : '';
      const hasSig = v.addSigCheck === 'yes';
      const sigParam = hasSig ? 'sig ownerSig' : '';
      const sigCheck = hasSig
        ? '\n        // Only the owner can trigger this spend\n        require(checkSig(ownerSig, owner));'
        : '';
      const ctorParams = ['pubkey recipient'];
      if (hasSig) ctorParams.push('pubkey owner');
      const sigDesc = hasSig
        ? '\n// Only the owner can trigger the spend.'
        : '\n// Anyone can trigger the spend — the contract\n// only cares WHERE the money goes, not WHO sends it.\n// NOTE: the Studio cannot yet build a spend with no\n// signature; withdraw by hand for now.';
      const minDesc = v.addMinValue === 'yes' ? `\n// Minimum output: ${parseInt(v.minValue) || 10000} litras.` : '';
      return `pragma silverscript ^0.1.0;

// ${v.contractName}
// Simple Covenant — enforces WHERE funds go,
// not just who can spend them. The contract inspects
// the spending transaction and guarantees the output
// goes to the designated recipient.${sigDesc}${minDesc}

contract ${v.contractName}(${ctorParams.join(', ')}) {

    // Spend path — enforces output destination
    entry spend(${sigParam}) {${sigCheck}
        // Build the expected output script for the recipient
        byte[] recipientScriptPubKey = byte[](new ScriptPubKeyP2PK(recipient));

        // Enforce: first output MUST go to recipient
        require(tx.outputs[0].scriptPubKey == recipientScriptPubKey);${minVal}
    }
}`;
    },

    annotations: (v) => [
      { line: 'pragma', text: 'Version declaration' },
      { line: 'contract', text: `"${v.contractName}" enforces where funds go` },
      ...(v.addSigCheck === 'yes' ? [{ line: 'checkSig', text: 'Only the owner can trigger the covenant' }] : []),
      { line: 'ScriptPubKeyP2PK', text: 'Build the expected output script from the recipient\'s public key' },
      { line: 'tx.outputs[0]', text: 'Inspect the spending transaction — first output MUST go to recipient' },
      ...(v.addMinValue === 'yes' ? [{ line: 'litras', text: `Minimum ${v.minValue} litras required in the output` }] : [])
    ]
  },
  
  /* ═══════════════════════════════════════════════════════
   PAYROLL / FREELANCE CONTRACT — Wizard Data
   
   Add this block inside WIZARD_DATA = { ... } in wizard-data.js
   Place it AFTER the 'covenant' entry (before the closing '};')
   ═══════════════════════════════════════════════════════ */

  // ────────────────────────────────────────────────────
  // 7. PAYROLL / FREELANCE CONTRACT
  // ────────────────────────────────────────────────────
  payroll: {
    id: 'payroll',
    title: 'Payroll / Freelance Contract',
    subtitle: 'Work Escrow',
    icon: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
    color: '#f59e42',

    steps: [
      // ── Step 1: What ──
      {
        type: 'explain',
        title: 'What is a Payroll / Freelance Contract?',
        content: {
          analogy: {
            icon: '📋',
            title: 'Like escrow for a job',
            text: 'A client locks the payment <em>before work begins</em>. The worker sees the money is reserved and can start. When the job is done, both sign and the worker is paid. If nothing is resolved by the deadline, the client takes the money back.'
          },
          bullets: [
            { icon: '💼', text: '<strong>Real-world work contracts</strong> — freelance jobs, contractor payments, milestone deliveries, bounties.' },
            { icon: '🤝', text: '<strong>Two paths by default</strong> — release (client + worker sign, worker is paid) and reclaim (client alone, after the timeout). A dispute ends only by agreement or by the client waiting out the deadline.' },
            { icon: '⚖️', text: '<strong>Optional third signer</strong> — add a key both parties trust and two more paths appear: that key plus the client refunds, that key plus the worker pays out. There is no built-in arbitrator on Kaspa; it is just a key you both agree on, and it can never take the money itself.' },
            { icon: '⏰', text: '<strong>Timeout safety</strong> — funds never get stuck. After the deadline the client can always reclaim alone.' }
          ],
          whoUsesThis: 'Freelancers, contractors, DAOs paying contributors, bug bounty programs, milestone-based grants — anyone exchanging work for payment.'
        }
      },
      // ── Step 2: How ──
      {
        type: 'diagram',
        title: 'How it works',
        content: {
          flow: [
            { label: 'Fund', desc: 'Client locks payment into the covenant', icon: '💰' },
            { label: 'Work', desc: 'Worker performs the agreed task', icon: '🔨' },
            { label: 'Resolve', desc: 'Release together, or reclaim after the deadline', icon: '⚖️' },
            { label: 'Paid', desc: 'Funds go to the worker, or back to the client', icon: '✅' }
          ],
          codePreview: `// Path A — Release (happy path)
// Client + Worker sign → Worker gets paid
require(checkSig(clientSig, clientKey));
require(checkSig(workerSig, workerKey));
require(tx.outputs[0].scriptPubKey == workerScript);

// Path B — Timeout reclaim
// Client alone, after the deadline → Client refunded
require(this.ageDaa >= 25920000); // ~30 days

// With a third signer, two more paths:
// refund    — Client + third key → Client refunded
// arbitrate — Worker + third key → Worker paid`,
          concepts: [
            { term: 'Two signatures', definition: 'Release needs both the client and the worker. Neither can move the money alone before the deadline.' },
            { term: 'Covenant enforcement', definition: 'Each path checks tx.outputs, so the money can only go to the party that path names.' },
            { term: 'Third signer', definition: 'Optional. A key both parties trust. With the client it refunds; with the worker it pays out. On its own it can do nothing.' },
            { term: 'Timeout', definition: 'The safety valve. If the work is never resolved, the client reclaims alone after the deadline.' }
          ]
        }
      },
      // ── Step 3: Configure ──
      {
        type: 'configure',
        title: 'Configure your contract',
        fields: [
          {
            name: 'contractName',
            label: 'Contract name',
            type: 'text',
            default: 'FreelanceContract',
            hint: 'A descriptive name — e.g. WebsiteRedesign, LogoDesign, AuditQ3',
            validate: 'identifier'
          },
          {
            name: 'funderPubkey',
            paramName: 'clientKey',
            label: 'Client public key',
            type: 'text',
            default: '',
            hint: 'The client who funds the contract. Connect a wallet to auto-fill.',
            placeholder: 'Kaspa address or public key',
            validate: 'pubkey'
          },
          {
            name: 'workerPubkey',
            paramName: 'workerKey',
            label: 'Worker public key',
            type: 'text',
            default: '',
            hint: 'The worker or freelancer who will receive payment on completion.',
            placeholder: 'Kaspa address or public key',
            validate: 'pubkey'
          },
          {
            // The arbiter directory (type 'arbiter_picker', /api/arbiters) is kept in the
            // engine and the server but not shown: no real arbitration service deals with
            // Kaspa yet. Plain optional key field until there is one.
            name: 'arbiterPubkey',
            paramName: 'arbiterKey',
            label: 'Arbitrator / 3rd signer (optional)',
            type: 'text',
            default: '',
            hint: 'Optional: a third key both parties trust, to handle disputes. Leave blank for a two-path contract (release + reclaim).',
            placeholder: 'Kaspa address or public key, or leave blank',
            validate: 'pubkey_optional'
          },
          {
			name: 'paymentAmount',
			label: 'Payment amount (KAS)',
			type: 'number',
			default: '10',
			hint: 'Amount to lock for the job, in whole KAS.',
			placeholder: '10',
			min: 1
          },
          {
            name: 'timeoutDays',
            label: 'Timeout (days)',
            type: 'number',
            default: '30',
            hint: 'After this many days with no resolution, the client can reclaim. Set a reasonable deadline for the work.',
            max: 4000  // this.ageDaa must stay below 2^32 (about 4,970 days)
          }
        ]
      },
      // ── Step 4: Review ──
      {
        type: 'review',
        title: 'Review & Create'
      }
    ],

    generate: (v) => {
      const timeoutDays = parseInt(v.timeoutDays) || 30;
      const withArbiter = !!(v.arbiterPubkey || '').trim();
      const name = v.contractName || 'FreelanceContract';
      const params = withArbiter
        ? 'pubkey clientKey, pubkey workerKey, pubkey arbiterKey'
        : 'pubkey clientKey, pubkey workerKey';
      const arbiterPaths = withArbiter ? `
    // ── Path B: Refund with the third signer ──────────
    // Client and third signer agree to refund the client.
    // Use when the worker did not deliver.
    entry refund(sig clientSig, sig arbiterSig) {
        require(checkSig(clientSig, clientKey));
        require(checkSig(arbiterSig, arbiterKey));
        byte[] clientScript = byte[](new ScriptPubKeyP2PK(clientKey));
        require(tx.outputs[0].scriptPubKey == clientScript);
    }

    // ── Path C: Payout with the third signer ──────────
    // Worker and third signer agree the work is done.
    // Use when the client is unresponsive or disputes unfairly.
    entry arbitrate(sig workerSig, sig arbiterSig) {
        require(checkSig(workerSig, workerKey));
        require(checkSig(arbiterSig, arbiterKey));
        byte[] workerScript = byte[](new ScriptPubKeyP2PK(workerKey));
        require(tx.outputs[0].scriptPubKey == workerScript);
    }
` : '';
      const reclaimLabel = withArbiter ? 'Path D' : 'Path B';
      return `pragma silverscript ^0.1.0;

// ${name}
// Payroll / Freelance Contract — locks funds for work${withArbiter ? '\n// with a trusted third signer for disputes' : ''}
// and timeout protection.

contract ${name}(${params}) {

    // ── Path A: Release (happy path) ─────────────────
    // Client and worker both agree work is complete.
    // Payment goes to the worker.
    entry release(sig clientSig, sig workerSig) {
        require(checkSig(clientSig, clientKey));
        require(checkSig(workerSig, workerKey));
        byte[] workerScript = byte[](new ScriptPubKeyP2PK(workerKey));
        require(tx.outputs[0].scriptPubKey == workerScript);
    }
${arbiterPaths}
    // ── ${reclaimLabel}: Timeout Reclaim ──────────────────────
    // If the contract expires with no resolution,
    // the client can reclaim their funds alone.
    entry reclaim(sig clientSig) {
        require(checkSig(clientSig, clientKey));
        require(this.ageDaa >= ${daysToDaa(timeoutDays)}); // ~${timeoutDays} days
        byte[] clientScript = byte[](new ScriptPubKeyP2PK(clientKey));
        require(tx.outputs[0].scriptPubKey == clientScript);
    }
}`;
    },

    annotations: (v) => {
      const withArbiter = !!(v.arbiterPubkey || '').trim();
      const days = v.timeoutDays || 30;
      return [
        { line: 'pragma', text: 'Version declaration — tells the compiler which SilverScript version to use' },
        { line: 'contract', text: withArbiter
            ? `"${v.contractName}" — release, refund, arbitrate, or reclaim after the timeout`
            : `"${v.contractName}" — two paths: release together, or the client reclaims after the timeout` },
        { line: 'Path A', text: 'Happy path — both parties agree, worker gets paid' },
        { line: 'release', text: 'Requires client + worker signatures and enforces payment to the worker' },
        ...(withArbiter ? [
          { line: 'Path B', text: 'Refund — client and third signer agree the work wasn\'t delivered' },
          { line: 'refund', text: 'Requires client + third-signer signatures, sends funds back to the client' },
          { line: 'Path C', text: 'Dispute payout — worker and third signer override an unresponsive client' },
          { line: 'arbitrate', text: 'Requires worker + third-signer signatures, pays the worker' },
          { line: 'Path D', text: `Timeout — after ${days} days, the client can reclaim alone` }
        ] : [
          { line: 'Path B', text: `Timeout — after ${days} days, the client can reclaim alone` }
        ]),
        { line: 'reclaim', text: 'Only the client signature is needed, but it must wait for the timeout' },
        { line: 'ScriptPubKeyP2PK', text: 'Covenant enforcement — the output must go to the named party\'s address' },
        { line: 'this.ageDaa', text: `Funds must be about ${days} days old (${daysToDaa(v.timeoutDays, 30).toLocaleString()} blocks) before the timeout reclaim` }
      ];
    }
  },
  

  // ────────────────────────────────────────────────────
  // 8. HASH-LOCKED SWAP (HTLC)
  // ────────────────────────────────────────────────────
  htlc: {
    id: 'htlc',
    title: 'Hash-Locked Swap',
    subtitle: 'HTLC',
    icon: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8l4 4-4 4"/></svg>`,
    color: '#6c5ce7',

    steps: [
      // ── Step 1: What ──
      {
        type: 'explain',
        title: 'What is a Hash-Locked Swap?',
        content: {
          analogy: {
            icon: '🔀',
            title: 'Like exchanging sealed envelopes with a code word',
            text: 'Alice locks funds with a <em>secret code</em> (hash). Bob can only claim the funds by revealing the original secret that matches the hash. If Bob never reveals the secret, Alice can <em>sign a refund transaction</em> after a timeout to get her money back. This is the foundation of atomic swaps and cross-chain trading.'
          },
          bullets: [
            { icon: '🔐', text: '<strong>Hash lock</strong> — funds are locked behind a SHA-256 hash. Only someone who knows the preimage (secret) can claim them.' },
            { icon: '⏰', text: '<strong>Time lock</strong> — if the secret is never revealed, the sender can sign a refund after the deadline. No funds get stuck forever.' },
            { icon: '⚛️', text: '<strong>Atomic swaps</strong> — two HTLCs on different chains enable trustless cross-chain trading. Either both trades happen, or neither does.' },
            { icon: '⚡', text: '<strong>Payment channels</strong> — HTLCs are the building blocks of Lightning-style payment networks.' }
          ],
          whoUsesThis: 'Cross-chain traders, payment channel operators, anyone who needs trustless conditional payments based on a shared secret.'
        }
      },
      // ── Step 2: How ──
      {
        type: 'diagram',
        title: 'How it works',
        content: {
          flow: [
            { label: 'Lock', desc: 'Sender locks funds with a SHA-256 hash of a secret', icon: '🔒' },
            { label: 'Share', desc: 'Sender shares the hash (not the secret) with the recipient', icon: '📤' },
            { label: 'Claim', desc: 'Recipient reveals the secret to claim funds', icon: '🔑' },
            { label: 'OR Refund', desc: 'If secret is never revealed, sender signs a refund after timeout', icon: '🔄' }
          ],
          codePreview: `// Path A: Recipient reveals the secret to claim
				entry claim(byte[32] secret, sig recipientSig) {
					require(sha256(byte[](secret)) == secretHash);
					require(checkSig(recipientSig, recipient));
				}

				// Path B: Sender signs a refund after timeout
				entry refund(sig senderSig) {
					require(checkSig(senderSig, sender));
					require(this.ageDaa >= 6048000); // ~7 days
				}`,
          concepts: [
            { term: 'sha256(byte[](secret))', definition: 'Hashes the revealed secret. If it matches the stored hash, the secret is valid.' },
            { term: 'Preimage', definition: 'The original secret value. Knowing it proves you\'re authorized to claim — without needing the sender\'s cooperation.' },
            { term: 'Atomic', definition: 'When used in a cross-chain swap, revealing the secret on one chain lets the other party extract it and claim on the other chain. All or nothing.' }
          ]
        }
      },
      // ── Step 3: Configure ──
      {
        type: 'configure',
        title: 'Configure your swap',
        fields: [
          {
            name: 'contractName',
            label: 'Contract name',
            type: 'text',
            default: 'HashLockedSwap',
            hint: 'A descriptive name — e.g. AliceBobSwap, CrossChainHTLC',
            validate: 'identifier'
          },
          {
            name: 'senderPubkey',
            paramName: 'sender',
            label: 'Sender public key',
            type: 'text',
            default: '',
            hint: 'The sender who locks the funds and can refund after timeout. Connect a wallet to auto-fill.',
            placeholder: 'Kaspa address or public key',
            validate: 'pubkey'
          },
          {
            name: 'recipientPubkey',
            paramName: 'recipient',
            label: 'Recipient public key',
            type: 'text',
            default: '',
            hint: 'The recipient who can claim by revealing the secret.',
            placeholder: 'Kaspa address or public key',
            validate: 'pubkey'
          },
          {
            name: 'secretHash',
            paramName: 'secretHash',
            label: 'Secret hash (SHA-256)',
            type: 'text',
            default: '',
            hint: 'The SHA-256 hash of your secret. Generate one off-chain and share only the hash, never the secret.',
            placeholder: '64-character hex hash',
            validate: 'hash'
          },
          {
            name: 'timeoutDays',
            label: 'Timeout (days)',
            type: 'number',
            default: '7',
            hint: 'After this many days, the sender can reclaim if the secret was never revealed. For cross-chain swaps, use a shorter timeout on the second leg.',
            max: 4000  // this.ageDaa must stay below 2^32 (about 4,970 days)
          }
        ]
      },
      // ── Step 4: Review ──
      {
        type: 'review',
        title: 'Review & Create'
      }
    ],

    generate: (v) => {
      const timeoutDays = parseInt(v.timeoutDays) || 7;
      return `pragma silverscript ^0.1.0;

// ${v.contractName || 'HashLockedSwap'}
// Hash-Locked Swap (HTLC) — trustless conditional payment.
// Recipient claims by revealing a secret that matches the hash.
// Sender can sign a refund after ${timeoutDays} days if unclaimed.

contract ${v.contractName}(pubkey sender, pubkey recipient, byte[32] secretHash) {

    // ── Path A: Claim with Secret ────────────────────
    // Recipient reveals the preimage to claim funds.
    // The SHA-256 hash of the secret must match.
    entry claim(byte[32] secret, sig recipientSig) {
        require(sha256(byte[](secret)) == secretHash);
        require(checkSig(recipientSig, recipient));
    }

    // ── Path B: Refund After Timeout ─────────────────
    // If the secret is never revealed, the sender
    // can sign a refund after the timeout expires.
    entry refund(sig senderSig) {
        require(checkSig(senderSig, sender));
        require(this.ageDaa >= ${daysToDaa(timeoutDays)}); // ~${timeoutDays} days
    }
}`;
    },

    annotations: (v) => [
      { line: 'pragma', text: 'Version declaration — tells the compiler which SilverScript version to use' },
      { line: 'contract', text: `"${v.contractName}" — a hash-locked swap with timeout refund` },
      { line: 'Path A', text: 'Claim path — recipient reveals the secret to unlock funds' },
      { line: 'sha256(byte[](secret))', text: 'Hash the revealed secret and compare to the stored hash' },
      { line: 'checkSig(recipientSig', text: 'Also verify the recipient\'s signature — prevents front-running' },
      { line: 'Path B', text: `Refund path — sender can sign a refund after ${v.timeoutDays || 7} days` },
      { line: 'this.ageDaa', text: `Funds must be about ${v.timeoutDays || 7} days old (${daysToDaa(v.timeoutDays, 7).toLocaleString()} blocks) before the sender can sign a refund` }
    ]
  },


  // ────────────────────────────────────────────────────
  // 9. DEAD MAN'S SWITCH
  // ────────────────────────────────────────────────────
  deadman: {
    id: 'deadman',
    title: "Dead Man's Switch",
    subtitle: 'Inheritance',
    icon: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4"/><circle cx="12" cy="16" r="1"/></svg>`,
    color: '#e17055',

    steps: [
      // ── Step 1: What ──
      {
        type: 'explain',
        title: "What is a Dead Man's Switch?",
        content: {
          analogy: {
            icon: '🛡️',
            title: 'Like a will — but enforced by code',
            text: 'You lock funds in a contract with a <em>countdown timer</em>. If you don\'t "check in" before the timer runs out, the funds become <em>claimable</em> by your chosen beneficiary — they still need to sign a transaction to collect. Every time you check in, the timer resets.'
          },
          bullets: [
            { icon: '⏳', text: '<strong>Inactivity trigger</strong> — funds become claimable by the beneficiary only if the owner goes silent for the specified period. The beneficiary must still sign a transaction to collect.' },
            { icon: '🔄', text: '<strong>Reset by spending</strong> — the owner "checks in" by spending the UTXO back to the same contract, which resets the age timer.' },
            { icon: '🏠', text: '<strong>Inheritance</strong> — pass crypto to family members without sharing private keys. They can sign a claim transaction only after you\'ve been inactive.' },
            { icon: '🔐', text: '<strong>Recovery</strong> — designate a backup key that activates only after extended inactivity. Great for lost-key scenarios.' }
          ],
          whoUsesThis: 'Anyone who wants a trustless inheritance plan, a backup recovery mechanism, or a claimable transfer triggered by inactivity.'
        }
      },
      // ── Step 2: How ──
      {
        type: 'diagram',
        title: 'How it works',
        content: {
          flow: [
            { label: 'Deposit', desc: 'Owner locks funds with a beneficiary and timeout', icon: '🔒' },
            { label: 'Active', desc: 'Owner checks in by spending back to the same contract', icon: '🔄' },
            { label: 'Inactive', desc: 'If owner stops checking in, timer runs out', icon: '⏰' },
            { label: 'Claim', desc: 'Beneficiary signs a claim transaction after inactivity period', icon: '💰' }
          ],
          codePreview: `// Path A: Owner spends (normal use or check-in)
			entry spend(sig ownerSig) {
				require(checkSig(ownerSig, owner));
				// Spending back to the same covenant resets this.ageDaa
			}

			// Path B: Beneficiary claims after inactivity
			entry claim(sig beneficiarySig) {
				require(checkSig(beneficiarySig, beneficiary));
				require(this.ageDaa >= 77760000); // ~90 days
			}`,
          concepts: [
            { term: 'this.ageDaa', definition: 'The age of the UTXO in blocks (DAA score, about 864,000 per day). Every time the owner spends back to the covenant, a new UTXO is created and the age resets to zero.' },
            { term: 'Check-in', definition: 'The owner sends the funds back to the same contract address. This creates a fresh UTXO with age = 0, resetting the dead man\'s switch.' },
            { term: 'Covenant check-in', definition: 'The owner can optionally be forced to send back to the same contract (covenant-enforced), preventing accidental withdrawal of the protected funds.' }
          ]
        }
      },
      // ── Step 3: Configure ──
      {
        type: 'configure',
        title: 'Configure your switch',
        fields: [
          {
            name: 'contractName',
            label: 'Contract name',
            type: 'text',
            default: 'DeadManSwitch',
            hint: 'A descriptive name — e.g. MyInheritance, BackupRecovery',
            validate: 'identifier'
          },
          {
            name: 'ownerPubkey',
            paramName: 'owner',
            label: 'Owner public key',
            type: 'text',
            default: '',
            hint: 'Your key — you check in periodically to keep the switch from triggering. Connect a wallet to auto-fill.',
            placeholder: 'Kaspa address or public key',
            validate: 'pubkey'
          },
          {
            name: 'beneficiaryPubkey',
            paramName: 'beneficiary',
            label: 'Beneficiary public key',
            type: 'text',
            default: '',
            hint: 'Who receives the funds if you stop checking in.',
            placeholder: 'Kaspa address or public key',
            validate: 'pubkey'
          },
          {
            name: 'inactivityDays',
            label: 'Inactivity period (days)',
            type: 'number',
            default: '90',
            hint: 'How many days of inactivity before the beneficiary can claim. Longer = safer but slower recovery. 90 days is a common choice.',
            max: 4000  // this.ageDaa must stay below 2^32 (about 4,970 days)
          },
          {
            name: 'enforceCheckin',
            label: 'Enforce covenant check-in?',
            type: 'select',
            options: [
              { value: 'no', label: 'No — owner can spend freely (simpler)' },
              { value: 'yes', label: 'Yes — owner must send back to same contract' }
            ],
            default: 'no',
            hint: 'If yes, the owner\'s spend path enforces that funds return to the same contract address. This prevents accidentally withdrawing the protected funds.'
          }
        ]
      },
      // ── Step 4: Review ──
      {
        type: 'review',
        title: 'Review & Create'
      }
    ],

    generate: (v) => {
      const inactivityDays = parseInt(v.inactivityDays) || 90;
      const covenantCheckin = v.enforceCheckin === 'yes';

      const checkinBody = covenantCheckin
        ? `        require(checkSig(ownerSig, owner));

        // Covenant: funds must return to this contract
        // This resets the age timer without letting funds escape
        int minerFee = 1000;
        int currentValue = tx.inputs[this.activeInputIndex].value;
        require(tx.outputs[0].scriptPubKey == tx.inputs[this.activeInputIndex].scriptPubKey);
        require(tx.outputs[0].value >= currentValue - minerFee);`
        : `        require(checkSig(ownerSig, owner));
        // Owner can spend freely — to check in, send back to the same address`;

      const covenantDesc = covenantCheckin
        ? '\n// Owner check-in is covenant-enforced — funds must return to\n// the contract, resetting the inactivity timer.'
        : '\n// Owner can spend freely. To check in, send funds back to\n// the same contract address to reset the timer.';

      return `pragma silverscript ^0.1.0;

// ${v.contractName || 'DeadManSwitch'}
// Dead Man's Switch — trustless inheritance / recovery.
// Owner checks in periodically. If inactive for
// ${inactivityDays} days, the beneficiary can claim.${covenantDesc}

contract ${v.contractName}(pubkey owner, pubkey beneficiary) {

    // ── Path A: Owner Spend / Check-In ───────────────
    // Owner uses this to spend normally or to "check in"
    // by sending funds back to this contract.
    // Each check-in resets the inactivity timer.
    entry spend(sig ownerSig) {
${checkinBody}
    }

    // ── Path B: Beneficiary Claims After Inactivity ──
    // If the owner hasn't checked in for ${inactivityDays} days,
    // the beneficiary can claim all funds.
    entry claim(sig beneficiarySig) {
        require(checkSig(beneficiarySig, beneficiary));
        require(this.ageDaa >= ${daysToDaa(inactivityDays)}); // ~${inactivityDays} days
    }
}`;
    },

    annotations: (v) => {
      const days = v.inactivityDays || 90;
      const base = [
        { line: 'pragma', text: 'Version declaration — tells the compiler which SilverScript version to use' },
        { line: 'contract', text: `"${v.contractName}" — a dead man's switch with ${days}-day inactivity trigger` },
        { line: 'Path A', text: 'Owner path — spend normally or check in to reset the timer' },
        { line: 'checkSig(ownerSig', text: 'Only the owner can spend or check in' },
        { line: 'Path B', text: `Beneficiary path — claimable after ${days} days of owner inactivity` },
        { line: 'checkSig(beneficiarySig', text: 'Only the designated beneficiary can claim' },
        { line: 'this.ageDaa', text: `The UTXO must be about ${days} days old (${daysToDaa(days, 90).toLocaleString()} blocks), meaning the owner hasn't checked in` }
      ];
      if (v.enforceCheckin === 'yes') {
        base.splice(4, 0,
          { line: 'tx.inputs[this.activeInputIndex].scriptPubKey', text: 'Covenant enforcement — funds must return to this same contract' },
          { line: 'currentValue - minerFee', text: 'All funds minus miner fee must return — prevents draining during check-in' }
        );
      }
      return base;
    }
  }  
};

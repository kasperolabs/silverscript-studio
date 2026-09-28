# Kaspa Spend Map (.ksm), version 1

A `.ksm` file is a small JSON document that holds everything needed to verify and spend one Kaspa P2SH covenant, with no dependency on the website, wallet or company that created it. If you hold the file and the right keys, you can get your money out with any software that follows this document.

This specification is independent of any product. SilverScript Studio produces `.ksm` files, and the reference library `kaspa-ksm` reads them, but neither is required.

---

## 1. Why this file has to exist

A covenant on Kaspa is a P2SH output. The chain stores only this:

```
OP_BLAKE2B <32-byte hash of the redeem script> OP_EQUAL      (hex: aa20<hash>87)
```

The redeem script itself, which holds the rules, the keys and the time locks, is **not on chain** until the first time someone spends from the address. To spend, you must present the exact script bytes whose hash matches. If nobody has those bytes, the coins at that address cannot be moved by anyone, ever.

On top of the script, a spender needs to know things the script does not say in plain terms: which spend paths exist, how to select one, what arguments each path takes and in what order, which transaction fields the locks require. Services usually keep this in a private database. A `.ksm` file is that knowledge, written down in a form any program can read.

Three consequences to keep in mind:

1. **Keep the file.** Losing a `.ksm` does not give anyone your money, but it can make your own money unreachable if you cannot rebuild the script another way.
2. **Get it before you fund.** A creator should hand out the file at the moment the covenant is created, not later.
3. **The file is checkable.** Anyone can hash `script.hex` and compare it with the address. A file that passes this check describes the real covenant; a file that fails it must not be used.

---

## 2. What the file is, and is not

It **is** a public description of spending rules. It contains public keys, never private keys.

It **is not** a secret in the way a seed phrase is. Holding a `.ksm` does not let you spend a path that requires a signature you cannot produce.

It **can** be sensitive in two ways:

- **Privacy.** It reveals every party's public key (and so their addresses), the amounts they agreed to, and the contract name. Share it with the parties, not the world.
- **Paths with no signature.** If a spend path requires no signature and does not pin where the money goes, then whoever knows the script can spend it. For such a covenant the file is effectively a bearer instrument. Tools should warn about this, and `ksm inspect` does.

---

## 3. A file at a glance

Abridged; `examples/vault.ksm` is the full version.

```json
{
  "ksm": 1,
  "network": "mainnet",
  "address": "kaspa:pp0jset6lljc6q0tl5hrqtgnenlnd7vsxvvjuvcwn6z62yx30z8gum6k0vh9s",
  "name": "Vault",
  "script": {
    "hex": "7604bf4a16608763...6a6868",
    "hash": "5f28657affe58d01ebfd2e302d13ccff36f99033192e330e9e85a510d1788e8e"
  },
  "entries": [
    {
      "name": "spend",
      "params": [{ "name": "ownerSig", "type": "sig" }],
      "dispatch": { "kind": "tag", "hex": "bf4a1660" },
      "locks": { "cltv": [], "csv": [] },
      "sigOps": 1,
      "payTo": null,
      "signers": [{ "sig": "ownerSig", "key": "owner", "pubkey": "4c10...c581" }]
    },
    {
      "name": "reclaim",
      "params": [{ "name": "funderSig", "type": "sig" }],
      "dispatch": { "kind": "tag", "hex": "35eecca6" },
      "locks": { "cltv": [], "csv": ["864000"] },
      "sigOps": 1,
      "payTo": null
    }
  ],
  "constructorArgs": [
    { "name": "owner",  "type": "pubkey", "value": "4c10...c581" },
    { "name": "funder", "type": "pubkey", "value": "1dc3...74e9" }
  ],
  "parties": [
    { "role": "owner",  "pubkey": "4c10...c581", "address": "kaspa:qpxpq2...wyasr" },
    { "role": "funder", "pubkey": "1dc3...74e9", "address": "kaspa:qqwu82...50sl0" }
  ],
  "source": { "language": "silverscript", "contract": "Vault", "text": "contract Vault(...) { ... }" },
  "compiler": { "name": "silverc", "version": "1.0.0", "ref": "3ed9733" }
}
```

Read in plain words: this covenant lives at that address; the owner can take the money at any time; the funder can take it back once the deposit is 864,000 DAA old (about one day on mainnet).

---

## 4. Field reference

Every field is either **required**, **derived** (a copy of something computable from `script.hex`, kept for convenience) or **informative** (useful context that no spend depends on).

The authority rule: **`script.hex` wins.** If a derived field disagrees with the script, the file is wrong about that field, and tools must use the value they compute from the script.

### Top level

| Field | Status | Meaning |
|---|---|---|
| `ksm` | required | Format version. This document defines `1`. |
| `network` | required | `mainnet`, `testnet-10`, `testnet-11`, `testnet-12`, `simnet` or `devnet`. Decides the address prefix (`kaspa`, `kaspatest`, `kaspasim`, `kaspadev`). |
| `address` | required, checked | The P2SH address. Must equal the address computed from `script.hex` and `network`. |
| `script.hex` | required | The redeem script, lowercase hex, no `0x`. The one field everything else hangs on. |
| `script.hash` | derived | BLAKE2b-256 of the script bytes. |
| `entries` | required | The spend paths, in the order the contract declares them. See below. |
| `name` | informative | Human name of the covenant. |
| `constructorArgs` | informative | The values the contract was built with. Needed to reproduce the script from source. |
| `parties` | informative | People involved, by role. |
| `source` | informative | The contract source code. Strongly recommended: it lets anyone read the rules and recompile. |
| `compiler` | informative | What produced the script (name, version, commit ref). Needed to reproduce it. |
| `funding` | informative | Expected deposit and known deposits. Never a balance: the chain is the only balance. |
| `created` | informative | When, by what tool, and an optional link back to it. |
| `extensions` | informative | Tool-specific data, namespaced (see section 12). |

### `entries[]`

| Field | Status | Meaning |
|---|---|---|
| `name` | required | Path name, unique within the file. |
| `params` | required | Arguments the spender supplies, in declaration order: `[{ name, type }]`. |
| `dispatch` | required | How the spender selects this path. One of `{ "kind": "tag", "hex": "<4 bytes>" }`, `{ "kind": "selector", "n": 0..16 }`, `{ "kind": "none" }`. |
| `locks` | derived | Time locks on this path: `{ "cltv": [...], "csv": [...] }`, decimal strings. |
| `sigOps` | derived | Signature-check opcodes on this path (at least 1). |
| `payTo` | derived | If the path forces where the money goes: `{ "kind": "p2pk", "pubkey": "<hex>" }`, else `null`. |
| `signers` | informative | Which key each `sig` param is checked against: `[{ sig, key, pubkey?, open? }]`. `pubkey` is filled when `key` is a constructor argument; `open: true` means the key is an entry argument, so whoever spends supplies their own key. |

### Dispatch kinds

- **`tag`**: SilverScript compiled with `silverc` 1.0 or later. Every entry has a 4-byte tag, and the script branches on `OP_DUP <tag> OP_EQUAL OP_IF`. The tag is derived from the entry's signature (name and parameter types), so it does not change when you rename the contract.
- **`selector`**: older multi-entry scripts. The script branches on `OP_DUP <n> OP_NUMEQUAL OP_IF`, where `n` is the entry's position.
- **`none`**: a single-entry script with no branching.

A file must not mix `tag` with the other kinds, and a file with more than one entry must not use `none`.

### Types

| Type | Canonical value in the file | Pushed on the stack as |
|---|---|---|
| `int` | decimal string, e.g. `"86400"` | minimal script number |
| `temporal` | decimal string of Unix milliseconds | minimal script number |
| `bool` | JSON `true` / `false` | script number 1 or 0 |
| `byte` | JSON number 0..255 | one byte |
| `pubkey` | 64 hex chars (32-byte x-only Schnorr key) | 32 bytes |
| `sig` | 130 hex chars (64-byte signature + 1 sighash byte) | 65 bytes |
| `datasig` | 128 hex chars | 64 bytes |
| `string` | UTF-8 text | UTF-8 bytes |
| `byte[]` | hex | bytes |
| `byte[N]` | hex of exactly N bytes | N bytes |

Rules for all values: hex is lowercase with no `0x`; integers are strings so that 64-bit values survive JavaScript; amounts are in sompi (1 KAS = 100,000,000 sompi), also as decimal strings.

Other types (structs, arrays of non-bytes) have no push encoding in version 1. A verifier warns about them; a spender cannot use a path that takes them.

---

## 5. Encodings a spender must get exactly right

**Data push.** Always the shortest form:

| Bytes | Encoding |
|---|---|
| empty | `00` (OP_0) |
| one byte 1..16 | `51`..`60` (OP_1..OP_16) |
| one byte `0x81` | `4f` (OP_1NEGATE) |
| 1..75 bytes | length byte, then the bytes |
| 76..255 bytes | `4c`, length byte, bytes |
| 256..65535 bytes | `4d`, length as 2 bytes little-endian, bytes |

**Script number.** Little-endian magnitude; the top bit of the last byte is the sign. Zero is the empty string. If the magnitude's top byte already has its high bit set, append `00` (positive) or `80` (negative). Examples: 5 → `05`, 128 → `8000`, 86400 → `805101`, -1 → `81`.

**Addresses.** Kaspa uses CashAddr-style bech32: `prefix:` + base32(version byte + payload) + an 8-character checksum. The checksum uses the 40-bit BCH generator of CashAddr, with the prefix expanded as each character's low 5 bits followed by a zero. Version `8` is P2SH (payload: BLAKE2b-256 of the redeem script). Version `0` is a Schnorr public key (payload: 32-byte x-only key). Bitcoin's bech32 expansion gives wrong checksums; do not use it.

**Hash.** BLAKE2b with a 32-byte output (not BLAKE2b-512 truncated; the output length is part of the parameter block).

**Opcodes that differ from Bitcoin.** On Kaspa, `0xb0` is `OP_CHECKLOCKTIMEVERIFY` and `0xb1` is `OP_CHECKSEQUENCEVERIFY`. Bitcoin tables put them one slot higher. A lock reader built on Bitcoin's table will read the wrong kind of lock.

---

## 6. Verifying a file

Do this every time you load a file you did not just create yourself.

1. Parse the JSON. Reject unless `ksm` is `1`, `network` is known, `script.hex` is non-empty lowercase hex, and `entries` is a non-empty list where each entry has `name`, `params` and a `dispatch` of a known kind.
2. Tokenize the script. A push that runs past the end is fatal.
3. Compute `hash = BLAKE2b-256(script bytes)`. If `script.hash` is present and differs, reject.
4. Compute the address from `network` and `hash` (version 8). If it differs from `address`, reject. If the address's prefix belongs to another network, say so.
5. For each entry, find its branch in the script: a `tag` entry must have `OP_DUP <tag> OP_EQUAL OP_IF` somewhere, a `selector` entry must have `OP_DUP <n> OP_NUMEQUAL OP_IF`. A missing branch is fatal: the file describes a path the script does not have.
6. For each party, the address (if given) must be the version-0 address of its `pubkey`.
7. Recompute `locks`, `sigOps` and `payTo` for each entry (section 7). Differences are warnings; use your values.
8. Optional but valuable: if `source`, `constructorArgs` and `compiler` are present, compile the source with that compiler and those arguments and compare the bytes with `script.hex`. A match proves the source text really is the rules you are looking at. (`ksm reproduce` does this with `silverc`.)

If steps 1 to 6 pass, the file can be used to spend. If step 8 passes too, the human-readable source can be trusted as well.

---

## 7. Reading one path out of the script

A spender needs three facts per path. Each is read from the path's own branch, so that a lock on one path is not applied to another.

**Finding the branch.** Locate the guard (section 6, step 5). The branch runs from just after `OP_IF` to the `OP_ELSE` at the same depth, counting nested `OP_IF`/`OP_NOTIF` against `OP_ENDIF`. If the branch closes with `OP_ENDIF` instead, keep reading to the end of the script (this errs toward seeing more locks, never fewer). With dispatch `none`, the branch is the whole script. If a guard cannot be found, use the whole script and treat the path as suspect.

**Time locks.** A lock opcode takes the number on top of the stack. Two layouts occur:

```
<N> OP_CHECKSEQUENCEVERIFY                                   older compilers
<N> OP_DUP OP_0 <2^32> OP_WITHIN OP_VERIFY OP_CHECKSEQUENCEVERIFY   silverc 1.0 (range check first)
```

So the lock value is the last number pushed right before the lock opcode, or, if the ops in between are only `OP_DUP` then pushes, `OP_WITHIN` and `OP_VERIFY`, the number that was duplicated. `OP_CHECKLOCKTIMEVERIFY` (0xb0) values go in `locks.cltv`; `OP_CHECKSEQUENCEVERIFY` (0xb1) values go in `locks.csv`.

**Signature ops.** Count `OP_CHECKSIG`, `OP_CHECKSIGVERIFY`, `OP_CHECKMULTISIG` and `OP_CHECKMULTISIGVERIFY` (0xac..0xaf) in the branch, minimum 1.

**Pinned payee.** A path that requires the first output to pay a fixed key compiles, in SilverScript, to `<000020> <32-byte key> OP_CAT <ac> OP_CAT ...` (building the P2PK script `20<key>ac` with a version prefix). If found, the spend must pay that key's address. This detection is best effort: other ways of pinning an output are not recognised, and in that case the node, not your tool, will tell you the output is wrong.

---

## 8. Spending, step by step

This is the full procedure, without any particular library. The reference library does steps 3 to 8 for you; see section 10.

### Step 1: find the coins

Ask a node or an indexer for the UTXOs at `address`. With a rusty-kaspa node that runs with `--utxoindex`, that is `getUtxosByAddresses`. Each UTXO has an outpoint (txid and index), an amount in sompi, and `blockDaaScore`, the DAA score of the block that created it. You need all three.

Each UTXO is a separate input and gets its own signatures. Spending many small deposits costs a fee per input; very small ones may be worth less than their fee.

### Step 2: choose a path and check it can go now

Pick an entry. Read its locks (section 7) and compare with the chain:

- **CLTV value below 500,000,000,000**: a DAA score. The current virtual DAA score must be at least that value.
- **CLTV value at or above 500,000,000,000**: Unix milliseconds. The current time must be past it (the node judges this by chain time, not your clock, so allow some slack).
- **CSV value N**: every UTXO you spend must be at least N DAA old: `blockDaaScore + N <= current DAA score`.

A path that mixes a DAA-score CLTV and a timestamp CLTV cannot be spent in one transaction.

On mainnet, about 10 DAA pass per second, so one day is roughly 864,000 DAA.

### Step 3: build the unsigned transaction

Inputs: the covenant UTXOs. Outputs: where the money goes, minus the fee. If the path has a `payTo`, the first output must pay exactly that key's version-0 address. Otherwise it is your choice, and a path's own rules may add conditions a generic tool cannot see; the node will reject anything the rules forbid.

### Step 4: set the fields the locks need, before signing

These fields are covered by the signature hash, so they must be final before anyone signs:

- `lockTime` of the transaction = the largest CLTV value of the path (or 0).
- `sequence` of every covenant input = the largest CSV value of the path (or 0).
- `sigOpCount` of every covenant input = the path's `sigOps`. Most SDKs write 1 by default; a path with two signature checks needs 2, or the node rejects the transaction for exceeding its script budget.

### Step 5: pay a fee that covers the real size

SDKs estimate mass with an empty signature script and one signature op. A covenant input carries the signatures, the arguments, the dispatch push and the whole redeem script, and each extra signature op adds mass too. Add that weight to the estimate and pay at least the node's minimum fee rate for the total. Underpaying gets the transaction rejected, not delayed.

### Step 6: sign

Each required key signs each covenant input with Schnorr, `SIGHASH_ALL` (sighash byte `01`). The signature placed in the script is 65 bytes: 64-byte signature followed by the sighash byte.

Wallets do not know your covenant, so they cannot finish the input themselves. Ask them only to sign, then build the signature script yourself. Known working calls, as of this writing:

- **Kasware**: `kasware.signPskt({ txJsonString, options: { signInputs: [{ index, sighashType: 1 }] } })`, one object argument, where `txJsonString` is the rusty-kaspa "safe JSON" of the unsigned transaction. The returned transaction has `signatureScript` = `41` + signature + `01` on each input you listed. Take the 65 bytes after `41`.
- **Kaspire**: the same shape plus a `sender` field, through `kaspire.request({ method: 'signPskt', params: {...} })`.
- Wallets that only sign their own address type (they leave covenant inputs empty) cannot be used for this step.

Check that the wallet is on the right network before signing; a signature made on another network is useless here.

### Step 7: assemble each input's signature script

Per input, concatenate:

```
<arg 1> <arg 2> ... <arg n>    the entry's params in declaration order;
                               a sig param is the push of its 65-byte signature,
                               any other param is the push of its value (section 4 table)
<dispatch>                     tag:      push of the 4 tag bytes     (04 + tag)
                               selector: push of the script number n (00 for 0, 51 for 1, ...)
                               none:     nothing
<redeem script>                push of script.hex
```

Example for the `spend` path above: `41<64-byte sig>01` `04bf4a1660` `4c6b<107 script bytes>`.

### Step 8: broadcast

Submit through any node (`submitTransaction`) or the wallet's push method. If the node rejects it, its message is the truth. Two messages worth knowing:

- "locktime requirement not satisfied ... N > 0": a CSV lock was not met, and the `0` is the input's `sequence`, not the transaction's lock time. The sequence was not set before signing.
- "Number too big ... 65 bytes": the script tried to read your signature as the path selector, so the dispatch push is missing.

---

## 9. Paths that need several signatures

When a path has two or more `sig` params, every signer must sign **the same unsigned transaction** (same inputs, outputs, lock fields and `sigOpCount`). A workable flow with no server:

1. One party builds the unsigned transaction (steps 1 to 5) and shares the safe JSON with the others, together with the `.ksm`.
2. Each party verifies the file, checks the outputs are what was agreed, signs every covenant input, and returns their signatures.
3. Whoever has all signatures assembles each input's script with every signature in its declared position, then broadcasts.

If anyone changes anything in the transaction after the first signature, every signature must be redone. If the coins at the address change (a new deposit, or someone spends first), the prepared transaction becomes invalid.

A coordination service can make this pleasant, but it is never required.

---

## 10. The reference library: `kaspa-ksm`

Plain JavaScript, no dependencies, Node 18+ and browsers. BLAKE2b, bech32, script reading and argument encoding are built in.

```
npm install kaspa-ksm
```

### Check a file

```js
const ksm = require('kaspa-ksm');
const r = ksm.verify(fs.readFileSync('vault.ksm', 'utf8'));
if (!r.ok) throw new Error(r.errors.join('\n'));   // wrong file: do not spend
r.warnings.forEach(w => console.warn(w));          // stale informative fields
```

### Plan a spend

```js
const plan = ksm.planSpend(manifest, 'reclaim', {
  args:  {},                                        // non-signature arguments, canonical values
  chain: { daa: currentDaa, nowMs: Date.now() },
  utxos: utxos.map(u => ({ blockDaaScore: u.blockDaaScore })),
});
plan.ready              // false with reasons in plan.blockers (e.g. "coins still aging ...")
plan.sequence           // put on every input
plan.lockTime           // put on the transaction
plan.sigOpCount         // put on every input
plan.payTo              // { pubkey, address } if the path forces the payee
plan.signaturesNeeded   // e.g. ['funderSig']
```

### Fill in the transaction and the signatures

```js
const unsigned = ksm.applyPlan(plan, txJsonString);           // sets sequence, lockTime, sigOpCount
const signed   = await kasware.signPskt({ txJsonString: unsigned,
                   options: { signInputs: inputs.map((_, index) => ({ index, sighashType: 1 })) } });
const tx = JSON.parse(typeof signed === 'string' ? signed : JSON.stringify(signed));
const final = ksm.finalize(plan, unsigned,
  tx.inputs.map(i => ({ funderSig: i.signatureScript })));     // accepts 41<sig>01 as returned
// submit `final` through a node
```

### With the Kaspa WASM SDK

`kaspa-ksm/sdk` wraps the whole build (sweep, fee sizing, lock fields) around the SDK you already use. You pass the SDK in; the core never imports it.

```js
const { buildSpendTx } = require('kaspa-ksm/sdk');
const kaspa = require('kaspa');                      // or the wasm32 SDK from the rusty-kaspa release
const { entries } = await rpc.getUtxosByAddresses({ addresses: [manifest.address] });
const { virtualDaaScore } = await rpc.getBlockDagInfo();
const built = await buildSpendTx({
  kaspa, manifest, entry: 'spend', utxos: entries,
  destination: 'kaspa:q...', daa: virtualDaaScore,
});
// built.txJsonString is ready for the wallet; built.plan feeds finalize()
```

This adapter mirrors a spend builder proven on mainnet, but SDK versions differ in small ways. Try a small amount first.

### Create a file

From `silverc` output:

```js
const art = JSON.parse(execFileSync('silverc', ['vault.sil', '--constructor-args', 'args.json', '-c']));
const ast = JSON.parse(execFileSync('silverc', ['vault.sil', '--ast-only', '-c']));
const manifest = ksm.fromSilvercArtifact(art, {
  network: 'mainnet', source: fs.readFileSync('vault.sil', 'utf8'),
  ast, constructorValues: [ownerPubkey, funderPubkey],
  compiler: { version: '1.0.0', ref: '3ed9733' },
});
```

From any other compiler, or by hand:

```js
const manifest = ksm.create({
  network: 'mainnet',
  script: redeemScriptHex,
  entries: [{ name: 'spend', params: [{ name: 'ownerSig', type: 'sig' }], dispatchTag: 'bf4a1660' }],
  constructorArgs: [{ name: 'owner', type: 'pubkey', value: 'kaspa:q...' }],   // addresses are accepted for pubkeys
  source: { text: sourceText, contract: 'Vault' },
});
```

`create` fills in the hash, address, per-path locks, `sigOps`, `payTo`, party addresses and, when source is given, `signers`. Entries without tags get selector dispatch automatically when there are several.

### Command line

```
npx kaspa-ksm verify    vault.ksm
npx kaspa-ksm inspect   vault.ksm [--asm]
npx kaspa-ksm plan      vault.ksm reclaim --daa 474200000 --utxo-daa 474100000
npx kaspa-ksm reproduce vault.ksm --silverc /path/to/silverc
```

`verify` exits 0 only for a usable file. `plan` exits 0 only when the path can be spent now. `reproduce` recompiles the source and compares the bytes.

### Other languages

Nothing here is JavaScript-specific. The JSON Schema in `ksm.schema.json` checks the shape; sections 5 to 8 are everything a reimplementation needs. BLAKE2b-256 is in most standard libraries (Python: `hashlib.blake2b(data, digest_size=32)`).

---

## 11. Tracking a covenant without anyone's service

The address is enough to watch the money: any Kaspa explorer or indexer shows its balance and history, and a node with `--utxoindex` can subscribe to UTXO changes for it. The `.ksm` adds meaning on top: what each deposit is for, when each path unlocks (from the locks and each UTXO's `blockDaaScore`), and who can act.

`funding` in the file is a record of intent and history, not a balance. Always read the balance from the chain.

---

## 12. Versioning and extensions

- `ksm` is an integer. Version 1 readers must refuse files with any other value rather than guess.
- New optional fields may appear in later minor revisions of version 1; readers must ignore fields they do not know.
- Tool-specific data goes under `extensions`, keyed by a name you control (a reverse domain works well): `"extensions": { "io.example.mytool": { ... } }`. Nothing under `extensions` may change how a spend is built.
- A change that alters how a spend is built or verified is version 2.

---

## 13. Known limits of version 1

- `payTo` detection recognises one output-pinning pattern. Other covenant rules about outputs (amounts, change back to the covenant, several outputs) are not described in the file; the node enforces them at spend time.
- A path whose branch closes with `OP_ENDIF` may pick up locks from the shared tail of the script. This errs toward a longer wait, never a failed spend due to a missing lock field.
- Only the types in section 4 have defined encodings.
- The file does not describe state-carrying covenants (paths that must re-create themselves in an output). Tools can still spend them if they know how to build the outputs.

---

## 14. Glossary

- **Covenant**: coins locked by a script that says who can spend them, when, and sometimes where they may go.
- **P2SH**: pay-to-script-hash. The chain stores only the script's hash; the script is revealed when spent.
- **Redeem script**: the covenant's compiled rules, `script.hex`.
- **Entry / spend path**: one way to unlock the coins.
- **Dispatch**: the value a spender pushes to pick a path.
- **DAA score**: Kaspa's block-height-like counter, about 10 per second on mainnet.
- **CLTV / CSV**: absolute and relative time locks (`OP_CHECKLOCKTIMEVERIFY`, `OP_CHECKSEQUENCEVERIFY`).
- **Sompi**: the smallest unit; 1 KAS = 100,000,000 sompi.
- **Safe JSON**: rusty-kaspa's JSON form of a transaction, with 64-bit numbers as strings.

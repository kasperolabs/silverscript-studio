# kaspa-ksm

Reference library and CLI for the **Kaspa Spend Map** (`.ksm`): one JSON file per covenant that lets anyone verify it and spend from it, with no dependency on the service that created it.

The format is specified in [KSM.md](KSM.md). The JSON Schema is `ksm.schema.json`.

```
npm install kaspa-ksm
npx kaspa-ksm verify my-covenant.ksm
```

```js
const ksm = require('kaspa-ksm');
const r = ksm.verify(text);                       // hash + address + branches checked against the script
if (r.ok) {
  const plan = ksm.planSpend(text, 'spend', { chain: { daa } });   // lock fields, dispatch, readiness
}
```

- No dependencies. BLAKE2b, Kaspa bech32, script reading and argument encoding are built in.
- Works in Node 18+ and browsers.
- `kaspa-ksm/sdk` builds the unsigned spend with the Kaspa WASM SDK you pass in.

Tests: `npm test`.

Produced by SilverScript Studio; usable by anyone. MIT licensed.

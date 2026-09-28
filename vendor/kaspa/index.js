// Kaspa WASM SDK (Covenants++ build) used by SilverScript Studio.
// Vendored because the build running mainnet is newer than the npm "kaspa" 0.13.0 package.
globalThis.WebSocket = require('isomorphic-ws');
module.exports = require('./kaspa.js');

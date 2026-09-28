'use strict';
const manifest = require('./manifest');
const spend = require('./spend');
const address = require('./address');
const script = require('./script');
const args = require('./args');
const { blake2b, blake2b256 } = require('./blake2b');
const bytes = require('./bytes');

module.exports = {
  ...manifest,
  ...spend,
  address, script, args, bytes,
  blake2b, blake2b256,
  p2shAddress: address.p2shAddress,
  p2pkAddress: address.p2pkAddress,
  disassemble: script.disassemble,
  // buildSpendTx lives in 'kaspa-ksm/sdk' so the core never touches the SDK
};

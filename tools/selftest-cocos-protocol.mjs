// Raw Cocos System.register bundles (APP/channel builds) do not have the
// define('src/chunks/bundle.*.js') wrapper used by WeChat mini-game packages.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temporary = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporary, 'cw-cocos-protocol-'));
const previous = process.env.CW_PROTO_BUNDLE;
try {
  const bundle = path.join(directory, 'bundle.js');
  fs.writeFileSync(bundle, `System.register([], function (_export, _context) { return { execute: function () {
System.register('chunks:///_virtual/proto-bundle.js', ['helpers', 'minimal'], function (publish) {
  let minimal;
  return { setters: [function () {}, function (module) { minimal = module.default; }], execute: function () {
    const protocol = {};
    for (const name of ['LoginRequest', 'LoginResponse', 'PingRequest', 'PingResponse', 'Ack', 'Nack']) {
      function Message() {}
      Message.encode = function (_body, writer) { return (writer || minimal.Writer.create()).uint32(8).int32(1); };
      Message.decode = function (bytes) {
        const reader = bytes instanceof minimal.Reader ? bytes : minimal.Reader.create(bytes);
        while (reader.pos < reader.len) reader.skipType(reader.uint32() & 7);
        return {};
      };
      protocol[name] = Message;
    }
    publish('protocol', protocol);
  } };
});
} }; });`);
  process.env.CW_PROTO_BUNDLE = bundle;
  const { describe, getProtocol } = await import('../src/proto.mjs');
  const protocol = getProtocol();
  assert.equal(typeof protocol.LoginRequest?.encode, 'function');
  assert.equal(typeof protocol.LoginResponse?.decode, 'function');
  assert.equal(describe(protocol).messages, 6);
  console.log('Cocos System.register protocol selftest passed');
} finally {
  if (previous === undefined) delete process.env.CW_PROTO_BUNDLE;
  else process.env.CW_PROTO_BUNDLE = previous;
  assert.equal(path.dirname(fs.realpathSync(directory)), temporary);
  fs.rmSync(directory, { recursive: true, force: true });
}

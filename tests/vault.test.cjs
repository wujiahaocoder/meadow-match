'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { webcrypto } = require('node:crypto');
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const Vault = require('../vault.js');
const Engine = require('../engine.js');

function sessionFor(seed, layout) {
  const now = new Date().toISOString();
  return {
    format: 1, generator: 1, seed, level: layout.level, highest: layout.level,
    cleared: 0, layout, game: Engine.createGame(layout),
    history: [layout.fingerprint], createdAt: now, updatedAt: now
  };
}

(async () => {
  const seed = Vault.newSeed();
  assert.match(seed, /^\d{39,49}$/);
  assert.ok(BigInt(seed) >= 1n << 127n);
  assert.notEqual(seed, Vault.newSeed());
  for (const length of [1, 2, 6, 7, 8, 15, 32, 257, 1024]) {
    const source = webcrypto.getRandomValues(new Uint8Array(length));
    source[0] = 0;
    source[length - 1] = 0;
    const code = Vault.encodeDecimal(source);
    assert.match(code, /^\d+$/);
    assert.deepEqual(Vault.decodeDecimal(code), source, 'numeric round trip keeps leading and trailing zero bytes');
  }
  assert.throws(() => Vault.decodeDecimal('1'.repeat(100)));
  assert.throws(() => Vault.decodeDecimal('a'.repeat(100)));
  assert.throws(() => Vault.decodeDecimal('1000000001072057594037927936'));

  const layout = await Engine.generate(seed, 2, 0);
  const session = sessionFor(seed, layout);
  // Persist a nontrivial mid-level position, including a live undo snapshot.
  for (const id of layout.solution.slice(0, 4)) {
    const result = Engine.pick(layout, session.game, id);
    assert.ok(result.ok);
  }
  await Vault.validate(session);
  const code1 = await Vault.encrypt(seed, session);
  const code2 = await Vault.encrypt(seed, session);
  assert.match(code1, /^\d+$/);
  assert.notEqual(code1, code2, 'fresh salt and nonce for every export');
  const restored = await Vault.decrypt(seed, code1);
  assert.deepEqual(restored, session, 'mid-level game, tray order, tool counts, undo, history, and layout survive');
  await assert.rejects(() => Vault.decrypt(Vault.newSeed(), code1), /种子不正确|已损坏/);
  const bytes = Vault.decodeDecimal(code1);
  bytes[bytes.length - 7] ^= 1;
  await assert.rejects(() => Vault.decrypt(seed, Vault.encodeDecimal(bytes)), /种子不正确|已损坏/);
  await assert.rejects(() => Vault.decrypt(seed, code1.slice(0, -1)), /长度不正确/);
  await assert.rejects(() => Vault.decrypt('123', code1), /种子/);

  const invalid = structuredClone(session);
  invalid.game.tray.push(invalid.game.tray[0]);
  await assert.rejects(() => Vault.validate(invalid), /重复|不一致/);
  const invalidStatus = structuredClone(session);
  invalidStatus.game.status = 'won';
  await assert.rejects(() => Vault.validate(invalidStatus), /胜负状态/);
  const invalidHistory = structuredClone(session);
  invalidHistory.history.push(invalidHistory.history[0]);
  await assert.rejects(() => Vault.validate(invalidHistory), /历史/);
  const invalidVersion = structuredClone(session);
  invalidVersion.generator = 999;
  await assert.rejects(() => Vault.validate(invalidVersion), /版本/);
  const invalidLayout = structuredClone(session);
  invalidLayout.layout.tiles[0].type = (invalidLayout.layout.tiles[0].type + 1) % 12;
  await assert.rejects(() => Vault.validate(invalidLayout), /校验失败/);
  const wrongGeneration = structuredClone(session);
  wrongGeneration.seed = Vault.newSeed();
  await assert.rejects(() => Vault.validate(wrongGeneration), /种子及生成参数/);

  // A fresh VM has no session/cache from this device. It receives ONLY two codes.
  const otherDevice = {
    module: { exports: {} }, require: createRequire(require.resolve('../vault.js')), crypto: webcrypto,
    TextEncoder, TextDecoder, Uint8Array, Blob, CompressionStream, DecompressionStream,
    structuredClone
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../vault.js'), 'utf8'), otherDevice);
  const imported = await otherDevice.module.exports.decrypt(seed, code1);
  assert.deepEqual(JSON.parse(JSON.stringify(imported)), session, 'cross-device restore requires only seed and encrypted decimal code');
  assert.equal(otherDevice.module.exports.HISTORY_LIMIT, 4096);
  const unsafeBrowser = { module: { exports: {} }, TextEncoder, TextDecoder, Uint8Array };
  vm.runInNewContext(fs.readFileSync(require.resolve('../vault.js'), 'utf8'), unsafeBrowser);
  assert.equal(unsafeBrowser.module.exports.available(), false);
  assert.throws(() => unsafeBrowser.module.exports.newSeed(), /Web Crypto API/);

  // Finish the restored certificate and check that the recovered board plays identically.
  const stateA = structuredClone(session.game), stateB = structuredClone(restored.game);
  for (const id of layout.solution.slice(4)) {
    assert.equal(Engine.pick(layout, stateA, id).ok, true);
    assert.equal(Engine.pick(restored.layout, stateB, id).ok, true);
  }
  assert.deepEqual(stateA, stateB);
  assert.equal(stateB.status, 'won');
  await Vault.validate({ ...session, game: stateB });
  console.log('PASS vault: numeric zero preservation; authenticated encryption; fresh salt/nonce; wrong seed; tampering; format/version/state rejection; mid-game and independent-device restore; identical subsequent play.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });

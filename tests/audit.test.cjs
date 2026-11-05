'use strict';
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const E = require('../engine.js');
const V = require('../vault.js');
const clone = structuredClone;

async function uncheckedEnvelope(seed, session) {
  // Intentionally bypass export validation to exercise the import trust boundary.
  const raw = new Uint8Array(20);
  let n = BigInt(seed);
  for (let i = 19; i >= 0; i--) { raw[i] = Number(n & 255n); n >>= 8n; }
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const nonce = webcrypto.getRandomValues(new Uint8Array(12));
  const material = await webcrypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt,
    info: new TextEncoder().encode('meadow-triples/offline-save/HKDF-SHA256/AES-256-GCM/v1') },
  material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const header = new Uint8Array([77, 84, 83, 1, 0]);
  const plain = clone(session); delete plain.seed;
  const encrypted = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
    additionalData: header, tagLength: 128 }, key, new TextEncoder().encode(JSON.stringify(plain))));
  const envelope = new Uint8Array(33 + encrypted.length);
  envelope.set(header); envelope.set(salt, 5); envelope.set(nonce, 21); envelope.set(encrypted, 33);
  return V.encodeDecimal(envelope);
}

(async () => {
  const seed = V.newSeed(), layout = await E.generate(seed, 3);
  const now = new Date().toISOString();
  const base = { format: 1, generator: 1, seed, level: 3, highest: 3, cleared: 0,
    createdAt: now, updatedAt: now, history: [layout.fingerprint], layout, game: E.createGame(layout) };
  await V.validate(base);

  const blocked = clone(base);
  const blockedId = E.blockers(layout).findIndex(ids => ids.length);
  blocked.game.places[blockedId] = 'tray';
  blocked.game.tray.push(blockedId);
  await assert.rejects(() => V.validate(blocked), /真实遮挡/);
  const invalidCode = await uncheckedEnvelope(seed, blocked);
  await assert.rejects(() => V.decrypt(seed, invalidCode), /真实遮挡/, 'authenticated but logically invalid save must be rejected');

  const unspentShuffle = clone(base);
  const otherId = layout.tiles.findIndex(t => t.type !== layout.tiles[0].type);
  [unspentShuffle.game.types[0], unspentShuffle.game.types[otherId]] =
    [unspentShuffle.game.types[otherId], unspentShuffle.game.types[0]];
  await assert.rejects(() => V.validate(unspentShuffle), /未使用洗牌/);

  const fakeUndo = clone(base);
  for (const id of layout.solution.slice(0, 2)) assert.ok(E.pick(layout, fakeUndo.game, id).ok);
  fakeUndo.game.undo = E.snapshot(base.game);
  await assert.rejects(() => V.validate(fakeUndo), /最近一次有效操作/);
  const unchangedUndo = clone(base);
  unchangedUndo.game.undo = E.snapshot(base.game);
  await assert.rejects(() => V.validate(unchangedUndo), /最近一次有效操作/);

  // Every actual operation, including undo's consumed-tool behavior, is accepted.
  const legitimate = clone(base);
  E.pick(layout, legitimate.game, layout.solution[0]);
  await V.validate(legitimate);
  E.takeOut(layout, legitimate.game);
  await V.validate(legitimate);
  E.pick(layout, legitimate.game, legitimate.game.reserve[0]);
  await V.validate(legitimate);
  E.shuffle(layout, legitimate.game, seed + '|audit');
  await V.validate(legitimate);
  E.undo(layout, legitimate.game);
  await V.validate(legitimate);
  assert.equal(legitimate.game.tools.undo, 0);
  assert.equal(legitimate.game.tools.shuffle, 0);
  assert.deepEqual(await V.decrypt(seed, await V.encrypt(seed, legitimate)), legitimate);
  console.log('PASS audit: removed-blocker closure; immutable pre-shuffle types; genuine single-operation undo; authenticated invalid-state rejection; valid pick/move/shuffle/undo round trips.');
})().catch(error => { console.error(error); process.exitCode = 1; });

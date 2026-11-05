(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MeadowVault = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const FORMAT = 1;
  const HISTORY_LIMIT = 4096;
  const MAX_BYTES = 1500000;
  const MAX_PLAIN = 4000000;
  const MAX_DIGITS = 10 + Math.ceil(MAX_BYTES / 7) * 17;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const INFO = encoder.encode('meadow-triples/offline-save/HKDF-SHA256/AES-256-GCM/v1');
  const VALIDATED_LAYOUTS = new Map();
  let dbPromise;
  let writeQueue = Promise.resolve();

  function fail(message) { throw new Error(message); }
  function cryptoAPI() {
    const c = root.crypto;
    if (!c || !c.subtle || !c.getRandomValues) {
      fail('当前浏览器未提供安全的 Web Crypto API，无法使用加密存档。请用支持此功能的现代浏览器打开本地文件，或使用 HTTPS / localhost。');
    }
    return c;
  }
  function engineAPI() {
    if (root.MeadowEngine) return root.MeadowEngine;
    if (typeof require === 'function') return require('./engine.js');
    fail('关卡验证模块尚未准备好。');
  }
  function parseSeed(seed) {
    if (typeof seed !== 'string' || !/^[1-9]\d{38,48}$/.test(seed)) fail('游戏种子应为 39–49 位十进制数字，请完整粘贴。');
    const value = BigInt(seed);
    if (value < (1n << 127n) || value >= (1n << 160n)) fail('游戏种子超出支持的安全范围。');
    let n = value;
    const bytes = new Uint8Array(20);
    for (let i = 19; i >= 0; i--) { bytes[i] = Number(n & 255n); n >>= 8n; }
    return bytes;
  }
  function newSeed() {
    const bytes = cryptoAPI().getRandomValues(new Uint8Array(20));
    bytes[0] |= 128;
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    return n.toString(10);
  }
  // Fixed-width chunks preserve zero bytes without a single unbounded BigInt.
  function encodeDecimal(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > MAX_BYTES) fail('存档数据过大，无法编码。');
    const parts = ['1', String(bytes.length).padStart(9, '0')];
    for (let offset = 0; offset < bytes.length; offset += 7) {
      let n = 0n;
      for (let j = 0; j < 7; j++) n = (n << 8n) | BigInt(bytes[offset + j] || 0);
      parts.push(n.toString(10).padStart(17, '0'));
    }
    return parts.join('');
  }
  function decodeDecimal(code) {
    if (typeof code !== 'string' || code.length < 27 || code.length > MAX_DIGITS || !/^\d+$/.test(code)) fail('存档码必须是完整的纯十进制数字，且不超过支持的容量。');
    if (code[0] !== '1') fail('不支持此数字编码版本。');
    const length = Number(code.slice(1, 10));
    if (length < 1 || length > MAX_BYTES || code.length !== 10 + Math.ceil(length / 7) * 17) fail('存档码长度不正确，可能未复制完整。');
    const bytes = new Uint8Array(Math.ceil(length / 7) * 7);
    for (let i = 10, offset = 0; i < code.length; i += 17, offset += 7) {
      let n = BigInt(code.slice(i, i + 17));
      if (n >= (1n << 56n)) fail('存档码包含无效数字分组。');
      for (let j = 6; j >= 0; j--) { bytes[offset + j] = Number(n & 255n); n >>= 8n; }
    }
    for (let i = length; i < bytes.length; i++) if (bytes[i] !== 0) fail('存档码尾部校验失败。');
    return bytes.slice(0, length);
  }
  async function deriveKey(seed, salt) {
    const c = cryptoAPI();
    const material = await c.subtle.importKey('raw', parseSeed(seed), 'HKDF', false, ['deriveKey']);
    return c.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: INFO }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function transform(bytes, decompress) {
    const Ctor = decompress ? root.DecompressionStream : root.CompressionStream;
    if (!Ctor) {
      if (decompress) fail('此浏览器不支持 gzip 解压，无法恢复该存档。请更新浏览器。');
      return null;
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new Ctor('gzip'));
    const reader = stream.getReader();
    const parts = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > (decompress ? MAX_PLAIN : MAX_BYTES)) { await reader.cancel(); fail('存档展开后超过容量限制。'); }
        parts.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }
  function integer(n, min, max) { return Number.isSafeInteger(n) && n >= min && n <= max; }
  function object(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }
  function assert(check, message) { if (!check) fail('存档校验失败：' + message); }
  function validateGame(game, layout, isUndo) {
    const n = layout.tiles.length;
    assert(object(game), '游戏状态缺失。');
    assert(Array.isArray(game.places) && game.places.length === n && game.places.every(p => ['board', 'tray', 'reserve', 'gone'].includes(p)), '方块状态不完整。');
    assert(Array.isArray(game.types) && game.types.length === n && game.types.every(t => integer(t, 0, 11)), '图案数据无效。');
    assert(Array.isArray(game.tray) && game.tray.length <= 7 && Array.isArray(game.reserve) && game.reserve.length <= 3, '收集槽或备用区超出容量。');
    const ids = new Set();
    for (const [place, list] of [['tray', game.tray], ['reserve', game.reserve]]) {
      for (const id of list) { assert(integer(id, 0, n - 1) && !ids.has(id) && game.places[id] === place, '槽位编号重复或状态不一致。'); ids.add(id); }
      assert(game.places.filter(p => p === place).length === list.length, '槽位与方块状态不一致。');
    }
    const original = Array(12).fill(0), current = Array(12).fill(0), gone = Array(12).fill(0), trayCounts = Array(12).fill(0);
    for (let i = 0; i < n; i++) {
      original[layout.tiles[i].type]++; current[game.types[i]]++;
      if (game.places[i] === 'gone') gone[game.types[i]]++;
    }
    for (const id of game.tray) trayCounts[game.types[id]]++;
    assert(original.every((v, i) => v === current[i] && gone[i] % 3 === 0 && trayCounts[i] < 3), '图案总量、三消记录或槽位不合法。');
    assert(object(game.tools) && ['undo', 'move', 'shuffle'].every(k => integer(game.tools[k], 0, 1)), '道具数量无效。');
    assert(game.tools.move === 0 || game.reserve.length === 0, '备用区缺少移出记录。');
    assert(game.tools.shuffle === 0 || game.types.every((type, id) => type === layout.tiles[id].type), '未使用洗牌时图案已改变。');
    // Removing a lower tile requires every actual upper blocker to have left
    // the board already. This closure must hold in current and undo snapshots.
    const graph = engineAPI().blockers(layout);
    assert(game.places.every((place, id) => place === 'board' || graph[id].every(upper => game.places[upper] !== 'board')), '移除记录违反真实遮挡。');
    const expected = game.places.every(p => p === 'gone') ? 'won' : game.tray.length === 7 ? 'lost' : 'playing';
    assert(game.status === expected, '胜负状态不一致。');
    if (!isUndo) {
      assert(game.undo === null || object(game.undo), '撤回快照无效。');
      if (game.undo !== null) {
        assert(game.undo.undo === undefined || game.undo.undo === null, '撤回快照嵌套过深。');
        validateGame(game.undo, layout, true);
        validateUndoTransition(game, layout);
      }
    }
  }
  function validateUndoTransition(game, layout) {
    const engine = engineAPI();
    const before = game.undo;
    assert(before.status === 'playing', '撤回快照不是操作前的游戏状态。');
    const expected = JSON.stringify(engine.snapshot(game));
    const cloneBefore = () => ({ ...engine.snapshot(before), undo: null });
    // A pick is deterministic, including insertion order and any three-clear.
    for (let id = 0; id < layout.tiles.length; id++) {
      if (before.places[id] !== 'board' && before.places[id] !== 'reserve') continue;
      const candidate = cloneBefore();
      if (engine.pick(layout, candidate, id).ok && JSON.stringify(engine.snapshot(candidate)) === expected) return;
    }
    const moved = cloneBefore();
    if (engine.takeOut(layout, moved).ok && JSON.stringify(engine.snapshot(moved)) === expected) return;
    // A random permutation has no unique seed in a snapshot. Verify the entire
    // legal effect: board-only permutation, fixed outside tiles and tool cost.
    if (before.tools.shuffle === 1 && game.tools.shuffle === 0 &&
      before.tools.undo === game.tools.undo && before.tools.move === game.tools.move &&
      before.status === game.status && JSON.stringify(before.places) === JSON.stringify(game.places) &&
      JSON.stringify(before.tray) === JSON.stringify(game.tray) && JSON.stringify(before.reserve) === JSON.stringify(game.reserve)) {
      const ids = before.places.map((place, id) => place === 'board' ? id : -1).filter(id => id >= 0);
      const priorBag = ids.map(id => before.types[id]).sort((a, b) => a - b);
      const nextBag = ids.map(id => game.types[id]).sort((a, b) => a - b);
      if (ids.length >= 2 && JSON.stringify(priorBag) === JSON.stringify(nextBag) &&
        before.types.every((type, id) => before.places[id] === 'board' || type === game.types[id])) return;
    }
    fail('存档校验失败：撤回快照与最近一次有效操作不一致。');
  }
  async function validate(session, options) {
    options = options || {};
    assert(object(session) && session.format === FORMAT && session.generator === 1, '存档或生成器版本不兼容。');
    parseSeed(session.seed);
    assert(integer(session.level, 1, Number.MAX_SAFE_INTEGER) && integer(session.highest, session.level, Number.MAX_SAFE_INTEGER) && integer(session.cleared, 0, Number.MAX_SAFE_INTEGER), '关卡记录无效。');
    assert(typeof session.createdAt === 'string' && Number.isFinite(Date.parse(session.createdAt)) && typeof session.updatedAt === 'string' && Number.isFinite(Date.parse(session.updatedAt)), '存档时间无效。');
    const layout = session.layout;
    assert(object(layout) && layout.version === 1 && layout.level === session.level && integer(layout.retry, 0, 1000000), '关卡参数无效。');
    assert(object(layout.params), '生成参数缺失。');
    assert(Array.isArray(layout.tiles) && layout.tiles.length >= 3 && layout.tiles.length <= 240 && layout.tiles.length % 3 === 0, '方块数量无效。');
    for (let i = 0; i < layout.tiles.length; i++) {
      const t = layout.tiles[i];
      assert(object(t) && t.id === i && Number.isFinite(t.x) && Number.isFinite(t.y) && t.x >= 0 && t.x <= 368 && t.y >= 0 && t.y <= 348 && integer(t.z, 0, 15) && integer(t.type, 0, 11), '方块坐标、层级或图案无效。');
      for (let j = 0; j < i; j++) {
        const other = layout.tiles[j];
        assert(t.z !== other.z || Math.abs(t.x - other.x) >= 52 || Math.abs(t.y - other.y) >= 52, '同层方块相互重叠。');
      }
    }
    assert(Array.isArray(layout.solution) && layout.solution.length === layout.tiles.length && new Set(layout.solution).size === layout.tiles.length && layout.solution.every(id => integer(id, 0, layout.tiles.length - 1)), '通关序列无效。');
    assert(typeof layout.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(layout.fingerprint), '关卡指纹无效。');
    assert(Array.isArray(session.history) && session.history.length >= 1 && session.history.length <= HISTORY_LIMIT && session.history.every(s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)) && new Set(session.history).size === session.history.length && session.history.includes(layout.fingerprint), '历史去重记录无效或超出容量。');
    validateGame(session.game, layout, false);
    const engine = engineAPI();
    // The cache key includes ALL layout data, including its actual certificate.
    const key = JSON.stringify(layout);
    let cached = VALIDATED_LAYOUTS.get(key);
    if (!cached) {
      const verified = engine.verifyLayout(layout);
      assert(verified && verified.valid, '关卡没有通过真实规则的可解性验证。');
      assert(await engine.fingerprint(layout) === layout.fingerprint, '关卡指纹不匹配。');
      cached = { seeds: new Set() };
      VALIDATED_LAYOUTS.set(key, cached);
      if (VALIDATED_LAYOUTS.size > 16) VALIDATED_LAYOUTS.delete(VALIDATED_LAYOUTS.keys().next().value);
    }
    if (options.reproduce !== false && !cached.seeds.has(session.seed)) {
      const reproduced = await engine.generate(session.seed, session.level, layout.retry);
      assert(JSON.stringify(reproduced) === JSON.stringify(layout), '关卡与种子及生成参数不一致。');
      cached.seeds.add(session.seed);
    }
    return session;
  }
  async function encrypt(seed, session) {
    cryptoAPI();
    parseSeed(seed);
    assert(session.seed === seed, '种子与当前游戏不一致。');
    await validate(session);
    const plainObject = { ...session };
    delete plainObject.seed;
    const plain = encoder.encode(JSON.stringify(plainObject));
    if (plain.length > MAX_PLAIN) fail('当前存档已超出导出容量，请整理历史记录。');
    const zipped = await transform(plain, false);
    const useZip = zipped && zipped.length < plain.length;
    const c = cryptoAPI();
    const salt = c.getRandomValues(new Uint8Array(16));
    const nonce = c.getRandomValues(new Uint8Array(12));
    const header = new Uint8Array([77, 84, 83, FORMAT, useZip ? 1 : 0]);
    const key = await deriveKey(seed, salt);
    const ciphertext = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: header, tagLength: 128 }, key, useZip ? zipped : plain));
    const output = new Uint8Array(header.length + salt.length + nonce.length + ciphertext.length);
    output.set(header); output.set(salt, 5); output.set(nonce, 21); output.set(ciphertext, 33);
    return encodeDecimal(output);
  }
  async function decrypt(seed, code) {
    cryptoAPI();
    parseSeed(seed);
    const bytes = decodeDecimal(code);
    if (bytes.length < 50 || bytes[0] !== 77 || bytes[1] !== 84 || bytes[2] !== 83 || bytes[3] !== FORMAT || bytes[4] > 1) fail('存档格式不兼容或数据已损坏。');
    let plain;
    try {
      const key = await deriveKey(seed, bytes.slice(5, 21));
      plain = new Uint8Array(await cryptoAPI().subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(21, 33), additionalData: bytes.slice(0, 5), tagLength: 128 }, key, bytes.slice(33)));
    } catch (error) {
      fail('无法恢复：游戏种子不正确，或存档码已损坏。请核对两个代码。');
    }
    let candidate;
    try {
      if (bytes[4] === 1) plain = await transform(plain, true);
      if (plain.length > MAX_PLAIN) fail('存档内容超过容量限制。');
      candidate = JSON.parse(decoder.decode(plain));
      assert(object(candidate) && candidate.seed === undefined, '存档内容格式无效。');
      candidate.seed = seed;
    } catch (error) {
      if (error.message && /浏览器|容量/.test(error.message)) throw error;
      fail('存档内容格式无效，未覆盖当前进度。');
    }
    await validate(candidate);
    return candidate;
  }
  function open() {
    if (!root.indexedDB) return Promise.reject(new Error('此浏览器无法使用 IndexedDB，本地自动保存不可用。请保留双码存档或切换浏览器。'));
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const request = root.indexedDB.open('meadow-triples', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('history')) db.createObjectStore('history', { keyPath: 'fingerprint' });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); dbPromise = undefined; };
        resolve(db);
      };
      request.onerror = () => { dbPromise = undefined; reject(new Error('无法打开本地存档，可能未授予存储权限。')); };
      request.onblocked = () => { dbPromise = undefined; reject(new Error('本地存档升级被其他窗口阻止，请关闭其他游戏窗口。')); };
    });
    return dbPromise;
  }
  async function load() {
    const db = await open();
    const data = await new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readonly');
      const request = tx.objectStore('meta').get('current');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(new Error('读取本地存档失败。'));
    });
    if (data) await validate(data);
    return data;
  }
  async function persist(session, strongValidation) {
    // Clone BEFORE waiting: later game actions cannot change an earlier write.
    const clone = typeof structuredClone === 'function' ? structuredClone(session) : JSON.parse(JSON.stringify(session));
    await validate(clone, { reproduce: strongValidation });
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'history'], 'readwrite');
      const meta = tx.objectStore('meta');
      const current = meta.get('current');
      current.onsuccess = () => {
        const previous = current.result;
        meta.put(clone, 'current');
        // Most writes only change one move. Avoid rewriting thousands of
        // identical history rows, while retaining one atomic transaction.
        if (previous && Array.isArray(previous.history) && previous.history.length === clone.history.length &&
          previous.history.every((fingerprint, i) => fingerprint === clone.history[i])) return;
        const history = tx.objectStore('history');
        history.clear();
        clone.history.forEach((fingerprint, order) => history.put({ fingerprint, order }));
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(new Error('本地自动保存失败：存储空间可能不足。当前进度尚未写入，请导出双码存档。'));
    });
  }
  function scheduleWrite(session, strongValidation) {
    const clone = typeof structuredClone === 'function' ? structuredClone(session) : JSON.parse(JSON.stringify(session));
    const run = () => persist(clone, strongValidation);
    const result = writeQueue.then(run, run);
    writeQueue = result.catch(() => {});
    return result;
  }
  async function save(session) { return scheduleWrite(session, false); }
  async function replace(session) { return scheduleWrite(session, true); }
  async function clear() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'history'], 'readwrite');
      tx.objectStore('meta').clear(); tx.objectStore('history').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(new Error('删除本地存档失败。'));
    });
  }
  return { FORMAT, HISTORY_LIMIT, MAX_DIGITS, MAX_BYTES, newSeed, encrypt, decrypt, validate, open, load, save, replace, clear, encodeDecimal, decodeDecimal, available: () => !!(root.crypto && root.crypto.subtle && root.crypto.getRandomValues) };
});

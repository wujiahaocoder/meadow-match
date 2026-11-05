(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MeadowEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const VERSION = 1, TILE_SIZE = 52, WIDTH = 420, HEIGHT = 400;
  const PLACES = ['board', 'tray', 'reserve', 'gone'];
  const copy = x => JSON.parse(JSON.stringify(x));
  const integer = n => Number.isSafeInteger(n);
  function random(seed) {
    // Four independent FNV-style lanes seed sfc32; never used for cryptography.
    const words = [2166136261, 3335557771, 1779033703, 3144134277];
    const str = String(seed);
    for (let i = 0; i < str.length; i++) {
      for (let k = 0; k < 4; k++) {
        words[k] = Math.imul(words[k] ^ (str.charCodeAt(i) + k * 97), 16777619);
        words[k] ^= words[k] >>> 13;
      }
    }
    let [a, b, c, d] = words.map(x => x >>> 0);
    const next = () => {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      const t = (a + b + d) | 0;
      d = (d + 1) | 0; a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0; c = ((c << 21) | (c >>> 11));
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
    for (let i = 0; i < 20; i++) next();
    return next;
  }
  function shuffled(array, rng) {
    const out = array.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
  function overlaps(a, b) {
    return a.x < b.x + TILE_SIZE && a.x + TILE_SIZE > b.x &&
      a.y < b.y + TILE_SIZE && a.y + TILE_SIZE > b.y;
  }
  function blockers(layout) {
    const out = layout.tiles.map(() => []);
    for (const a of layout.tiles) for (const b of layout.tiles) {
      if (b.z > a.z && overlaps(a, b)) out[a.id].push(b.id);
    }
    return out;
  }
  function isAvailable(layout, game, id) {
    if (!integer(id) || id < 0 || id >= layout.tiles.length) return false;
    if (game.places[id] === 'reserve') return true;
    if (game.places[id] !== 'board') return false;
    const a = layout.tiles[id];
    return !layout.tiles.some(b => game.places[b.id] === 'board' && b.z > a.z && overlaps(a, b));
  }
  function createGame(layout) {
    return {
      places: layout.tiles.map(() => 'board'), types: layout.tiles.map(t => t.type),
      tray: [], reserve: [], tools: { undo: 1, move: 1, shuffle: 1 }, status: 'playing', undo: null
    };
  }
  function snapshot(game) {
    return {
      places: game.places.slice(), types: game.types.slice(), tray: game.tray.slice(),
      reserve: game.reserve.slice(), tools: { ...game.tools }, status: game.status
    };
  }
  function pick(layout, game, id) {
    if (game.status !== 'playing' || game.tray.length >= 7 || !isAvailable(layout, game, id))
      return { ok: false, matched: [] };
    game.undo = snapshot(game);
    if (game.places[id] === 'reserve') game.reserve.splice(game.reserve.indexOf(id), 1);
    game.places[id] = 'tray';
    const type = game.types[id];
    let index = game.tray.length;
    for (let i = game.tray.length - 1; i >= 0; i--) if (game.types[game.tray[i]] === type) {
      index = i + 1; break;
    }
    game.tray.splice(index, 0, id);
    const group = game.tray.filter(t => game.types[t] === type);
    const matched = group.length >= 3 ? group.slice(0, 3) : [];
    if (matched.length) {
      const gone = new Set(matched);
      game.tray = game.tray.filter(t => !gone.has(t));
      for (const t of matched) game.places[t] = 'gone';
    }
    if (game.places.every(p => p === 'gone')) game.status = 'won';
    else if (game.tray.length >= 7) game.status = 'lost';
    return { ok: true, matched, index, status: game.status };
  }
  function takeOut(layout, game) {
    if (game.status !== 'playing' || !game.tools.move || !game.tray.length) return { ok: false, moved: [] };
    game.undo = snapshot(game);
    const moved = game.tray.splice(0, 3);
    for (const id of moved) game.places[id] = 'reserve';
    game.reserve.push(...moved);
    game.tools.move = 0;
    return { ok: true, moved };
  }
  function shuffle(layout, game, rngSeed) {
    const ids = layout.tiles.filter(t => game.places[t.id] === 'board').map(t => t.id);
    if (game.status !== 'playing' || !game.tools.shuffle || ids.length < 2) return { ok: false };
    game.undo = snapshot(game);
    const types = shuffled(ids.map(id => game.types[id]), random(String(rngSeed) + '|shuffle-v1'));
    for (let i = 0; i < ids.length; i++) game.types[ids[i]] = types[i];
    game.tools.shuffle = 0;
    return { ok: true, ids };
  }
  function undo(layout, game) {
    if (!game.tools.undo || !game.undo) return { ok: false };
    const before = snapshot(game), prior = game.undo;
    Object.assign(game, copy(prior));
    game.tools = {
      undo: 0, move: Math.min(before.tools.move, prior.tools.move),
      shuffle: Math.min(before.tools.shuffle, prior.tools.shuffle)
    };
    game.undo = null;
    return { ok: true };
  }
  function canonical(layout) {
    const ordered = layout.tiles.slice().sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x || a.type - b.type);
    const indices = new Map(ordered.map((t, i) => [t.id, i]));
    const graph = blockers(layout);
    return JSON.stringify({ version: VERSION, size: TILE_SIZE, tiles: ordered.map(t => [
      t.x, t.y, t.z, t.type, graph[t.id].map(id => indices.get(id)).sort((a, b) => a - b)
    ]) });
  }
  async function fingerprint(layout) {
    let cryptoAPI = globalThis.crypto;
    if (!cryptoAPI?.subtle && typeof require === 'function') cryptoAPI = require('node:crypto').webcrypto;
    if (!cryptoAPI?.subtle) throw new Error('当前环境不支持 SHA-256 安全摘要，无法验证关卡。');
    const digest = await cryptoAPI.subtle.digest('SHA-256', new TextEncoder().encode(canonical(layout)));
    return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  }
  function verifyLayout(layout) {
    const fail = reason => ({ valid: false, reason });
    try {
      if (!layout || layout.version !== VERSION || !integer(layout.level) || layout.level < 1 ||
        !integer(layout.retry) || layout.retry < 0 || !Array.isArray(layout.tiles) ||
        layout.tiles.length < 3 || layout.tiles.length > 180 || layout.tiles.length % 3 !== 0)
        return fail('关卡元数据无效');
      const n = layout.tiles.length, counts = Array(12).fill(0);
      for (let i = 0; i < n; i++) {
        const t = layout.tiles[i];
        if (!t || t.id !== i || !integer(t.x) || !integer(t.y) || t.x < 0 || t.x > WIDTH - TILE_SIZE ||
          t.y < 0 || t.y > HEIGHT - TILE_SIZE || !integer(t.z) || t.z < 0 || t.z > 7 ||
          !integer(t.type) || t.type < 0 || t.type > 11) return fail('方块数据无效');
        counts[t.type]++;
        for (let j = 0; j < i; j++) if (layout.tiles[j].z === t.z && overlaps(layout.tiles[j], t))
          return fail('同层方块交叠');
      }
      if (counts.some(n => n % 3)) return fail('图案数量不守恒');
      if (!Array.isArray(layout.solution) || layout.solution.length !== n ||
        new Set(layout.solution).size !== n) return fail('通关序列不完整');
      const game = createGame(layout), graph = blockers(layout);
      let peak = 0, choicesSum = 0;
      for (const id of layout.solution) {
        if (!integer(id) || id < 0 || id >= n || game.places[id] !== 'board' ||
          graph[id].some(b => game.places[b] === 'board')) return fail('通关序列违反遮挡');
        choicesSum += layout.tiles.reduce((sum, t) => sum + (game.places[t.id] === 'board' &&
          !graph[t.id].some(b => game.places[b] === 'board') ? 1 : 0), 0);
        const result = pick(layout, game, id);
        if (!result.ok || game.status === 'lost') return fail('通关序列超过七格容量');
        peak = Math.max(peak, game.tray.length);
      }
      if (game.status !== 'won' || game.tray.length || game.reserve.length) return fail('未完全消除');
      return { valid: true, peak, averageChoices: Math.round(choicesSum / n * 100) / 100,
        initialChoices: graph.filter(bs => bs.length === 0).length,
        overlapEdges: graph.reduce((sum, a) => sum + a.length, 0) };
    } catch (e) { return fail('关卡验证失败'); }
  }
  function parameters(level, rng) {
    const difficulty = Math.log2(level);
    const total = level === 1 ? 18 : Math.min(162, 72 + 6 * Math.floor(5 * Math.log2(level / 2)));
    const layers = level === 1 ? 2 : Math.min(8, Math.max(4 + Math.floor(difficulty / 2), Math.ceil(total / 21)));
    return { total, layers, kinds: level === 1 ? 3 : Math.min(12, 7 + Math.floor(difficulty)),
      activeTriples: level === 1 ? 1 : Math.min(4, 2 + Math.floor(difficulty / 2)),
      centers: 1 + Math.floor(rng() * (2 + Math.min(2, difficulty / 6))),
      density: Math.min(.83, .48 + difficulty * .018),
      skew: (rng() - .5) * .65, difficulty: Math.round(difficulty * 1000) / 1000 };
  }
  function geometry(params, rng) {
    const n = params.total, layers = params.layers;
    const centers = Array.from({ length: params.centers }, () => ({
      x: 65 + rng() * 235, y: 65 + rng() * 220,
      rx: 95 + rng() * 130, ry: 88 + rng() * 125, weight: .5 + rng() * .5
    }));
    const perLayer = Array(layers).fill(0);
    // Weighted allocation distributes density continuously, rather than selecting a map template.
    for (let i = 0; i < n; i++) {
      const eligible = Array.from({ length: layers }, (_, z) => z).filter(z => perLayer[z] < 22);
      let best = eligible[0], score = Infinity;
      for (const z of eligible) {
        const weight = 1 + (layers - 1 - z) * .025;
        const s = (perLayer[z] + rng() * 1.7) / weight;
        if (s < score) { score = s; best = z; }
      }
      perLayer[best]++;
    }
    const tiles = [];
    const offsetX = (rng() - .5) * 21, offsetY = (rng() - .5) * 21;
    for (let z = 0; z < layers; z++) {
      const placed = [];
      let tries = 0;
      while (placed.length < perLayer[z] && tries < 32000) {
        tries++;
        const x = Math.floor(rng() * (WIDTH - TILE_SIZE + 1));
        const y = Math.floor(rng() * (HEIGHT - TILE_SIZE + 1));
        let field = .12;
        for (const c of centers) {
          const dx = (x - c.x - z * offsetX) / c.rx;
          const dy = (y - c.y - z * offsetY - params.skew * (x - 184)) / c.ry;
          field += c.weight * Math.exp(-2.1 * (dx * dx + dy * dy));
        }
        if (rng() > Math.min(.95, field * (1.1 - params.density * .25))) continue;
        const t = { id: tiles.length, x, y, z, type: 0 };
        if (placed.some(b => overlaps(t, b))) continue;
        placed.push(t); tiles.push(t);
      }
      if (placed.length !== perLayer[z]) throw new Error('布局采样预算耗尽');
    }
    return tiles;
  }
  function topologicalSequence(tiles, rng, difficulty) {
    const graph = blockers({ tiles });
    const removed = new Set(), sequence = [];
    while (sequence.length < tiles.length) {
      const choices = tiles.filter(t => !removed.has(t.id) && graph[t.id].every(id => removed.has(id)));
      if (!choices.length) throw new Error('遮挡结构出现环');
      // Alternating local/remote choices spreads related types between overlapping regions.
      const last = sequence.length ? tiles[sequence[sequence.length - 1]] : null;
      let chosen;
      if (last && difficulty > 1 && rng() < .6) {
        const scored = choices.map(t => ({ t, s: rng() * 140 + Math.hypot(t.x - last.x, t.y - last.y) }));
        scored.sort((a, b) => b.s - a.s); chosen = scored[0].t;
      } else chosen = choices[Math.floor(rng() * choices.length)];
      removed.add(chosen.id); sequence.push(chosen.id);
    }
    return sequence;
  }
  function assignTypes(tiles, sequence, params, rng) {
    const usage = Array(params.kinds).fill(0), active = [];
    let groups = tiles.length / 3, occupancy = 0;
    for (let i = 0; i < sequence.length; i++) {
      let chosen;
      const canOpen = groups > 0 && active.length < params.activeTriples && occupancy < 5;
      const easyFirst = params.total === 18 && i < 6;
      if (!active.length || (canOpen && !easyFirst && rng() < .73)) {
        const available = usage.map((n, type) => ({ n, type, score: n + rng() * .9 }))
          .filter(o => !active.some(a => a.type === o.type)).sort((a, b) => a.score - b.score);
        chosen = { type: available[0].type, seen: 0 };
        usage[chosen.type]++; active.push(chosen); groups--;
      } else {
        const candidates = active.filter(a => occupancy < 6 || a.seen === 2);
        if (!candidates.length) throw new Error('构造容量预算失败');
        chosen = candidates[Math.floor(rng() * candidates.length)];
      }
      tiles[sequence[i]].type = chosen.type;
      chosen.seen++; occupancy++;
      if (chosen.seen === 3) { occupancy -= 3; active.splice(active.indexOf(chosen), 1); }
    }
    if (active.length || occupancy || groups) throw new Error('三消构造未闭合');
  }
  async function generate(seed, level, retry = 0) {
    if (typeof seed !== 'string' || !/^\d{1,78}$/.test(seed) || !integer(level) || level < 1 ||
      !integer(retry) || retry < 0 || retry > 1000000) throw new Error('种子或关卡参数无效');
    // Bounded work: the host can terminate a Worker independently of this inner budget.
    for (let attempt = 0; attempt < 8; attempt++) {
      const rng = random(seed + '|generator:' + VERSION + '|level:' + level + '|retry:' + retry + '|attempt:' + attempt);
      try {
        const params = parameters(level, rng);
        const tiles = geometry(params, rng);
        const solution = topologicalSequence(tiles, rng, params.difficulty);
        assignTypes(tiles, solution, params, rng);
        const layout = { version: VERSION, level, retry, params: { ...params, attempt }, tiles, solution };
        const metrics = verifyLayout(layout);
        if (!metrics.valid) continue;
        layout.params.metrics = metrics;
        layout.fingerprint = await fingerprint(layout);
        return layout;
      } catch (error) {
        if (attempt === 7) throw new Error('关卡生成超出预算，请重试。');
      }
    }
    throw new Error('无法生成经验证的关卡，请重试。');
  }
  return { VERSION, TILE_SIZE, WIDTH, HEIGHT, PLACES, random, overlaps, blockers,
    isAvailable, createGame, snapshot, pick, takeOut, shuffle, undo, canonical, fingerprint,
    verifyLayout, generate };
});

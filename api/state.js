import { put, head } from '@vercel/blob';

// 포인터 블롭(PTR)의 contentType에 현재 버전 키를 적고, 실제 내용은 덮어쓰지 않는 버전별 블롭에 저장한다.
// 버전 블롭은 주소가 매번 달라서 CDN 캐시 때문에 옛 내용을 읽을 일이 없고,
// 포인터는 조건부 저장(ifMatch)으로 바꿔서 동시 입력이 서로를 덮어쓰지 않게 한다.
const PTR = 'solrank/ptr.txt';
const VER = (k) => 'solrank/v/' + k + '.json';
const INITIAL = {"teams":[{"name":"우서방야","players":[{"id":"p1","name":"구마","games":[]},{"id":"p2","name":"현수","games":[]},{"id":"p3","name":"교수","games":[]},{"id":"p4","name":"태숭","games":[]},{"id":"p5","name":"변태","games":[]},{"id":"p6","name":"엄마","games":[]},{"id":"p7","name":"임씨","games":[]}]},{"name":"천민사냥","players":[{"id":"p8","name":"왕치","games":[]},{"id":"p9","name":"마왕","games":[]},{"id":"p10","name":"응문","games":[]},{"id":"p11","name":"웡맘","games":[]},{"id":"p12","name":"웡벙","games":[]},{"id":"p13","name":"아빠","games":[]},{"id":"p14","name":"지릭","games":[]}]}],"seq":14};

const keyOf = (ct) => { const m = /v=([\w-]+)/.exec(ct || ''); return m ? m[1] : null; };
const baseOf = (url) => url.slice(0, url.indexOf(PTR));

async function meta() {
  try { return await head(PTR); }
  catch (e) { if (/not.?found|404|does not exist/i.test(String(e && (e.name + ' ' + e.message)))) return null; throw e; }
}

async function load(m) {
  const k = m && keyOf(m.contentType);
  if (!k) return structuredClone(INITIAL);
  const r = await fetch(baseOf(m.url) + VER(k));
  if (!r.ok) throw new Error('blob read ' + r.status);
  return r.json();
}

function find(state, id) {
  for (const t of state.teams) {
    const i = t.players.findIndex((p) => p.id === id);
    if (i >= 0) return { t, i, p: t.players[i] };
  }
  return null;
}
const clean = (s) => String(s || '').trim().slice(0, 12);

function apply(state, op) {
  const now = Date.now();
  switch (op.op) {
    case 'game': {
      const f = find(state, op.id);
      if (!f || !['W', 'L'].includes(op.r)) throw new Error('bad game');
      f.p.games.push({ r: op.r, t: now }); break;
    }
    case 'undo': { const f = find(state, op.id); if (f && f.p.games.length) f.p.games.pop(); break; }
    case 'undoLast': {
      let best = null;
      for (const t of state.teams) for (const p of t.players) {
        const g = p.games[p.games.length - 1];
        if (g && (!best || g.t > best.t)) best = { t: g.t, p };
      }
      if (best) best.p.games.pop(); break;
    }
    case 'rename': { const f = find(state, op.id); const n = clean(op.name); if (f && n) f.p.name = n; break; }
    case 'move': {
      const f = find(state, op.id); if (!f) break;
      const other = state.teams[state.teams[0] === f.t ? 1 : 0];
      f.t.players.splice(f.i, 1); other.players.push(f.p); break;
    }
    case 'del': { const f = find(state, op.id); if (f) f.t.players.splice(f.i, 1); break; }
    case 'add': {
      const n = clean(op.name); const ti = op.team === 1 ? 1 : 0; if (!n) break;
      state.seq = (state.seq || 0) + 1;
      state.teams[ti].players.push({ id: 'p' + state.seq + '_' + now.toString(36), name: n, games: [] }); break;
    }
    default: throw new Error('unknown op');
  }
  state.rev = (state.rev || 0) + 1;
}

const isConflict = (e) => /precondition|412|conflict|already exists|ifmatch|if-match/i.test(String(e && (e.name + ' ' + e.message)));

async function update(op) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const m = await meta();
    const state = await load(m);
    apply(state, op);
    const key = String(state.rev).padStart(6, '0') + '-' + Math.random().toString(36).slice(2, 10);
    await put(VER(key), JSON.stringify(state), { access: 'public', contentType: 'application/json', addRandomSuffix: false, cacheControlMaxAge: 31536000 });
    try {
      const opts = { access: 'public', contentType: 'text/plain; v=' + key, addRandomSuffix: false, cacheControlMaxAge: 60 };
      if (m) { opts.allowOverwrite = true; opts.ifMatch = m.etag; }
      await put(PTR, key, opts);
      return state;
    } catch (e) {
      if (!isConflict(e)) throw e;
      await new Promise((r) => setTimeout(r, 30 + Math.random() * 150));
    }
  }
  throw new Error('busy');
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const state = await load(await meta());
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=20, stale-while-revalidate=20');
      return res.status(200).json({ state });
    }
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'POST') {
      const op = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const state = await update(op);
      return res.status(200).json({ state });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method' });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}

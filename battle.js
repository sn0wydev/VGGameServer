'use strict';
// ============================================================================
//  GIFT BATTLE — shared "winner takes the pot" game, server-authoritative.
//
//  One global round at a time:
//    open    nobody has bet yet (waiting)
//    bet     the first gift started a countdown; players add gifts from their inventory
//    spin    the reel spins; the winner was decided on the server when the spin started
//    result  winner shown for a few seconds, then a fresh round opens
//
//  Rules
//   - Gifts / NFTs from the player's OWN inventory only. No Stars.
//   - chance(player) = value of the player's gifts / value of ALL gifts in the pot
//     (alone in the round = 100%).
//   - The winner receives every gift that was bet. Nothing else is paid, nothing is taken.
//   - Value of a gift = coinValues (everyday gifts) / starValues (NFTs), same numbers Rocket uses.
//
//  Fairness: each round commits to a secret (sha256 shown while betting, secret revealed after).
//  r = HMAC-SHA256(secret, 'voidgifts-battle') as a number in [0,1). Players are ordered by when
//  they first joined; the winner is the first player whose cumulative value exceeds r x total.
//
//  If the process dies mid-round, startup returns every staked gift to its owner.
//  Config: game-config.js -> battle {...}.   Kill switch: env BATTLE=off.
// ============================================================================
const crypto = require('crypto');

const DEFAULTS = {
  enabled: true,
  betSeconds: 30,        // countdown that starts with the first gift
  spinSeconds: 8,
  resultSeconds: 7,
  maxPlayers: 25,
  maxItemsPerPlayer: 5,
  minItemValue: 1,
  stripTiles: 70,        // tiles on the reel (more players' tiles in proportion to their chance)
};

function createBattle({ pool, tx, addLedger, createGift, CFG, NFT_SET, fail, requireSubscription }) {
  const E = process.env;
  const R = { ...DEFAULTS, ...(CFG.battle || {}) };
  if (E.BATTLE === 'off') R.enabled = false;
  if (E.NODE_ENV === 'test') {
    if (E.BATTLE_BET_SECONDS) R.betSeconds = Number(E.BATTLE_BET_SECONDS);
    if (E.BATTLE_SPIN_SECONDS) R.spinSeconds = Number(E.BATTLE_SPIN_SECONDS);
    if (E.BATTLE_RESULT_SECONDS) R.resultSeconds = Number(E.BATTLE_RESULT_SECONDS);
  }
  const forcedR = E.NODE_ENV === 'test' && E.BATTLE_TEST_R ? E.BATTLE_TEST_R.split(',').map(Number) : [];

  const starValues = CFG.starValues || {};
  const valueOf = (name) => (NFT_SET.has(name) ? Number(starValues[name]) : Number(CFG.coinValues[name])) || 0;

  // ---- fairness / math ---------------------------------------------------------------
  const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const rFromSecret = (secret) => crypto.createHmac('sha256', secret).update('voidgifts-battle').digest().readUIntBE(0, 6) / 2 ** 48;
  function pickWinner(r, values) {            // values: array in join order -> winner index
    const total = values.reduce((a, b) => a + b, 0);
    const target = r * total;
    let cum = 0;
    for (let i = 0; i < values.length; i++) { cum += values[i]; if (target < cum) return i; }
    return values.length - 1;
  }
  function seededRand(secret) {               // small deterministic PRNG so the reel layout is reproducible
    let a = crypto.createHash('sha256').update(secret + ':reel').digest().readUInt32BE(0) >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  // The reel: tiles of every player in proportion to their chance (each player at least once),
  // shuffled, with a tile of the winner at index `winnerTile` where the line will stop.
  function buildStrip(values, winnerIdx, secret) {
    const N = R.stripTiles, total = values.reduce((a, b) => a + b, 0), rnd = seededRand(secret);
    const exact = values.map((v) => (v / total) * N), counts = exact.map((x) => Math.max(1, Math.floor(x)));
    let diff = N - counts.reduce((a, b) => a + b, 0);
    const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]).map((p) => p[1]);
    for (let k = 0; diff > 0; k++, diff--) counts[order[k % order.length]]++;
    for (let k = 0; diff < 0; k++) { const i = order[order.length - 1 - (k % order.length)]; if (counts[i] > 1) { counts[i]--; diff++; } }
    const strip = []; counts.forEach((c, i) => { for (let j = 0; j < c; j++) strip.push(i); });
    for (let i = strip.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [strip[i], strip[j]] = [strip[j], strip[i]]; }
    const winnerTile = strip.length - 12;
    if (strip[winnerTile] !== winnerIdx) { const at = strip.indexOf(winnerIdx); [strip[at], strip[winnerTile]] = [strip[winnerTile], strip[at]]; }
    return { strip, winnerTile, offset: 0.1 + crypto.randomInt(0, 800) / 1000 };   // the line stops 10%..90% into the tile (no snapping)
  }

  // ---- state ---------------------------------------------------------------------------
  let round = null, history = [], flushTimer = null, started = false, chain = Promise.resolve();
  const clients = new Map();
  const inflight = new Set();
  const track = (p) => { inflight.add(p); const done = () => inflight.delete(p); p.then(done, done); return p; };
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  const displayName = (u) => (u.show_in_leaderboard === false ? 'Player' : (u.username ? '@' + u.username : (u.first_name || 'Player')).toString().slice(0, 24));
  const avatarOf = (u) => (u.show_in_leaderboard === false ? null : (u.avatar_url || null));

  function playersView(userId) {
    if (!round) return [];
    const list = [...round.players.values()], total = list.reduce((a, p) => a + p.value, 0) || 1;
    return list.map((p) => ({ name: p.name, avatar: p.avatar, value: p.value, chance: p.value / total, items: p.items.map((i) => i.item), me: p.userId === userId }));
  }
  function snapshot(userId) {
    const r = round, finished = r && r.phase === 'result', list = r ? [...r.players.values()] : [];
    return {
      serverNow: Date.now(), phase: r ? r.phase : 'open', roundId: r ? r.id : 0, hash: r ? r.hash : null,
      betEndsAt: r ? r.betEndsAt : 0, maxPlayers: R.maxPlayers, maxItems: R.maxItemsPerPlayer,
      totalValue: list.reduce((a, p) => a + p.value, 0), itemCount: list.reduce((a, p) => a + p.items.length, 0),
      players: playersView(userId),
      spin: r && r.spin && (r.phase === 'spin' || r.phase === 'result') ? { startedAt: r.spin.startedAt, ms: R.spinSeconds * 1000, strip: r.spin.strip, winnerTile: r.spin.winnerTile, offset: r.spin.offset, winner: r.spin.winner } : null,
      secret: finished ? r.secret : null,
      history,
    };
  }
  function flush() { flushTimer = null; for (const [res, c] of clients) { try { res.write(`data: ${JSON.stringify(snapshot(c.userId))}\n\n`); } catch { clients.delete(res); } } }
  const broadcast = () => { if (!flushTimer) flushTimer = setTimeout(flush, 120); };

  // ---- database --------------------------------------------------------------------------
  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS battle_rounds (
        id BIGSERIAL PRIMARY KEY, hash TEXT NOT NULL, secret TEXT NOT NULL, winner_id BIGINT, winner_name TEXT, winner_avatar TEXT,
        total_value BIGINT NOT NULL DEFAULT 0, item_count INT NOT NULL DEFAULT 0, players INT NOT NULL DEFAULT 0,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ);
      CREATE TABLE IF NOT EXISTS battle_bets (
        id BIGSERIAL PRIMARY KEY, round_id BIGINT NOT NULL, user_id BIGINT NOT NULL, prize_id TEXT NOT NULL, item TEXT NOT NULL,
        value BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (round_id, prize_id));
      CREATE INDEX IF NOT EXISTS idx_battle_bets_round ON battle_bets (round_id);
    `);
    // an interrupted round: give every gift back
    const open = (await pool.query(`SELECT id, prize_id FROM battle_bets WHERE status = 'active'`)).rows;
    for (const b of open) {
      await tx(async (c) => {
        const got = await c.query(`UPDATE battle_bets SET status = 'refunded' WHERE id = $1 AND status = 'active' RETURNING id`, [b.id]);
        if (got.rowCount) await c.query(`UPDATE prizes SET status = 'pending', updated_at = NOW() WHERE prize_id = $1 AND status = 'staked'`, [b.prize_id]);
      });
    }
    if (open.length) console.log(`⚔️ Battle: returned ${open.length} gift(s) from an interrupted round`);
    history = (await pool.query(`SELECT id, winner_name, winner_avatar, total_value, item_count FROM battle_rounds WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 8`)).rows
      .map((r) => ({ id: Number(r.id), name: r.winner_name, avatar: r.winner_avatar, value: Number(r.total_value), items: r.item_count }));
  }

  // ---- round loop --------------------------------------------------------------------------
  async function newRound() {
    const secret = crypto.randomBytes(32).toString('hex'), hash = sha256(secret);
    const ins = await pool.query('INSERT INTO battle_rounds (hash, secret) VALUES ($1,$2) RETURNING id', [hash, secret]);
    round = { id: Number(ins.rows[0].id), phase: 'open', secret, hash, betEndsAt: 0, players: new Map(), spin: null, timers: [] };
    broadcast();
  }

  async function startSpin(r) {
    try {
      if (round !== r || r.phase !== 'bet') return;
      r.phase = 'closing';                                   // no new bets from here on
      await Promise.allSettled([...inflight]);
      const players = [...r.players.values()], values = players.map((p) => p.value);
      const rv = forcedR.length ? forcedR.shift() : rFromSecret(r.secret);
      const w = pickWinner(rv, values);
      const reel = buildStrip(values, w, r.secret);
      r.spin = { ...reel, winner: w, startedAt: Date.now() };
      r.phase = 'spin';
      broadcast();
      setTimeout(() => finish(r).catch((e) => console.error('🚨 battle finish failed:', e)), R.spinSeconds * 1000 + 500);
    } catch (e) { console.error('🚨 battle startSpin:', e); await refundRound(r).catch(() => {}); setTimeout(() => newRound().catch(() => {}), 3000); }
  }

  async function finish(r) {
    const players = [...r.players.values()], winner = players[r.spin.winner], total = players.reduce((a, p) => a + p.value, 0);
    const itemCount = players.reduce((a, p) => a + p.items.length, 0);
    try {
      await tx(async (c) => {
        const ids = players.flatMap((p) => p.items.map((i) => i.prizeId));
        await c.query(`UPDATE battle_bets SET status = CASE WHEN user_id = $2 THEN 'won' ELSE 'lost' END WHERE round_id = $1`, [r.id, winner.userId]);
        await c.query(`UPDATE prizes SET status = 'battle_done', updated_at = NOW() WHERE prize_id = ANY($1) AND status = 'staked'`, [ids]);
        const won = [];
        for (const p of players) for (const i of p.items) won.push({ item: i.item, prize_id: await createGift(c, { id: winner.userId, username: winner.username }, i.item) });
        for (const p of players) {
          if (p === winner) await addLedger(c, p.userId, 'battle:win', 0, 0, { round: r.id, gifts: won.map((x) => x.item), total }, `battle:win:${r.id}`);
          else await addLedger(c, p.userId, 'battle:loss', 0, 0, { round: r.id, gifts: p.items.map((i) => i.item), value: p.value }, `battle:loss:${r.id}:${p.userId}`);
        }
        await c.query(`UPDATE battle_rounds SET winner_id = $2, winner_name = $3, winner_avatar = $4, total_value = $5, item_count = $6, players = $7, finished_at = NOW() WHERE id = $1`,
          [r.id, winner.userId, winner.name, winner.avatar, total, itemCount, players.length]);
      });
    } catch (e) { console.error('🚨 battle settlement failed, returning gifts:', e); await refundRound(r).catch((er) => console.error('🚨 battle refund failed:', er)); }
    r.phase = 'result';
    history = [{ id: r.id, name: winner.name, avatar: winner.avatar, value: total, items: itemCount }, ...history].slice(0, 8);
    broadcast();
    setTimeout(() => newRound().catch((e) => { console.error('🚨 battle newRound:', e); setTimeout(() => newRound().catch(() => {}), 5000); }), R.resultSeconds * 1000);
  }

  async function refundRound(r) {
    await tx(async (c) => {
      const got = await c.query(`UPDATE battle_bets SET status = 'refunded' WHERE round_id = $1 AND status = 'active' RETURNING prize_id`, [r.id]);
      if (got.rowCount) await c.query(`UPDATE prizes SET status = 'pending', updated_at = NOW() WHERE prize_id = ANY($1) AND status = 'staked'`, [got.rows.map((x) => x.prize_id)]);
    });
  }

  // ---- joining ---------------------------------------------------------------------------------
  function join(user, body) {
    return track(serial(async () => {
      if (!R.enabled) throw fail(503, 'BATTLE_OFF', 'Gift Battle is switched off');
      const r = round;
      const open = () => r && round === r && (r.phase === 'open' || (r.phase === 'bet' && Date.now() < r.betEndsAt));
      if (!open()) throw fail(409, 'BETTING_CLOSED', 'Betting is closed for this round');
      await requireSubscription(user.id);
      const ids = [...new Set((Array.isArray(body.prize_ids) ? body.prize_ids : []).map(String))].slice(0, 50);
      if (!ids.length) throw fail(400, 'NO_ITEMS', 'Pick at least one gift');
      const mine = r.players.get(user.id), have = mine ? mine.items.length : 0;
      if (!mine && r.players.size >= R.maxPlayers) throw fail(409, 'ROOM_FULL', 'This round is full');
      if (have + ids.length > R.maxItemsPerPlayer) throw fail(400, 'TOO_MANY_ITEMS', `You can bet up to ${R.maxItemsPerPlayer} gifts per round`, { max: R.maxItemsPerPlayer });

      const out = await tx(async (c) => {
        await c.query(
          `INSERT INTO users (user_id, username, first_name, last_name, avatar_url) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (user_id) DO UPDATE SET username = COALESCE($2, users.username), first_name = COALESCE($3, users.first_name), avatar_url = COALESCE($5, users.avatar_url)`,
          [user.id, user.username ?? null, user.first_name ?? null, user.last_name ?? null, user.photo_url ?? null]);
        const u = (await c.query('SELECT * FROM users WHERE user_id = $1 FOR UPDATE', [user.id])).rows[0];
        if (!open()) throw fail(409, 'BETTING_CLOSED', 'Betting is closed for this round');
        const upd = await c.query(`UPDATE prizes SET status = 'staked', updated_at = NOW() WHERE prize_id = ANY($1) AND user_id = $2 AND status = 'pending' RETURNING prize_id, gift_name`, [ids, user.id]);
        if (upd.rowCount !== ids.length) throw fail(409, 'ITEM_UNAVAILABLE', 'One of these gifts is not available to bet');
        const items = [];
        for (const row of upd.rows) {
          const v = valueOf(row.gift_name);
          if (!(v >= R.minItemValue)) throw fail(400, 'ITEM_TOO_CHEAP', `${row.gift_name} cannot be used in a battle`);
          const ins = await c.query(`INSERT INTO battle_bets (round_id, user_id, prize_id, item, value) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [r.id, user.id, row.prize_id, row.gift_name, v]);
          items.push({ betId: Number(ins.rows[0].id), prizeId: row.prize_id, item: row.gift_name, value: v });
        }
        await addLedger(c, user.id, 'battle:stake', 0, 0, { round: r.id, gifts: items.map((i) => i.item) }, `battle:stake:${r.id}:${items[0].betId}`);
        return { items, u };
      });

      let p = r.players.get(user.id);
      if (!p) { p = { userId: user.id, username: user.username ?? null, name: displayName(out.u), avatar: avatarOf(out.u), items: [], value: 0 }; r.players.set(user.id, p); }
      for (const i of out.items) { p.items.push(i); p.value += i.value; }
      if (r.phase === 'open') { r.phase = 'bet'; r.betEndsAt = Date.now() + R.betSeconds * 1000; setTimeout(() => startSpin(r), R.betSeconds * 1000); }
      broadcast();
      return { ok: true, me: playersView(user.id).find((x) => x.me) };
    }));
  }

  // ---- routes ------------------------------------------------------------------------------------
  function routes(app, { auth, limit, wrap }) {
    app.get('/api/battle/state', auth, limit('bstate', 40, 10000), (req, res) => res.set('Cache-Control', 'no-store').json(snapshot(req.user.id)));
    app.get('/api/battle/stream', auth, limit('bstream', 12, 60000), (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 1500\n\n');
      clients.set(res, { userId: req.user.id });
      res.write(`data: ${JSON.stringify(snapshot(req.user.id))}\n\n`);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
    });
    app.post('/api/battle/join', auth, limit('bjoin', 10, 10000), wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(await join(req.user, req.body || {}))));
    // Provably fair check: the hash is public right away, the secret + join order once the round is over.
    app.get('/api/battle/round/:id', wrap(async (req, res) => {
      const id = Number(req.params.id);
      const row = Number.isSafeInteger(id) ? (await pool.query('SELECT id, hash, secret, total_value, finished_at FROM battle_rounds WHERE id = $1', [id])).rows[0] : null;
      if (!row) throw fail(404, 'NOT_FOUND', 'Unknown round');
      if (!row.finished_at) return res.json({ id: Number(row.id), hash: row.hash });
      const bets = (await pool.query('SELECT user_id, SUM(value)::bigint AS v, MIN(id) AS first FROM battle_bets WHERE round_id = $1 GROUP BY user_id ORDER BY MIN(id)', [id])).rows;
      res.json({ id: Number(row.id), hash: row.hash, secret: row.secret, r: rFromSecret(row.secret), values_in_join_order: bets.map((b) => Number(b.v)), winner_index: pickWinner(rFromSecret(row.secret), bets.map((b) => Number(b.v))) });
    }));
  }

  function start() { if (started || !R.enabled) return; started = true; newRound().catch((e) => { console.error('🚨 battle could not start:', e); started = false; }); }
  const publicConfig = () => ({ enabled: R.enabled, maxPlayers: R.maxPlayers, maxItems: R.maxItemsPerPlayer, betSeconds: R.betSeconds, spinSeconds: R.spinSeconds });

  return { init, start, routes, publicConfig, pickWinner, buildStrip, rFromSecret, enabled: R.enabled };
}

module.exports = { createBattle, DEFAULTS };

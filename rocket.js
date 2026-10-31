'use strict';
// ============================================================================
//  ROCKET — shared crash game, server-authoritative.
//
//  One global round at a time:
//    bet     players place bets (Stars, or a gift / NFT from their inventory)
//    fly     the multiplier rises:  m(t) = e^(growth * t)   (t in seconds since takeoff)
//    crash   at a point decided BEFORE the round started
//
//  The client only draws. It never decides a payout: a cash-out is accepted only
//  while the server's own clock says the rocket has not crashed yet.
//
//  Fairness:  every round commits to a secret.  hash = sha256(secret) is published
//  during betting, the secret is revealed after the crash, and the crash point is
//  derived from HMAC-SHA256(secret) — anyone can recompute it (see crashFromSecret).
//
//  Upgrades (the "double or upgrade" part):  an item stake is worth  value x multiplier
//  when cashed out. It becomes the best item of its own kind worth up to that amount:
//     everyday gift -> best everyday gift, remainder paid in COINS
//     NFT           -> best NFT (from rocket.nftTiers), remainder paid in STARS
//  Values come from game-config.js (coinValues / starValues).
//
//  Config: game-config.js -> rocket {...}.   Kill switch: env ROCKET=off.
//  Single-instance assumption (like the rest of the game server): the round loop
//  lives in this process. If the process dies mid-round, startup refunds every open
//  bet (Stars back, staked items unlocked).
// ============================================================================
const crypto = require('crypto');

const DEFAULTS = {
  enabled: true,
  minBet: 50,            // Stars (and minimum value of a staked item)
  maxBet: 20000,         // Stars
  growth: 0.11,          // m(t) = e^(growth * t)
  edge: 0.97,            // 0.97 = 3% house edge (players get back ~97% of Stars staked over time)
  maxMultiplier: 500,
  betSeconds: 8,
  crashPauseSeconds: 4,
  maxPayoutStars: 200000,   // cap on a single Stars payout
  maxUpgradeValue: 4000,    // an NFT can only upgrade into NFTs worth at most this many Stars
  nftTiers: null,           // null = every NFT in nftGifts that has a starValue; or an array of names (the ones you really hold)
};

function createRocket({ pool, tx, addLedger, createGift, bal, CFG, NFT_SET, fail, requireSubscription }) {
  const E = process.env;
  const R = { ...DEFAULTS, ...(CFG.rocket || {}) };
  if (E.ROCKET === 'off') R.enabled = false;
  if (E.NODE_ENV === 'test') {   // tests only: speed things up / force crash points
    if (E.ROCKET_BET_SECONDS) R.betSeconds = Number(E.ROCKET_BET_SECONDS);
    if (E.ROCKET_PAUSE_SECONDS) R.crashPauseSeconds = Number(E.ROCKET_PAUSE_SECONDS);
  }
  const forced = E.NODE_ENV === 'test' && E.ROCKET_TEST_CRASH ? E.ROCKET_TEST_CRASH.split(',').map(Number) : [];
  const K = R.growth;

  // ---- item values & upgrade tiers -------------------------------------------------
  const starValues = CFG.starValues || {};
  const basic = (CFG.battle && CFG.battle.basicValues) || {};
  const valueOf = (name) => (NFT_SET.has(name) ? Number(starValues[name]) : Number(basic[name] ?? CFG.coinValues[name])) || 0;
  const itemMin = (name) => (NFT_SET.has(name) ? R.minBet : Math.min(R.minBet, ...Object.values(basic).map(Number).filter((v) => v > 0)));
  const giftTiers = Object.keys(CFG.coinValues).filter((n) => !NFT_SET.has(n)).map((n) => ({ n, v: valueOf(n) })).sort((a, b) => a.v - b.v);
  const nftNames = (Array.isArray(R.nftTiers) ? R.nftTiers : CFG.nftGifts).filter((n) => NFT_SET.has(n) && valueOf(n) > 0 && valueOf(n) <= R.maxUpgradeValue);
  const nftTiers = nftNames.map((n) => ({ n, v: valueOf(n) })).sort((a, b) => a.v - b.v);

  function outcome(name, m) {
    const isNft = NFT_SET.has(name), base = valueOf(name), tiers = isNft ? nftTiers : giftTiers;
    const worth = Math.floor(base * m);
    let to = name, toV = base;
    for (const t of tiers) if (t.v <= worth && t.v >= toV) { to = t.n; toV = t.v; }
    return { worth, to, rem: Math.max(0, worth - toV), isNft };
  }

  // ---- crash point -------------------------------------------------------------------
  function crashFromSecret(secret) {
    const h = crypto.createHmac('sha256', secret).update('voidgifts-rocket').digest();
    const r = h.readUIntBE(0, 6) / 2 ** 48;                       // uniform in [0, 1)
    const c = Math.floor((100 * R.edge) / (1 - r)) / 100;         // P(crash >= x) = edge / x
    return Math.min(R.maxMultiplier, Math.max(1, c));
  }
  const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const multAt = (ms) => Math.floor(Math.exp(K * (ms / 1000)) * 100) / 100;

  // ---- state -------------------------------------------------------------------------
  let round = null;                 // current round
  let history = [];                 // last crash points, newest first
  const clients = new Map();        // res -> { userId }
  const inflight = new Set();       // bet / cash-out transactions currently running
  let flushTimer = null, started = false;

  const track = (p) => { inflight.add(p); const done = () => inflight.delete(p); p.then(done, done); return p; };
  const publicName = (u) => {
    if (u.show_in_leaderboard === false) return 'Player';
    const n = (u.first_name || u.username || 'Player').toString().trim();
    return n.slice(0, 12) || 'Player';
  };

  function myBetView(b) {
    return b && { kind: b.kind, amount: b.amount || 0, item: b.item || null, prize_id: b.prizeId || null, auto: b.auto || 0, status: b.status, cash_at: b.cashAt || null, result: b.result || null };
  }
  function snapshot(userId) {
    const r = round, now = Date.now();
    const crashed = r && r.phase === 'crash';
    return {
      serverNow: now, phase: r ? r.phase : 'bet', roundId: r ? r.id : 0, hash: r ? r.hash : null,
      betEndsAt: r ? r.betEndsAt : 0, flyStartedAt: r ? r.flyStartedAt : 0,
      crashAt: crashed ? r.crashAt : null, secret: crashed ? r.secret : null,
      history,
      bets: r ? [...r.bets.values()].map((b) => ({ n: b.name, k: b.kind, a: b.amount || null, i: b.item || null, s: b.status === 'cashing' ? 'active' : b.status, x: b.cashAt || null, me: b.userId === userId })) : [],
      me: r && userId ? myBetView(r.bets.get(userId)) : null,
    };
  }
  function flush() {
    flushTimer = null;
    for (const [res, c] of clients) { try { res.write(`data: ${JSON.stringify(snapshot(c.userId))}\n\n`); } catch { clients.delete(res); } }
  }
  function broadcast() { if (!flushTimer) flushTimer = setTimeout(flush, 120); }

  // ---- database ----------------------------------------------------------------------
  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rocket_rounds (
        id BIGSERIAL PRIMARY KEY, hash TEXT NOT NULL, secret TEXT NOT NULL, crash_at NUMERIC(10,2) NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), crashed_at TIMESTAMPTZ);
      CREATE TABLE IF NOT EXISTS rocket_bets (
        id BIGSERIAL PRIMARY KEY, round_id BIGINT NOT NULL, user_id BIGINT NOT NULL, kind TEXT NOT NULL,
        stake_stars BIGINT NOT NULL DEFAULT 0, prize_id TEXT, item TEXT, auto NUMERIC(10,2),
        status TEXT NOT NULL DEFAULT 'active', cash_at NUMERIC(10,2), result JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (round_id, user_id));
      CREATE INDEX IF NOT EXISTS idx_rocket_bets_user ON rocket_bets (user_id, id DESC);
    `);
    // A crash/redeploy mid-round: give everything back.
    const open = (await pool.query(`SELECT * FROM rocket_bets WHERE status = 'active'`)).rows;
    for (const b of open) {
      await tx(async (c) => {
        const got = await c.query(`UPDATE rocket_bets SET status = 'refunded' WHERE id = $1 AND status = 'active' RETURNING id`, [b.id]);
        if (!got.rowCount) return;
        if (b.kind === 'stars' && Number(b.stake_stars) > 0) {
          await c.query('UPDATE users SET stars = stars + $2, updated_at = NOW() WHERE user_id = $1', [b.user_id, b.stake_stars]);
          await addLedger(c, b.user_id, 'rocket:refund', Number(b.stake_stars), 0, { round: b.round_id }, `rocket:refund:${b.id}`);
        } else if (b.prize_id) {
          await c.query(`UPDATE prizes SET status = 'pending', updated_at = NOW() WHERE prize_id = $1 AND status = 'staked'`, [b.prize_id]);
        }
      });
    }
    if (open.length) console.log(`🚀 Rocket: refunded ${open.length} open bet(s) from an interrupted round`);
    history = (await pool.query('SELECT crash_at FROM rocket_rounds WHERE crashed_at IS NOT NULL ORDER BY id DESC LIMIT 20')).rows.map((r) => Number(r.crash_at));
  }

  // ---- the round loop ------------------------------------------------------------------
  async function newRound() {
    let secret = crypto.randomBytes(32).toString('hex'), crashAt = crashFromSecret(secret);
    if (forced.length) crashAt = forced.shift();
    const hash = sha256(secret);
    const ins = await pool.query('INSERT INTO rocket_rounds (hash, secret, crash_at) VALUES ($1,$2,$3) RETURNING id', [hash, secret, crashAt]);
    round = { id: Number(ins.rows[0].id), phase: 'bet', secret, hash, crashAt, betEndsAt: Date.now() + R.betSeconds * 1000, flyStartedAt: 0, crashTimeAbs: 0, bets: new Map(), timers: [] };
    broadcast();
    setTimeout(startFlight, R.betSeconds * 1000);
  }

  async function startFlight() {
    try {
      await Promise.allSettled([...inflight]);            // let bets that are mid-transaction finish
      // nobody here and nobody watching: don't burn a round, keep the betting window open
      if (!round.bets.size && !clients.size) { round.betEndsAt = Date.now() + R.betSeconds * 1000; broadcast(); return void setTimeout(startFlight, R.betSeconds * 1000); }
      round.phase = 'fly';
      round.flyStartedAt = Date.now();
      const crashMs = Math.max(400, Math.ceil((Math.log(round.crashAt) / K) * 1000));
      round.crashTimeAbs = round.flyStartedAt + crashMs;
      for (const b of round.bets.values()) {          // auto cash-outs run on exact timers
        if (b.auto && b.auto < round.crashAt) round.timers.push(setTimeout(() => cashAuto(b).catch((e) => console.error('rocket auto cash-out:', e.message)), Math.ceil((Math.log(b.auto) / K) * 1000)));
      }
      round.timers.push(setTimeout(() => doCrash().catch((e) => console.error('🚨 rocket crash handling failed:', e)), crashMs));
      broadcast();
    } catch (e) { console.error('🚨 rocket startFlight:', e); setTimeout(newRound, 5000); }
  }

  async function doCrash() {
    const r = round;
    r.phase = 'crash';
    r.timers.forEach(clearTimeout);
    await Promise.allSettled([...inflight]);
    for (const b of r.bets.values()) {
      if (b.status !== 'active') continue;
      try {
        if (b.auto && b.auto < r.crashAt) await cashBet(b, b.auto);
        else await loseBet(b);
      } catch (e) { console.error('🚨 rocket settle failed for bet', b.id, e); }
    }
    await pool.query('UPDATE rocket_rounds SET crashed_at = NOW() WHERE id = $1', [r.id]).catch(() => {});
    history = [r.crashAt, ...history].slice(0, 20);
    broadcast();
    setTimeout(() => newRound().catch((e) => { console.error('🚨 rocket newRound:', e); setTimeout(() => newRound().catch(() => {}), 5000); }), R.crashPauseSeconds * 1000);
  }

  // ---- settlement -----------------------------------------------------------------------
  async function cashBet(b, m) {
    const out = await tx(async (c) => {
      const got = await c.query(`UPDATE rocket_bets SET status = 'cashed', cash_at = $2 WHERE id = $1 AND status = 'active' RETURNING id`, [b.id, m]);
      if (!got.rowCount) throw fail(409, 'TOO_LATE', 'Too late');
      await c.query('SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE', [b.userId]);
      let result;
      if (b.kind === 'stars') {
        const payout = Math.min(R.maxPayoutStars, Math.floor(b.amount * m));
        await c.query('UPDATE users SET stars = stars + $2, updated_at = NOW() WHERE user_id = $1', [b.userId, payout]);
        await addLedger(c, b.userId, 'rocket:win', payout, 0, { round: round.id, bet: b.id, stake: b.amount, at: m }, `rocket:win:${b.id}`);
        result = { stars: payout };
      } else {
        const o = outcome(b.item, m);
        await c.query(`UPDATE prizes SET status = 'rocket_done', updated_at = NOW() WHERE prize_id = $1 AND status = 'staked'`, [b.prizeId]);
        const newId = await createGift(c, { id: b.userId, username: b.username }, o.to);
        if (o.rem > 0) {
          await c.query('UPDATE users SET stars = stars + $2, updated_at = NOW() WHERE user_id = $1', [b.userId, o.rem]);
        }
        await addLedger(c, b.userId, 'rocket:win', o.rem, 0, { round: round.id, bet: b.id, from: b.item, to: o.to, at: m, prize_id: newId }, `rocket:win:${b.id}`);
        result = { from: b.item, to: o.to, prize_id: newId, stars: o.rem };
      }
      await c.query('UPDATE rocket_bets SET result = $2 WHERE id = $1', [b.id, JSON.stringify(result)]);
      const u = (await c.query('SELECT * FROM users WHERE user_id = $1', [b.userId])).rows[0];
      return { result, balance: bal(u) };
    });
    b.status = 'cashed'; b.cashAt = m; b.result = out.result;
    broadcast();
    return out;
  }

  async function loseBet(b) {
    await tx(async (c) => {
      const got = await c.query(`UPDATE rocket_bets SET status = 'lost' WHERE id = $1 AND status = 'active' RETURNING id`, [b.id]);
      if (!got.rowCount) return;
      if (b.prizeId) await c.query(`UPDATE prizes SET status = 'rocket_done', updated_at = NOW() WHERE prize_id = $1 AND status = 'staked'`, [b.prizeId]);
      await addLedger(c, b.userId, 'rocket:loss', 0, 0, { round: round.id, bet: b.id, kind: b.kind, stake: b.amount || 0, item: b.item || null, crash: round.crashAt }, `rocket:loss:${b.id}`);
    });
    b.status = 'lost';
  }

  async function cashAuto(b) {
    if (round.phase !== 'fly' || b.status !== 'active') return;
    b.status = 'cashing';
    try { await track(cashBet(b, b.auto)); } catch (e) { b.status = 'active'; throw e; }
  }

  // ---- player actions -----------------------------------------------------------------
  async function placeBet(user, body) {
    if (!R.enabled) throw fail(503, 'ROCKET_OFF', 'Rocket is switched off');
    const r = round;
    if (!r || r.phase !== 'bet' || Date.now() >= r.betEndsAt) throw fail(409, 'BETTING_CLOSED', 'Betting is closed for this round');
    if (r.bets.has(user.id)) throw fail(409, 'ALREADY_BET', 'You already have a bet this round');
    await requireSubscription(user.id);
    const auto = Number(body.auto);
    const autoAt = Number.isFinite(auto) && auto >= 1.1 ? Math.min(R.maxMultiplier, Math.floor(auto * 100) / 100) : 0;
    const prizeId = body.prize_id ? String(body.prize_id) : null;
    const amount = Math.floor(Number(body.amount));
    if (!prizeId && !(amount >= R.minBet)) throw fail(400, 'BELOW_MIN', `Minimum bet is ${R.minBet} Stars`, { min: R.minBet });
    if (!prizeId && amount > R.maxBet) throw fail(400, 'ABOVE_MAX', `Maximum bet is ${R.maxBet} Stars`, { max: R.maxBet });

    const job = track(tx(async (c) => {
      const u = (await c.query(
        `INSERT INTO users (user_id, username, first_name, last_name, avatar_url) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id) DO UPDATE SET username = COALESCE($2, users.username), first_name = COALESCE($3, users.first_name)
         RETURNING *`, [user.id, user.username ?? null, user.first_name ?? null, user.last_name ?? null, user.photo_url ?? null])).rows[0];
      const locked = (await c.query('SELECT * FROM users WHERE user_id = $1 FOR UPDATE', [user.id])).rows[0] || u;
      if (round !== r || r.phase !== 'bet' || Date.now() >= r.betEndsAt) throw fail(409, 'BETTING_CLOSED', 'Betting is closed for this round');
      let item = null, kind = 'stars', stake = 0;
      if (prizeId) {
        const p = await c.query(`UPDATE prizes SET status = 'staked', updated_at = NOW() WHERE prize_id = $1 AND user_id = $2 AND status = 'pending' RETURNING gift_name`, [prizeId, user.id]);
        if (!p.rowCount) throw fail(409, 'ITEM_UNAVAILABLE', 'This item is not available to bet');
        item = p.rows[0].gift_name;
        if (valueOf(item) < itemMin(item)) throw fail(400, 'BELOW_MIN', `This item is worth less than the ${itemMin(item)} Stars minimum`, { min: itemMin(item) });
        kind = NFT_SET.has(item) ? 'nft' : 'gift';
      } else {
        if (Number(locked.stars) < amount) throw fail(402, 'INSUFFICIENT_STARS', 'Not enough Stars', { need: amount, have: Number(locked.stars) });
        await c.query('UPDATE users SET stars = stars - $2, updated_at = NOW() WHERE user_id = $1', [user.id, amount]);
        stake = amount;
      }
      const ins = await c.query(
        `INSERT INTO rocket_bets (round_id, user_id, kind, stake_stars, prize_id, item, auto) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [r.id, user.id, kind, stake, prizeId, item, autoAt || null]);
      const betId = Number(ins.rows[0].id);
      await addLedger(c, user.id, kind === 'stars' ? 'rocket:bet' : 'rocket:stake', -stake, 0, { round: r.id, bet: betId, item }, `rocket:bet:${betId}`);
      const after = (await c.query('SELECT * FROM users WHERE user_id = $1', [user.id])).rows[0];
      return { betId, kind, item, stake, name: publicName(locked), balance: bal(after) };
    }));
    const out = await job;
    const b = { id: out.betId, userId: user.id, username: user.username ?? null, name: out.name, kind: out.kind, amount: out.stake, item: out.item, prizeId, auto: autoAt, status: 'active', cashAt: null, result: null };
    r.bets.set(user.id, b);
    broadcast();
    return { bet: myBetView(b), balance: out.balance };
  }

  async function cashOut(user) {
    const r = round, b = r && r.bets.get(user.id);
    if (!b || b.status !== 'active') throw fail(409, 'NO_ACTIVE_BET', 'You have no active bet');
    if (r.phase !== 'fly') throw fail(409, 'NOT_FLYING', 'The rocket is not flying');
    const now = Date.now();
    if (now >= r.crashTimeAbs) throw fail(409, 'TOO_LATE', 'Too late — the rocket crashed');
    const m = Math.max(1, multAt(now - r.flyStartedAt));
    if (m >= r.crashAt) throw fail(409, 'TOO_LATE', 'Too late — the rocket crashed');
    b.status = 'cashing';
    try {
      const out = await track(cashBet(b, m));
      return { at: m, result: out.result, balance: out.balance };
    } catch (e) { if (b.status === 'cashing') b.status = 'active'; throw e; }
  }

  // ---- routes -------------------------------------------------------------------------------
  function routes(app, { auth, limit, wrap }) {
    app.get('/api/rocket/state', auth, limit('rstate', 40, 10000), (req, res) => res.set('Cache-Control', 'no-store').json(snapshot(req.user.id)));
    app.get('/api/rocket/stream', auth, limit('rstream', 12, 60000), (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 1500\n\n`);
      clients.set(res, { userId: req.user.id });
      res.write(`data: ${JSON.stringify(snapshot(req.user.id))}\n\n`);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
    });
    app.post('/api/rocket/bet', auth, limit('rbet', 10, 10000), wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(await placeBet(req.user, req.body || {}))));
    app.post('/api/rocket/cashout', auth, limit('rcash', 20, 10000), wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(await cashOut(req.user))));
    // Provably fair check: hash is public right away, the secret once the round has crashed.
    app.get('/api/rocket/round/:id', wrap(async (req, res) => {
      const id = Number(req.params.id);
      const row = Number.isSafeInteger(id) ? (await pool.query('SELECT id, hash, secret, crash_at, crashed_at FROM rocket_rounds WHERE id = $1', [id])).rows[0] : null;
      if (!row) throw fail(404, 'NOT_FOUND', 'Unknown round');
      res.json({ id: Number(row.id), hash: row.hash, ...(row.crashed_at ? { secret: row.secret, crash_at: Number(row.crash_at) } : {}) });
    }));
  }

  function start() {
    if (started || !R.enabled) return;
    started = true;
    newRound().catch((e) => { console.error('🚨 rocket could not start:', e); started = false; });
  }

  const publicConfig = () => ({ enabled: R.enabled, minBet: R.minBet, maxBet: R.maxBet, growth: R.growth, maxMultiplier: R.maxMultiplier, betSeconds: R.betSeconds, giftTiers, nftTiers });

  return { init, start, routes, publicConfig, crashFromSecret, outcome, enabled: R.enabled };
}

module.exports = { createRocket, DEFAULTS };

'use strict';
// ============================================================================
//  MINES — solo, server-authoritative.
//
//  A 5x5 board hides `mines` bombs (player picks 1..24). Every safe tile the player opens
//  raises the multiplier; the player can cash out any time after the first safe tile.
//  Opening a bomb ends the game and the stake is lost.
//
//  Multiplier after k safe tiles with m mines on N=25 tiles:
//      fair(m,k) = C(N,k) / C(N-m,k)            (inverse of the chance of surviving k picks)
//      mult(m,k) = floor(edge * fair * 100) / 100
//  so the long-run return is `edge` (0.90 = the house keeps 10%) whatever the player does.
//
//  Fairness:  each game commits to a secret. hash = sha256(secret) is shown at the start,
//  the secret is revealed when the game ends (win or lose). The bomb layout is a Fisher-Yates
//  shuffle of tiles 0..24 driven by HMAC-SHA256(secret, 'voidgifts-mines:' + i); the first `mines`
//  tiles of the shuffled list are the bombs. The browser re-checks this (see Fair in script.js).
//
//  The layout is NEVER sent to the client while a game is active.
//  Games live in the database, so a redeploy mid-game loses nothing: the player resumes.
//
//  Config: game-config.js -> mines {...}.
//  KILL SWITCH: env MINES=off (Railway variable). While off, EVERY /api/mines route answers 503 MINES_OFF, the config tells the
//  app to hide Mines, and at boot every unfinished game is refunded (stake back in the player's Stars), so nothing is left running.
// ============================================================================
const crypto = require('crypto');

const N = 25;                      // tiles on the board (5 x 5)
const DEFAULTS = {
  enabled: true,
  minBet: 50,                      // Stars
  maxBet: 20000,                   // Stars
  edge: 0.90,                      // 0.90 = 10% house edge
  maxMultiplier: 100,              // a game can never pay more than bet x this; reaching it cashes out automatically (cuts the huge, very rare payouts)
  minMines: 1,
  maxMines: 24,
  maxPayoutStars: 200000,          // cap on a single payout; reaching it cashes out automatically
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rnd = (secret, label) => crypto.createHmac('sha256', secret).update(label).digest().readUIntBE(0, 6) / 2 ** 48;

// The bomb tiles for a secret (sorted). Same algorithm lives in the browser for verification.
function layoutFromSecret(secret, mines) {
  const a = Array.from({ length: N }, (_, i) => i);
  for (let i = N - 1; i > 0; i--) {
    const j = Math.floor(rnd(secret, 'voidgifts-mines:' + i) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, mines).sort((x, y) => x - y);
}

// Multiplier for k safe tiles opened with m mines (k = 0 -> 1.00).
function multiplier(m, k, edge) {
  if (k <= 0) return 1;
  let fair = 1;
  for (let i = 0; i < k; i++) fair *= (N - i) / (N - m - i);
  return Math.floor(edge * fair * 100 + 1e-7) / 100;
}

function createMines({ pool, tx, addLedger, bal, CFG, fail, requireSubscription }) {
  const E = process.env;
  const R = { ...DEFAULTS, ...(CFG.mines || {}) };
  if (E.MINES === 'off') R.enabled = false;
  if (E.NODE_ENV === 'test' && E.MINES_EDGE && Number(E.MINES_EDGE) > 0 && Number(E.MINES_EDGE) <= 1) R.edge = Number(E.MINES_EDGE);
  const forcedSecrets = E.NODE_ENV === 'test' && E.MINES_TEST_SECRETS ? E.MINES_TEST_SECRETS.split(',') : [];

  const capped = (m, k) => Math.min(multiplier(m, k, R.edge), R.maxMultiplier);   // what the player is paid: fair multiplier, never above the cap

  // What the player may see of a game while it is running (never the layout).
  function view(g) {
    const picks = (g.picks || []).map(Number), m = Number(g.mines), k = picks.length, bet = Number(g.bet);
    const safeLeft = N - m - k;
    const mult = capped(m, k);
    return {
      id: Number(g.id), hash: g.hash, bet, mines: m, picks, status: g.status,
      mult, payout: k ? Math.min(Math.floor(bet * mult), R.maxPayoutStars) : 0,
      next: safeLeft > 0 ? capped(m, k + 1) : null,
    };
  }

  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mines_games (
        id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, bet BIGINT NOT NULL, mines INT NOT NULL,
        hash TEXT NOT NULL, secret TEXT NOT NULL, picks INT[] NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active', payout BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ);
      CREATE UNIQUE INDEX IF NOT EXISTS mines_one_active ON mines_games (user_id) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_mines_user ON mines_games (user_id, id DESC);
    `);
    if (!R.enabled) {                                  // switched off: nobody keeps a stake locked in a game that can no longer be played
      const open = (await pool.query(`SELECT * FROM mines_games WHERE status = 'active'`)).rows;
      for (const g of open) {
        await tx(async (c) => {
          const got = await c.query(`UPDATE mines_games SET status = 'refunded', payout = $2, finished_at = NOW() WHERE id = $1 AND status = 'active' RETURNING id`, [g.id, g.bet]);
          if (!got.rowCount) return;
          await c.query('UPDATE users SET stars = stars + $2, updated_at = NOW() WHERE user_id = $1', [g.user_id, g.bet]);
          await addLedger(c, g.user_id, 'mines:refund', Number(g.bet), 0, { game: Number(g.id) }, `mines:refund:${g.id}`);
        });
      }
      console.log(`⛏️  Mines is OFF${open.length ? ` — refunded ${open.length} unfinished game(s)` : ''}`);
    }
  }

  // ---- actions ---------------------------------------------------------------------------
  async function state(user) {
    const act = (await pool.query(`SELECT * FROM mines_games WHERE user_id = $1 AND status = 'active'`, [user.id])).rows[0];
    const hist = (await pool.query(
      `SELECT id, bet, mines, status, payout, cardinality(picks) AS k FROM mines_games WHERE user_id = $1 AND status NOT IN ('active','refunded') ORDER BY id DESC LIMIT 12`, [user.id])).rows
      .map((r) => ({ id: Number(r.id), bet: Number(r.bet), mines: Number(r.mines), status: r.status, payout: Number(r.payout), k: Number(r.k) }));
    return { active: act ? view(act) : null, history: hist };
  }

  async function start(user, body) {
    if (!R.enabled) throw fail(503, 'MINES_OFF', 'Mines is switched off');
    const bet = Math.floor(Number(body.bet)), mines = Math.floor(Number(body.mines));
    if (!(bet >= R.minBet)) throw fail(400, 'BELOW_MIN', `Minimum bet is ${R.minBet} Stars`, { min: R.minBet });
    if (bet > R.maxBet) throw fail(400, 'ABOVE_MAX', `Maximum bet is ${R.maxBet} Stars`, { max: R.maxBet });
    if (!(mines >= R.minMines && mines <= R.maxMines)) throw fail(400, 'BAD_MINES', `Pick ${R.minMines}-${R.maxMines} mines`);
    await requireSubscription(user.id);
    const secret = forcedSecrets.length ? forcedSecrets.shift() : crypto.randomBytes(32).toString('hex');
    try {
      return await tx(async (c) => {
        await c.query(
          `INSERT INTO users (user_id, username, first_name, last_name, avatar_url) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (user_id) DO UPDATE SET username = COALESCE($2, users.username), first_name = COALESCE($3, users.first_name)`,
          [user.id, user.username ?? null, user.first_name ?? null, user.last_name ?? null, user.photo_url ?? null]);
        const u = (await c.query('SELECT * FROM users WHERE user_id = $1 FOR UPDATE', [user.id])).rows[0];
        const open = (await c.query(`SELECT * FROM mines_games WHERE user_id = $1 AND status = 'active'`, [user.id])).rows[0];
        if (open) throw fail(409, 'ACTIVE_GAME', 'Finish your current game first', { game: view(open) });
        if (Number(u.stars) < bet) throw fail(402, 'INSUFFICIENT_STARS', 'Not enough Stars', { need: bet, have: Number(u.stars) });
        await c.query('UPDATE users SET stars = stars - $2, updated_at = NOW() WHERE user_id = $1', [user.id, bet]);
        const g = (await c.query(`INSERT INTO mines_games (user_id, bet, mines, hash, secret) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [user.id, bet, mines, sha256(secret), secret])).rows[0];
        await addLedger(c, user.id, 'mines:bet', -bet, 0, { game: Number(g.id), mines }, `mines:bet:${g.id}`);
        const after = (await c.query('SELECT * FROM users WHERE user_id = $1', [user.id])).rows[0];
        return { game: view(g), balance: bal(after) };
      });
    } catch (e) {
      if (e && e.code === '23505') {               // two start requests at once: the unique index let only one through
        const row = (await pool.query(`SELECT * FROM mines_games WHERE user_id = $1 AND status = 'active'`, [user.id])).rows[0];
        throw fail(409, 'ACTIVE_GAME', 'Finish your current game first', { game: row ? view(row) : null });
      }
      throw e;
    }
  }

  // Pays out a game inside an open transaction (already locked). Returns the new balance.
  async function payOut(c, g, status) {
    const v = view(g);
    await c.query(`UPDATE mines_games SET status = $2, payout = $3, finished_at = NOW() WHERE id = $1`, [g.id, status, v.payout]);
    await c.query('UPDATE users SET stars = stars + $2, updated_at = NOW() WHERE user_id = $1', [g.user_id, v.payout]);
    await addLedger(c, g.user_id, 'mines:win', v.payout, 0, { game: Number(g.id), mines: Number(g.mines), picks: v.picks.length, mult: v.mult }, `mines:win:${g.id}`);
    return (await c.query('SELECT * FROM users WHERE user_id = $1', [g.user_id])).rows[0];
  }

  async function reveal(user, body) {
    const tile = Number(body.tile);
    if (!Number.isInteger(tile) || tile < 0 || tile >= N) throw fail(400, 'BAD_TILE', 'Unknown tile');
    return tx(async (c) => {
      const g = (await c.query(`SELECT * FROM mines_games WHERE user_id = $1 AND status = 'active' FOR UPDATE`, [user.id])).rows[0];
      if (!g) throw fail(409, 'NO_GAME', 'You have no active game');
      const picks = g.picks.map(Number);
      if (picks.includes(tile)) throw fail(409, 'ALREADY_OPEN', 'That tile is already open');
      const layout = layoutFromSecret(g.secret, Number(g.mines));
      if (layout.includes(tile)) {
        await c.query(`UPDATE mines_games SET status = 'lost', payout = 0, finished_at = NOW() WHERE id = $1`, [g.id]);
        return { hit: true, tile, mines: layout, secret: g.secret, hash: g.hash, id: Number(g.id), picks, bet: Number(g.bet), mine_count: Number(g.mines) };
      }
      const g2 = (await c.query('UPDATE mines_games SET picks = array_append(picks, $2) WHERE id = $1 RETURNING *', [g.id, tile])).rows[0];
      const v = view(g2);
      const atCap = multiplier(Number(g2.mines), picks.length + 1, R.edge) >= R.maxMultiplier || Math.floor(Number(g2.bet) * v.mult) >= R.maxPayoutStars;
      if (v.next === null || atCap) {                // every safe tile open, or the multiplier / payout cap reached: cash out for the player
        const u = await payOut(c, g2, 'cashed');
        return { hit: false, tile, done: true, game: { ...v, status: 'cashed' }, mines: layout, secret: g2.secret, balance: bal(u), won: v.payout };
      }
      return { hit: false, tile, done: false, game: v };
    });
  }

  async function cashout(user) {
    return tx(async (c) => {
      const g = (await c.query(`SELECT * FROM mines_games WHERE user_id = $1 AND status = 'active' FOR UPDATE`, [user.id])).rows[0];
      if (!g) throw fail(409, 'NO_GAME', 'You have no active game');
      if (!g.picks.length) throw fail(409, 'PICK_FIRST', 'Open at least one tile first');
      const u = await payOut(c, g, 'cashed');
      const v = view(g);
      return { won: v.payout, mult: v.mult, mines: layoutFromSecret(g.secret, Number(g.mines)), secret: g.secret, hash: g.hash, id: Number(g.id), picks: v.picks, balance: bal(u) };
    });
  }

  function routes(app, { auth, limit, wrap }) {
    const noStore = (res) => res.set('Cache-Control', 'no-store');
    const gate = (req, res, next) => (R.enabled ? next() : res.status(503).set('Cache-Control', 'no-store').json({ error: 'Mines is switched off', code: 'MINES_OFF' }));
    app.get('/api/mines/state', gate, auth, limit('mstate', 40, 10000), wrap(async (req, res) => noStore(res).json(await state(req.user))));
    app.post('/api/mines/start', gate, auth, limit('mstart', 12, 10000), wrap(async (req, res) => noStore(res).json(await start(req.user, req.body || {}))));
    app.post('/api/mines/reveal', gate, auth, limit('mreveal', 60, 10000), wrap(async (req, res) => noStore(res).json(await reveal(req.user, req.body || {}))));
    app.post('/api/mines/cashout', gate, auth, limit('mcash', 20, 10000), wrap(async (req, res) => noStore(res).json(await cashout(req.user))));
    // Provably fair check: only finished games reveal their secret.
    app.get('/api/mines/game/:id', gate, wrap(async (req, res) => {
      const id = Number(req.params.id);
      const row = Number.isSafeInteger(id) ? (await pool.query('SELECT id, hash, secret, mines, picks, status, payout FROM mines_games WHERE id = $1', [id])).rows[0] : null;
      if (!row) throw fail(404, 'NOT_FOUND', 'Unknown game');
      res.json({ id: Number(row.id), hash: row.hash, mines: Number(row.mines), ...(row.status !== 'active' ? { secret: row.secret, layout: layoutFromSecret(row.secret, Number(row.mines)), status: row.status, payout: Number(row.payout) } : {}) });
    }));
  }

  const publicConfig = () => !R.enabled ? { enabled: false } : ({ enabled: true, tiles: N, minBet: R.minBet, maxBet: R.maxBet, edge: R.edge, maxMultiplier: R.maxMultiplier, minMines: R.minMines, maxMines: R.maxMines, maxPayout: R.maxPayoutStars });

  return { init, routes, publicConfig, enabled: R.enabled };
}

module.exports = { createMines, layoutFromSecret, multiplier, DEFAULTS };

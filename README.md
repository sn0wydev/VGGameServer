# VGGameServer — the authoritative game server

The mini app (script.js) **no longer decides anything**. It only asks this server and draws the answer:

| App asks | Server does |
|---|---|
| `POST /api/spin {wheel, mult}` | checks the price, takes the Stars, rolls every prize with `crypto.randomInt`, creates the gift rows, pays Stars/coins — all in one DB transaction |
| `POST /api/daily` | enforces the cooldown (DB), rolls and grants |
| `POST /api/promo {code}` | validates (enabled / dates / max uses / once per player), pays coins + Stars + gifts |
| `POST /api/prizes/:id/convert` | gift → coins, only if it is still untouched and yours |
| `GET /api/me` | balances, inventory, daily timer; also collects confirmed Stars/TON purchases |
| `GET /api/config` | public: prices, reel pictures, coin values (**real odds are not sent**) |

Every `/api` call carries Telegram's signed `initData`; the user id comes from that signature, never from the request body.
A tampered, forged or expired session gets `401`. The browser console can still *display* a fake number, but it can't change what the server stores, and the next refresh puts the real balance back.

## Deploy on Railway
1. New service from this folder (`npm start`). Use the **same Postgres** as prize-store (`DATABASE_URL`).
2. Variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | same as prize-store |
| `BOT_TOKEN` | the mini-app bot's token (same one the relayer uses) |
| `ADMIN_API_KEY` | a long random secret — protects `/admin/panel` |
| `BOT_URL` | your VGServers (main bot) URL — used to collect Stars purchases and check channel subscription |
| `TON_API_URL` | your TON payments service URL (collects TON purchases) |
| `ALLOWED_ORIGINS` | your mini-app origin(s), comma separated (e.g. `https://yourname.github.io`); default `*` |
| `ENFORCE_SUBSCRIPTION` | optional; defaults to `true` when `BOT_URL` is set |
| `RATE_MULT` | optional, multiplies the per-player rate limits (default 1) |

3. Set the same **`INTERNAL_API_KEY`** on prize-store, the relayer and (already) the main bot. prize-store now *requires* it on every route that writes balances/prizes (see "What changed elsewhere").
4. In the app's `script.js` set `GAME_API_BASE` to this service's public URL.
5. Open `https://<this-service>/admin/panel`, paste `ADMIN_API_KEY`, click **Load**.

**Release order** (do it on your dev environment first): game server up → prize-store + relayer with the key → publish the new front end. The old front end can't write balances any more once prize-store is locked, so don't leave it on production.

## What you edit, and where
- **Prices, odds, prize values, daily cooldown** → `game-config.js`, redeploy. The server refuses to boot if a table doesn't total exactly 100, a preview table's ids differ, or a gift has no coin value — you can't ship a broken table by accident.
  - `prizes` = real odds (server only). `preview` = what the reel shows (sent to the app).
- **Promocodes** → no redeploy: `/admin/panel`. Create, edit, **Enable/Disable**, **Expire now**, delete. A code can give coins, Stars and a gift, with optional start/expiry date and a max-uses cap. Status shows as *active / disabled / expired / scheduled / used up*. (`SEED_PROMOS` in the config only seeds the first start.)
  - The same things over HTTP (header `X-Admin-Key`): `GET/POST /admin/promos`, `POST /admin/promos/:code/active {active}`, `POST /admin/promos/:code/expire`, `DELETE /admin/promos/:code`, `POST /admin/users/:id/reset-daily`, `GET /admin/users/:id` (balance + last 30 ledger rows).
- **Adding a new spin**: add a wheel to `game-config.js` (same shape as `hex`), then add its page/hero/wheel in the front end (as with Hex/Astral). The server needs no other change.

## Paid promocodes (anti alt-account / bot farming)
Promocodes are locked by default. An account can redeem when **any** of these is true:
1. It has paid **at least 2 TON in total** (cumulative; configurable: `promoAccess.minTonPaid` in `game-config.js`). Only **TON** purchases count, not Telegram Stars. TON value is measured as Stars x `tonPerStar` (0.00932, the deposit-package rate), so the smallest package (1.86 TON) alone is not enough, but two of them or any bigger package is.
2. You allowed it by hand: `/admin/panel` -> **Who can redeem promocodes** -> *Allow* (or *Block*, or *Back to automatic*). Many ids at once: paste them into the box and press *Allow all listed*.
   HTTP: `POST /admin/users/:id/promo-access {allowed: true|false|null}`, `POST /admin/promo-access/bulk {user_ids:[...], allowed}`, `GET /admin/users/:id` shows the result and how much TON they paid.
3. The **code** is flagged *Open to everyone* (a public giveaway). Blocked accounts are still blocked.

Details: access is checked before the code is looked at, so an unpaid account can't probe which codes exist (a wrong code and a right code get the same answer). A blocked account (`false`) is refused even if it paid.
Players who paid TON **before** this update aren't counted automatically; allow them in bulk, or back-fill with `POST /admin/users/:id/ton-paid {ton: 5}`.
To switch the rule off for everyone: `requirePayment: false` in `game-config.js`. `GET /api/me` returns `promo: {allowed, reason, required_ton, paid_ton}` if you want to show a lock icon.

## Tables it adds (all additive, safe on your existing DB)
`promocodes`, `promo_redemptions`, `ledger` (every spin/daily/convert/promo/purchase with before/after deltas — your audit trail), and `users.daily_last_at`.
Existing `users` / `prizes` are reused, so the leaderboard, the relayer's claim flow and `/addstars` keep working unchanged.

## What changed elsewhere
- **prize-store**: `POST /prizes`, `PATCH/DELETE /prizes/:id`, `/lock`, `/schedule`, cooldown routes, `PUT /users/:id`, `GET /prizes`, `GET /users/:id`, `GET /prizes/queue/nft-due` now require `x-internal-key`. Before, anyone with F12 could `PUT` themselves a million Stars or `POST` a free Diamond. Public reads left: health, leaderboard, `/users/:id/subscription`, nft-credits, nft-sales.
- **relayer**: sends the key on its prize-store calls (one line in `storeCall`).
- **front end**: odds tables, coin values and promocodes are gone from `script.js`; `TELEGRAM_GIFT_IDS` is gone (prizes are registered by the server, and the relayer resolves the gift by name, so those ids were never used).

## Honest limits
- Existing balances are whatever the old app last pushed to prize-store; nothing is imported from players' phones (that would reopen the hole).
- Promocodes redeemed under the old system were only remembered in the player's browser, so a player could redeem each seeded code once more. Disable or replace the old five codes in the panel if that matters.
- Stars/TON purchases are collected by asking the bot / TON service (they mark credits "delivered" when asked). The server retries and logs `UNCREDITED PURCHASE` with the charge ids if its own database is down at that moment.
- TON invoice creation (`/ton/create-pending`) lives in a service I haven't seen; it should get the same signed-initData check.
- The server trusts Telegram's signature for up to `INITDATA_MAX_AGE_SECONDS` (7 days) — the same window the bot and relayer already use.

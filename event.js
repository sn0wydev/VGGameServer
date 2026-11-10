'use strict';
// ============================================================================
//  Timed event (Black Friday). Switched by environment variables, no code edit needed:
//
//    EVENT_ENABLED       on | off   (default off). Master switch. Off = the app behaves exactly as before the event.
//    EVENT_START         optional ISO time WITH offset, e.g. 2026-11-11T00:00:00+05:00. Empty = starts as soon as EVENT_ENABLED=on.
//    EVENT_END           ISO time WITH offset (default 2026-11-16T00:00:00+05:00 = 16.11.2026 00:00 in UTC+5).
//                        From that exact moment the server is back to normal by itself: no restart, no deploy.
//    EVENT_DAILY_HOURS   daily gift cooldown while the event runs (default 12). Normal value: dailyCooldownHours in game-config.js.
//    EVENT_ODDS          on | off   (default on). off = keep the shorter daily cooldown but use the normal odds.
//
//  Event odds live in game-config.js as "eventPrizes" next to a wheel's normal "prizes" (Void, Furry, Hex, Astral).
//  The reel preview (what scrolls by on screen) is the same in both modes. Rocket, Battle and Mines are not touched.
// ============================================================================
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

function createEvent({ CFG, NFT_SET, env = process.env, now = () => Date.now() }) {
  const enabledFlag = String(env.EVENT_ENABLED || 'off').toLowerCase() === 'on';
  const oddsOn = String(env.EVENT_ODDS || 'on').toLowerCase() !== 'off';
  const startMs = env.EVENT_START ? Date.parse(env.EVENT_START) : 0;
  const endMs = Date.parse(env.EVENT_END || '2026-11-16T00:00:00+05:00');
  const baseDailyMs = Math.round((CFG.dailyCooldownHours || 24) * 3600 * 1000);
  const eventDailyMs = Math.round(Math.max(0.01, num(env.EVENT_DAILY_HOURS, 12)) * 3600 * 1000);
  const problems = [];
  if (enabledFlag && !Number.isFinite(endMs)) problems.push('EVENT_END is not a valid date (use e.g. 2026-11-16T00:00:00+05:00)');
  if (enabledFlag && env.EVENT_START && !Number.isFinite(startMs)) problems.push('EVENT_START is not a valid date');

  // the event tables are checked like the normal ones: same ids, total 100 (always, even while the event is off)
  const tables = {};
  for (const [name, w] of Object.entries(CFG.wheels)) {
    if (!w.eventPrizes) continue;
    const sum = w.eventPrizes.reduce((a, r) => a + r.chance, 0);
    if (Math.abs(sum - 100) > 0.001) problems.push(`${name}: eventPrizes total ${sum.toFixed(4)} (must be 100)`);
    const a = w.prizes.map((r) => r.id).sort().join('|'), b = w.eventPrizes.map((r) => r.id).sort().join('|');
    if (a !== b) problems.push(`${name}: eventPrizes ids differ from prizes ids`);
    for (const r of w.eventPrizes) {
      if (!(r.chance > 0)) problems.push(`${name}: eventPrizes ${r.id} chance must be > 0`);
      if (r.type === 'gift' && !(r.value in CFG.coinValues)) problems.push(`${name}: eventPrizes gift "${r.value}" has no coinValues entry`);
    }
    tables[name] = w.eventPrizes;
  }
  const enabled = enabledFlag && problems.length === 0;
  const active = () => enabled && now() >= (startMs || 0) && now() < endMs;
  const live = (name) => (active() && oddsOn && tables[name]) || CFG.wheels[name].prizes;
  const sumOf = (t, f) => t.filter(f).reduce((a, r) => a + r.chance, 0);

  return {
    enabled, enabledFlag, problems, endMs, startMs, active,
    dailyMs: () => (active() ? eventDailyMs : baseDailyMs),
    prizes: (name) => live(name),
    // wheel entries for /api/config: nft/gift chances follow the table that is live right now
    publicWheels(wheels) {
      const out = { ...wheels };
      for (const name of Object.keys(tables)) {
        const t = live(name);
        out[name] = { ...wheels[name], nftChance: sumOf(t, (r) => r.type === 'gift' && NFT_SET.has(r.value)) / 100, giftChance: sumOf(t, (r) => r.type === 'gift') / 100 };
      }
      return out;
    },
    // what the app needs: gold theme, banners, countdown. The app also checks ends_at on its own clock, so it flips at the exact second.
    public() {
      if (!enabled) return { active: false };
      return { active: active(), starts_at: startMs ? new Date(startMs).toISOString() : null, ends_at: new Date(endMs).toISOString(),
        daily_cooldown_ms: eventDailyMs, odds: oddsOn, wheels: oddsOn ? Object.keys(tables) : [] };
    },
    describe() {
      if (!enabledFlag) return '🎄 Event: off';
      if (!enabled) return `⚠️  Event NOT started: ${problems.join('; ')}`;
      return `🎉 Event ${active() ? 'ACTIVE' : (now() < (startMs || 0) ? 'scheduled' : 'finished')}: ends ${new Date(endMs).toISOString()}, daily ${eventDailyMs / 3600000}h, event odds ${oddsOn ? 'on (' + Object.keys(tables).join(',') + ')' : 'off'}`;
    },
  };
}
module.exports = { createEvent };

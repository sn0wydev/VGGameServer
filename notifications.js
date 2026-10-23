// ============================================
// Scheduled bot messages
// ============================================
// Language: the player's choice from the bot (users.lang_pref, set via POST /internal/user-lang), English if never chosen.
//  1. DAILY READY  - sent once, the moment a player's daily-gift cooldown ends.
//  2. COMEBACK     - "didn't forget us?" nudge for players who haven't opened the app for a while
//                    (at most one per NUDGE_EVERY_DAYS, stops after MAX_NUDGES unanswered ones,
//                    only inside the NOTIFY_HOURS_UTC window).
// Messages go out through the Telegram Bot API with this service's BOT_TOKEN (the same bot that owns the mini app),
// so a player must have started the bot. A player who blocked the bot (HTTP 403) is flagged and skipped from then on.
// Players can switch it off under Settings (users.notify_enabled).
//
// Env (all optional):
//   NOTIFICATIONS=off         disable everything
//   WEBAPP_URL                the mini app URL for the "Open" button (e.g. https://t.me/YourBot/app or the https page)
//   NOTIFY_INTERVAL_SECONDS   how often to look for due messages (default 60, min 15)
//   NUDGE_AFTER_DAYS          inactive this long before a comeback nudge (default 3)
//   NUDGE_EVERY_DAYS          minimum gap between nudges (default 7)
//   MAX_NUDGES                unanswered nudges before we stop (default 3)
//   NOTIFY_HOURS_UTC          "5-17" = nudges only between 05:00 and 17:00 UTC (default 5-17). Daily-ready is never delayed.
//   TELEGRAM_API_BASE         for tests (default https://api.telegram.org)
// ============================================

const T = {
  en: {
    open: '🎁 Open VoidGifts',
    daily: ['🎁 <b>Your daily gift is ready!</b>\nThe cooldown is over — open VoidGifts and spin again.'],
    nudge: [
      '👋 <b>Hey {name}, didn\'t forget us?</b>\nBig prizes are waiting in the wheels — log in and try your luck!',
      '🔥 <b>{name}, the wheels miss you!</b>\nYour free daily gift is waiting, and someone has to win the big prizes. Might as well be you.',
      '🎰 <b>Long time no spin!</b>\nCome back for your daily gift — rare NFT gifts are still up for grabs.',
    ],
  },
  ru: {
    open: '🎁 Открыть VoidGifts',
    daily: ['🎁 <b>Ежедневный подарок готов!</b>\nОжидание закончилось — заходите в VoidGifts и крутите снова.'],
    nudge: [
      '👋 <b>{name}, не забыли про нас?</b>\nВ колёсах ждут крупные призы — заходите и испытайте удачу!',
      '🔥 <b>{name}, колёса скучают!</b>\nБесплатный ежедневный подарок ждёт вас, а крупные призы кто-то должен выиграть. Пусть это будете вы.',
      '🎰 <b>Давно не крутили!</b>\nВозвращайтесь за ежедневным подарком — редкие NFT-подарки всё ещё разыгрываются.',
    ],
  },
  es: {
    open: '🎁 Abrir VoidGifts',
    daily: ['🎁 <b>¡Tu regalo diario está listo!</b>\nTerminó la espera: abre VoidGifts y gira de nuevo.'],
    nudge: [
      '👋 <b>{name}, ¿nos habías olvidado?</b>\nHay grandes premios esperando en las ruletas: entra y prueba tu suerte.',
      '🔥 <b>¡{name}, las ruletas te echan de menos!</b>\nTu regalo diario gratis te espera, y alguien tiene que ganar los grandes premios. Que seas tú.',
      '🎰 <b>¡Hace tiempo que no giras!</b>\nVuelve por tu regalo diario: aún hay regalos NFT raros en juego.',
    ],
  },
  fr: {
    open: '🎁 Ouvrir VoidGifts',
    daily: ['🎁 <b>Votre cadeau quotidien est prêt !</b>\nL\'attente est terminée : ouvrez VoidGifts et retentez votre chance.'],
    nudge: [
      '👋 <b>{name}, vous nous avez oubliés ?</b>\nDe gros lots vous attendent dans les roues : connectez-vous et tentez votre chance !',
      '🔥 <b>{name}, les roues vous attendent !</b>\nVotre cadeau quotidien gratuit est là, et quelqu\'un doit remporter les gros lots. Pourquoi pas vous ?',
      '🎰 <b>Ça fait longtemps !</b>\nRevenez chercher votre cadeau quotidien : des cadeaux NFT rares sont encore à gagner.',
    ],
  },
  de: {
    open: '🎁 VoidGifts öffnen',
    daily: ['🎁 <b>Dein täglicher Gewinn ist bereit!</b>\nDie Wartezeit ist vorbei – öffne VoidGifts und dreh wieder.'],
    nudge: [
      '👋 <b>{name}, hast du uns vergessen?</b>\nIn den Rädern warten große Preise – melde dich an und versuch dein Glück!',
      '🔥 <b>{name}, die Räder vermissen dich!</b>\nDein kostenloses Tagesgeschenk wartet, und die großen Preise muss jemand gewinnen. Warum nicht du?',
      '🎰 <b>Lange nicht gedreht!</b>\nHol dir dein Tagesgeschenk – seltene NFT-Geschenke gibt es weiterhin zu gewinnen.',
    ],
  },
  zh: {
    open: '🎁 打开 VoidGifts',
    daily: ['🎁 <b>你的每日礼物已就绪！</b>\n冷却时间结束了——打开 VoidGifts，再转一次吧。'],
    nudge: [
      '👋 <b>{name}，没忘了我们吧？</b>\n转盘里还有大奖在等你——登录试试手气！',
      '🔥 <b>{name}，转盘想你了！</b>\n免费每日礼物在等你，大奖总得有人赢，说不定就是你。',
      '🎰 <b>好久没转了！</b>\n回来领取每日礼物吧——稀有 NFT 礼物仍在等你来抽。',
    ],
  },
};

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Messages use the language the player CHOSE in the bot (/start picker). No choice = English.
const CHOICES = ['en', 'ru'];
const pickLang = (code) => { const l = String(code || '').toLowerCase().slice(0, 2); return CHOICES.includes(l) && T[l] ? l : 'en'; };

// kind: 'daily' | 'nudge'; variant picks one of the nudge texts (any int).
function buildMessage(kind, { lang, name, variant = 0 }) {
  const L = T[pickLang(lang)];
  const list = L[kind];
  const text = list[Math.abs(variant) % list.length].replace(/\{name\}/g, esc(name || '').trim() || (pickLang(lang) === 'ru' ? 'друг' : 'there'));
  return { text, button: L.open };
}

function parseHours(s) {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(s || '5-17');
  if (!m) return [5, 17];
  return [Math.min(23, +m[1]), Math.min(24, +m[2])];
}
function inWindow(hourUtc, [from, to]) { return from <= to ? hourUtc >= from && hourUtc < to : hourUtc >= from || hourUtc < to; }

function createNotifier({ pool, botToken, dailyMs, env = process.env, log = console }) {
  const enabled = (env.NOTIFICATIONS || 'on').toLowerCase() !== 'off';
  const API = (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
  const webapp = env.WEBAPP_URL || '';
  const num = (k, d) => { const v = parseFloat(env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
  const cfg = {
    intervalMs: Math.max(15, num('NOTIFY_INTERVAL_SECONDS', 60)) * 1000,
    nudgeAfterDays: num('NUDGE_AFTER_DAYS', 3), nudgeEveryDays: num('NUDGE_EVERY_DAYS', 7),
    maxNudges: Math.trunc(num('MAX_NUDGES', 3)), hours: parseHours(env.NOTIFY_HOURS_UTC),
  };
  let busy = false, stopped = false;

  async function init() {
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS lang TEXT;            -- Telegram's language (informational)
      ALTER TABLE users ADD COLUMN IF NOT EXISTS lang_pref TEXT;       -- what the player chose in the bot (en/ru); NULL = English
      ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_enabled BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_blocked BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_notified_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS nudge_sent_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS nudges_unanswered INTEGER NOT NULL DEFAULT 0;`);
  }

  // Called (fire and forget) whenever a signed-in player opens the app.
  const seenAt = new Map();
  function touch(user) {
    const now = Date.now();
    if (now - (seenAt.get(user.id) || 0) < 10 * 60 * 1000) return;
    seenAt.set(user.id, now);
    if (seenAt.size > 50000) seenAt.clear();
    pool.query('UPDATE users SET last_seen_at = NOW(), lang = COALESCE($2, lang), nudges_unanswered = 0, bot_blocked = false WHERE user_id = $1', [user.id, user.language_code || null])
      .catch(() => {});
  }

  async function send(chatId, msg) {
    const body = { chat_id: chatId, text: msg.text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (webapp) body.reply_markup = { inline_keyboard: [[{ text: msg.button, web_app: { url: webapp } }]] };
    const r = await fetch(`${API}/bot${botToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    if (r.ok) return { ok: true };
    const j = await r.json().catch(() => ({}));
    return { ok: false, status: r.status, retryAfter: j.parameters && j.parameters.retry_after, desc: j.description };
  }

  // Deliver one message; returns true when it should count as delivered. Marks blocked users.
  async function deliver(u, kind, variant) {
    const res = await send(u.user_id, buildMessage(kind, { lang: u.lang, name: u.first_name, variant }));
    if (res.ok) return true;
    if (res.status === 403 || (res.status === 400 && /chat not found/i.test(res.desc || ''))) {
      await pool.query('UPDATE users SET bot_blocked = true WHERE user_id = $1', [u.user_id]).catch(() => {});
    } else if (res.status === 429) {
      const e = new Error('rate limited'); e.retryAfter = res.retryAfter || 5; throw e;
    } else log.warn(`⚠️ notify ${kind} to ${u.user_id} failed: HTTP ${res.status} ${res.desc || ''}`);
    return false;
  }

  async function tick() {
    if (!enabled || busy || stopped) return { daily: 0, nudge: 0 };
    busy = true;
    const out = { daily: 0, nudge: 0 };
    try {
      // 1. daily cooldown finished. Claiming the row (daily_notified_at) first makes this safe across restarts / instances.
      const due = await pool.query(
        `UPDATE users SET daily_notified_at = NOW() WHERE user_id IN (
           SELECT user_id FROM users
            WHERE notify_enabled AND NOT bot_blocked AND daily_last_at IS NOT NULL
              AND daily_last_at + ($1 || ' milliseconds')::interval <= NOW()
              AND daily_last_at > NOW() - INTERVAL '3 days'
              AND (daily_notified_at IS NULL OR daily_notified_at < daily_last_at)
            ORDER BY daily_last_at LIMIT 100 FOR UPDATE SKIP LOCKED)
         RETURNING user_id, first_name, lang_pref AS lang`, [String(dailyMs)]);
      for (const u of due.rows) {
        if (await deliver(u, 'daily', 0)) out.daily++;
        await new Promise((r) => setTimeout(r, 50));
      }
      // 2. comeback nudge, only inside the allowed hours
      if (inWindow(new Date().getUTCHours(), cfg.hours)) {
        const nud = await pool.query(
          `UPDATE users SET nudge_sent_at = NOW(), nudges_unanswered = nudges_unanswered + 1 WHERE user_id IN (
             SELECT user_id FROM users
              WHERE notify_enabled AND NOT bot_blocked AND nudges_unanswered < $3
                AND COALESCE(last_seen_at, updated_at) < NOW() - ($1 || ' days')::interval
                AND (nudge_sent_at IS NULL OR nudge_sent_at < NOW() - ($2 || ' days')::interval)
              ORDER BY COALESCE(last_seen_at, updated_at) DESC LIMIT 50 FOR UPDATE SKIP LOCKED)
           RETURNING user_id, first_name, lang_pref AS lang, nudges_unanswered`, [String(cfg.nudgeAfterDays), String(cfg.nudgeEveryDays), cfg.maxNudges]);
        for (const u of nud.rows) {
          if (await deliver(u, 'nudge', u.nudges_unanswered - 1)) out.nudge++;
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      if (out.daily || out.nudge) log.log(`🔔 notifications sent: ${out.daily} daily-ready, ${out.nudge} comeback`);
    } catch (e) {
      if (e.retryAfter) log.warn(`⚠️ Telegram rate limit - pausing notifications ${e.retryAfter}s`);
      else log.error('❌ notification run failed:', e.message);
    } finally { busy = false; }
    return out;
  }

  function start() {
    if (!enabled) { log.log('🔕 notifications: off'); return; }
    log.log(`🔔 notifications: ON (every ${cfg.intervalMs / 1000}s, comeback after ${cfg.nudgeAfterDays}d, window ${cfg.hours[0]}-${cfg.hours[1]} UTC, button ${webapp ? 'yes' : 'NO - set WEBAPP_URL'})`);
    const t = setInterval(tick, cfg.intervalMs); t.unref();
    setTimeout(tick, 15000).unref();
  }

  // For the admin panel: send a message of either kind to one player right now (ignores opt-out / windows).
  async function sendTest(userId, kind) {
    const r = await pool.query('SELECT user_id, first_name, lang_pref AS lang FROM users WHERE user_id = $1', [userId]);
    if (!r.rows[0]) return { ok: false, error: 'user not found' };
    const res = await send(userId, buildMessage(kind === 'daily' ? 'daily' : 'nudge', { lang: r.rows[0].lang, name: r.rows[0].first_name, variant: Math.floor(Math.random() * 3) }));
    return res.ok ? { ok: true } : { ok: false, error: `Telegram: HTTP ${res.status} ${res.desc || ''}` };
  }

  return { init, start, tick, touch, sendTest, cfg, enabled, stop() { stopped = true; } };
}

module.exports = { CHOICES, createNotifier, buildMessage, pickLang, parseHours, inWindow, T };

'use strict';
// ============================================================================
//  VoidGifts game config — EDIT THIS FILE (then redeploy) to change prices, odds,
//  prize values and the daily cooldown. Promocodes are NOT here: they live in the
//  database and are managed live from  https://<your-server>/admin/panel
//  (they are only seeded from SEED_PROMOS below the first time the server starts).
//
//  RULES the server checks at startup (it refuses to boot if one is broken):
//   - every wheel's "prizes" chances must add up to EXACTLY 100
//   - every "preview" table must use the same prize ids as "prizes" and also total 100
//   - every gift must have an entry in coinValues (what "Convert to coins" pays)
//   - every NFT gift (nftGifts) must ALSO have an entry in starValues; NFT gifts convert into Stars, all others into coins
//  "prizes"  = the REAL odds, used only on the server.
//  "preview" = display-only odds the app uses to paint the reel (what players see scroll by).
// ============================================================================

module.exports = {
  // Daily gift cooldown in hours.
  dailyCooldownHours: 24,

  // Who may redeem promocodes (stops alt-account / bot farming).
  //  - requirePayment: true  -> an account must have paid at least minTonPaid TON in total (cumulative), OR be allowed by hand.
  //  - tonPerStar: how TON purchases are measured. The deposit packages are ~0.00932 TON per Star (1000 Stars = 9.32 TON).
  //  - Manual switch per player: /admin/panel -> "Who can redeem promocodes" (Allow / Block / Back to automatic).
  //  - A single code can be flagged "Open to everyone" in the panel for a public giveaway (blocked players are still blocked).
  promoAccess: { requirePayment: true, minTonPaid: 2, tonPerStar: 0.00932 },

  // Allowed multipliers on paid wheels (N independent spins, paid N x price).
  multipliers: [1, 10, 100],

  // Coins paid by "Convert to coins" for each gift.
  coinValues: {
      "Heart": 15,
      "Bear": 75,
      "Rose": 100,
      "Gift": 125,
      "Cake": 150,
      "Rose Bouquet": 200,
      "Ring": 300,
      "Trophy": 500,
      "Diamond": 750,
      "Calendar": 1000,
      "Rocket": 400,
      "Star Notepad": 1250,
      "Instant Ramen": 1100,
      "Champagne": 150,
      "Socks": 900,
      "Lollipop": 800,
      "Input Key": 1200,
      "Astral Shard": 2500,
      "Kissed Frog": 3600,
      "Voodoo Doll": 3300,
      "Vintage Cigar": 3400,
      "Witch Hat": 1200,
      "Light Sword": 1150,
      "Lucky Locket": 2200
  },

  // STARS paid by "Convert to Stars" - NFT gifts only. Every gift listed in nftGifts MUST have an entry here.
  // Everyday (non-NFT) gifts keep converting into COINS (coinValues above). These start at the same numbers as the
  // old coin values; change them freely. Expected return check (after the NFT rebalance): void ~67%, furry ~61%, starry ~67%, astral ~58% of the
  // price comes back in Stars on average (direct Stars prizes + NFTs valued at starValues). The house always keeps the rest.
  // Inventory "convert NFT to Stars". Prices follow the relayer's sell-gift board (set env RELAYER_URL on the game server for live market prices);
  // these are the placeholder copies used until then. Everything is rounded down to a tidy number (339 -> 330).
  // An NFT missing here pays starValues x nftConvertRate. Wheels and Rocket still use the full starValues.
  nftConvertRate: 0.5,
  nftConvertPrices: {
    "Star Notepad": 468, "Instant Ramen": 381, "Input Key": 645, "Astral Shard": 11713, "Kissed Frog": 3958,
    "Voodoo Doll": 3770, "Vintage Cigar": 3773, "Witch Hat": 671, "Light Sword": 663, "Lucky Locket": 1935,
  },
  starValues: {
      "Calendar": 1000,
      "Star Notepad": 1250,
      "Instant Ramen": 1100,
      "Socks": 900,
      "Lollipop": 800,
      "Input Key": 1200,
      "Astral Shard": 2500,
      "Kissed Frog": 3600,
      "Voodoo Doll": 3300,
      "Vintage Cigar": 3400,
      "Witch Hat": 1200,
      "Light Sword": 1150,
      "Lucky Locket": 2200
  },

  // Gifts that are NFTs (the app marks them as rare/NFT in results).
  nftGifts: ["Calendar","Star Notepad","Instant Ramen","Socks","Lollipop","Input Key","Astral Shard","Kissed Frog","Voodoo Doll","Vintage Cigar","Witch Hat","Light Sword","Lucky Locket"],

  // Rocket crash game (see rocket.js). Remove this block to use defaults; env ROCKET=off disables it.
  rocket: {
    minBet: 50,
    maxBet: 20000,
    growth: 0.11,          // m(t) = e^(0.11 t)
    edge: 0.90,            // 10% house edge: P(crash >= x) = 0.90 / x  (0.97 was the old 3%)
    maxMultiplier: 500,
    betSeconds: 8,
    crashPauseSeconds: 4,
    maxUpgradeValue: 4000, // NFT stakes only upgrade into NFTs worth up to this many Stars
    nftTiers: null,        // null = all NFTs in nftGifts; or list the ones you actually hold
  },

  // Gift Battle (see battle.js). Remove this block to use defaults; env BATTLE=off disables it.
  battle: {
    betSeconds: 30,        // countdown that starts when the first gift is placed
    spinSeconds: 8,
    resultSeconds: 7,
    maxPlayers: 0,         // 0 = no limit on players per round
    maxItemsPerPlayer: 5,
    minItemValue: 1,
    // House fee, taken in gifts out of the OTHER players' stakes. No fee when the winner held freeAtChance (90%) or more;
    // below that it grows linearly up to maxPct at ~0% chance:  pct = maxPct x (1 - chance / freeAtChance).
    fee: { enabled: true, maxPct: 10, freeAtChance: 0.9 },
    // What everyday (non-NFT) gifts count for INSIDE Gift Battle: their real Telegram Star prices. NFTs use starValues.
    // A gift missing here falls back to its coin value. Wheels, Rocket and converting are not affected.
    basicValues: { Heart: 15, Bear: 15, Rose: 25, Gift: 25, Cake: 50, "Rose Bouquet": 50, Champagne: 50, Rocket: 50, Ring: 100, Trophy: 100, Diamond: 100 },
  },

  wheels: {
    // ── Daily Gift (free, once per cooldown) ──
    daily: {
      price: 0,
      prizes: [
      { id: 'coin1', type: 'coin', value: 1, chance: 76.9192 },
      { id: 'coin5', type: 'coin', value: 5, chance: 6.9638 },
      { id: 'coin10', type: 'coin', value: 10, chance: 4.6459 },
      { id: 'coin25', type: 'coin', value: 25, chance: 3.7024 },
      { id: 'coin50', type: 'coin', value: 50, chance: 2.3076 },
      { id: 'coin100', type: 'coin', value: 100, chance: 1.8563 },
      { id: 'coin250', type: 'coin', value: 250, chance: 0.9435 },
      { id: 'coin500', type: 'coin', value: 500, chance: 0.4513 },
      { id: 'giftHeart', type: 'gift', value: 'Heart', chance: 0.6000 },
      { id: 'giftBear', type: 'gift', value: 'Bear', chance: 0.5000 },
      { id: 'giftRose', type: 'gift', value: 'Rose', chance: 0.3500 },
      { id: 'giftGift', type: 'gift', value: 'Gift', chance: 0.3500 },
      { id: 'giftCake', type: 'gift', value: 'Cake', chance: 0.1500 },
      { id: 'giftRoseBouquet', type: 'gift', value: 'Rose Bouquet', chance: 0.1500 },
      { id: 'giftRing', type: 'gift', value: 'Ring', chance: 0.0500 },
      { id: 'giftTrophy', type: 'gift', value: 'Trophy', chance: 0.0200 },
      { id: 'giftDiamond', type: 'gift', value: 'Diamond', chance: 0.0200 },
      { id: 'giftCalendar', type: 'gift', value: 'Calendar', chance: 0.0200 }
      ],
      preview: [
      { id: 'coin1', type: 'coin', value: 1, chance: 31.9339 },
      { id: 'coin5', type: 'coin', value: 5, chance: 10.8346 },
      { id: 'coin10', type: 'coin', value: 10, chance: 9.0305 },
      { id: 'coin25', type: 'coin', value: 25, chance: 8.1536 },
      { id: 'coin50', type: 'coin', value: 50, chance: 6.5911 },
      { id: 'coin100', type: 'coin', value: 100, chance: 5.9762 },
      { id: 'coin250', type: 'coin', value: 250, chance: 4.4072 },
      { id: 'coin500', type: 'coin', value: 500, chance: 3.1626 },
      { id: 'giftHeart', type: 'gift', value: 'Heart', chance: 3.5950 },
      { id: 'giftBear', type: 'gift', value: 'Bear', chance: 3.3118 },
      { id: 'giftRose', type: 'gift', value: 'Rose', chance: 2.8207 },
      { id: 'giftGift', type: 'gift', value: 'Gift', chance: 2.8207 },
      { id: 'giftCake', type: 'gift', value: 'Cake', chance: 1.9265 },
      { id: 'giftRoseBouquet', type: 'gift', value: 'Rose Bouquet', chance: 1.9265 },
      { id: 'giftRing', type: 'gift', value: 'Ring', chance: 1.1751 },
      { id: 'giftTrophy', type: 'gift', value: 'Trophy', chance: 0.7780 },
      { id: 'giftDiamond', type: 'gift', value: 'Diamond', chance: 0.7780 },
      { id: 'giftCalendar', type: 'gift', value: 'Calendar', chance: 0.7780 }
      ],
    },
    // ── Void Spin ──
    void: {
      price: 50,
      prizes: [
      { id: 'voidStars5', type: 'stars', value: 5, chance: 38.1391 },
      { id: 'voidStars10', type: 'stars', value: 10, chance: 22.8702 },
      { id: 'voidStars25', type: 'stars', value: 25, chance: 11.6324 },
      { id: 'voidStars50', type: 'stars', value: 50, chance: 6.9754 },
      { id: 'voidStars100', type: 'stars', value: 100, chance: 4.1828 },
      { id: 'voidGiftHeart', type: 'gift', value: 'Heart', chance: 8.0000 },
      { id: 'voidGiftBear', type: 'gift', value: 'Bear', chance: 3.0000 },
      { id: 'voidGiftCake', type: 'gift', value: 'Cake', chance: 1.5000 },
      { id: 'voidGiftRocket', type: 'gift', value: 'Rocket', chance: 1.5000 },
      { id: 'voidGiftLollipop', type: 'gift', value: 'Lollipop', chance: 1.2088 },
      { id: 'voidGiftSocks', type: 'gift', value: 'Socks', chance: 0.8462 },
      { id: 'voidGiftInstantRamen', type: 'gift', value: 'Instant Ramen', chance: 0.1451 }
      ],
      preview: [
      { id: 'voidStars5', type: 'stars', value: 5, chance: 20.8200 },
      { id: 'voidStars10', type: 'stars', value: 10, chance: 16.5402 },
      { id: 'voidStars25', type: 'stars', value: 25, chance: 12.2017 },
      { id: 'voidStars50', type: 'stars', value: 50, chance: 9.6934 },
      { id: 'voidStars100', type: 'stars', value: 100, chance: 7.7007 },
      { id: 'voidGiftHeart', type: 'gift', value: 'Heart', chance: 10.2394 },
      { id: 'voidGiftBear', type: 'gift', value: 'Bear', chance: 6.5855 },
      { id: 'voidGiftCake', type: 'gift', value: 'Cake', chance: 4.8208 },
      { id: 'voidGiftRocket', type: 'gift', value: 'Rocket', chance: 4.8208 },
      { id: 'voidGiftLollipop', type: 'gift', value: 'Lollipop', chance: 2.9405 },
      { id: 'voidGiftSocks', type: 'gift', value: 'Socks', chance: 2.5045 },
      { id: 'voidGiftInstantRamen', type: 'gift', value: 'Instant Ramen', chance: 1.1325 }
      ],
    },
    // ── Furry Spin ──
    furry: {
      price: 150,
      prizes: [
      { id: 'furryStars10', type: 'stars', value: 10, chance: 27.8649 },
      { id: 'furryStars25', type: 'stars', value: 25, chance: 16.9943 },
      { id: 'furryStars50', type: 'stars', value: 50, chance: 11.6909 },
      { id: 'furryStars100', type: 'stars', value: 100, chance: 8.0426 },
      { id: 'furryStars150', type: 'stars', value: 150, chance: 6.4619 },
      { id: 'furryStars300', type: 'stars', value: 300, chance: 4.4454 },
      { id: 'furryGiftRose', type: 'gift', value: 'Rose', chance: 6.0000 },
      { id: 'furryGiftCake', type: 'gift', value: 'Cake', chance: 5.0000 },
      { id: 'furryGiftChampagne', type: 'gift', value: 'Champagne', chance: 4.0000 },
      { id: 'furryGiftTrophy', type: 'gift', value: 'Trophy', chance: 2.5000 },
      { id: 'furryGiftDiamond', type: 'gift', value: 'Diamond', chance: 2.5000 },
      { id: 'furryGiftSocks', type: 'gift', value: 'Socks', chance: 1.5000 },
      { id: 'furryGiftStarNotepad', type: 'gift', value: 'Star Notepad', chance: 1.3333 },
      { id: 'furryGiftCalendar', type: 'gift', value: 'Calendar', chance: 1.1667 },
      { id: 'furryGiftInstantRamen', type: 'gift', value: 'Instant Ramen', chance: 0.5000 }
      ],
      preview: [
      { id: 'furryStars10', type: 'stars', value: 10, chance: 14.7767 },
      { id: 'furryStars25', type: 'stars', value: 25, chance: 11.8286 },
      { id: 'furryStars50', type: 'stars', value: 50, chance: 9.9961 },
      { id: 'furryStars100', type: 'stars', value: 100, chance: 8.4474 },
      { id: 'furryStars150', type: 'stars', value: 150, chance: 7.6553 },
      { id: 'furryStars300', type: 'stars', value: 300, chance: 6.4693 },
      { id: 'furryGiftRose', type: 'gift', value: 'Rose', chance: 7.3259 },
      { id: 'furryGiftCake', type: 'gift', value: 'Cake', chance: 6.7488 },
      { id: 'furryGiftChampagne', type: 'gift', value: 'Champagne', chance: 6.1041 },
      { id: 'furryGiftTrophy', type: 'gift', value: 'Trophy', chance: 4.9404 },
      { id: 'furryGiftDiamond', type: 'gift', value: 'Diamond', chance: 4.9404 },
      { id: 'furryGiftSocks', type: 'gift', value: 'Socks', chance: 3.1196 },
      { id: 'furryGiftStarNotepad', type: 'gift', value: 'Star Notepad', chance: 2.9586 },
      { id: 'furryGiftCalendar', type: 'gift', value: 'Calendar', chance: 2.7860 },
      { id: 'furryGiftInstantRamen', type: 'gift', value: 'Instant Ramen', chance: 1.9028 }
      ],
    },
    // ── Starry Spin ──
    hex: {
      price: 500,
      prizes: [
      { id: 'hexStars25', type: 'stars', value: 25, chance: 21.9005 },
      { id: 'hexStars50', type: 'stars', value: 50, chance: 16.8040 },
      { id: 'hexStars100', type: 'stars', value: 100, chance: 12.8934 },
      { id: 'hexStars250', type: 'stars', value: 250, chance: 9.0841 },
      { id: 'hexStars500', type: 'stars', value: 500, chance: 6.9700 },
      { id: 'hexStars1000', type: 'stars', value: 1000, chance: 5.3480 },
      { id: 'hexGiftChampagne', type: 'gift', value: 'Champagne', chance: 4.0000 },
      { id: 'hexGiftTrophy', type: 'gift', value: 'Trophy', chance: 4.0000 },
      { id: 'hexGiftDiamond', type: 'gift', value: 'Diamond', chance: 4.0000 },
      { id: 'hexGiftRing', type: 'gift', value: 'Ring', chance: 3.0000 },
      { id: 'hexGiftLightSword', type: 'gift', value: 'Light Sword', chance: 4.8364 },
      { id: 'hexGiftWitchHat', type: 'gift', value: 'Witch Hat', chance: 4.7454 },
      { id: 'hexGiftVoodooDoll', type: 'gift', value: 'Voodoo Doll', chance: 0.8421 },
      { id: 'hexGiftVintageCigar', type: 'gift', value: 'Vintage Cigar', chance: 0.8162 },
      { id: 'hexGiftKissedFrog', type: 'gift', value: 'Kissed Frog', chance: 0.7599 }
      ],
      preview: [
      { id: 'hexStars25', type: 'stars', value: 25, chance: 13.5851 },
      { id: 'hexStars50', type: 'stars', value: 50, chance: 12.0584 },
      { id: 'hexStars100', type: 'stars', value: 100, chance: 10.7034 },
      { id: 'hexStars250', type: 'stars', value: 250, chance: 9.1429 },
      { id: 'hexStars500', type: 'stars', value: 500, chance: 8.1154 },
      { id: 'hexStars1000', type: 'stars', value: 1000, chance: 7.2035 },
      { id: 'hexGiftChampagne', type: 'gift', value: 'Champagne', chance: 6.0844 },
      { id: 'hexGiftTrophy', type: 'gift', value: 'Trophy', chance: 6.0844 },
      { id: 'hexGiftDiamond', type: 'gift', value: 'Diamond', chance: 6.0844 },
      { id: 'hexGiftRing', type: 'gift', value: 'Ring', chance: 5.3456 },
      { id: 'hexGiftLightSword', type: 'gift', value: 'Light Sword', chance: 4.6814 },
      { id: 'hexGiftWitchHat', type: 'gift', value: 'Witch Hat', chance: 4.6416 },
      { id: 'hexGiftVoodooDoll', type: 'gift', value: 'Voodoo Doll', chance: 2.1319 },
      { id: 'hexGiftVintageCigar', type: 'gift', value: 'Vintage Cigar', chance: 2.1021 },
      { id: 'hexGiftKissedFrog', type: 'gift', value: 'Kissed Frog', chance: 2.0355 }
      ],
    },
    // ── Astral Spin ──
    astral: {
      price: 1000,
      prizes: [
      { id: 'astralStars50', type: 'stars', value: 50, chance: 22.8345 },
      { id: 'astralStars100', type: 'stars', value: 100, chance: 16.9158 },
      { id: 'astralStars250', type: 'stars', value: 250, chance: 11.3776 },
      { id: 'astralStars500', type: 'stars', value: 500, chance: 8.4287 },
      { id: 'astralStars1000', type: 'stars', value: 1000, chance: 6.2439 },
      { id: 'astralStars2500', type: 'stars', value: 2500, chance: 4.1996 },
      { id: 'astralGiftDiamond', type: 'gift', value: 'Diamond', chance: 5.0000 },
      { id: 'astralGiftTrophy', type: 'gift', value: 'Trophy', chance: 4.0000 },
      { id: 'astralGiftRing', type: 'gift', value: 'Ring', chance: 4.0000 },
      { id: 'astralGiftInputKey', type: 'gift', value: 'Input Key', chance: 9.1242 },
      { id: 'astralGiftLuckyLocket', type: 'gift', value: 'Lucky Locket', chance: 4.4704 },
      { id: 'astralGiftVoodooDoll', type: 'gift', value: 'Voodoo Doll', chance: 2.4946 },
      { id: 'astralGiftAstralShard', type: 'gift', value: 'Astral Shard', chance: 0.9107 }
      ],
      preview: [
      { id: 'astralStars50', type: 'stars', value: 50, chance: 14.7034 },
      { id: 'astralStars100', type: 'stars', value: 100, chance: 12.8465 },
      { id: 'astralStars250', type: 'stars', value: 250, chance: 10.7467 },
      { id: 'astralStars500', type: 'stars', value: 500, chance: 9.3895 },
      { id: 'astralStars1000', type: 'stars', value: 1000, chance: 8.2037 },
      { id: 'astralStars2500', type: 'stars', value: 2500, chance: 6.8628 },
      { id: 'astralGiftDiamond', type: 'gift', value: 'Diamond', chance: 7.0362 },
      { id: 'astralGiftTrophy', type: 'gift', value: 'Trophy', chance: 6.3640 },
      { id: 'astralGiftRing', type: 'gift', value: 'Ring', chance: 6.3640 },
      { id: 'astralGiftInputKey', type: 'gift', value: 'Input Key', chance: 6.6279 },
      { id: 'astralGiftLuckyLocket', type: 'gift', value: 'Lucky Locket', chance: 4.8078 },
      { id: 'astralGiftVoodooDoll', type: 'gift', value: 'Voodoo Doll', chance: 3.6978 },
      { id: 'astralGiftAstralShard', type: 'gift', value: 'Astral Shard', chance: 2.3497 }
      ],
    },
  },

  // Promocodes seeded on first boot only (after that, manage them in /admin/panel).
  // rewards: coins / stars / gifts (array of gift names, each given once).
  SEED_PROMOS: [
    { code: 'WELCOME100', active: true, rewards: { coins: 100 }, message_key: 'promoWelcome' },
    { code: 'LUCKY777',   active: true, rewards: { coins: 777 }, message_key: 'promoLucky' },
    { code: 'FREECOINS',  active: true, rewards: { coins: 50 },  message_key: 'promoFree' },
    { code: 'VOIDGIFT',   active: true, rewards: { coins: 200 }, message_key: 'promoVoidGift' },
    { code: 'SPIN2WIN',   active: true, rewards: { coins: 150 }, message_key: 'promoSpin2Win' },
  ],
};

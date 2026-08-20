/* Gameplay balance in one place — change these without touching game logic. */

const TUNING = {
  level:   { minLength: 80, maxLength: 260, defaultLength: 140, blockSize: 22, streetHalf: 4.2, mapWidth: 50 },
  scoring: {
    parBase: 17, parPerMetre: 0.25,
    timeWeight: 500, timeCap: 650,
    scareWeight: 500,
    grumblePenalty: 40,
    wantedBonus: 100,
    boneBonus: 150,
    medals: { gold: 1050, silver: 820, bronze: 600 },
  },
  pace: {   /* how much of your scare radius applies at each pace */
    sneak: 0.32, still: 0.5, walk: 0.72, run: 1.0, barkMultiplier: 1.55,
  },
  penalties: { carBump: 3, splash: 2 },
};

export { TUNING };

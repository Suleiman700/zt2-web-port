// Game clock. In Zoo Tycoon 2 one day/night cycle is one month: scenario scripts measure a
// month with getCurrentMonth() plus getCurrentTimeOfDay() as the progress within it, animal AI
// uses timeOfDay in hours (e.g. sleep when >= 20 or <= 4), and guest ratings are kept per day of
// the month (ZTAIGuestMgr M1..M31). config/timekeeper.xml runs game time at timeScale 3600 (one
// game hour per real second), so a day lasts 24 s and a month of 30 days about 12 minutes.
// The world lights, sky, fog and sun use t = progress through the cycle (0..1, 0 = midnight).
// The month length is inferred, not read from the game, and waits for comparison with the original.

export const DAY_SECONDS = 24;
export const DAYS_PER_MONTH = 30;
export const MONTH_SECONDS = DAY_SECONDS * DAYS_PER_MONTH;
const START_T = 0.25; // new zoos start in the morning

export class GameClock {
  constructor(saved = null) {
    this.month = saved?.month ?? 0; // months since the zoo opened (0 = first month)
    this.t = saved?.t ?? START_T;    // progress through the current month / day-night cycle
    this.paused = saved?.paused ?? false;
  }

  // Advances by dt real seconds; returns the number of months that ended.
  update(dt) {
    if (this.paused) return 0;
    this.t += dt / MONTH_SECONDS;
    let ended = 0;
    while (this.t >= 1) { this.t -= 1; this.month++; ended++; }
    return ended;
  }

  get hour() { return this.t * 24; }           // timeOfDay as the AI rules use it
  get year() { return Math.floor(this.month / 12) + 1; }
  get monthOfYear() { return (this.month % 12) + 1; }
  get dayOfMonth() { return Math.floor(this.t * DAYS_PER_MONTH) + 1; }

  toJSON() { return { month: this.month, t: this.t, paused: this.paused }; }
}

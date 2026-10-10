// Zoo finances: money moves through categories like the original's ZTTransaction categories
// (config/economy_*.xml and each object's ZTEconomyComponent), recorded per month for the
// finances panel. Debits are stored as negative amounts.

// Labels from the original Zoo Status panel (lang/1033/ui.xml, zoostatus:econ_category_*).
export const CATEGORY_NAMES = {
  admissions_income: 'Admissions Income',
  concessions_food_drink: 'Food/Drink Sales',
  concessions_gifts: 'Shop Sales',
  donations_income: 'Donations',
  cash_grants: 'Cash Grants',
  recycling: 'Recycling',
  construction: 'Construction',
  animal: 'Animal Adoption',
  animal_upkeep: 'Animal Upkeep',
  staff_salaries: 'Staff Salaries',
  upkeep: 'Upkeep',
  research: 'Research',
};

const HISTORY_MONTHS = 24;

export class Ledger {
  constructor(saved = null) {
    this.current = { ...(saved?.current ?? {}) }; // category -> amount this month
    this.history = [...(saved?.history ?? [])];   // [{ month, totals }] most recent last
  }

  record(category, amount) {
    if (!amount) return;
    this.current[category] = Math.round(((this.current[category] ?? 0) + amount) * 100) / 100;
  }

  // Ends `month`: its totals go to the history and a new month starts.
  closeMonth(month) {
    this.history.push({ month, totals: this.current });
    if (this.history.length > HISTORY_MONTHS) this.history.shift();
    this.current = {};
  }

  static net(totals) { return Object.values(totals).reduce((s, v) => s + v, 0); }

  toJSON() { return { current: this.current, history: this.history }; }
}

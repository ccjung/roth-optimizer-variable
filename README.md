# Roth Optimizer — Smart Variable Conversion Strategy

A React 18 + Vite application that adds a **Smart Variable Conversion Strategy** on top of a full Roth conversion simulation engine. Unlike a static annual conversion amount, this strategy **dynamically calculates the optimal conversion each year** based on the user's age and Medicare IRMAA 2-year lookback windows.

## Features

### 🧠 Smart Variable Conversion Strategy (New)
- **Phase 1 — Golden Window (ages < 63):** Conversions are calculated to completely fill the user-selected federal tax bracket ceiling.  
  `Conversion = Target Bracket Ceiling − Base Household Income`  
  Medicare's 2-year lookback means any income earned before age 63 cannot affect Medicare Part B/D premiums at age 65 — so you can convert aggressively with zero IRMAA risk.

- **Phase 2 — IRMAA Cap (ages 63+):** Conversions are throttled to stop exactly at the selected IRMAA tier ceiling to prevent cliff penalties.  
  `Conversion = Target IRMAA Tier Ceiling − Base Household Income`

- **Automatic termination** when the Traditional IRA balance reaches zero.

- **2026 federal tax brackets** and **2026 projected IRMAA thresholds** as the baseline, with optional annual inflation scaling of both.

### 📊 Manual Simulator
- Year-by-year simulation with a fixed annual conversion amount.
- Federal tax, IRMAA surcharges, and RMD projections.

### 📈 Visualizations (Recharts)
- Variable drain rate bar chart with Phase 1 / Phase 2 color coding.
- MAGI vs. ceiling reference lines.
- Lifetime account balance trajectories (Trad IRA drain + Roth accumulation).
- Annual federal tax + IRMAA cost stacked bars.
- Full year-by-year data tables with CSV export.

---

## Quick Start

```bash
npm install
npm run dev        # Starts Vite dev server at http://localhost:5173
npm run build      # Production build to dist/
npm test           # Run engine unit tests
```

## Key Files

| File | Purpose |
|------|---------|
| `src/engine.js` | Pure JS calculation engine. Contains `calculateOptimalVariableConversions()`, `runSmartVariableSimulation()`, `runSimulation()`, and all tax/IRMAA helpers. |
| `src/App.jsx` | React 18 frontend. `SmartStrategyPanel` component + `ManualPanel`. |
| `test/engine.test.mjs` | Node.js unit tests for the engine (no test framework needed). |

---

## Engine API

### `calculateOptimalVariableConversions(params)`

The core smart strategy function. Returns an array of annual conversion entries.

```js
import { calculateOptimalVariableConversions } from "./src/engine.js";

const schedule = calculateOptimalVariableConversions({
  currentAge:           58,
  baseIncome:           30000,       // non-conversion MAGI
  startingIraBalance:   500000,
  targetBracketCeiling: 432800,      // 2026 MFJ 24% bracket MAGI ceiling
  targetIrmaaCeiling:   326000,      // 2026 MFJ IRMAA Tier 2 ceiling
  filingStatus:         "mfj",
  growthRate:           0.07,
  inflationRate:        0.025,       // optional: inflation-scale thresholds
});

// schedule[i] = {
//   age, yearIndex, phase, conversionAmount,
//   ceiling, iraBalanceBefore, iraBalanceAfter, magi
// }
```

**Phase logic:**
- `age < 63` → `phase: "golden_window"` → ceiling = `targetBracketCeiling`
- `age >= 63` → `phase: "irmaa_cap"` → ceiling = `targetIrmaaCeiling`

### `runSmartVariableSimulation(params)`

Full lifetime simulation (age → endAge) using the smart variable schedule.

```js
import { runSmartVariableSimulation } from "./src/engine.js";

const { conversionSchedule, years, summary } = runSmartVariableSimulation({
  currentAge:           58,
  startingIraBalance:   500000,
  taxableBrokerageBalance: 100000,
  baseIncome:           30000,
  targetBracketCeiling: 432800,
  targetIrmaaCeiling:   326000,
  filingStatus:         "mfj",
  growthRate:           0.07,
  inflationRate:        0.025,
  endAge:               90,
});
```

### Ceiling helper functions

```js
import { bracketCeiling, irmaaTierCeiling } from "./src/engine.js";

// MFJ 24% bracket → taxable income ceiling + standard deduction
const b = bracketCeiling("mfj", 0.24);   // 402100 + 30700 = 432800

// MFJ IRMAA Tier 2 ceiling
const i = irmaaTierCeiling("mfj", 2);    // 326000
```

---

## 2026 Baseline Values Used

### Federal Tax Brackets (MFJ, projected 2026)

| Rate | Taxable Income Range | MAGI Ceiling (incl. std. ded.) |
|------|---------------------|-------------------------------|
| 10%  | $0 – $24,400        | $55,100 |
| 12%  | $24,400 – $98,900   | $129,600 |
| 22%  | $98,900 – $210,900  | $241,600 |
| **24%** | **$210,900 – $402,100** | **$432,800** |
| 32%  | $402,100 – $510,800 | $541,500 |
| 35%  | $510,800 – $767,600 | $798,300 |

Standard deduction MFJ: **$30,700** · Single: **$15,350**

### IRMAA Tiers (MFJ, 2026 projected)

| Tier | MAGI Threshold | Part B Monthly |
|------|----------------|---------------|
| 0 (No IRMAA) | ≤ $218,000 | $185.00 |
| 1 | ≤ $272,000 | $259.00 |
| **2** | **≤ $326,000** | **$370.00** |
| 3 | ≤ $392,000 | $480.90 |
| 4 | ≤ $750,000 | $591.90 |
| 5 | Unlimited | $628.90 |

---

## Business Rules Summary

1. **IRMAA lookback:** Medicare uses MAGI from 2 years prior. Income at age 63 determines age-65 Medicare premiums.
2. **Golden Window termination:** Age 63 is the cutover point. Ages < 63 use Phase 1 (bracket fill). Ages ≥ 63 use Phase 2 (IRMAA cap).
3. **Cliff prevention:** Phase 2 stops conversions at exactly the IRMAA tier ceiling — going $1 over triggers the full surcharge for the tier above.
4. **Termination:** The schedule loop stops as soon as the IRA balance reaches zero.
5. **RMDs:** Not included in the conversion schedule itself (the engine models RMDs in the lifetime simulation separately via the IRS Uniform Lifetime Table).

---

## Source

Extends [ccjung/roth-conversion](https://github.com/ccjung/roth-conversion) with the new Smart Variable Conversion Strategy feature.

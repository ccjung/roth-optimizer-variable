/**
 * test/engine.test.mjs
 * Quick smoke-tests for calculateOptimalVariableConversions and
 * runSmartVariableSimulation.
 *
 * Run:  node test/engine.test.mjs
 */

import {
  calculateOptimalVariableConversions,
  runSmartVariableSimulation,
  bracketCeiling,
  irmaaTierCeiling,
  TAX_BRACKETS_2026,
  IRMAA_TIERS_2026,
  STANDARD_DEDUCTION_2026,
} from "../src/engine.js";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

// ─── 1. bracketCeiling / irmaaTierCeiling helpers ────────────────────────────
console.log("\n── Ceiling helpers ──");
const mfj24Ceiling    = bracketCeiling("mfj", 0.24);
const mfjIrmaa2Ceiling = irmaaTierCeiling("mfj", 2);
assert(mfj24Ceiling    === TAX_BRACKETS_2026.mfj.find(b => b.rate === 0.24).max + STANDARD_DEDUCTION_2026.mfj,
       `MFJ 24% bracket ceiling = ${mfj24Ceiling}`);
assert(mfjIrmaa2Ceiling === IRMAA_TIERS_2026.mfj.find(t => t.tier === 2).maxMAGI,
       `MFJ IRMAA Tier 2 ceiling = ${mfjIrmaa2Ceiling}`);

// ─── 2. calculateOptimalVariableConversions — basic structure ─────────────────
console.log("\n── calculateOptimalVariableConversions (MFJ, age 58) ──");
const schedule = calculateOptimalVariableConversions({
  currentAge:           58,
  baseIncome:           30000,
  startingIraBalance:   500000,
  targetBracketCeiling: mfj24Ceiling,    // Phase 1 ceiling
  targetIrmaaCeiling:   mfjIrmaa2Ceiling, // Phase 2 ceiling
  filingStatus:         "mfj",
  growthRate:           0.07,
  inflationRate:        0,
});
assert(schedule.length > 0, `Generated ${schedule.length} conversion years`);
assert(schedule.every(r => r.conversionAmount >= 0), "All conversions non-negative");
assert(schedule.every(r => r.iraBalanceAfter >= 0), "IRA never goes negative");

// Phase 1 rows should be age <63
const phase1 = schedule.filter(r => r.phase === "golden_window");
const phase2 = schedule.filter(r => r.phase === "irmaa_cap");
assert(phase1.every(r => r.age < 63), "Phase 1 rows all have age <63");
assert(phase2.every(r => r.age >= 63), "Phase 2 rows all have age >=63");

// Each phase-1 row: magi should be ≤ targetBracketCeiling
assert(phase1.every(r => r.magi <= mfj24Ceiling + 1), "Phase 1 MAGI never exceeds bracket ceiling");

// Each phase-2 row: magi should be ≤ targetIrmaaCeiling
assert(phase2.every(r => r.magi <= mfjIrmaa2Ceiling + 1), "Phase 2 MAGI never exceeds IRMAA ceiling");

// IRA should reach zero by the end
const lastRow = schedule[schedule.length - 1];
assert(lastRow.iraBalanceAfter < 1000, `IRA drained to near-zero: ${Math.round(lastRow.iraBalanceAfter)}`);

// ─── 3. Phase 1 conversion amount formula ────────────────────────────────────
console.log("\n── Phase 1 formula check ──");
const firstRow = schedule[0];
const expectedConv = Math.min(mfj24Ceiling - 30000, 500000);
assert(
  Math.abs(firstRow.conversionAmount - expectedConv) < 1,
  `Year-1 conversion = ${firstRow.conversionAmount} (expected ~${expectedConv})`
);

// ─── 4. Age 65+ user starts in Phase 2 immediately ───────────────────────────
console.log("\n── Starts at age 65 — all rows should be IRMAA_CAP ──");
const sched65 = calculateOptimalVariableConversions({
  currentAge:           65,
  baseIncome:           40000,
  startingIraBalance:   300000,
  targetBracketCeiling: mfj24Ceiling,
  targetIrmaaCeiling:   mfjIrmaa2Ceiling,
  filingStatus:         "mfj",
  growthRate:           0.07,
  inflationRate:        0,
});
assert(sched65.every(r => r.phase === "irmaa_cap"), "All rows are irmaa_cap when starting at age 65");

// ─── 5. runSmartVariableSimulation returns valid structure ────────────────────
console.log("\n── runSmartVariableSimulation ──");
const simResult = runSmartVariableSimulation({
  currentAge:           58,
  startingIraBalance:   500000,
  taxableBrokerageBalance: 100000,
  baseIncome:           30000,
  targetBracketCeiling: mfj24Ceiling,
  targetIrmaaCeiling:   mfjIrmaa2Ceiling,
  filingStatus:         "mfj",
  growthRate:           0.07,
  inflationRate:        0,
  endAge:               90,
});
assert(simResult.years.length > 0, `Simulation produced ${simResult.years.length} lifetime years`);
assert(simResult.summary.totalAmountConverted > 0, `Total converted: ${simResult.summary.totalAmountConverted}`);
assert(simResult.summary.totalFederalTax > 0, `Lifetime tax > 0: ${simResult.summary.totalFederalTax}`);
assert(simResult.summary.estateValueAtEndAge > 0, `Estate at 90 > 0: ${simResult.summary.estateValueAtEndAge}`);
assert(simResult.summary.finalRothIRA > 0, `Final Roth IRA > 0: ${simResult.summary.finalRothIRA}`);
assert(simResult.conversionSchedule.length > 0, `conversionSchedule has ${simResult.conversionSchedule.length} entries`);

// ─── 6. Zero base income edge case ───────────────────────────────────────────
console.log("\n── Edge case: zero base income ──");
const schedZero = calculateOptimalVariableConversions({
  currentAge:           60,
  baseIncome:           0,
  startingIraBalance:   200000,
  targetBracketCeiling: mfj24Ceiling,
  targetIrmaaCeiling:   mfjIrmaa2Ceiling,
  filingStatus:         "mfj",
  growthRate:           0.07,
  inflationRate:        0,
});
assert(schedZero.length > 0, "Works with zero base income");
assert(schedZero[0].conversionAmount <= mfj24Ceiling, "First conversion ≤ bracket ceiling when base=0");

// ─── 7. IRA larger than ceiling — still drains safely ─────────────────────────
console.log("\n── Large IRA ($2M) drains fully ──");
const schedLarge = calculateOptimalVariableConversions({
  currentAge:           55,
  baseIncome:           50000,
  startingIraBalance:   2000000,
  targetBracketCeiling: mfj24Ceiling,
  targetIrmaaCeiling:   mfjIrmaa2Ceiling,
  filingStatus:         "mfj",
  growthRate:           0.05,
  inflationRate:        0,
  maxYears:             50,
});
const lastLarge = schedLarge[schedLarge.length - 1];
assert(lastLarge.iraBalanceAfter < 1000, `2M IRA drained to ${Math.round(lastLarge.iraBalanceAfter)} over ${schedLarge.length} years`);

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
if (failed > 0) process.exit(1);

/**
 * engine.js
 * Roth Optimizer – Smart Variable Conversion Strategy
 *
 * Includes the full simulation engine from the original roth-conversion repo
 * PLUS the new calculateOptimalVariableConversions() function that implements
 * the "Smart Variable Conversion Strategy" with Phase 1 / Phase 2 logic.
 *
 * 2026 Federal Tax Brackets (26 USC §1, projected via IRS Rev. Proc. methodology)
 * 2026 Medicare IRMAA Thresholds (CMS projected schedule)
 */

// ---------------------------------------------------------------------------
// 2026 Federal Income Tax Brackets (projected — TCJ sunset + CPI adjustment)
// ---------------------------------------------------------------------------
export const TAX_BRACKETS_2026 = {
  single: [
    { rate: 0.10, min: 0,       max: 12200  },
    { rate: 0.12, min: 12200,   max: 49450  },
    { rate: 0.22, min: 49450,   max: 105450 },
    { rate: 0.24, min: 105450,  max: 201050 },
    { rate: 0.32, min: 201050,  max: 255400 },
    { rate: 0.35, min: 255400,  max: 639310 },
    { rate: 0.37, min: 639310,  max: Infinity },
  ],
  mfj: [
    { rate: 0.10, min: 0,       max: 24400  },
    { rate: 0.12, min: 24400,   max: 98900  },
    { rate: 0.22, min: 98900,   max: 210900 },
    { rate: 0.24, min: 210900,  max: 402100 },
    { rate: 0.32, min: 402100,  max: 510800 },
    { rate: 0.35, min: 510800,  max: 767600 },
    { rate: 0.37, min: 767600,  max: Infinity },
  ],
};

// 2026 Standard Deductions
export const STANDARD_DEDUCTION_2026 = { single: 15350, mfj: 30700 };

// ---------------------------------------------------------------------------
// 2026 Medicare IRMAA Tiers (CMS projected)
// Base Part B monthly premium: $185.00 (projected 2026)
// ---------------------------------------------------------------------------
export const IRMAA_TIERS_2026 = {
  single: [
    { maxMAGI: 109000,   tier: 0, label: "No IRMAA",  partBMonthly: 185.00, partDMonthly: 0.00  },
    { maxMAGI: 136000,   tier: 1, label: "Tier 1",    partBMonthly: 259.00, partDMonthly: 13.70 },
    { maxMAGI: 163000,   tier: 2, label: "Tier 2",    partBMonthly: 370.00, partDMonthly: 35.30 },
    { maxMAGI: 196000,   tier: 3, label: "Tier 3",    partBMonthly: 480.90, partDMonthly: 57.00 },
    { maxMAGI: 500000,   tier: 4, label: "Tier 4",    partBMonthly: 591.90, partDMonthly: 78.60 },
    { maxMAGI: Infinity, tier: 5, label: "Tier 5",    partBMonthly: 628.90, partDMonthly: 85.80 },
  ],
  mfj: [
    { maxMAGI: 218000,   tier: 0, label: "No IRMAA",  partBMonthly: 185.00, partDMonthly: 0.00  },
    { maxMAGI: 272000,   tier: 1, label: "Tier 1",    partBMonthly: 259.00, partDMonthly: 13.70 },
    { maxMAGI: 326000,   tier: 2, label: "Tier 2",    partBMonthly: 370.00, partDMonthly: 35.30 },
    { maxMAGI: 392000,   tier: 3, label: "Tier 3",    partBMonthly: 480.90, partDMonthly: 57.00 },
    { maxMAGI: 750000,   tier: 4, label: "Tier 4",    partBMonthly: 591.90, partDMonthly: 78.60 },
    { maxMAGI: Infinity, tier: 5, label: "Tier 5",    partBMonthly: 628.90, partDMonthly: 85.80 },
  ],
};

// IRS Uniform Lifetime Table for RMD divisors (ages 72–90+)
const ULT = {
  72: 27.4, 73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9,
  78: 22.0, 79: 21.1, 80: 20.2, 81: 19.4, 82: 18.5, 83: 17.7,
  84: 16.8, 85: 16.0, 86: 15.2, 87: 14.4, 88: 13.7, 89: 12.9,
  90: 12.2,
};

/** SECURE 2.0 RMD start age. */
export function rmdStartAge(birthYear) {
  if (birthYear <= 1950) return 72;
  if (birthYear <= 1959) return 73;
  return 75;
}

/** Calculate RMD for a given balance, age, birthYear. Returns 0 if below start age. */
export function calcRMD(balance, age, birthYear) {
  const startAge = rmdStartAge(birthYear);
  if (age < startAge) return 0;
  const divisor = ULT[Math.min(age, 90)] ?? 12.2;
  return balance / divisor;
}

function round2(n) { return Math.round(n * 100) / 100; }

function scaledBrackets(filingStatus, inflationRate, yearIndex) {
  const factor = Math.pow(1 + (inflationRate ?? 0), yearIndex ?? 0);
  if (factor === 1) return TAX_BRACKETS_2026[filingStatus];
  return TAX_BRACKETS_2026[filingStatus].map(b => ({
    rate: b.rate,
    min:  b.min === 0        ? 0        : b.min  * factor,
    max:  b.max === Infinity ? Infinity : b.max  * factor,
  }));
}

function scaledStdDed(filingStatus, inflationRate, yearIndex) {
  const factor = Math.pow(1 + (inflationRate ?? 0), yearIndex ?? 0);
  return STANDARD_DEDUCTION_2026[filingStatus] * factor;
}

function scaledIrmaaTiers(filingStatus, inflationRate, yearIndex) {
  const factor = Math.pow(1 + (inflationRate ?? 0), yearIndex ?? 0);
  if (factor === 1) return IRMAA_TIERS_2026[filingStatus];
  return IRMAA_TIERS_2026[filingStatus].map(t => ({
    ...t,
    maxMAGI: t.maxMAGI === Infinity ? Infinity : t.maxMAGI * factor,
  }));
}

/** Federal income tax for a given taxable income. */
export function calcFederalTax(taxableIncome, filingStatus, inflationRate = 0, yearIndex = 0) {
  if (taxableIncome <= 0) return 0;
  const brackets = scaledBrackets(filingStatus, inflationRate, yearIndex);
  let tax = 0;
  for (const b of brackets) {
    if (taxableIncome <= b.min) break;
    tax += (Math.min(taxableIncome, b.max) - b.min) * b.rate;
  }
  return tax;
}

/** Effective and marginal rates. */
export function calcTaxRates(taxableIncome, filingStatus, inflationRate = 0, yearIndex = 0) {
  if (taxableIncome <= 0) return { effectiveRate: 0, marginalRate: 0 };
  const brackets = scaledBrackets(filingStatus, inflationRate, yearIndex);
  const tax = calcFederalTax(taxableIncome, filingStatus, inflationRate, yearIndex);
  const effectiveRate = tax / taxableIncome;
  let marginalRate = brackets[0].rate;
  for (const b of brackets) {
    if (taxableIncome > b.min) marginalRate = b.rate;
  }
  return { effectiveRate, marginalRate };
}

/** IRMAA tier lookup (no lookback). */
export function calcIRMAARaw(magi, filingStatus, inflationRate = 0, yearIndex = 0) {
  const tiers = scaledIrmaaTiers(filingStatus, inflationRate, yearIndex);
  const basePremium = IRMAA_TIERS_2026[filingStatus][0].partBMonthly;
  for (const t of tiers) {
    if (magi <= t.maxMAGI) {
      return {
        tier: t.tier, label: t.label,
        partBMonthly: t.partBMonthly, partDMonthly: t.partDMonthly,
        annualSurcharge: round2((t.partBMonthly - basePremium + t.partDMonthly) * 12),
        crossesThreshold: t.tier > 0,
      };
    }
  }
  const last = tiers[tiers.length - 1];
  return {
    tier: last.tier, label: last.label,
    partBMonthly: last.partBMonthly, partDMonthly: last.partDMonthly,
    annualSurcharge: round2((last.partBMonthly - basePremium + last.partDMonthly) * 12),
    crossesThreshold: true,
  };
}

/** Full IRMAA with 2-year lookback. */
export function calcIRMAA(magi, filingStatus, age = 65, magiTwoYearsAgo = null,
                           inflationRate = 0, yearIndex = 0) {
  const tiers = scaledIrmaaTiers(filingStatus, inflationRate, yearIndex);
  const basePremium = IRMAA_TIERS_2026[filingStatus][0].partBMonthly;
  const NO_IRMAA = { tier: 0, label: "No IRMAA", partBMonthly: 0, partDMonthly: 0,
    annualSurcharge: 0, crossesThreshold: false, onMedicare: false };

  function tierForMagi(m) {
    if (m == null || m <= 0) return { ...NO_IRMAA, onMedicare: true };
    for (const t of tiers) {
      if (m <= t.maxMAGI) {
        return {
          tier: t.tier, label: t.label,
          partBMonthly: t.partBMonthly, partDMonthly: t.partDMonthly,
          annualSurcharge: round2((t.partBMonthly - basePremium + t.partDMonthly) * 12),
          crossesThreshold: t.tier > 0, onMedicare: true,
        };
      }
    }
    const last = tiers[tiers.length - 1];
    return {
      tier: last.tier, label: last.label,
      partBMonthly: last.partBMonthly, partDMonthly: last.partDMonthly,
      annualSurcharge: round2((last.partBMonthly - basePremium + last.partDMonthly) * 12),
      crossesThreshold: true, onMedicare: true,
    };
  }

  if (age < 65) {
    return { currentIRMAA: { ...NO_IRMAA }, futureIRMAA: tierForMagi(magi) };
  }
  return { currentIRMAA: tierForMagi(magiTwoYearsAgo), futureIRMAA: tierForMagi(magi) };
}

// ---------------------------------------------------------------------------
// ★ NEW: calculateOptimalVariableConversions
//
// Implements the "Smart Variable Conversion Strategy":
//
//   Phase 1 — "Golden Window" (currentAge < 63):
//     Conversion = targetBracketCeiling - baseIncome
//     (Medicare's 2-year lookback means conversions before 63 don't affect age-65 IRMAA)
//
//   Phase 2 — "IRMAA Cap" (age ≥ 63):
//     Conversion = targetIrmaaCeiling - baseIncome
//     (Throttle to keep MAGI from crossing the specified IRMAA tier cliff)
//
//   Termination: stops when the Traditional IRA balance reaches zero.
//
// @param {object}  params
// @param {number}  params.currentAge           Owner's current age
// @param {number}  [params.birthYear]          Birth year (auto-derived from age if omitted)
// @param {number}  params.baseIncome           Non-conversion annual ordinary income ($)
// @param {number}  params.startingIraBalance   Opening Traditional IRA balance ($)
// @param {number}  params.targetBracketCeiling MAGI ceiling for Phase 1 (e.g. top of 24% bracket)
// @param {number}  params.targetIrmaaCeiling   MAGI ceiling for Phase 2 (e.g. IRMAA Tier 2 limit)
// @param {"single"|"mfj"} params.filingStatus  Filing status
// @param {number}  [params.growthRate=0.07]    Annual IRA growth rate (0–1)
// @param {number}  [params.inflationRate=0]    Annual bracket/IRMAA inflation (0–1)
// @param {number}  [params.maxYears=40]        Safety cap on projection years
//
// @returns {Array<{age, yearIndex, phase, conversionAmount, iraBalanceBefore, iraBalanceAfter, magi}>}
// ---------------------------------------------------------------------------
export function calculateOptimalVariableConversions({
  currentAge,
  birthYear,
  baseIncome,
  startingIraBalance,
  targetBracketCeiling,
  targetIrmaaCeiling,
  filingStatus = "mfj",
  growthRate = 0.07,
  inflationRate = 0,
  maxYears = 40,
}) {
  // Derive birth year if not provided
  const resolvedBirthYear = birthYear ?? (new Date().getFullYear() - currentAge);

  const schedule = [];
  let iraBalance = startingIraBalance;

  for (let i = 0; i < maxYears; i++) {
    if (iraBalance <= 0) break;

    const age = currentAge + i;

    // Inflation-scale the ceilings forward for this year index
    const inflFactor = Math.pow(1 + (inflationRate ?? 0), i);
    const scaledBracketCeiling = targetBracketCeiling * inflFactor;
    const scaledIrmaaCeiling   = targetIrmaaCeiling   * inflFactor;

    // Phase 1: Golden Window (age < 63) — fill to the target tax bracket
    // Phase 2: IRMAA Cap (age ≥ 63) — throttle to the IRMAA tier ceiling
    const ceiling = age < 63 ? scaledBracketCeiling : scaledIrmaaCeiling;

    // How much room is there above base income?
    const room = Math.max(0, ceiling - baseIncome);

    // Can't convert more than what remains in the IRA
    const conversionAmount = Math.min(room, iraBalance);

    const iraBalanceBefore = iraBalance;

    // Remove the conversion from the IRA, then apply growth
    iraBalance -= conversionAmount;
    iraBalance = Math.max(0, iraBalance) * (1 + growthRate);

    const magi = baseIncome + conversionAmount;

    schedule.push({
      age,
      yearIndex:          i,
      phase:              age < 63 ? "golden_window" : "irmaa_cap",
      conversionAmount:   round2(conversionAmount),
      ceiling:            round2(ceiling),
      iraBalanceBefore:   round2(iraBalanceBefore),
      iraBalanceAfter:    round2(iraBalance),
      magi:               round2(magi),
    });

    // Stop if the IRA just emptied (after growth above it's 0 if it was 0 before growth)
    if (iraBalance <= 0) break;
  }

  return schedule;
}

// ---------------------------------------------------------------------------
// runSmartVariableSimulation
//
// Full year-by-year lifetime simulation that uses the smart variable schedule.
// Computes tax, IRMAA, and balances for every year from currentAge to endAge.
// ---------------------------------------------------------------------------
export function runSmartVariableSimulation({
  currentAge,
  birthYear,
  startingIraBalance,
  taxableBrokerageBalance = 0,
  baseIncome,
  targetBracketCeiling,
  targetIrmaaCeiling,
  filingStatus = "mfj",
  growthRate = 0.07,
  inflationRate = 0,
  endAge = 90,
  payTaxFromConversion = false,
}) {
  const resolvedBirthYear = birthYear ?? (new Date().getFullYear() - currentAge);

  // Build the variable conversion schedule first
  const conversionSchedule = calculateOptimalVariableConversions({
    currentAge,
    birthYear: resolvedBirthYear,
    baseIncome,
    startingIraBalance,
    targetBracketCeiling,
    targetIrmaaCeiling,
    filingStatus,
    growthRate,
    inflationRate,
    maxYears: endAge - currentAge + 1,
  });

  // Build a lookup map: yearIndex → conversionAmount
  const scheduleMap = {};
  for (const entry of conversionSchedule) {
    scheduleMap[entry.yearIndex] = entry.conversionAmount;
  }

  let tradIRA      = startingIraBalance;
  let rothIRA      = 0;
  let taxBrokerage = taxableBrokerageBalance;

  const years     = [];
  const magiHistory = [null, null]; // 2-year lookback

  for (let age = currentAge; age <= endAge; age++) {
    const yearIndex = age - currentAge;
    const infFactor = Math.pow(1 + (inflationRate ?? 0), yearIndex);

    // RMD
    const rmd = calcRMD(tradIRA, age, resolvedBirthYear);

    // Conversion from schedule (only if IRA has balance)
    const scheduledConversion = scheduleMap[yearIndex] ?? 0;
    const conversionAmount    = tradIRA > 0 ? Math.min(scheduledConversion, tradIRA) : 0;

    // Tax computation
    const stdDed       = scaledStdDed(filingStatus, inflationRate, yearIndex);
    const grossIncome  = baseIncome + conversionAmount + rmd;
    const taxableInc   = Math.max(0, grossIncome - stdDed);
    const federalTax   = calcFederalTax(taxableInc, filingStatus, inflationRate, yearIndex);

    // Incremental tax from conversion only
    const baseGross    = baseIncome + rmd;
    const baseTaxable  = Math.max(0, baseGross - stdDed);
    const baseFedTax   = calcFederalTax(baseTaxable, filingStatus, inflationRate, yearIndex);
    const convTax      = federalTax - baseFedTax;

    const { effectiveRate, marginalRate } = calcTaxRates(taxableInc, filingStatus, inflationRate, yearIndex);

    // MAGI & IRMAA with 2-year lookback
    const magi = grossIncome;
    const { currentIRMAA: irmaa, futureIRMAA: futureIRMAA } = calcIRMAA(
      magi, filingStatus, age, magiHistory[0], inflationRate, yearIndex,
    );
    magiHistory[0] = magiHistory[1];
    magiHistory[1] = magi;

    // Pay taxes from brokerage
    const taxPaidFromBrokerage = Math.min(federalTax, taxBrokerage);
    taxBrokerage -= taxPaidFromBrokerage;
    const taxShortfall     = federalTax - taxPaidFromBrokerage;
    const brokerageExhausted = taxShortfall > 0;

    // Apply conversion + RMD to IRA
    tradIRA = Math.max(0, tradIRA - conversionAmount - rmd);

    const rothDeposit = payTaxFromConversion
      ? Math.max(0, conversionAmount - taxShortfall)
      : conversionAmount;
    rothIRA += rothDeposit;

    // Apply growth
    tradIRA      = Math.max(0, tradIRA)      * (1 + growthRate);
    rothIRA      *= (1 + growthRate);
    taxBrokerage = Math.max(0, taxBrokerage) * (1 + growthRate);

    const estateValue = tradIRA + rothIRA + taxBrokerage;

    // Phase label
    const convYears = conversionSchedule.length;
    let phase = yearIndex < convYears ? "conversion" : "post_conversion";
    if (rmd > 0 && yearIndex >= convYears) phase = "rmd";

    years.push({
      age,
      yearIndex,
      phase,
      conversionAmount:       round2(conversionAmount),
      rmd:                    round2(rmd),
      grossIncome:            round2(grossIncome),
      magi:                   round2(magi),
      federalTax:             round2(federalTax),
      convTax:                round2(convTax),
      effectiveRate:          round2(effectiveRate),
      marginalRate,
      taxShortfall:           round2(taxShortfall),
      brokerageExhausted,
      onMedicare:             age >= 65,
      irmaa,
      futureIRMAA,
      endingTraditionalIRA:   round2(tradIRA),
      endingRothIRA:          round2(rothIRA),
      endingTaxableBrokerage: round2(taxBrokerage),
      estateValue:            round2(estateValue),
    });
  }

  const totalFedTax     = years.reduce((s, y) => s + y.federalTax, 0);
  const totalConvTax    = years.reduce((s, y) => s + y.convTax, 0);
  const totalIRMAA      = years.reduce((s, y) => s + (y.irmaa?.annualSurcharge ?? 0), 0);
  const totalConverted  = years.reduce((s, y) => s + y.conversionAmount, 0);
  const last            = years[years.length - 1] ?? {};

  return {
    conversionSchedule,
    years,
    summary: {
      totalFederalTax:       round2(totalFedTax),
      totalConvTax:          round2(totalConvTax),
      totalIRMAA:            round2(totalIRMAA),
      totalLifetimeCost:     round2(totalFedTax + totalIRMAA),
      totalAmountConverted:  round2(totalConverted),
      conversionYears:       conversionSchedule.length,
      finalTraditionalIRA:   last.endingTraditionalIRA  ?? 0,
      finalRothIRA:          last.endingRothIRA         ?? 0,
      finalTaxableBrokerage: last.endingTaxableBrokerage ?? 0,
      estateValueAtEndAge:   last.estateValue           ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Static simulation (fixed annual conversion) — used by the Manual tab
// ---------------------------------------------------------------------------
export function runSimulation({
  traditionalIRABalance,
  taxableBrokerageBalance = 0,
  annualRothConversion,
  conversionYears,
  growthRate,
  filingStatus,
  currentAge = 60,
  birthYear,
  otherOrdinaryIncome = 0,
  payTaxFromConversion = false,
  inflationRate = 0,
}) {
  const resolvedBirthYear = birthYear ?? (new Date().getFullYear() - currentAge);
  const rmdAge = rmdStartAge(resolvedBirthYear);

  let tradIRA      = traditionalIRABalance;
  let rothIRA      = 0;
  let taxBrokerage = taxableBrokerageBalance;

  const years   = [];
  const magiHist = [null, null];

  for (let i = 0; i < conversionYears; i++) {
    const age = currentAge + i;
    const rmd = calcRMD(tradIRA, age, resolvedBirthYear);
    const conv = tradIRA > 0 ? Math.min(annualRothConversion, tradIRA) : 0;

    const stdDed     = scaledStdDed(filingStatus, inflationRate, i);
    const gross      = otherOrdinaryIncome + conv + rmd;
    const taxableInc = Math.max(0, gross - stdDed);
    const fedTax     = calcFederalTax(taxableInc, filingStatus, inflationRate, i);

    const baseGross    = otherOrdinaryIncome + rmd;
    const baseFedTax   = calcFederalTax(Math.max(0, baseGross - stdDed), filingStatus, inflationRate, i);
    const convTax      = fedTax - baseFedTax;

    const { effectiveRate, marginalRate } = calcTaxRates(taxableInc, filingStatus, inflationRate, i);

    const magi = gross;
    const { currentIRMAA: irmaa, futureIRMAA } = calcIRMAA(magi, filingStatus, age, magiHist[0], inflationRate, i);
    magiHist[0] = magiHist[1];
    magiHist[1] = magi;

    const taxPaid = Math.min(fedTax, taxBrokerage);
    taxBrokerage -= taxPaid;
    const shortfall      = fedTax - taxPaid;
    const brokExhausted  = shortfall > 0;

    tradIRA = Math.max(0, tradIRA - conv - rmd);

    const rothDeposit = payTaxFromConversion
      ? Math.max(0, conv - shortfall)
      : conv;
    rothIRA += rothDeposit;

    tradIRA      = Math.max(0, tradIRA) * (1 + growthRate);
    rothIRA      *= (1 + growthRate);
    taxBrokerage = Math.max(0, taxBrokerage) * (1 + growthRate);

    const baselineIRA = traditionalIRABalance * Math.pow(1 + growthRate, i + 1);
    const baselineRMD = calcRMD(baselineIRA, age + (rmdAge - age), resolvedBirthYear);

    years.push({
      year: i + 1, age,
      conversionAmount:       round2(conv),
      rmd:                    round2(rmd),
      endingTraditionalIRA:   round2(tradIRA),
      endingRothIRA:          round2(rothIRA),
      endingTaxableBrokerage: round2(taxBrokerage),
      federalTax:             round2(fedTax),
      conversionTax:          round2(convTax),
      effectiveRate:          round2(effectiveRate),
      marginalRate,
      taxShortfall:           round2(shortfall),
      brokerageExhausted:     brokExhausted,
      magi:                   round2(magi),
      onMedicare:             age >= 65,
      irmaa,
      futureIRMAA,
      baselineRMD:            round2(baselineRMD),
      projectedRMD:           round2(calcRMD(tradIRA, age + (rmdAge - age), resolvedBirthYear)),
      rmdReduction:           round2(Math.max(0, baselineRMD - calcRMD(tradIRA, age + (rmdAge - age), resolvedBirthYear))),
    });
  }

  const totConv     = years.reduce((s, y) => s + y.conversionAmount, 0);
  const totConvTax  = years.reduce((s, y) => s + y.conversionTax, 0);
  const totFedTax   = years.reduce((s, y) => s + y.federalTax, 0);
  const totIRMAA    = years.reduce((s, y) => s + (y.irmaa?.annualSurcharge ?? 0), 0);
  const last        = years[years.length - 1] ?? {};

  return {
    years,
    summary: {
      totalAmountConverted:        round2(totConv),
      totalFederalTaxOnConversions:round2(totConvTax),
      totalFederalTaxOnly:         round2(totFedTax),
      totalIRMAASurcharges:        round2(totIRMAA),
      totalYearsModeled:           years.length,
      finalTraditionalIRA:         last.endingTraditionalIRA  ?? 0,
      finalRothIRA:                last.endingRothIRA         ?? 0,
      finalTaxableBrokerage:       last.endingTaxableBrokerage ?? 0,
      rmdStartAge:                 rmdStartAge(resolvedBirthYear),
      irmaaBreachYears:            years.filter(y => y.irmaa?.crossesThreshold).length,
      brokerageExhaustedYears:     years.filter(y => y.brokerageExhausted).length,
      totalUnfundedTax:            round2(years.reduce((s, y) => s + y.taxShortfall, 0)),
    },
  };
}

// ---------------------------------------------------------------------------
// Bracket ceiling helpers — 2026 values
// ---------------------------------------------------------------------------

/**
 * Return the MAGI ceiling (gross income, before standard deduction) for
 * the top of a given bracket for the specified filing status in 2026.
 * e.g. bracketCeiling("mfj", 0.24) = 402100 + 30700 = 432800 MAGI
 */
export function bracketCeiling(filingStatus, rate) {
  const brackets = TAX_BRACKETS_2026[filingStatus];
  const stdDed   = STANDARD_DEDUCTION_2026[filingStatus];
  const bracket  = brackets.find(b => b.rate === rate);
  if (!bracket) throw new Error(`No ${rate * 100}% bracket for ${filingStatus}`);
  return bracket.max + stdDed; // convert taxable income ceiling to MAGI ceiling
}

/**
 * Return the MAGI ceiling for a given IRMAA tier (2026 thresholds).
 * tier: 0 (no IRMAA), 1, 2, 3, 4, 5
 */
export function irmaaTierCeiling(filingStatus, tier) {
  const tiers = IRMAA_TIERS_2026[filingStatus];
  const t = tiers.find(t => t.tier === tier);
  if (!t) throw new Error(`No IRMAA tier ${tier} for ${filingStatus}`);
  return t.maxMAGI; // already a MAGI ceiling
}

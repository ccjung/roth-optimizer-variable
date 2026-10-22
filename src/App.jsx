import { useState, useMemo, useEffect, useCallback } from "react";
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area, ReferenceLine,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import {
  runSimulation,
  runSmartVariableSimulation,
  calculateOptimalVariableConversions,
  optimizeConversion,
  runLifetimeProjection,
  calcBreakEven,
  calcSSClaimingComparison,
  calcIRMAARaw,
  TAX_BRACKETS_2026,
  IRMAA_TIERS_2026,
  STANDARD_DEDUCTION_2026,
  STATE_TAX_RATES,
  STATE_TAX_NOTES,
  bracketCeiling,
  irmaaTierCeiling,
  rmdStartAge,
} from "./engine.js";

// ─── Formatting helpers ───────────────────────────────────────────────────────
const fmt$ = (n) =>
  n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const fmtPct = (n) =>
  n == null ? "—" : (n * 100).toFixed(1) + "%";

// ─── Reusable UI primitives ───────────────────────────────────────────────────
function Card({ title, children, accent }) {
  return (
    <div style={{
      background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10,
      padding: "20px 24px", borderTop: accent ? `3px solid ${accent}` : undefined,
    }}>
      {title && (
        <h3 style={{ fontSize: 13, fontWeight: 600, color: "#57606a", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 14 }}>
          {title}
        </h3>
      )}
      {children}
    </div>
  );
}

function StatBox({ label, value, sub, color }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: color ?? "#1f2328" }}>{value}</div>
      <div style={{ fontSize: 13, color: "#57606a", marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 12, color: "#8b949e", marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function InputField({ label, id, value, onChange, min, max, step, note, prefix, suffix }) {
  const [draft, setDraft] = useState(String(value));

  // Sync draft when parent pushes a new value (e.g. age → birthYear auto-update)
  const strValue = String(value);
  if (draft !== strValue && strValue !== String(parseFloat(draft))) {
    setDraft(strValue);
  }

  const handleChange = (e) => {
    const raw = e.target.value;
    setDraft(raw);
    const parsed = parseFloat(raw);
    if (!isNaN(parsed)) onChange(parsed);
  };

  const handleBlur = () => {
    const parsed = parseFloat(draft);
    const clean = isNaN(parsed) ? 0 : parsed;
    setDraft(String(clean));
    onChange(clean);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label htmlFor={id} style={{ fontSize: 13, fontWeight: 600, color: "#1f2328" }}>{label}</label>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {prefix && <span style={{ fontSize: 14, color: "#57606a" }}>{prefix}</span>}
        <input id={id} type="text" inputMode="numeric" value={draft}
          onChange={handleChange} onBlur={handleBlur}
          style={{ flex: 1, padding: "7px 10px", border: "1px solid #d0d7de", borderRadius: 6, fontSize: 14, outline: "none", background: "#fff" }}
        />
        {suffix && <span style={{ fontSize: 14, color: "#57606a" }}>{suffix}</span>}
      </div>
      {note && <span style={{ fontSize: 12, color: "#8b949e" }}>{note}</span>}
    </div>
  );
}

function IRMAAbadge({ label, crosses, notOnMedicare }) {
  if (notOnMedicare) {
    return (
      <span style={{ background: crosses ? "#fef3c7" : "#f7f8fa", color: crosses ? "#92400e" : "#8b949e",
        borderRadius: 4, padding: "2px 7px", fontSize: 12, fontStyle: "italic" }}
        title="Not on Medicare yet. Shows future IRMAA impact.">
        {crosses ? `⚠ ${label} (future)` : "N/A"}
      </span>
    );
  }
  return (
    <span style={{ background: crosses ? "#fff3cd" : "#d1fae5", color: crosses ? "#92400e" : "#065f46",
      borderRadius: 4, padding: "2px 7px", fontSize: 12, fontWeight: 600 }}>
      {label}
    </span>
  );
}

const td = { padding: "7px 10px", textAlign: "right", borderBottom: "1px solid #f0f0f0", whiteSpace: "nowrap" };

function exportCSV(rows, headers, filename) {
  const esc = v => { if (v == null) return ""; const s = String(v); return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g,'""')}"` : s; };
  const lines = [headers.map(esc).join(","), ...rows.map(row => headers.map(h => esc(row[h])).join(","))];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob); const a = document.createElement("a");
  a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}

function PhaseBadge({ phase }) {
  const cfg = {
    golden_window:   { bg: "#dbeafe", color: "#1e40af", label: "GOLDEN WINDOW" },
    irmaa_cap:       { bg: "#fef3c7", color: "#92400e", label: "IRMAA CAP" },
    conversion:      { bg: "#dbeafe", color: "#1e40af", label: "CONVERSION" },
    post_conversion: { bg: "#e5e7eb", color: "#57606a", label: "POST-CONV" },
    gap:             { bg: "#e5e7eb", color: "#57606a", label: "GAP" },
    rmd:             { bg: "#fde68a", color: "#92400e", label: "RMD" },
  }[phase] ?? { bg: "#f7f8fa", color: "#57606a", label: (phase ?? "").toUpperCase() };
  return <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 3, fontWeight: 600, background: cfg.bg, color: cfg.color }}>{cfg.label}</span>;
}

// ─── Smart Variable Strategy Panel ───────────────────────────────────────────
function SmartStrategyPanel({ baseInputs, onApply }) {
  const [targetBracketRate, setTargetBracketRate] = useState(0.24);
  const [targetIrmaaaTier,  setTargetIrmaaaTier]  = useState(2);
  const [endAge,            setEndAge]            = useState(90);
  const [showSchedule,      setShowSchedule]      = useState(false);

  const { filingStatus, currentAge, otherOrdinaryIncome: baseIncome = 0 } = baseInputs;

  const resolvedCeilings = useMemo(() => {
    try {
      return { bCeiling: bracketCeiling(filingStatus, targetBracketRate), iCeiling: irmaaTierCeiling(filingStatus, targetIrmaaaTier), error: null };
    } catch (e) { return { bCeiling: null, iCeiling: null, error: e.message }; }
  }, [filingStatus, targetBracketRate, targetIrmaaaTier]);

  const { result, error } = useMemo(() => {
    if (!resolvedCeilings.bCeiling) return { result: null, error: resolvedCeilings.error };
    try {
      const r = runSmartVariableSimulation({
        currentAge:              baseInputs.currentAge,
        birthYear:               baseInputs.birthYear,
        startingIraBalance:      baseInputs.traditionalIRABalance,
        taxableBrokerageBalance: baseInputs.taxableBrokerageBalance,
        baseIncome,
        filingStatus:            baseInputs.filingStatus,
        growthRate:              baseInputs.growthRate,
        inflationRate:           baseInputs.inflationRate,
        targetBracketCeiling:    resolvedCeilings.bCeiling,
        targetIrmaaCeiling:      resolvedCeilings.iCeiling,
        endAge,
      });
      return { result: r, error: null };
    } catch (e) { return { result: null, error: e.message }; }
  }, [baseInputs, baseIncome, resolvedCeilings, endAge]);

  const s = result?.summary;
  const convSched = result?.conversionSchedule ?? [];
  const phase1Rows = convSched.filter(r => r.phase === "golden_window");
  const phase2Rows = convSched.filter(r => r.phase === "irmaa_cap");
  const p1Total = phase1Rows.reduce((s, r) => s + r.conversionAmount, 0);
  const p2Total = phase2Rows.reduce((s, r) => s + r.conversionAmount, 0);

  const drainChartData = convSched.map(row => ({
    age: row.age, "Conversion": Math.round(row.conversionAmount),
    "IRA Balance": Math.round(row.iraBalanceAfter), phase: row.phase,
  }));
  const lifetimeData = (result?.years ?? []).map(y => ({
    age: y.age, "Trad IRA": Math.round(y.endingTraditionalIRA), "Roth IRA": Math.round(y.endingRothIRA),
    "Taxable": Math.round(y.endingTaxableBrokerage), "Fed Tax": Math.round(y.federalTax),
    "MAGI": Math.round(y.magi), "IRMAA": Math.round(y.irmaa?.annualSurcharge ?? 0),
    "Estate": Math.round(y.estateValue),
  }));

  const bracketLabel = (targetBracketRate * 100).toFixed(0) + "%";
  const irmaaLabel   = IRMAA_TIERS_2026[filingStatus].find(t => t.tier === targetIrmaaaTier)?.label ?? "Tier " + targetIrmaaaTier;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Card title="Smart Variable Conversion — Strategy Parameters">
        <div style={{ fontSize: 13, color: "#57606a", marginBottom: 16, padding: "10px 14px", background: "#eff6ff", borderRadius: 8, border: "1px solid #bfdbfe" }}>
          <strong style={{ color: "#1e40af" }}>🧠 How it works:</strong>{" "}
          Before age 63 <strong>(Golden Window)</strong>, converts up to the top of your target bracket — no IRMAA risk because Medicare's 2-year lookback means age-65 premiums are already locked in.
          From age 63+ <strong>(IRMAA Cap)</strong>, throttles down to stop exactly at your chosen IRMAA tier ceiling to prevent cliff penalties.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 13, fontWeight: 600 }}>Phase 1 — Target Tax Bracket</label>
            <select value={targetBracketRate} onChange={e => setTargetBracketRate(Number(e.target.value))}
              style={{ padding: "7px 10px", border: "1px solid #d0d7de", borderRadius: 6, fontSize: 14, background: "#fff" }}>
              {[0.10,0.12,0.22,0.24,0.32,0.35].map(r => (
                <option key={r} value={r}>{(r*100).toFixed(0)}% bracket{r===0.24?" (recommended)":""}</option>
              ))}
            </select>
            {resolvedCeilings.bCeiling && (
              <span style={{ fontSize: 12, color: "#3b82d4" }}>MAGI ceiling: {fmt$(resolvedCeilings.bCeiling)} · Max conversion: {fmt$(Math.max(0, resolvedCeilings.bCeiling - baseIncome))}</span>
            )}
            <span style={{ fontSize: 12, color: "#57606a" }}>Ages &lt;63 · Formula: Bracket Ceiling − Base Income</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 13, fontWeight: 600 }}>Phase 2 — IRMAA Tier Cap</label>
            <select value={targetIrmaaaTier} onChange={e => setTargetIrmaaaTier(Number(e.target.value))}
              style={{ padding: "7px 10px", border: "1px solid #d0d7de", borderRadius: 6, fontSize: 14, background: "#fff" }}>
              {[0,1,2,3,4].map(t => {
                const tier = IRMAA_TIERS_2026[filingStatus].find(x => x.tier === t);
                return <option key={t} value={t}>Tier {t} — {fmt$(tier?.maxMAGI)} limit{t===2?" (recommended)":""}</option>;
              })}
            </select>
            {resolvedCeilings.iCeiling && (
              <span style={{ fontSize: 12, color: "#f59e0b" }}>MAGI ceiling: {fmt$(resolvedCeilings.iCeiling)} · Max conversion: {fmt$(Math.max(0, resolvedCeilings.iCeiling - baseIncome))}</span>
            )}
            <span style={{ fontSize: 12, color: "#57606a" }}>Ages ≥63 · Formula: IRMAA Ceiling − Base Income</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 13, fontWeight: 600 }}>Project Through Age</label>
            <input type="number" min={75} max={100} value={endAge} onChange={e => setEndAge(Number(e.target.value))}
              style={{ padding: "7px 10px", border: "1px solid #d0d7de", borderRadius: 6, fontSize: 14, background: "#fff" }} />
            <span style={{ fontSize: 12, color: "#57606a" }}>Lifetime projection end age</span>
          </div>
        </div>
        <div style={{ marginTop: 16, display: "flex", gap: 10 }}>
          <button onClick={() => setShowSchedule(!showSchedule)}
            style={{ background: "#1f2328", color: "#fff", border: "none", borderRadius: 6, padding: "9px 20px", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
            {showSchedule ? "▲ Hide" : "▼ Show"} Conversion Schedule
          </button>
          {s && (
            <button onClick={() => onApply(convSched)}
              style={{ background: "#10b981", color: "#fff", border: "none", borderRadius: 6, padding: "9px 20px", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
              ✓ Apply to Manual Simulator
            </button>
          )}
        </div>
      </Card>

      {error && <div style={{ background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 8, padding: "12px 16px", color: "#991b1b", fontSize: 14 }}>⚠ {error}</div>}

      {s && (
        <>
          <div style={{ background: "linear-gradient(135deg,#eff6ff,#dbeafe)", border: "1px solid #93c5fd", borderRadius: 10, padding: "20px 24px" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#1e40af", marginBottom: 14 }}>
              🧠 Smart Variable Strategy — {bracketLabel} bracket (Phase 1) → {irmaaLabel} IRMAA cap (Phase 2)
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 12 }}>
              <StatBox label="Total Converted"     value={fmt$(s.totalAmountConverted)} color="#3b82d4" />
              <StatBox label="Conversion Years"    value={`${s.conversionYears} yrs`}   color="#1f2328" />
              <StatBox label="Phase 1 (Golden)"    value={fmt$(p1Total)}   color="#10b981" sub={`${phase1Rows.length} yr${phase1Rows.length !== 1?"s":""} < age 63`} />
              <StatBox label="Phase 2 (IRMAA Cap)" value={fmt$(p2Total)}   color="#f59e0b" sub={`${phase2Rows.length} yr${phase2Rows.length !== 1?"s":""} ≥ age 63`} />
              <StatBox label={`Estate at ${endAge}`} value={fmt$(s.estateValueAtEndAge)} color="#10b981" />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginTop: 14 }}>
              <StatBox label="Lifetime Federal Tax" value={fmt$(s.totalFederalTax)}    color="#ef4444" />
              <StatBox label="Lifetime IRMAA"       value={fmt$(s.totalIRMAA)}         color={s.totalIRMAA > 0 ? "#f59e0b" : "#8b949e"} />
              <StatBox label="Lifetime Total Cost"  value={fmt$(s.totalLifetimeCost)}  color="#7c5cd8" />
            </div>
          </div>

          {currentAge < 63 && phase1Rows.length > 0 && (
            <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 8, padding: "12px 16px", fontSize: 13, color: "#166534" }}>
              <strong>✅ Golden Window Active!</strong> At age {currentAge} you have <strong>{63 - currentAge} year{63 - currentAge !== 1?"s":""}</strong> in the IRMAA-safe golden window.
              Conversions here ({fmt$(p1Total)} total) cannot affect age-65 Medicare premiums due to the 2-year lookback.
              {phase2Rows.length > 0 && <> Starting at age 63, the strategy throttles to the <strong>{irmaaLabel}</strong> ceiling ({fmt$(resolvedCeilings.iCeiling)}).</>}
            </div>
          )}
          {currentAge >= 63 && (
            <div style={{ background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 8, padding: "12px 16px", fontSize: 13, color: "#92400e" }}>
              <strong>⚠ IRMAA Window:</strong> At age {currentAge} all conversions are capped at the <strong>{irmaaLabel}</strong> MAGI ceiling ({fmt$(resolvedCeilings.iCeiling)}) to prevent Medicare surcharge cliff penalties.
            </div>
          )}

          <Card title="Dynamic Conversion Amount — Variable Drain Rate">
            <div style={{ fontSize: 13, color: "#57606a", marginBottom: 10 }}>
              Blue = Phase 1 Golden Window (bracket fill) · Amber = Phase 2 IRMAA Cap · Black line = IRA balance
            </div>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={drainChartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="age" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="left"  tickFormatter={v => "$" + (v/1000).toFixed(0) + "k"} tick={{ fontSize: 11 }} />
                <YAxis yAxisId="right" orientation="right" tickFormatter={v => "$" + (v/1000).toFixed(0) + "k"} tick={{ fontSize: 11 }} />
                <Tooltip formatter={v => fmt$(v)} labelFormatter={v => `Age ${v}`} />
                <Legend />
                <Bar yAxisId="left" dataKey="Conversion" fill="#3b82d4" radius={[3,3,0,0]} />
                <Bar yAxisId="left" dataKey={row => row.phase === "irmaa_cap" ? row["Conversion"] : 0}
                  name="IRMAA Cap Phase" fill="#f59e0b" radius={[3,3,0,0]} stackId="hidden" />
                <Line yAxisId="right" type="monotone" dataKey="IRA Balance" stroke="#1f2328" strokeWidth={2} dot={false} />
                {currentAge < 63 && <ReferenceLine yAxisId="left" x={63} stroke="#ef4444" strokeDasharray="6 3"
                  label={{ value: "Age 63 — IRMAA Window", fontSize: 10, fill: "#ef4444" }} />}
              </BarChart>
            </ResponsiveContainer>
          </Card>

          <Card title="MAGI vs Ceiling Targets">
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={lifetimeData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="age" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={v => "$" + (v/1000).toFixed(0) + "k"} tick={{ fontSize: 11 }} />
                <Tooltip formatter={v => fmt$(v)} labelFormatter={v => `Age ${v}`} />
                <Legend />
                <Line type="monotone" dataKey="MAGI" stroke="#3b82d4" strokeWidth={2} dot={false} />
                <ReferenceLine y={resolvedCeilings.bCeiling} stroke="#10b981" strokeDasharray="6 3"
                  label={{ value: `${bracketLabel}: ${fmt$(resolvedCeilings.bCeiling)}`, position: "right", fontSize: 10, fill: "#10b981" }} />
                <ReferenceLine y={resolvedCeilings.iCeiling} stroke="#f59e0b" strokeDasharray="6 3"
                  label={{ value: `${irmaaLabel}: ${fmt$(resolvedCeilings.iCeiling)}`, position: "right", fontSize: 10, fill: "#f59e0b" }} />
                {currentAge < 63 && <ReferenceLine x={63} stroke="#ef4444" strokeDasharray="5 3" />}
              </LineChart>
            </ResponsiveContainer>
          </Card>

          <Card title="Lifetime Account Balances">
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={lifetimeData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="age" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={v => "$" + (v/1000).toFixed(0) + "k"} tick={{ fontSize: 11 }} />
                <Tooltip formatter={v => fmt$(v)} labelFormatter={v => `Age ${v}`} />
                <Legend />
                <Line type="monotone" dataKey="Trad IRA" stroke="#3b82d4" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="Roth IRA" stroke="#10b981" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="Taxable"  stroke="#f59e0b" strokeWidth={2} dot={false} strokeDasharray="5 3" />
                <Line type="monotone" dataKey="Estate"   stroke="#1f2328" strokeWidth={2} dot={false} strokeDasharray="3 2" />
              </LineChart>
            </ResponsiveContainer>
          </Card>

          <Card title="Annual Tax + IRMAA Cost">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={lifetimeData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="age" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={v => "$" + (v/1000).toFixed(0) + "k"} tick={{ fontSize: 11 }} />
                <Tooltip formatter={v => fmt$(v)} labelFormatter={v => `Age ${v}`} />
                <Legend />
                <Bar dataKey="Fed Tax" fill="#ef4444" stackId="cost" />
                <Bar dataKey="IRMAA"   fill="#f59e0b" stackId="cost" radius={[3,3,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {showSchedule && (
            <Card title="Variable Conversion Schedule — Year-by-Year">
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
                <button onClick={() => exportCSV(
                  convSched.map(r => ({ "Age": r.age, "Phase": r.phase, "Ceiling": r.ceiling,
                    "Conversion": r.conversionAmount, "MAGI": r.magi, "IRA Before": r.iraBalanceBefore, "IRA After": r.iraBalanceAfter })),
                  ["Age","Phase","Ceiling","Conversion","MAGI","IRA Before","IRA After"],
                  "smart-variable-schedule.csv"
                )} style={{ background: "#3b82d4", color: "#fff", border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
                  ⬇ Export CSV
                </button>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: "#f7f8fa" }}>
                      {["Age","Phase","Annual Ceiling","Conversion","MAGI","IRA Before","IRA After"].map(h => (
                        <th key={h} style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600, color: "#57606a", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {convSched.map((r, i) => (
                      <tr key={i} style={{ background: r.phase === "golden_window" ? "#eff6ff" : "#fffbeb" }}>
                        <td style={td}>{r.age}</td>
                        <td style={{ ...td, textAlign: "center" }}><PhaseBadge phase={r.phase} /></td>
                        <td style={{ ...td, color: r.phase === "golden_window" ? "#3b82d4" : "#f59e0b" }}>{fmt$(r.ceiling)}</td>
                        <td style={{ ...td, fontWeight: 600 }}>{fmt$(r.conversionAmount)}</td>
                        <td style={td}>{fmt$(r.magi)}</td>
                        <td style={td}>{fmt$(r.iraBalanceBefore)}</td>
                        <td style={{ ...td, color: r.iraBalanceAfter === 0 ? "#ef4444" : "#10b981", fontWeight: 600 }}>{fmt$(r.iraBalanceAfter)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ─── Manual Simulator Panel ───────────────────────────────────────────────────
function ManualPanel({ baseInputs, conversion, setConversion, years, setYears, appliedSchedule, stateTaxRate }) {
  const { result, error } = useMemo(() => {
    try {
      const r = runSimulation({ ...baseInputs, annualRothConversion: conversion, conversionYears: Math.round(years), stateTaxRate });
      return { result: r, error: null };
    } catch (e) { return { result: null, error: e.message }; }
  }, [baseInputs, conversion, years, stateTaxRate]);

  const s = result?.summary;

  const chartData = (result?.years ?? []).map(y => ({
    name: `Age ${y.age}`, age: y.age,
    "Trad IRA": Math.round(y.endingTraditionalIRA), "Roth IRA": Math.round(y.endingRothIRA),
    "Taxable": Math.round(y.endingTaxableBrokerage), "Conv. Tax": Math.round(y.conversionTax ?? 0),
    "MAGI": Math.round(y.magi),
  }));

  const irmaaLine = baseInputs.filingStatus === "single" ? 109000 : 218000;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {appliedSchedule && (
        <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#166534" }}>
          <strong>✓ Smart Strategy applied</strong> — {appliedSchedule.length} variable conversion years loaded. Showing static approximation using the average annual amount.
        </div>
      )}
      {error && <div style={{ background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 8, padding: "12px 16px", color: "#991b1b", fontSize: 14 }}>⚠ {error}</div>}

      {s && (
        <Card title={`Conversion Window Summary — ${s.totalYearsModeled} yr${s.totalYearsModeled!==1?"s":""}`} accent="#3b82d4">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }}>
            <StatBox label="Total Converted"   value={fmt$(s.totalAmountConverted)}         color="#3b82d4" />
            <StatBox label="Conversion Tax"    value={fmt$(s.totalFederalTaxOnConversions)}  color="#ef4444" />
            <StatBox label="IRMAA Surcharge"   value={fmt$(s.totalIRMAASurcharges)}          color={s.totalIRMAASurcharges > 0 ? "#f59e0b" : "#8b949e"} />
            <StatBox label="Final Roth IRA"    value={fmt$(s.finalRothIRA)}                  color="#10b981" />
          </div>
        </Card>
      )}

      {chartData.length > 0 && (
        <>
          <Card title="Account Balances">
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={v => "$" + (v/1000).toFixed(0) + "k"} tick={{ fontSize: 12 }} />
                <Tooltip formatter={v => fmt$(v)} />
                <Legend />
                <Line type="monotone" dataKey="Trad IRA" stroke="#3b82d4" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="Roth IRA" stroke="#10b981" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="Taxable"  stroke="#f59e0b" strokeWidth={2} dot={false} strokeDasharray="5 3" />
              </LineChart>
            </ResponsiveContainer>
          </Card>
          <Card title="Projected MAGI vs IRMAA Threshold">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={v => "$" + (v/1000).toFixed(0) + "k"} tick={{ fontSize: 12 }} />
                <Tooltip formatter={v => fmt$(v)} />
                <Legend />
                <Bar dataKey="MAGI" fill="#3b82d4" radius={[4,4,0,0]} />
                <Bar dataKey={() => irmaaLine} name={`IRMAA Threshold (${fmt$(irmaaLine)})`}
                  fill="none" stroke="#ef4444" strokeWidth={2} strokeDasharray="6 3" legendType="line" />
              </BarChart>
            </ResponsiveContainer>
          </Card>
          <Card title="Annual Conversion Tax">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={v => "$" + (v/1000).toFixed(0) + "k"} tick={{ fontSize: 12 }} />
                <Tooltip formatter={v => fmt$(v)} />
                <Legend />
                <Bar dataKey="Conv. Tax" fill="#ef4444" radius={[4,4,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </>
      )}

      {result && (
        <Card title="Year-by-Year Breakdown">
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#f7f8fa" }}>
                  {["Yr","Age","Converted","Trad IRA","Roth IRA","Fed Tax","Eff. Rate","MAGI","IRMAA"].map(h => (
                    <th key={h} style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600, color: "#57606a", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.years.map((y, i) => (
                  <tr key={i} style={{ background: i % 2 === 0 ? "#fff" : "#fafafa" }}>
                    <td style={td}>{y.year}</td>
                    <td style={td}>{y.age}</td>
                    <td style={{ ...td, color: "#3b82d4" }}>{fmt$(y.conversionAmount)}</td>
                    <td style={td}>{fmt$(y.endingTraditionalIRA)}</td>
                    <td style={{ ...td, color: "#10b981", fontWeight: 600 }}>{fmt$(y.endingRothIRA)}</td>
                    <td style={{ ...td, color: "#ef4444" }}>{fmt$(y.federalTax ?? y.totalFederalTax)}</td>
                    <td style={td}>{fmtPct(y.effectiveRate)}</td>
                    <td style={td}>{fmt$(y.magi)}</td>
                    <td style={{ ...td, textAlign: "center" }}>
                      <IRMAAbadge
                        label={y.onMedicare ? (y.irmaa?.label ?? "—") : (y.futureIRMAA?.label ?? "—")}
                        crosses={y.onMedicare ? y.irmaa?.crossesThreshold : y.futureIRMAA?.crossesThreshold}
                        notOnMedicare={!y.onMedicare}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

// ─── Bracket Comparison Panel ─────────────────────────────────────────────────
const BRACKET_COLORS = { "10%":"#6ee7b7","12%":"#34d399","22%":"#3b82d4","24%":"#7c5cd8","32%":"#f59e0b","35%":"#ef4444","37%":"#991b1b" };

function BracketPanel({ baseInputs, ssIncome, ssStartAge, endAge, onApply }) {
  const [selectedBracket, setSelectedBracket] = useState(null);

  const scenarios = useMemo(() => {
    const { filingStatus, otherOrdinaryIncome = 0 } = baseInputs;
    const results = [];
    for (const b of TAX_BRACKETS_2026[filingStatus]) {
      if (b.max === Infinity) continue;
      const label   = `${(b.rate * 100).toFixed(0)}%`;
      const magiTop = b.max + STANDARD_DEDUCTION_2026[filingStatus];
      const annual  = Math.max(0, magiTop - otherOrdinaryIncome);
      if (annual <= 0) continue;
      const rmdAge  = rmdStartAge(baseInputs.birthYear ?? new Date().getFullYear() - baseInputs.currentAge);
      const maxYrs  = Math.max(1, rmdAge - (baseInputs.currentAge ?? 60));
      const numYears = Math.min(Math.ceil(baseInputs.traditionalIRABalance / annual), maxYrs);
      try {
        const lifetime = runLifetimeProjection({ ...baseInputs, annualRothConversion: annual, conversionYears: numYears,
          socialSecurityBenefit: ssIncome, ssStartAge, endAge });
        results.push({ label, rate: b.rate, magiTop: Math.round(magiTop), annualAmount: Math.round(annual), numYears,
          lifetimeTax: lifetime.summary.totalLifetimeTax, lifetimeIRMAA: lifetime.summary.totalLifetimeIRMAA,
          lifetimeCost: lifetime.summary.totalLifetimeCost, estateValue: lifetime.summary.estateValueAtEndAge,
          years: lifetime.years });
      } catch (_) { /* skip */ }
    }
    return results;
  }, [baseInputs, ssIncome, ssStartAge, endAge]);

  const best   = scenarios.length > 0 ? scenarios.reduce((a, b) => a.lifetimeCost < b.lifetimeCost ? a : b) : null;
  const active = selectedBracket ? scenarios.find(s => s.label === selectedBracket) : best;
  const barData = scenarios.map(s => ({ name: `${s.label} bracket`, "Lifetime Tax": Math.round(s.lifetimeTax),
    "Lifetime IRMAA": Math.round(s.lifetimeIRMAA), estateValue: Math.round(s.estateValue), label: s.label }));
  const lifetimeData = active?.years.map(y => ({ age: y.age, "Trad IRA": Math.round(y.endingTraditionalIRA),
    "Roth IRA": Math.round(y.endingRothIRA), "Fed Tax": Math.round(y.totalFederalTax),
    "IRMAA": Math.round(y.irmaa?.annualSurcharge ?? 0) })) ?? [];

  if (scenarios.length === 0) return <div style={{ padding: 20, color: "#57606a" }}>Enter your inputs on the left to see bracket strategies.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Card title="Select a Tax Bracket Target">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 16 }}>
          {scenarios.map(s => {
            const isBest = s.label === best?.label, isActive = s.label === active?.label;
            return (
              <button key={s.label} onClick={() => setSelectedBracket(s.label)} style={{
                padding: "10px 18px", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600, position: "relative",
                background: isActive ? (BRACKET_COLORS[s.label] ?? "#3b82d4") : "#f7f8fa",
                color: isActive ? "#fff" : "#1f2328",
                border: isActive ? `2px solid ${BRACKET_COLORS[s.label] ?? "#3b82d4"}` : "2px solid #e5e7eb",
              }}>
                {isBest && <span style={{ position: "absolute", top: -8, right: -8, background: "#16a34a", color: "#fff", borderRadius: 10, padding: "1px 6px", fontSize: 10, fontWeight: 700 }}>★ BEST</span>}
                {s.label} bracket
                <div style={{ fontSize: 11, fontWeight: 400, marginTop: 2, opacity: 0.85 }}>{s.numYears} yr{s.numYears!==1?"s":""} · {fmt$(s.annualAmount)}/yr</div>
              </button>
            );
          })}
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f7f8fa" }}>
                {["Bracket","Annual Conv.","Years","MAGI ceiling","Lifetime Tax","Lifetime IRMAA","Total Cost","Estate @90","Apply"].map(h => (
                  <th key={h} style={{ padding: "7px 10px", textAlign: h==="Bracket"?"left":"right", fontWeight: 600, color: "#57606a", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scenarios.map((s, i) => {
                const isBest = s.label === best?.label, isActive = s.label === active?.label;
                return (
                  <tr key={i} onClick={() => setSelectedBracket(s.label)}
                    style={{ background: isActive ? "#eff6ff" : isBest ? "#f0fdf4" : i%2===0?"#fff":"#fafafa", cursor: "pointer" }}>
                    <td style={{ ...td, textAlign: "left" }}>
                      <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: BRACKET_COLORS[s.label]??"#ccc", marginRight: 6 }} />
                      <strong>{s.label}</strong>
                      {isBest && <span style={{ marginLeft: 6, fontSize: 10, background: "#16a34a", color: "#fff", borderRadius: 3, padding: "1px 5px", fontWeight: 700 }}>BEST</span>}
                    </td>
                    <td style={td}>{fmt$(s.annualAmount)}</td>
                    <td style={td}>{s.numYears}</td>
                    <td style={{ ...td, color: "#57606a" }}>{fmt$(s.magiTop)}</td>
                    <td style={{ ...td, color: "#ef4444" }}>{fmt$(s.lifetimeTax)}</td>
                    <td style={{ ...td, color: s.lifetimeIRMAA > 0 ? "#f59e0b" : "#8b949e" }}>{s.lifetimeIRMAA > 0 ? fmt$(s.lifetimeIRMAA) : "—"}</td>
                    <td style={{ ...td, fontWeight: isActive?700:400, color: isBest?"#166534":undefined }}>{fmt$(s.lifetimeCost)}</td>
                    <td style={{ ...td, color: "#10b981", fontWeight: 600 }}>{fmt$(s.estateValue)}</td>
                    <td style={{ ...td, textAlign: "left" }}>
                      <button onClick={e => { e.stopPropagation(); onApply(s.annualAmount, s.numYears); }}
                        style={{ background: isBest?"#16a34a":"none", color: isBest?"#fff":"#57606a", border: isBest?"none":"1px solid #d0d7de", borderRadius: 5, padding: "3px 10px", fontSize: 12, cursor: "pointer" }}>Apply</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Lifetime Cost by Bracket">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={barData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="name" tick={{ fontSize: 12 }} />
            <YAxis tickFormatter={v => "$" + (v/1000).toFixed(0) + "k"} tick={{ fontSize: 12 }} />
            <Tooltip formatter={v => fmt$(v)} />
            <Legend />
            <Bar dataKey="Lifetime Tax"   fill="#ef4444" stackId="a" />
            <Bar dataKey="Lifetime IRMAA" fill="#f59e0b" stackId="a" radius={[3,3,0,0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      {active && (
        <Card title={`${active.label} Bracket — Lifetime Account Balances`} accent={BRACKET_COLORS[active.label] ?? "#3b82d4"}>
          <div style={{ fontSize: 13, color: "#57606a", marginBottom: 10 }}>
            Converting <strong>{fmt$(active.annualAmount)}/yr</strong> for <strong>{active.numYears} years</strong> · Lifetime cost <strong>{fmt$(active.lifetimeCost)}</strong>
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={lifetimeData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="age" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={v => "$" + (v/1000).toFixed(0) + "k"} tick={{ fontSize: 11 }} />
              <Tooltip formatter={v => fmt$(v)} labelFormatter={v => `Age ${v}`} />
              <Legend />
              <Line type="monotone" dataKey="Trad IRA" stroke="#3b82d4" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="Roth IRA" stroke="#10b981" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      )}
    </div>
  );
}

// ─── Optimizer Panel ───────────────────────────────────────────────────────────
function OptimizerPanel({ baseInputs, ssIncome, ssStartAge, endAge, onApply }) {
  const [maxIRMAATier,     setMaxIRMAATier]     = useState(5);
  const [maxTaxBracket,    setMaxTaxBracket]    = useState("none");
  const [rmdTamingEnabled, setRmdTamingEnabled] = useState(false);
  const [targetMaxRMD,     setTargetMaxRMD]     = useState(0);
  const [selectedIdx,      setSelectedIdx]      = useState(0);

  const { optResult, optError } = useMemo(() => {
    try {
      const bracketCap = maxTaxBracket === "none" ? null : Number(maxTaxBracket);
      const resolvedTargetMaxRMD = targetMaxRMD > 0 ? targetMaxRMD
        : rmdTamingEnabled ? Math.max(0, (baseInputs.filingStatus === "mfj" ? 402100 : 201050) + (baseInputs.filingStatus === "mfj" ? 30700 : 15350) - (baseInputs.otherOrdinaryIncome ?? 0)) : null;
      const r = optimizeConversion({ ...baseInputs, socialSecurityBenefit: ssIncome, ssStartAge: Math.round(ssStartAge) },
        { maxIRMAATier, endAge: Math.round(endAge), maxTaxBracket: bracketCap, targetMaxRMD: resolvedTargetMaxRMD });
      return { optResult: r, optError: null };
    } catch (e) { return { optResult: null, optError: e.message }; }
  }, [baseInputs, ssIncome, ssStartAge, endAge, maxIRMAATier, maxTaxBracket, rmdTamingEnabled, targetMaxRMD]);

  if (!optResult && !optError) return null;

  const { recommended, strategies, bracketComparison } = optResult ?? { strategies: [], bracketComparison: [] };
  const selected = strategies?.[selectedIdx] ?? recommended;

  const lifetimeChartData = selected?.lifetimeYears?.map(y => ({
    age: y.age, "Trad IRA": Math.round(y.endingTraditionalIRA), "Roth IRA": Math.round(y.endingRothIRA),
    "Fed Tax": Math.round(y.totalFederalTax), "MAGI": Math.round(y.magi),
    "IRMAA Surcharge": Math.round(y.irmaa?.annualSurcharge ?? 0), "Estate": Math.round(y.estateValue),
  })) ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Card title="Optimizer Controls">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 13, fontWeight: 600 }}>Max Conversion Tax Bracket</label>
            <select value={maxTaxBracket} onChange={e => setMaxTaxBracket(e.target.value)}
              style={{ padding: "7px 10px", border: "1px solid #d0d7de", borderRadius: 6, fontSize: 14, background: "#fff" }}>
              <option value="none">No limit — all brackets</option>
              {[0.12,0.22,0.24,0.32].map(r => <option key={r} value={r}>Cap at {(r*100).toFixed(0)}%</option>)}
            </select>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 13, fontWeight: 600 }}>IRMAA Tolerance</label>
            <select value={maxIRMAATier} onChange={e => setMaxIRMAATier(Number(e.target.value))}
              style={{ padding: "7px 10px", border: "1px solid #d0d7de", borderRadius: 6, fontSize: 14, background: "#fff" }}>
              <option value={5}>No limit (recommended)</option>
              <option value={0}>Tier 0 — avoid IRMAA entirely</option>
              <option value={1}>Tier 1 max</option>
              <option value={2}>Tier 2 max</option>
              <option value={3}>Tier 3 max</option>
              <option value={4}>Tier 4 max</option>
            </select>
          </div>
        </div>
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" id="rmdTaming" checked={rmdTamingEnabled} onChange={e => setRmdTamingEnabled(e.target.checked)}
            style={{ cursor: "pointer", accentColor: "#3b82d4" }} />
          <label htmlFor="rmdTaming" style={{ fontSize: 13, fontWeight: 600, cursor: "pointer" }}>🎯 RMD Taming — only convert excess that would push future RMDs above the 24% bracket floor</label>
        </div>
        {rmdTamingEnabled && (
          <div style={{ marginTop: 8 }}>
            <InputField label="Custom Target Max RMD ($, leave 0 for auto)" id="targetRmd"
              value={targetMaxRMD} onChange={v => setTargetMaxRMD(Math.max(0, v))} prefix="$" step={5000} />
          </div>
        )}
      </Card>

      {optError && <div style={{ background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 8, padding: "12px 16px", color: "#991b1b", fontSize: 14 }}>⚠ {optError}</div>}

      {recommended && (
        <div style={{ background: "linear-gradient(135deg,#f0fdf4,#dcfce7)", border: "1px solid #86efac", borderRadius: 10, padding: "18px 22px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#166534", marginBottom: 10 }}>✅ Optimal Strategy (lowest lifetime tax + IRMAA)</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 12, marginBottom: 14 }}>
            <StatBox label="Typical Annual Conv." value={fmt$(recommended.typicalAnnualAmount)} color="#166534" />
            <StatBox label="Conversion Years"    value={`${recommended.conversionYears} yrs`}  color="#1f2328" />
            <StatBox label="Lifetime Tax"        value={fmt$(recommended.lifetimeTax)}          color="#ef4444" />
            <StatBox label="Lifetime IRMAA"      value={fmt$(recommended.lifetimeIRMAA)}        color="#f59e0b" />
            <StatBox label="Estate at 90"        value={fmt$(recommended.estateValue)}          color="#10b981" />
          </div>
          <div style={{ fontSize: 13, color: "#166534", marginBottom: 10 }}>{recommended.ceilingLabel}</div>
          <button onClick={() => onApply(recommended.typicalAnnualAmount, recommended.conversionYears)}
            style={{ background: "#16a34a", color: "#fff", border: "none", borderRadius: 6, padding: "8px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            Apply to Simulator →
          </button>
        </div>
      )}

      {strategies?.length > 0 && (
        <Card title="Strategy Comparison Table">
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "#f7f8fa" }}>
                  {["Strategy","Conv. Yrs","$/yr","Lifetime Tax","IRMAA","Estate @90",""].map(h => (
                    <th key={h} style={{ padding: "6px 10px", textAlign: h==="Strategy"||h===""?"left":"right", fontWeight: 600, color: "#57606a", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {strategies.slice(0, 14).map((s, i) => (
                  <tr key={i} onClick={() => setSelectedIdx(i)}
                    style={{ background: i === selectedIdx ? "#eff6ff" : i%2===0?"#fff":"#fafafa", cursor: "pointer" }}>
                    <td style={{ ...td, textAlign: "left", maxWidth: 280, whiteSpace: "normal" }}>
                      {i === 0 && <span style={{ background: "#16a34a", color: "#fff", borderRadius: 3, padding: "1px 5px", fontSize: 10, fontWeight: 700, marginRight: 5 }}>BEST</span>}
                      {s.isRmdTaming && <span style={{ background: "#3b82d4", color: "#fff", borderRadius: 3, padding: "1px 5px", fontSize: 10, fontWeight: 700, marginRight: 5 }}>🎯 RMD TAMING</span>}
                      {s.ceilingLabel}
                    </td>
                    <td style={td}>{s.conversionYears}</td>
                    <td style={td}>{fmt$(s.typicalAnnualAmount)}</td>
                    <td style={{ ...td, color: "#ef4444" }}>{fmt$(s.lifetimeTax)}</td>
                    <td style={{ ...td, color: s.lifetimeIRMAA > 0 ? "#f59e0b" : "#8b949e" }}>{s.lifetimeIRMAA > 0 ? fmt$(s.lifetimeIRMAA) : "—"}</td>
                    <td style={{ ...td, color: "#10b981", fontWeight: 600 }}>{fmt$(s.estateValue)}</td>
                    <td style={{ ...td, textAlign: "left" }}>
                      <button onClick={e => { e.stopPropagation(); onApply(s.typicalAnnualAmount, s.conversionYears); }}
                        style={{ background: "none", border: "1px solid #d0d7de", borderRadius: 4, padding: "2px 8px", fontSize: 11, cursor: "pointer", color: "#57606a" }}>Apply</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {selected && lifetimeChartData.length > 0 && (
        <Card title={`Lifetime Balances — ${selected.ceilingLabel}`}>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={lifetimeChartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="age" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={v => "$" + (v/1000).toFixed(0) + "k"} tick={{ fontSize: 11 }} />
              <Tooltip formatter={v => fmt$(v)} labelFormatter={v => `Age ${v}`} />
              <Legend />
              <Line type="monotone" dataKey="Trad IRA" stroke="#3b82d4" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="Roth IRA" stroke="#10b981" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="Estate"   stroke="#1f2328" strokeWidth={2} dot={false} strokeDasharray="3 2" />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      )}
    </div>
  );
}

// ─── Break-Even Panel ─────────────────────────────────────────────────────────
function BreakEvenPanel({ baseInputs, ssIncome, ssStartAge, endAge }) {
  const breakEvenData = useMemo(() => {
    try {
      return calcBreakEven({ ...baseInputs, socialSecurityBenefit: ssIncome, ssStartAge, endAge });
    } catch { return null; }
  }, [baseInputs, ssIncome, ssStartAge, endAge]);

  if (!breakEvenData) return <div style={{ padding: 20, color: "#57606a" }}>Enter inputs on the left to see break-even analysis.</div>;

  const { breakEvenAge, years } = breakEvenData;
  const chartData = years.map(y => ({ age: y.age, "Roth Strategy": y.rothEstate, "Do Nothing": y.baselineEstate, "Advantage": y.advantage }));
  const last = years[years.length - 1] ?? {};

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ background: breakEvenAge != null ? "linear-gradient(135deg,#f0fdf4,#dcfce7)" : "linear-gradient(135deg,#fef9f0,#fef3c7)",
        border: `1px solid ${breakEvenAge != null ? "#86efac" : "#fcd34d"}`, borderRadius: 10, padding: "20px 24px" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: breakEvenAge != null ? "#166534" : "#92400e", marginBottom: 12 }}>
          {breakEvenAge != null ? `✅ Roth strategy surpasses do-nothing at age ${breakEvenAge}` : "⚠ Roth strategy does not overtake do-nothing within the projection window"}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
          <StatBox label="Break-Even Age"       value={breakEvenAge ?? "N/A"}  color={breakEvenAge ? "#166534" : "#92400e"} />
          <StatBox label={`Roth Estate (${endAge})`}     value={fmt$(last.rothEstate)}      color="#10b981" />
          <StatBox label={`Baseline Estate (${endAge})`} value={fmt$(last.baselineEstate)}  color="#8b949e" />
          <StatBox label="Net Advantage"        value={fmt$(last.advantage)}   color={last.advantage >= 0 ? "#10b981" : "#ef4444"} />
        </div>
      </div>

      <Card title="Total Net Worth: Roth Strategy vs Do-Nothing">
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="age" tick={{ fontSize: 11 }} />
            <YAxis tickFormatter={v => "$" + (v/1000).toFixed(0) + "k"} tick={{ fontSize: 11 }} />
            <Tooltip formatter={v => fmt$(v)} labelFormatter={v => `Age ${v}`} />
            <Legend />
            {breakEvenAge != null && (
              <ReferenceLine x={breakEvenAge} stroke="#16a34a" strokeDasharray="6 3"
                label={{ value: `Break-even ${breakEvenAge}`, position: "top", fontSize: 11, fill: "#16a34a" }} />
            )}
            <Line type="monotone" dataKey="Roth Strategy" stroke="#10b981" strokeWidth={2.5} dot={false} />
            <Line type="monotone" dataKey="Do Nothing"    stroke="#8b949e" strokeWidth={2} dot={false} strokeDasharray="5 3" />
          </LineChart>
        </ResponsiveContainer>
      </Card>

      <Card title="Roth Advantage Over Do-Nothing">
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="age" tick={{ fontSize: 11 }} />
            <YAxis tickFormatter={v => "$" + (v/1000).toFixed(0) + "k"} tick={{ fontSize: 11 }} />
            <Tooltip formatter={v => fmt$(v)} labelFormatter={v => `Age ${v}`} />
            <ReferenceLine y={0} stroke="#374151" strokeWidth={1.5} />
            <Area type="monotone" dataKey="Advantage" stroke="#10b981" fill="#bbf7d0" strokeWidth={2} dot={false} baseValue={0} />
          </AreaChart>
        </ResponsiveContainer>
      </Card>
    </div>
  );
}

// ─── SS Claiming Age Panel ────────────────────────────────────────────────────
function SSClaimingPanel({ baseInputs, fraAnnualBenefit, endAge }) {
  const [selectedAge, setSelectedAge] = useState(67);

  const result = useMemo(() => {
    if (!fraAnnualBenefit || fraAnnualBenefit <= 0) return null;
    try { return calcSSClaimingComparison({ ...baseInputs, socialSecurityBenefit: fraAnnualBenefit, endAge }); }
    catch { return null; }
  }, [baseInputs, fraAnnualBenefit, endAge]);

  if (!fraAnnualBenefit || fraAnnualBenefit <= 0) return <div style={{ padding: 20, color: "#57606a" }}>Enter an annual SS benefit in the inputs panel.</div>;
  if (!result) return <div style={{ padding: 20, color: "#57606a" }}>Computing…</div>;

  const { scenarios } = result;
  const selected   = scenarios.find(s => s.claimAge === selectedAge) ?? scenarios[2];
  const bestEstate = scenarios.reduce((a, b) => a.estateValue > b.estateValue ? a : b);
  const bestCost   = scenarios.reduce((a, b) => a.lifetimeCost < b.lifetimeCost ? a : b);
  const COLORS = { 62: "#f59e0b", 65: "#3b82d4", 67: "#7c5cd8", 70: "#10b981" };
  const LABELS = { 62: "Early (62)", 65: "Age 65", 67: "FRA (67)", 70: "Maximum (70)" };

  const barData = scenarios.map(s => ({ name: LABELS[s.claimAge] ?? `Age ${s.claimAge}`,
    "Total SS": Math.round(s.totalSS), "Lifetime Tax": Math.round(s.lifetimeTax),
    "Estate Value": Math.round(s.estateValue), claimAge: s.claimAge }));

  const lifetimeData = selected.years.map(y => ({
    age: y.age, "SS Benefit": Math.round(y.ssBenefit), "MAGI": Math.round(y.magi),
    "Fed Tax": Math.round(y.totalFederalTax), "Estate": Math.round(y.estateValue),
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Card title="Select a Claiming Age">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
          {scenarios.map(s => {
            const isActive = s.claimAge === selectedAge;
            const isBestEstate = s.claimAge === bestEstate.claimAge;
            return (
              <button key={s.claimAge} onClick={() => setSelectedAge(s.claimAge)} style={{
                padding: "10px 18px", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600, position: "relative",
                background: isActive ? (COLORS[s.claimAge] ?? "#3b82d4") : "#f7f8fa",
                color: isActive ? "#fff" : "#1f2328",
                border: `2px solid ${isActive ? (COLORS[s.claimAge] ?? "#3b82d4") : "#e5e7eb"}`,
              }}>
                {isBestEstate && <span style={{ position: "absolute", top: -8, right: -8, background: "#10b981", color: "#fff", borderRadius: 10, padding: "1px 6px", fontSize: 10, fontWeight: 700 }}>★ BEST ESTATE</span>}
                {LABELS[s.claimAge] ?? `Age ${s.claimAge}`}
                <div style={{ fontSize: 11, fontWeight: 400, marginTop: 2, opacity: 0.85 }}>{fmt$(s.annualBenefit)}/yr</div>
              </button>
            );
          })}
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#f7f8fa" }}>
                {["Claim Age","Annual Benefit","Total SS Received","Lifetime Tax","Lifetime IRMAA","Estate at 90"].map(h => (
                  <th key={h} style={{ padding: "7px 10px", textAlign: "right", fontWeight: 600, color: "#57606a", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scenarios.map((s, i) => (
                <tr key={i} onClick={() => setSelectedAge(s.claimAge)}
                  style={{ background: s.claimAge === selectedAge ? "#eff6ff" : i%2===0?"#fff":"#fafafa", cursor: "pointer" }}>
                  <td style={{ ...td, color: COLORS[s.claimAge] ?? "#1f2328", fontWeight: 700 }}>{LABELS[s.claimAge] ?? `Age ${s.claimAge}`}</td>
                  <td style={td}>{fmt$(s.annualBenefit)}</td>
                  <td style={{ ...td, color: "#10b981" }}>{fmt$(s.totalSS)}</td>
                  <td style={{ ...td, color: "#ef4444" }}>{fmt$(s.lifetimeTax)}</td>
                  <td style={{ ...td, color: s.lifetimeIRMAA > 0 ? "#f59e0b" : "#8b949e" }}>{s.lifetimeIRMAA > 0 ? fmt$(s.lifetimeIRMAA) : "—"}</td>
                  <td style={{ ...td, color: "#10b981", fontWeight: 600 }}>{fmt$(s.estateValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="SS Benefit Comparison — Lifetime Totals">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={barData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="name" tick={{ fontSize: 12 }} />
            <YAxis tickFormatter={v => "$" + (v/1000).toFixed(0) + "k"} tick={{ fontSize: 12 }} />
            <Tooltip formatter={v => fmt$(v)} />
            <Legend />
            <Bar dataKey="Total SS"     fill="#10b981" radius={[3,3,0,0]} />
            <Bar dataKey="Lifetime Tax" fill="#ef4444" radius={[3,3,0,0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      {selected && (
        <Card title={`${LABELS[selected.claimAge] ?? `Age ${selected.claimAge}`} — Lifetime Income & Estate`}>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={lifetimeData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="age" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={v => "$" + (v/1000).toFixed(0) + "k"} tick={{ fontSize: 11 }} />
              <Tooltip formatter={v => fmt$(v)} labelFormatter={v => `Age ${v}`} />
              <Legend />
              <Line type="monotone" dataKey="SS Benefit" stroke="#10b981" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="MAGI"       stroke="#3b82d4" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="Estate"     stroke="#1f2328" strokeWidth={2} dot={false} strokeDasharray="3 2" />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [tradIRA,       setTradIRA]       = useState(500000);
  const [brokerage,     setBrokerage]     = useState(100000);
  const [conversion,    setConversion]    = useState(50000);
  const [years,         setYears]         = useState(10);
  const [growth,        setGrowth]        = useState(7);
  const [filing,        setFiling]        = useState("mfj");
  const [age,           setAge]           = useState(58);
  const [birthYear,     setBirthYear]     = useState(new Date().getFullYear() - 58);
  const [otherIncome,   setOtherIncome]   = useState(30000);
  const [inflation,     setInflation]     = useState(2.5);
  const [ssIncome,      setSsIncome]      = useState(24000);
  const [ssStartAge,    setSsStartAge]    = useState(67);
  const [endAge,        setEndAge]        = useState(90);
  const [stateKey,      setStateKey]      = useState("None (no state tax)");
  const [activeTab,     setActiveTab]     = useState("smart");
  const [appliedSched,  setAppliedSched]  = useState(null);

  const stateTaxRate = STATE_TAX_RATES[stateKey] ?? 0;

  const handleAgeChange = (v) => { setAge(v); setBirthYear(new Date().getFullYear() - v); };

  const baseInputs = {
    traditionalIRABalance:   tradIRA,
    taxableBrokerageBalance: brokerage,
    growthRate:              growth / 100,
    filingStatus:            filing,
    currentAge:              Math.round(age),
    birthYear:               Math.round(birthYear),
    otherOrdinaryIncome:     otherIncome,
    inflationRate:           inflation / 100,
    stateTaxRate,
  };

  function handleApplySchedule(schedule) {
    if (!schedule?.length) return;
    const avgConv = Math.round(schedule.reduce((s, r) => s + r.conversionAmount, 0) / schedule.length);
    setConversion(avgConv);
    setYears(schedule.length);
    setAppliedSched(schedule);
    setActiveTab("manual");
  }

  function handleApplyOptimized(amount, numYears) {
    setConversion(amount);
    setYears(numYears);
    setActiveTab("manual");
  }

  const tabs = [
    ["smart",      "🧠 Smart Variable"],
    ["manual",     "📊 Manual Simulator"],
    ["brackets",   "🎯 Bracket Comparison"],
    ["optimize",   "⚡ Optimize for Me"],
    ["breakeven",  "📈 Break-Even"],
    ["ssclaiming", "🔵 SS Claiming Age"],
  ];

  const needsSS = ["optimize","breakeven","ssclaiming"].includes(activeTab);

  return (
    <div style={{ minHeight: "100vh", background: "#f0f2f5", padding: "24px 16px" }}>
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>

        {/* Header */}
        <div style={{ background: "#1f2328", borderRadius: 10, padding: "20px 28px", color: "#fff" }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>🧠 Roth Conversion Optimizer</h1>
          <p style={{ color: "#8b949e", marginTop: 4, fontSize: 14 }}>
            Smart Variable Strategy · Bracket Comparison · Lifetime Optimizer · Break-Even · SS Claiming · 2026 brackets &amp; IRMAA thresholds
          </p>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {tabs.map(([id, label]) => (
            <button key={id} onClick={() => setActiveTab(id)} style={{
              padding: "9px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer",
              background: activeTab === id ? "#1f2328" : "#fff",
              color:      activeTab === id ? "#fff"     : "#57606a",
              border:     activeTab === id ? "2px solid #1f2328" : "2px solid #e5e7eb",
            }}>
              {label}
            </button>
          ))}
        </div>

        {/* Layout: inputs + main panel */}
        <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 20 }}>

          {/* Inputs panel */}
          <Card title="Household Inputs">
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <InputField label="Traditional IRA Balance"       id="tradIRA"   value={tradIRA}     onChange={setTradIRA}    prefix="$" step={1000} />
              <InputField label="Taxable Brokerage (for taxes)" id="brokerage" value={brokerage}   onChange={setBrokerage}  prefix="$" step={1000} note="Pays annual tax bills" />
              <InputField label="Other Annual Income (MAGI)"    id="other"     value={otherIncome} onChange={setOtherIncome} prefix="$" step={1000}
                note="Wages, pension, Social Security, dividends, etc." />

              {activeTab === "manual" && <>
                <InputField label="Annual Roth Conversion" id="conv" value={conversion} onChange={setConversion} prefix="$" step={1000} note="Fixed amount converted each year" />
                <InputField label="Conversion Years"       id="cyrs" value={years}      onChange={setYears}      suffix="yrs" min={1} max={40} step={1} />
              </>}

              {needsSS && <>
                <InputField label="Annual SS Benefit (FRA at 67)" id="ss" value={ssIncome} onChange={setSsIncome} prefix="$" step={1000}
                  note={activeTab === "ssclaiming" ? "Enter your FRA benefit at age 67. Other ages are calculated automatically." : "Annual gross Social Security benefit"} />
                <InputField label="SS Start Age" id="ssAge" value={ssStartAge} onChange={setSsStartAge} min={62} max={70} suffix="yrs"
                  note={activeTab === "ssclaiming" ? "Used for Optimizer & Break-Even; SS tab compares all ages." : "Age you begin collecting SS"} />
                <InputField label="Project Through Age" id="endAge" value={endAge} onChange={setEndAge} min={75} max={100} suffix="yrs" />
              </>}

              {activeTab === "brackets" && <>
                <InputField label="Annual SS Benefit" id="ssBr"    value={ssIncome}   onChange={setSsIncome}   prefix="$" step={1000} />
                <InputField label="SS Start Age"      id="ssAgeBr" value={ssStartAge} onChange={setSsStartAge} min={62} max={70} suffix="yrs" />
                <InputField label="Project Through Age" id="endAgeBr" value={endAge} onChange={setEndAge} min={75} max={100} suffix="yrs" />
              </>}

              <InputField label="Annual Growth Rate"   id="growth" value={growth}    onChange={setGrowth}    suffix="%" step={0.5} min={0} max={20} />
              <InputField label="Annual Inflation Rate" id="infl"  value={inflation} onChange={setInflation}  suffix="%" step={0.1} min={0} max={10}
                note="Scales tax brackets &amp; IRMAA thresholds each year." />
              <InputField label="Current Age"   id="age" value={age}       onChange={handleAgeChange} suffix="yrs" min={18} max={85} />
              <InputField label="Birth Year"    id="by"  value={birthYear} onChange={v => { setBirthYear(v); setAge(new Date().getFullYear() - v); }} min={1930} max={2006}
                note={birthYear <= 1950 ? "RMD starts age 72" : birthYear <= 1959 ? "RMD starts age 73" : "RMD starts age 75"} />

              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label htmlFor="filing" style={{ fontSize: 13, fontWeight: 600 }}>Filing Status</label>
                <select id="filing" value={filing} onChange={e => setFiling(e.target.value)}
                  style={{ padding: "7px 10px", border: "1px solid #d0d7de", borderRadius: 6, fontSize: 14, background: "#fff" }}>
                  <option value="single">Single</option>
                  <option value="mfj">Married Filing Jointly</option>
                </select>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label htmlFor="stateTax" style={{ fontSize: 13, fontWeight: 600 }}>State Tax on Conversion</label>
                <select id="stateTax" value={stateKey} onChange={e => setStateKey(e.target.value)}
                  style={{ padding: "7px 10px", border: "1px solid #d0d7de", borderRadius: 6, fontSize: 14, background: "#fff" }}>
                  <optgroup label="── No income tax">
                    {["None (no state tax)","AK – Alaska","FL – Florida","NV – Nevada","NH – New Hampshire","SD – South Dakota","TN – Tennessee","TX – Texas","WA – Washington","WY – Wyoming"].map(k => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </optgroup>
                  <optgroup label="── Conversion fully exempt">
                    {["AL – Alabama","IL – Illinois","MS – Mississippi","PA – Pennsylvania"].map(k => (
                      <option key={k} value={k}>{k} — exempt</option>
                    ))}
                  </optgroup>
                  <optgroup label="── Taxed">
                    {Object.entries(STATE_TAX_RATES).filter(([,v]) => v > 0).map(([k, v]) => (
                      <option key={k} value={k}>{k} — {(v*100).toFixed(2)}%</option>
                    ))}
                  </optgroup>
                </select>
                {STATE_TAX_NOTES[stateKey] && (
                  <span style={{ fontSize: 12, color: STATE_TAX_RATES[stateKey] === 0 ? "#166534" : "#57606a" }}>
                    {STATE_TAX_NOTES[stateKey]}
                  </span>
                )}
              </div>

              {/* 2026 Key Thresholds reference */}
              <div style={{ background: "#f7f8fa", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#57606a", marginBottom: 6 }}>
                  2026 {filing === "mfj" ? "MFJ" : "Single"} Key Thresholds
                </div>
                {[
                  ["24% bracket top",      fmt$(TAX_BRACKETS_2026[filing].find(b => b.rate === 0.24)?.max + STANDARD_DEDUCTION_2026[filing])],
                  ["IRMAA Tier 2 ceiling", fmt$(IRMAA_TIERS_2026[filing].find(t => t.tier === 2)?.maxMAGI)],
                  ["IRMAA Tier 0 ceiling", fmt$(IRMAA_TIERS_2026[filing].find(t => t.tier === 0)?.maxMAGI)],
                  ["Standard deduction",   fmt$(STANDARD_DEDUCTION_2026[filing])],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
                    <span style={{ color: "#57606a" }}>{k}</span><strong>{v}</strong>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          {/* Main panel */}
          <div>
            {activeTab === "smart" && (
              <SmartStrategyPanel baseInputs={baseInputs} onApply={handleApplySchedule} />
            )}
            {activeTab === "manual" && (
              <ManualPanel baseInputs={baseInputs} conversion={conversion} setConversion={setConversion}
                years={years} setYears={setYears} appliedSchedule={appliedSched} stateTaxRate={stateTaxRate} />
            )}
            {activeTab === "brackets" && (
              <BracketPanel baseInputs={baseInputs} ssIncome={ssIncome} ssStartAge={Math.round(ssStartAge)}
                endAge={Math.round(endAge)} onApply={handleApplyOptimized} />
            )}
            {activeTab === "optimize" && (
              <OptimizerPanel baseInputs={baseInputs} ssIncome={ssIncome} ssStartAge={Math.round(ssStartAge)}
                endAge={Math.round(endAge)} onApply={handleApplyOptimized} />
            )}
            {activeTab === "breakeven" && (
              <BreakEvenPanel baseInputs={{ ...baseInputs, annualRothConversion: conversion, conversionYears: Math.round(years) }}
                ssIncome={ssIncome} ssStartAge={Math.round(ssStartAge)} endAge={Math.round(endAge)} />
            )}
            {activeTab === "ssclaiming" && (
              <SSClaimingPanel baseInputs={{ ...baseInputs, annualRothConversion: conversion, conversionYears: Math.round(years) }}
                fraAnnualBenefit={ssIncome} endAge={Math.round(endAge)} />
            )}
          </div>
        </div>

        <div style={{ textAlign: "center", fontSize: 12, color: "#8b949e", padding: "8px 0 16px" }}>
          2026 projected federal tax brackets · 2026 Medicare IRMAA thresholds (CMS projected) · IRMAA 2-year lookback · IRS Uniform Lifetime Table for RMDs
        </div>
      </div>
    </div>
  );
}

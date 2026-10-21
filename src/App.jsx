import { useState, useMemo, useCallback } from "react";
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area, ReferenceLine,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import {
  runSimulation,
  runSmartVariableSimulation,
  calculateOptimalVariableConversions,
  calcIRMAARaw,
  TAX_BRACKETS_2026,
  IRMAA_TIERS_2026,
  STANDARD_DEDUCTION_2026,
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
      background: "#fff",
      border: "1px solid #e5e7eb",
      borderRadius: 10,
      padding: "20px 24px",
      borderTop: accent ? `3px solid ${accent}` : undefined,
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

function InputField({ label, id, value, onChange, type = "number", min, max, step, note, prefix, suffix }) {
  const [draft, setDraft] = useState(String(value));

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
        <input
          id={id}
          type="text"
          inputMode="numeric"
          value={draft}
          onChange={handleChange}
          onBlur={handleBlur}
          style={{
            flex: 1, padding: "7px 10px", border: "1px solid #d0d7de",
            borderRadius: 6, fontSize: 14, outline: "none", background: "#fff",
          }}
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
      <span style={{ background: crosses ? "#fef3c7" : "#f7f8fa", color: crosses ? "#92400e" : "#8b949e", borderRadius: 4, padding: "2px 7px", fontSize: 12, fontStyle: "italic" }}
        title="Not on Medicare yet. Shows impact this income will have on IRMAA in 2 years.">
        {crosses ? `⚠ ${label} (future)` : "N/A"}
      </span>
    );
  }
  return (
    <span style={{ background: crosses ? "#fff3cd" : "#d1fae5", color: crosses ? "#92400e" : "#065f46", borderRadius: 4, padding: "2px 7px", fontSize: 12, fontWeight: 600 }}>
      {label}
    </span>
  );
}

const td = {
  padding: "7px 10px",
  textAlign: "right",
  borderBottom: "1px solid #f0f0f0",
  whiteSpace: "nowrap",
};

function exportCSV(rows, headers, filename) {
  const esc = v => { if (v == null) return ""; const s = String(v); return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [headers.map(esc).join(","), ...rows.map(row => headers.map(h => esc(row[h])).join(","))];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}

// ─── Phase badge ──────────────────────────────────────────────────────────────
function PhaseBadge({ phase }) {
  const cfg = {
    golden_window:   { bg: "#dbeafe", color: "#1e40af", label: "GOLDEN WINDOW" },
    irmaa_cap:       { bg: "#fef3c7", color: "#92400e", label: "IRMAA CAP" },
    conversion:      { bg: "#dbeafe", color: "#1e40af", label: "CONVERSION" },
    post_conversion: { bg: "#e5e7eb", color: "#57606a", label: "POST-CONV" },
    rmd:             { bg: "#fde68a", color: "#92400e", label: "RMD" },
  }[phase] ?? { bg: "#f7f8fa", color: "#57606a", label: phase.toUpperCase() };
  return (
    <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 3, fontWeight: 600, background: cfg.bg, color: cfg.color }}>
      {cfg.label}
    </span>
  );
}

// ─── Smart Strategy Panel ─────────────────────────────────────────────────────
function SmartStrategyPanel({ baseInputs, onApply }) {
  const [targetBracketRate, setTargetBracketRate] = useState(0.24);
  const [targetIrmaaaTier,  setTargetIrmaaaTier]  = useState(2);
  const [endAge,            setEndAge]            = useState(90);
  const [showSchedule,      setShowSchedule]      = useState(false);

  const { filingStatus, currentAge, otherOrdinaryIncome: baseIncome = 0 } = baseInputs;

  // Resolve ceilings from bracket/IRMAA tier selections
  const resolvedCeilings = useMemo(() => {
    try {
      const bCeiling = bracketCeiling(filingStatus, targetBracketRate);
      const iCeiling = irmaaTierCeiling(filingStatus, targetIrmaaaTier);
      return { bCeiling, iCeiling, error: null };
    } catch (e) {
      return { bCeiling: null, iCeiling: null, error: e.message };
    }
  }, [filingStatus, targetBracketRate, targetIrmaaaTier]);

  const { result, error } = useMemo(() => {
    if (!resolvedCeilings.bCeiling) return { result: null, error: resolvedCeilings.error };
    try {
      const r = runSmartVariableSimulation({
        ...baseInputs,
        baseIncome,
        targetBracketCeiling: resolvedCeilings.bCeiling,
        targetIrmaaCeiling:   resolvedCeilings.iCeiling,
        endAge,
      });
      return { result: r, error: null };
    } catch (e) {
      return { result: null, error: e.message };
    }
  }, [baseInputs, baseIncome, resolvedCeilings, endAge]);

  const s = result?.summary;
  const convSched = result?.conversionSchedule ?? [];

  // Chart data — variable drain rate
  const drainChartData = convSched.map(row => ({
    age:        row.age,
    "Conversion":      Math.round(row.conversionAmount),
    "IRA Balance":     Math.round(row.iraBalanceAfter),
    "MAGI":            Math.round(row.magi),
    phase:             row.phase,
  }));

  // Lifetime chart data
  const lifetimeData = (result?.years ?? []).map(y => ({
    age:         y.age,
    "Trad IRA":  Math.round(y.endingTraditionalIRA),
    "Roth IRA":  Math.round(y.endingRothIRA),
    "Taxable":   Math.round(y.endingTaxableBrokerage),
    "Fed Tax":   Math.round(y.federalTax),
    "MAGI":      Math.round(y.magi),
    "IRMAA":     Math.round(y.irmaa?.annualSurcharge ?? 0),
    "Estate":    Math.round(y.estateValue),
  }));

  // Summary stats for Phase 1 vs Phase 2
  const phase1Rows = convSched.filter(r => r.phase === "golden_window");
  const phase2Rows = convSched.filter(r => r.phase === "irmaa_cap");
  const p1Total    = phase1Rows.reduce((s, r) => s + r.conversionAmount, 0);
  const p2Total    = phase2Rows.reduce((s, r) => s + r.conversionAmount, 0);

  const bracketLabel = (TAX_BRACKETS_2026[filingStatus].find(b => b.rate === targetBracketRate)?.rate * 100).toFixed(0) + "%";
  const irmaaLabel   = IRMAA_TIERS_2026[filingStatus].find(t => t.tier === targetIrmaaaTier)?.label;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* Strategy controls */}
      <Card title="Smart Variable Conversion — Strategy Parameters">
        <div style={{ fontSize: 13, color: "#57606a", marginBottom: 16, padding: "10px 14px", background: "#eff6ff", borderRadius: 8, border: "1px solid #bfdbfe" }}>
          <strong style={{ color: "#1e40af" }}>🧠 How it works:</strong>
          <span style={{ marginLeft: 6 }}>
            Before age 63 <strong>(Golden Window)</strong>, converts up to the top of your target tax bracket — no IRMAA risk because Medicare's 2-year lookback means age-65 premiums are already locked in.
            From age 63+ <strong>(IRMAA Cap)</strong>, throttles down to stop exactly at your chosen IRMAA tier ceiling to prevent cliff penalties.
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
          {/* Phase 1 target */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 13, fontWeight: 600 }}>Phase 1 — Target Tax Bracket</label>
            <select value={targetBracketRate} onChange={e => setTargetBracketRate(Number(e.target.value))}
              style={{ padding: "7px 10px", border: "1px solid #d0d7de", borderRadius: 6, fontSize: 14, background: "#fff" }}>
              <option value={0.10}>10% bracket</option>
              <option value={0.12}>12% bracket</option>
              <option value={0.22}>22% bracket</option>
              <option value={0.24}>24% bracket (recommended)</option>
              <option value={0.32}>32% bracket</option>
              <option value={0.35}>35% bracket</option>
            </select>
            {resolvedCeilings.bCeiling && (
              <span style={{ fontSize: 12, color: "#3b82d4" }}>
                MAGI ceiling: {fmt$(resolvedCeilings.bCeiling)} · Max annual conversion: {fmt$(Math.max(0, resolvedCeilings.bCeiling - baseIncome))}
              </span>
            )}
            <span style={{ fontSize: 12, color: "#57606a" }}>Ages &lt;63 only. Formula: Bracket Ceiling − Base Income</span>
          </div>

          {/* Phase 2 target */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 13, fontWeight: 600 }}>Phase 2 — IRMAA Tier Cap</label>
            <select value={targetIrmaaaTier} onChange={e => setTargetIrmaaaTier(Number(e.target.value))}
              style={{ padding: "7px 10px", border: "1px solid #d0d7de", borderRadius: 6, fontSize: 14, background: "#fff" }}>
              <option value={0}>No IRMAA (Tier 0) — {filingStatus === "mfj" ? "$218k" : "$109k"} limit</option>
              <option value={1}>Tier 1 — {filingStatus === "mfj" ? "$272k" : "$136k"} limit</option>
              <option value={2}>Tier 2 — {filingStatus === "mfj" ? "$326k" : "$163k"} limit (recommended)</option>
              <option value={3}>Tier 3 — {filingStatus === "mfj" ? "$392k" : "$196k"} limit</option>
              <option value={4}>Tier 4 — {filingStatus === "mfj" ? "$750k" : "$500k"} limit</option>
            </select>
            {resolvedCeilings.iCeiling && (
              <span style={{ fontSize: 12, color: "#f59e0b" }}>
                MAGI ceiling: {fmt$(resolvedCeilings.iCeiling)} · Max annual conversion: {fmt$(Math.max(0, resolvedCeilings.iCeiling - baseIncome))}
              </span>
            )}
            <span style={{ fontSize: 12, color: "#57606a" }}>Ages 63+. Formula: IRMAA Ceiling − Base Income</span>
          </div>

          {/* End age */}
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

      {error && (
        <div style={{ background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 8, padding: "12px 16px", color: "#991b1b", fontSize: 14 }}>
          ⚠ {error}
        </div>
      )}

      {s && (
        <>
          {/* Summary hero */}
          <div style={{
            background: "linear-gradient(135deg,#eff6ff,#dbeafe)",
            border: "1px solid #93c5fd", borderRadius: 10, padding: "20px 24px",
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#1e40af", marginBottom: 14 }}>
              🧠 Smart Variable Strategy Result — {bracketLabel} bracket (Phase 1) → {irmaaLabel} IRMAA cap (Phase 2)
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 12 }}>
              <StatBox label="Total Converted" value={fmt$(s.totalAmountConverted)} color="#3b82d4" />
              <StatBox label="Conversion Years" value={`${s.conversionYears} yrs`} color="#1f2328" />
              <StatBox label="Phase 1 (Golden)" value={fmt$(p1Total)} color="#10b981" sub={`${phase1Rows.length} yr${phase1Rows.length !== 1 ? "s" : ""} < age 63`} />
              <StatBox label="Phase 2 (IRMAA Cap)" value={fmt$(p2Total)} color="#f59e0b" sub={`${phase2Rows.length} yr${phase2Rows.length !== 1 ? "s" : ""} ≥ age 63`} />
              <StatBox label="Estate at Age" value={fmt$(s.estateValueAtEndAge)} color="#10b981" sub={`age ${endAge}`} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginTop: 14 }}>
              <StatBox label="Lifetime Federal Tax" value={fmt$(s.totalFederalTax)} color="#ef4444" />
              <StatBox label="Lifetime IRMAA" value={fmt$(s.totalIRMAA)} color={s.totalIRMAA > 0 ? "#f59e0b" : "#8b949e"} />
              <StatBox label="Lifetime Total Cost" value={fmt$(s.totalLifetimeCost)} color="#7c5cd8" />
            </div>
          </div>

          {/* Phase transition info banner */}
          {currentAge < 63 && phase1Rows.length > 0 && (
            <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 8, padding: "12px 16px", fontSize: 13, color: "#166534" }}>
              <strong>✅ Golden Window Active!</strong> At age {currentAge} you have <strong>{63 - currentAge} year{63 - currentAge !== 1 ? "s" : ""}</strong> in the IRMAA-safe golden window.
              The strategy maximizes conversions in these years ({fmt$(p1Total)} total) since any income earned before age 63 cannot affect Medicare premiums at age 65 due to the 2-year lookback.
              {phase2Rows.length > 0 && (
                <> Starting at age 63, the strategy throttles to the <strong>{irmaaLabel}</strong> ceiling ({fmt$(resolvedCeilings.iCeiling)}) to avoid IRMAA cliff penalties.</>
              )}
            </div>
          )}

          {currentAge >= 63 && (
            <div style={{ background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 8, padding: "12px 16px", fontSize: 13, color: "#92400e" }}>
              <strong>⚠ IRMAA Window:</strong> At age {currentAge} you are already in Phase 2. All conversions are capped at the <strong>{irmaaLabel}</strong> MAGI ceiling ({fmt$(resolvedCeilings.iCeiling)}) to prevent Medicare surcharge cliff penalties. The Golden Window (ages &lt;63) has passed.
            </div>
          )}

          {/* Variable conversion drain chart */}
          <Card title="Dynamic Conversion Amount — Year-by-Year Variable Drain Rate">
            <div style={{ fontSize: 13, color: "#57606a", marginBottom: 10 }}>
              The conversion amount <strong>shifts dynamically</strong> at age 63: Phase 1 (blue) fills to the {bracketLabel} bracket ceiling; Phase 2 (amber) caps at the {irmaaLabel} IRMAA tier.
              The IRA balance line shows the drain rate.
            </div>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={drainChartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="age" tick={{ fontSize: 11 }} label={{ value: "Age", position: "insideBottom", offset: -2, fontSize: 11 }} />
                <YAxis yAxisId="left"  tickFormatter={v => "$" + (v / 1000).toFixed(0) + "k"} tick={{ fontSize: 11 }} />
                <YAxis yAxisId="right" orientation="right" tickFormatter={v => "$" + (v / 1000).toFixed(0) + "k"} tick={{ fontSize: 11 }} />
                <Tooltip formatter={v => fmt$(v)} labelFormatter={v => `Age ${v}`} />
                <Legend />
                <Bar yAxisId="left" dataKey="Conversion" fill="#3b82d4" radius={[3, 3, 0, 0]}
                  label={false}
                />
                {/* IRMAA cap phase rendered over top in amber */}
                <Bar yAxisId="left" dataKey={(row) => row.phase === "irmaa_cap" ? row["Conversion"] : 0}
                  name="IRMAA Cap Phase" fill="#f59e0b" radius={[3, 3, 0, 0]} stackId="hidden" />
                <Line yAxisId="right" type="monotone" dataKey="IRA Balance" stroke="#1f2328" strokeWidth={2} dot={false} />
                {currentAge < 63 && <ReferenceLine yAxisId="left" x={63} stroke="#ef4444" strokeDasharray="6 3" label={{ value: "Age 63 — IRMAA Window", fontSize: 10, fill: "#ef4444" }} />}
              </BarChart>
            </ResponsiveContainer>
            <div style={{ display: "flex", gap: 16, marginTop: 10, fontSize: 12, color: "#57606a" }}>
              <span style={{ background: "#dbeafe", padding: "2px 8px", borderRadius: 3 }}>🔵 Golden Window: max {bracketLabel} bracket fill</span>
              <span style={{ background: "#fef3c7", padding: "2px 8px", borderRadius: 3 }}>🟡 IRMAA Cap: throttled to {irmaaLabel} ceiling</span>
            </div>
          </Card>

          {/* MAGI chart with IRMAA reference */}
          <Card title="Projected MAGI vs Ceiling Targets">
            <div style={{ fontSize: 13, color: "#57606a", marginBottom: 10 }}>
              MAGI stays at or below the bracket ceiling in Phase 1, and at or below the IRMAA ceiling in Phase 2.
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={lifetimeData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="age" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={v => "$" + (v / 1000).toFixed(0) + "k"} tick={{ fontSize: 11 }} />
                <Tooltip formatter={v => fmt$(v)} labelFormatter={v => `Age ${v}`} />
                <Legend />
                <Line type="monotone" dataKey="MAGI" stroke="#3b82d4" strokeWidth={2} dot={false} />
                <ReferenceLine y={resolvedCeilings.bCeiling} stroke="#10b981" strokeDasharray="6 3"
                  label={{ value: `${bracketLabel} bracket: ${fmt$(resolvedCeilings.bCeiling)}`, position: "right", fontSize: 10, fill: "#10b981" }} />
                <ReferenceLine y={resolvedCeilings.iCeiling} stroke="#f59e0b" strokeDasharray="6 3"
                  label={{ value: `${irmaaLabel}: ${fmt$(resolvedCeilings.iCeiling)}`, position: "right", fontSize: 10, fill: "#f59e0b" }} />
                {currentAge < 63 && <ReferenceLine x={63} stroke="#ef4444" strokeDasharray="5 3" />}
              </LineChart>
            </ResponsiveContainer>
          </Card>

          {/* Lifetime account balances */}
          <Card title="Lifetime Account Balances — Traditional IRA Drain + Roth Accumulation">
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={lifetimeData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="age" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={v => "$" + (v / 1000).toFixed(0) + "k"} tick={{ fontSize: 11 }} />
                <Tooltip formatter={v => fmt$(v)} labelFormatter={v => `Age ${v}`} />
                <Legend />
                <Line type="monotone" dataKey="Trad IRA"  stroke="#3b82d4" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="Roth IRA"  stroke="#10b981" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="Taxable"   stroke="#f59e0b" strokeWidth={2} dot={false} strokeDasharray="5 3" />
                <Line type="monotone" dataKey="Estate"    stroke="#1f2328" strokeWidth={2} dot={false} strokeDasharray="3 2" />
              </LineChart>
            </ResponsiveContainer>
          </Card>

          {/* Tax & IRMAA cost chart */}
          <Card title="Annual Federal Tax + IRMAA — Lifetime Cost Profile">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={lifetimeData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="age" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={v => "$" + (v / 1000).toFixed(0) + "k"} tick={{ fontSize: 11 }} />
                <Tooltip formatter={v => fmt$(v)} labelFormatter={v => `Age ${v}`} />
                <Legend />
                <Bar dataKey="Fed Tax" fill="#ef4444" stackId="cost" />
                <Bar dataKey="IRMAA"   fill="#f59e0b" stackId="cost" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>

          {/* Conversion schedule table */}
          {showSchedule && (
            <Card title="Variable Conversion Schedule — Year-by-Year Detail">
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
                <button onClick={() => exportCSV(
                  convSched.map(r => ({
                    "Age": r.age, "Phase": r.phase === "golden_window" ? "Golden Window (<63)" : "IRMAA Cap (≥63)",
                    "Ceiling": r.ceiling, "Conversion": r.conversionAmount,
                    "MAGI": r.magi, "IRA Before": r.iraBalanceBefore, "IRA After": r.iraBalanceAfter,
                  })),
                  ["Age","Phase","Ceiling","Conversion","MAGI","IRA Before","IRA After"],
                  "smart-variable-conversion-schedule.csv"
                )}
                  style={{ background: "#3b82d4", color: "#fff", border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
                  ⬇ Export CSV
                </button>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: "#f7f8fa" }}>
                      {["Age","Phase","Annual Ceiling","Conversion Amount","MAGI","IRA Before","IRA After"].map(h => (
                        <th key={h} style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600, color: "#57606a", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {convSched.map((r, i) => {
                      const isGolden = r.phase === "golden_window";
                      return (
                        <tr key={i} style={{ background: isGolden ? "#eff6ff" : "#fffbeb" }}>
                          <td style={td}>{r.age}</td>
                          <td style={{ ...td, textAlign: "center" }}>
                            <PhaseBadge phase={r.phase} />
                          </td>
                          <td style={{ ...td, color: isGolden ? "#3b82d4" : "#f59e0b" }}>{fmt$(r.ceiling)}</td>
                          <td style={{ ...td, color: "#1f2328", fontWeight: 600 }}>{fmt$(r.conversionAmount)}</td>
                          <td style={td}>{fmt$(r.magi)}</td>
                          <td style={td}>{fmt$(r.iraBalanceBefore)}</td>
                          <td style={{ ...td, color: r.iraBalanceAfter === 0 ? "#ef4444" : "#10b981", fontWeight: 600 }}>
                            {fmt$(r.iraBalanceAfter)}
                            {r.iraBalanceAfter === 0 && <span style={{ marginLeft: 4, fontSize: 10 }}>✓ ZERO</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ display: "flex", gap: 16, marginTop: 10, fontSize: 12, color: "#57606a" }}>
                <span style={{ background: "#dbeafe", padding: "2px 8px", borderRadius: 3 }}>🔵 Golden Window — Phase 1 (age &lt;63): fills to {bracketLabel} bracket</span>
                <span style={{ background: "#fef3c7", padding: "2px 8px", borderRadius: 3 }}>🟡 IRMAA Cap — Phase 2 (age ≥63): capped at {irmaaLabel}</span>
              </div>
            </Card>
          )}

          {/* Full year-by-year lifetime detail */}
          <Card title="Lifetime Simulation Detail">
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "#f7f8fa" }}>
                    {["Age","Phase","Conversion","MAGI","Fed Tax","Eff. Rate","IRMAA","Trad IRA","Roth IRA","Estate"].map(h => (
                      <th key={h} style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600, color: "#57606a", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(result?.years ?? []).map((y, i) => (
                    <tr key={i} style={{
                      background: y.phase === "conversion" && y.conversionAmount > 0 ? (y.age < 63 ? "#eff6ff" : "#fffbeb") :
                        y.phase === "rmd" ? "#fef3c7" : i % 2 === 0 ? "#fff" : "#fafafa"
                    }}>
                      <td style={td}>{y.age}</td>
                      <td style={{ ...td, textAlign: "center" }}><PhaseBadge phase={y.age < 63 && y.conversionAmount > 0 ? "golden_window" : y.age >= 63 && y.conversionAmount > 0 ? "irmaa_cap" : y.phase} /></td>
                      <td style={{ ...td, color: "#3b82d4" }}>{y.conversionAmount > 0 ? fmt$(y.conversionAmount) : "—"}</td>
                      <td style={td}>{fmt$(y.magi)}</td>
                      <td style={{ ...td, color: "#ef4444" }}>{fmt$(y.federalTax)}</td>
                      <td style={td}>{fmtPct(y.effectiveRate)}</td>
                      <td style={{ ...td, textAlign: "center" }}>
                        <IRMAAbadge
                          label={y.onMedicare ? (y.irmaa?.label ?? "—") : (y.futureIRMAA?.label ?? "—")}
                          crosses={y.onMedicare ? y.irmaa?.crossesThreshold : y.futureIRMAA?.crossesThreshold}
                          notOnMedicare={!y.onMedicare}
                        />
                      </td>
                      <td style={td}>{fmt$(y.endingTraditionalIRA)}</td>
                      <td style={{ ...td, color: "#10b981", fontWeight: 600 }}>{fmt$(y.endingRothIRA)}</td>
                      <td style={{ ...td, fontWeight: 600 }}>{fmt$(y.estateValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

// ─── Manual Simulator Panel ───────────────────────────────────────────────────
function ManualPanel({ baseInputs, conversion, setConversion, years, setYears, appliedSchedule }) {
  const { result, error } = useMemo(() => {
    try {
      const r = runSimulation({ ...baseInputs, annualRothConversion: conversion, conversionYears: Math.round(years) });
      return { result: r, error: null };
    } catch (e) { return { result: null, error: e.message }; }
  }, [baseInputs, conversion, years]);

  const s = result?.summary;

  const chartData = (result?.years ?? []).map((y, i) => ({
    name:      `Age ${y.age}`,
    age:       y.age,
    "Trad IRA":    Math.round(y.endingTraditionalIRA),
    "Roth IRA":    Math.round(y.endingRothIRA),
    "Taxable":     Math.round(y.endingTaxableBrokerage),
    "Conv. Tax":   Math.round(y.conversionTax),
    "MAGI":        Math.round(y.magi),
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {appliedSchedule && (
        <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#166534" }}>
          <strong>✓ Smart Strategy applied</strong> — {appliedSchedule.length} variable conversion years loaded. Below shows the static approximation using the average annual amount.
        </div>
      )}
      {error && (
        <div style={{ background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 8, padding: "12px 16px", color: "#991b1b", fontSize: 14 }}>⚠ {error}</div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 16 }}>
        <Card title="Conversion Inputs">
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <InputField label="Annual Conversion" id="conv" value={conversion} onChange={setConversion} prefix="$" />
            <InputField label="Conversion Years" id="years" value={years} onChange={setYears} min={1} max={30} suffix="yrs" />
          </div>
        </Card>

        {s && (
          <Card title="Conversion Window Summary" accent="#3b82d4">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }}>
              <StatBox label="Total Converted" value={fmt$(s.totalAmountConverted)} color="#3b82d4" />
              <StatBox label="Conversion Tax" value={fmt$(s.totalFederalTaxOnConversions)} color="#ef4444" />
              <StatBox label="IRMAA Surcharge" value={fmt$(s.totalIRMAASurcharges)} color={s.totalIRMAASurcharges > 0 ? "#f59e0b" : "#8b949e"} />
              <StatBox label="Final Roth IRA" value={fmt$(s.finalRothIRA)} color="#10b981" />
            </div>
          </Card>
        )}
      </div>

      {chartData.length > 0 && (
        <>
          <Card title="Account Balances">
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={v => "$" + (v / 1000).toFixed(0) + "k"} tick={{ fontSize: 12 }} />
                <Tooltip formatter={v => fmt$(v)} />
                <Legend />
                <Line type="monotone" dataKey="Trad IRA" stroke="#3b82d4" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="Roth IRA" stroke="#10b981" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="Taxable"  stroke="#f59e0b" strokeWidth={2} dot={false} strokeDasharray="5 3" />
              </LineChart>
            </ResponsiveContainer>
          </Card>
          <Card title="Annual Conversion Tax">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={v => "$" + (v / 1000).toFixed(0) + "k"} tick={{ fontSize: 12 }} />
                <Tooltip formatter={v => fmt$(v)} />
                <Legend />
                <Bar dataKey="Conv. Tax" fill="#ef4444" radius={[4, 4, 0, 0]} />
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
                    <td style={{ ...td, color: "#ef4444" }}>{fmt$(y.federalTax)}</td>
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
  const [activeTab,     setActiveTab]     = useState("smart");
  const [appliedSched,  setAppliedSched]  = useState(null);

  // Keep age + birthYear in sync
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
  };

  function handleApplySchedule(schedule) {
    if (!schedule?.length) return;
    const avgConv = Math.round(schedule.reduce((s, r) => s + r.conversionAmount, 0) / schedule.length);
    setConversion(avgConv);
    setYears(schedule.length);
    setAppliedSched(schedule);
    setActiveTab("manual");
  }

  const tabs = [
    ["smart",  "🧠 Smart Variable Strategy"],
    ["manual", "📊 Manual Simulator"],
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#f0f2f5", padding: "24px 16px" }}>
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>

        {/* Header */}
        <div style={{ background: "#1f2328", borderRadius: 10, padding: "20px 28px", color: "#fff" }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>
            🧠 Roth Optimizer — Smart Variable Conversion Strategy
          </h1>
          <p style={{ color: "#8b949e", marginTop: 4, fontSize: 14 }}>
            Dynamically calculates optimal annual conversion amounts · 2026 federal brackets · 2026 IRMAA thresholds · IRMAA 2-year lookback aware
          </p>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 8 }}>
          {tabs.map(([id, label]) => (
            <button key={id} onClick={() => setActiveTab(id)} style={{
              padding: "9px 20px", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer",
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
              <InputField label="Traditional IRA Balance"      id="tradIRA"     value={tradIRA}    onChange={setTradIRA}    prefix="$" step={1000} />
              <InputField label="Taxable Brokerage (for taxes)" id="brokerage"  value={brokerage}  onChange={setBrokerage}  prefix="$" step={1000} note="Used to cover annual tax bills" />
              <InputField label="Other Annual Income (MAGI)"   id="other"       value={otherIncome} onChange={setOtherIncome} prefix="$" step={1000}
                note="Wages, pension, Social Security, dividends, etc. This is the base that conversions are added on top of." />
              <InputField label="Annual Growth Rate"           id="growth"      value={growth}     onChange={setGrowth}     suffix="%" step={0.5}  min={0} max={20} />
              <InputField label="Annual Inflation Rate"        id="infl"        value={inflation}  onChange={setInflation}  suffix="%" step={0.1}  min={0} max={10}
                note="Scales tax brackets and IRMAA thresholds forward each year." />
              <InputField label="Current Age"                  id="age"         value={age}        onChange={handleAgeChange} suffix="yrs" min={18} max={85} />
              <InputField label="Birth Year"                   id="by"          value={birthYear}  onChange={setBirthYear}  min={1930} max={2006}
                note={birthYear <= 1950 ? "RMD starts age 72" : birthYear <= 1959 ? "RMD starts age 73" : "RMD starts age 75"} />

              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label htmlFor="filing" style={{ fontSize: 13, fontWeight: 600 }}>Filing Status</label>
                <select id="filing" value={filing} onChange={e => setFiling(e.target.value)}
                  style={{ padding: "7px 10px", border: "1px solid #d0d7de", borderRadius: 6, fontSize: 14, background: "#fff" }}>
                  <option value="single">Single</option>
                  <option value="mfj">Married Filing Jointly</option>
                </select>
              </div>

              {/* 2026 bracket reference */}
              <div style={{ background: "#f7f8fa", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#57606a", marginBottom: 6 }}>
                  2026 {filing === "mfj" ? "MFJ" : "Single"} Key Thresholds
                </div>
                {[
                  ["24% bracket top",        fmt$(TAX_BRACKETS_2026[filing].find(b => b.rate === 0.24)?.max + STANDARD_DEDUCTION_2026[filing])],
                  ["IRMAA Tier 2 ceiling",   fmt$(IRMAA_TIERS_2026[filing].find(t => t.tier === 2)?.maxMAGI)],
                  ["IRMAA Tier 0 ceiling",   fmt$(IRMAA_TIERS_2026[filing].find(t => t.tier === 0)?.maxMAGI)],
                  ["Standard deduction",     fmt$(STANDARD_DEDUCTION_2026[filing])],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#1f2328", marginBottom: 3 }}>
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
              <ManualPanel
                baseInputs={baseInputs}
                conversion={conversion}
                setConversion={setConversion}
                years={years}
                setYears={setYears}
                appliedSchedule={appliedSched}
              />
            )}
          </div>
        </div>

        <div style={{ textAlign: "center", fontSize: 12, color: "#8b949e", padding: "8px 0 16px" }}>
          Uses 2026 projected federal tax brackets · 2026 Medicare IRMAA thresholds (CMS projected) · IRMAA 2-year lookback modeled · IRS Uniform Lifetime Table for RMDs
        </div>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";

interface CityRow {
  city: string;
  country: string | null;
  actions: number;
  completedRate: number;
  volume: number;
  lastAt: string | null;
}

interface RecentRow {
  id: string;
  kind: string;
  city: string;
  status: string;
  amountIn: string | null;
  tokenIn: string | null;
  amountOut: string | null;
  tokenOut: string | null;
  txHash: string | null;
  createdAt: string | null;
  proof: string;
}

interface DashboardData {
  byCity: CityRow[];
  recent: RecentRow[];
  treasury: { count: number; totalUsd: number };
  reputation: {
    agentId: string | null;
    scanUrl: string | null;
    feedbackCount: number;
    avgScore: number | null;
    onchain: { count: number; value: number } | null;
  };
  metrics: { totalActions: number; completedRate: number; lastActivityAt: string | null };
  safety: {
    engine: { status: string; haltReason: string | null; haltedAt: string | null };
    caps: { perTxCap: number; perUserDailyCap: number; globalDailyCap: number; globalSpentToday: number };
    gas: { floor: number; balance: number; pass: boolean; feeCurrency: string } | null;
    idempotency: { duplicates: number; ok: boolean };
    recentCycles: {
      cycleId: string | null;
      gasPass: boolean | null;
      halted: boolean | null;
      aborted: boolean | null;
      attempted: number | null;
      succeeded: number | null;
      failed: number | null;
      skipped: number | null;
      createdAt: string | null;
    }[];
  };
}

// Brand palette (Brand Board v1).
const INK = "#0B0A09";
const CREAM = "#F2EDE3";
const GOLD = "#E9A53C";
const GREEN = "#34B27B";
const RED = "#e0635e";
const FAINT = "rgba(242,237,227,0.45)";
const MUTED = "rgba(242,237,227,0.65)";
const BORDER = "rgba(242,237,227,0.14)";
const MONO = "var(--font-space-mono), ui-monospace, monospace";

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [err, setErr] = useState("");
  const [beat, setBeat] = useState(1200);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard", { cache: "no-store" });
      if (res.ok) {
        setData((await res.json()) as DashboardData);
        setErr("");
      } else {
        setErr("Could not load dashboard data.");
      }
    } catch {
      setErr("Could not load dashboard data.");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load]);

  // Cosmetic next-heartbeat countdown reflecting the ~20-minute engine cadence.
  useEffect(() => {
    const t = setInterval(() => setBeat((b) => (b <= 1 ? 1200 : b - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  const rep = data?.reputation;
  const safety = data?.safety;
  const halted = safety?.engine.status === "halted";

  const cities = data?.byCity ?? [];
  const maxActions = Math.max(1, ...cities.map((c) => c.actions));
  const volumeRouted = cities.reduce((s, c) => s + (c.volume || 0), 0);
  const successPct = Math.round((data?.metrics.completedRate ?? 0) * 100);

  return (
    <div
      style={{
        background: INK,
        color: CREAM,
        minHeight: "100vh",
        fontFamily: "var(--font-archivo), system-ui, sans-serif",
      }}
    >
      <style>{`
        @keyframes rr-blink { 0%,100% { opacity:1 } 50% { opacity:0.2 } }
        @keyframes rr-spin { to { transform:rotate(360deg) } }
        @keyframes rr-flash { 0%,100% { opacity:1 } 50% { opacity:0.35 } }
        .rr-main { display:grid; grid-template-columns: minmax(0,1fr) minmax(0,1.45fr); align-items:stretch; }
        .rr-kpi { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px,1fr)); }
        @media (max-width: 1024px), (pointer: coarse) { .rr-main { grid-template-columns: 1fr; } .rr-right { border-top:1px solid ${BORDER}; } }
        @media (max-width: 768px), (pointer: coarse) {
          .rr-feed-row { grid-template-columns: 46px 1fr 1.1fr 64px !important; gap:8px !important; padding-left:14px !important; padding-right:14px !important; }
          .rr-feed-proof { display:none !important; }
        }
      `}</style>

      {/* TOP BAR */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
          padding: "16px clamp(18px,3vw,40px)",
          borderBottom: `1px solid ${BORDER}`,
          position: "sticky",
          top: 0,
          background: "rgba(11,10,9,0.9)",
          backdropFilter: "blur(10px)",
          zIndex: 50,
        }}
      >
        <a
          href="/"
          style={{ display: "flex", alignItems: "center", gap: 11, textDecoration: "none", color: CREAM }}
        >
          <RouteGlyph size={26} />
          <span style={{ fontWeight: 900, fontSize: 15, letterSpacing: "-0.01em" }}>
            REMIT<span style={{ color: GOLD }}>ROUTE</span>
          </span>
          <span
            style={{
              fontFamily: MONO,
              fontSize: 10,
              letterSpacing: "0.14em",
              color: FAINT,
              paddingLeft: 12,
              borderLeft: `1px solid ${BORDER}`,
              marginLeft: 4,
            }}
          >
            PUBLIC LIVE FEED
          </span>
        </a>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
            fontFamily: MONO,
            fontSize: 11,
            letterSpacing: "0.08em",
          }}
        >
          <span style={{ color: FAINT }}>
            ERC-8004 <span style={{ color: CREAM }}>{rep?.agentId ? `#${rep.agentId}` : "n/a"}</span>
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, color: GREEN }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: GREEN,
                boxShadow: `0 0 9px ${GREEN}`,
                animation: "rr-blink 1.6s infinite",
              }}
            />
            AGENT LIVE
          </span>
          <span style={{ color: FAINT }}>
            NEXT BEAT <span style={{ color: GOLD }}>{mmss(beat)}</span>
          </span>
          <span
            title={halted ? safety?.engine.haltReason ?? "halted" : "engine running"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              border: `1px solid ${halted ? "rgba(224,99,94,0.5)" : "rgba(52,178,123,0.4)"}`,
              background: halted ? "rgba(224,99,94,0.1)" : "rgba(52,178,123,0.08)",
              color: halted ? RED : GREEN,
              padding: "7px 11px",
              borderRadius: 2,
              animation: halted ? "rr-flash 1s ease-in-out infinite" : undefined,
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: halted ? RED : GREEN }} />
            CIRCUIT BREAKER: {halted ? "HALTED" : "ACTIVE"}
          </span>
        </div>
      </header>

      {err && (
        <p style={{ color: RED, fontFamily: MONO, padding: "16px clamp(18px,3vw,40px)" }}>{err}</p>
      )}
      {!data && !err && (
        <p style={{ color: MUTED, fontFamily: MONO, padding: "16px clamp(18px,3vw,40px)" }}>Loading...</p>
      )}

      {data && (
        <>
          {/* KPI ROW */}
          <section className="rr-kpi" style={{ borderBottom: `1px solid ${BORDER}` }}>
            <Kpi label="ACTIONS / TOTAL" value={data.metrics.totalActions.toLocaleString("en-US")} />
            <Kpi label="VOLUME ROUTED" value={`$${volumeRouted.toLocaleString("en-US", { maximumFractionDigits: 0 })}`} color={GOLD} />
            <Kpi label="ACTIVE CITIES" value={String(cities.length)} />
            <Kpi label="SUCCESS RATE" value={`${successPct}%`} color={GREEN} />
            <Kpi label="x402 CALLS" value={data.treasury.count.toLocaleString("en-US")} color={GOLD} last />
          </section>

          {/* MAIN GRID */}
          <section className="rr-main">
            {/* LEFT: city activity + safety + agent */}
            <div style={{ borderRight: `1px solid ${BORDER}` }}>
              <div style={{ padding: "clamp(20px,2.4vw,32px)", borderBottom: `1px solid ${BORDER}` }}>
                <SectionLabel color={GOLD}>/ ACTIVITY BY CITY</SectionLabel>
                {cities.length === 0 && <Empty>No activity yet.</Empty>}
                <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                  {cities.map((c) => (
                    <div key={`${c.city}-${c.country ?? ""}`}>
                      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
                        <span style={{ fontWeight: 800, fontSize: 17, textTransform: "uppercase" }}>
                          {c.city || "Global"}{" "}
                          <span style={{ fontFamily: MONO, fontSize: 11, color: FAINT }}>
                            {c.country ?? ""}
                          </span>
                        </span>
                        <span style={{ fontFamily: MONO, fontSize: 14, color: GOLD }}>{c.actions}</span>
                      </div>
                      <div style={{ height: 6, background: "rgba(242,237,227,0.1)", marginTop: 10, borderRadius: 3, overflow: "hidden" }}>
                        <div
                          style={{
                            height: "100%",
                            width: `${Math.max(6, Math.round((c.actions / maxActions) * 100))}%`,
                            background: "linear-gradient(90deg,#E9A53C,#34B27B)",
                          }}
                        />
                      </div>
                      <div style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, marginTop: 6, display: "flex", justifyContent: "space-between" }}>
                        <span>{Math.round(c.completedRate * 100)}% COMPLETED</span>
                        <span>{relative(c.lastAt)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Safety guardrails */}
              {safety && (
                <div style={{ padding: "clamp(20px,2.4vw,32px)", borderBottom: `1px solid ${BORDER}` }}>
                  <SectionLabel color={GREEN}>/ SAFETY GUARDRAILS</SectionLabel>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 1,
                      background: BORDER,
                      border: `1px solid ${BORDER}`,
                      fontFamily: MONO,
                    }}
                  >
                    <Guard ok={!halted} label="CIRCUIT BREAKER" value={halted ? `HALTED: ${safety.engine.haltReason ?? "tripped"}` : "ACTIVE"} />
                    <Guard ok={safety.idempotency.ok} label="IDEMPOTENCY" value={`${safety.idempotency.duplicates} DUP ROWS`} />
                    <Guard
                      ok={safety.gas ? safety.gas.pass : true}
                      label="GAS FLOOR"
                      value={safety.gas ? `${trim(String(safety.gas.balance))} / ${safety.gas.floor} ${safety.gas.feeCurrency}` : "N/A"}
                    />
                    <Guard ok label="SPEND CAPS" value={`TX ${safety.caps.perTxCap} / DAY ${safety.caps.globalDailyCap}`} />
                  </div>
                  {safety.recentCycles.length > 0 && (
                    <div style={{ marginTop: 16 }}>
                      <div style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, marginBottom: 8, letterSpacing: "0.08em" }}>
                        RECENT HEARTBEAT CYCLES (NEWEST FIRST)
                      </div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {safety.recentCycles.map((c, i) => (
                          <span
                            key={c.cycleId ?? i}
                            title={`attempted ${c.attempted ?? 0}, ok ${c.succeeded ?? 0}, failed ${c.failed ?? 0}, skipped ${c.skipped ?? 0}`}
                            style={{
                              width: 14,
                              height: 14,
                              borderRadius: 3,
                              background: c.halted ? RED : (c.failed ?? 0) > 0 ? GOLD : GREEN,
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Agent reputation + treasury */}
              <div style={{ padding: "clamp(20px,2.4vw,32px)" }}>
                <SectionLabel color={GOLD}>/ AGENT</SectionLabel>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 1,
                    background: BORDER,
                    border: `1px solid ${BORDER}`,
                    fontFamily: MONO,
                  }}
                >
                  <Tag label="AVG RATING" value={rep?.avgScore != null ? `${Math.round(rep.avgScore)}/100` : "n/a"} color={GREEN} />
                  <Tag label="RATINGS" value={String(rep?.feedbackCount ?? 0)} />
                  <Tag label="x402 CALLS" value={String(data.treasury.count)} color={GOLD} />
                  <Tag label="REVENUE" value={`$${data.treasury.totalUsd.toFixed(2)}`} color={GOLD} />
                </div>
                {rep?.onchain && rep.onchain.count > 0 && (
                  <div style={{ fontFamily: MONO, fontSize: 10.5, color: GREEN, marginTop: 12, lineHeight: 1.7 }}>
                    ONCHAIN VERIFIED: {rep.onchain.count} SIGNAL(S), SUMMARY {rep.onchain.value}
                  </div>
                )}
                {rep?.scanUrl && (
                  <a
                    href={rep.scanUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: "inline-block",
                      marginTop: 14,
                      background: GOLD,
                      color: INK,
                      fontWeight: 800,
                      fontSize: 13,
                      padding: "10px 15px",
                      borderRadius: 2,
                      textDecoration: "none",
                    }}
                  >
                    View on agentscan &#8599;
                  </a>
                )}
                <div style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, marginTop: 14, lineHeight: 1.7 }}>
                  Other agents pay per call for the FX-route API. Each payment settles onchain on Celo.
                </div>
              </div>
            </div>

            {/* RIGHT: live feed */}
            <div className="rr-right" style={{ display: "flex", flexDirection: "column" }}>
              <div
                style={{
                  padding: "clamp(16px,2.2vw,26px) clamp(20px,2.4vw,32px)",
                  borderBottom: `1px solid ${BORDER}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 16,
                }}
              >
                <div
                  style={{
                    fontFamily: MONO,
                    fontSize: 11,
                    letterSpacing: "0.14em",
                    color: GOLD,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <span
                    style={{
                      width: 14,
                      height: 14,
                      border: "2px solid rgba(233,165,60,0.4)",
                      borderTopColor: GOLD,
                      borderRadius: "50%",
                      display: "inline-block",
                      animation: "rr-spin 1s linear infinite",
                    }}
                  />
                  / LIVE ACTIONS
                </div>
                <div style={{ fontFamily: MONO, fontSize: 10.5, color: FAINT, letterSpacing: "0.08em" }}>
                  EACH ROW PROOF-STAMPED
                </div>
              </div>
              <div
                className="rr-feed-row"
                style={{
                  display: "grid",
                  gridTemplateColumns: "62px 1fr 1.5fr 1fr 86px",
                  gap: 10,
                  padding: "12px clamp(20px,2.4vw,32px)",
                  borderBottom: `1px solid ${BORDER}`,
                  fontFamily: MONO,
                  fontSize: 10,
                  letterSpacing: "0.1em",
                  color: FAINT,
                }}
              >
                <span>TIME</span>
                <span>CITY</span>
                <span>ACTION</span>
                <span className="rr-feed-proof">PROOF</span>
                <span style={{ textAlign: "right" }}>STATUS</span>
              </div>
              <div style={{ flex: 1 }}>
                {data.recent.length === 0 && <Empty>No actions yet.</Empty>}
                {data.recent.map((r) => (
                  <div
                    key={r.id}
                    className="rr-feed-row"
                    style={{
                      display: "grid",
                      gridTemplateColumns: "62px 1fr 1.5fr 1fr 86px",
                      gap: 10,
                      padding: "15px clamp(20px,2.4vw,32px)",
                      borderBottom: "1px solid rgba(242,237,227,0.06)",
                      fontFamily: MONO,
                      fontSize: 12,
                      alignItems: "center",
                    }}
                  >
                    <span style={{ color: FAINT }}>{hhmm(r.createdAt)}</span>
                    <span style={{ fontWeight: 700 }}>{(r.city || "Global").toUpperCase()}</span>
                    <span>
                      <span style={{ color: GOLD }}>{r.kind.replace(/_/g, " ").toUpperCase()}</span>{" "}
                      <span style={{ color: "rgba(242,237,227,0.65)" }}>
                        {r.amountIn ? `${trim(r.amountIn)} ${r.tokenIn ?? ""}` : ""}
                      </span>
                    </span>
                    <a
                      className="rr-feed-proof"
                      href={r.txHash ? `https://celoscan.io/tx/${r.txHash}` : undefined}
                      target="_blank"
                      rel="noreferrer"
                      title={`Validation proof ${r.proof}`}
                      style={{ color: FAINT, textDecoration: "none" }}
                    >
                      {short(r.proof)}
                    </a>
                    <span style={{ textAlign: "right", color: statusColor(r.status) }}>
                      {r.status.toUpperCase()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <footer
            style={{
              borderTop: `1px solid ${BORDER}`,
              padding: "22px clamp(18px,3vw,40px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              flexWrap: "wrap",
              fontFamily: MONO,
              fontSize: 11,
              letterSpacing: "0.08em",
              color: FAINT,
            }}
          >
            <span>
              Each proof is a deterministic keccak256 digest of the action, in the ERC-8004
              Validation Registry style. Anyone can recompute it.
            </span>
            <a href="/app" style={{ color: GOLD, textDecoration: "none" }}>
              OPEN THE MINIPAY APP &#8599;
            </a>
          </footer>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, color, last }: { label: string; value: string; color?: string; last?: boolean }) {
  return (
    <div
      style={{
        padding: "clamp(18px,2.4vw,30px)",
        borderRight: last ? "none" : `1px solid ${BORDER}`,
      }}
    >
      <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.12em", color: FAINT }}>{label}</div>
      <div
        style={{
          fontWeight: 900,
          fontSize: "clamp(28px,3.2vw,42px)",
          letterSpacing: "-0.03em",
          marginTop: 12,
          color: color ?? CREAM,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function SectionLabel({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: "0.14em", color, marginBottom: 22 }}>
      {children}
    </div>
  );
}

function Guard({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <div style={{ background: INK, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: ok ? GREEN : RED, flex: "0 0 auto" }} />
        <span style={{ fontSize: 10, color: FAINT, letterSpacing: "0.1em" }}>{label}</span>
      </div>
      <div style={{ fontSize: 13, marginTop: 8, color: ok ? CREAM : RED }}>{value}</div>
    </div>
  );
}

function Tag({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: INK, padding: 16 }}>
      <div style={{ fontSize: 10, color: FAINT, letterSpacing: "0.1em" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, marginTop: 8, color: color ?? CREAM }}>{value}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p style={{ color: MUTED, fontFamily: MONO, fontSize: 13, margin: "0 0 14px" }}>{children}</p>;
}

// The route glyph from the brand board.
function RouteGlyph({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ flex: "none" }}>
      <circle cx="6" cy="25" r="3.4" stroke={GOLD} strokeWidth="2" />
      <circle cx="26" cy="7" r="3.4" stroke={GOLD} strokeWidth="2" />
      <path d="M7.6 22.6 C 16 16, 12 9, 24.2 9.2" stroke={GOLD} strokeWidth="2" strokeLinecap="round" />
      <circle cx="16.2" cy="13.4" r="2.6" fill={GREEN} />
    </svg>
  );
}

function statusColor(status: string): string {
  if (status === "confirmed" || status === "success") return GREEN;
  if (status === "failed" || status === "reverted") return RED;
  if (status === "dry_run") return FAINT;
  return GOLD;
}

function trim(amount: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  return n.toFixed(6).replace(/\.?0+$/, "");
}

function short(hash: string): string {
  if (!hash || hash.length < 12) return hash;
  return `${hash.slice(0, 6)}..${hash.slice(-4)}`;
}

// MM:SS from a seconds count.
function mmss(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(m)}:${pad(s)}`;
}

// HH:MM in local time from an ISO timestamp.
function hhmm(iso: string | null): string {
  if (!iso) return "--:--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

// Relative time like "3m ago" from an ISO timestamp.
function relative(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

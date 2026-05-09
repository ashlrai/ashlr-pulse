/**
 * Costs tab — cost breakdown 24h donut + detailed table.
 *
 * Receives pre-loaded data from the shell (page.tsx).
 */

import type { ReactElement } from "react";

import { fmtUsd } from "@/lib/pricing";
import { palette, space } from "@/lib/theme";

import { Card, CardHeader } from "@/components/ui/Card";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { DonutChart } from "@/components/charts/DonutChart";

import { th, td } from "../_components/dashboard-format";
import type { TabProps } from "./types";

export function CostsTab({ data, isSubMode }: TabProps): ReactElement {
  const breakdown = data.costBreakdown24h;

  // Build donut slices from the breakdown components (filter 0-value entries)
  const slices: { label: string; value: number; color: string }[] = [
    { label: "input",            value: breakdown.input,              color: palette.cyan    },
    { label: "output",           value: breakdown.output,             color: palette.magenta },
    { label: "reasoning",        value: breakdown.reasoning,          color: palette.purple  },
    { label: "cache read",       value: breakdown.cache_read,         color: palette.green   },
    { label: "cache write · 5m", value: breakdown.cache_5m_write,     color: palette.amber   },
    { label: "cache write · 1h", value: breakdown.cache_1h_write,     color: "#f97316"       },
    { label: "cache (legacy)",   value: breakdown.cache_write_legacy, color: palette.textDim },
  ]
    .filter((s) => s.value > 0)
    .map((s) => ({ ...s, value: s.value / 1000 })); // millicents → cents for display scale

  const hasData = breakdown.total > 0;

  return (
    <div style={{ marginTop: space.x4 }}>

      {!hasData && (
        <div style={{
          padding: space.x6,
          textAlign: "center",
          color: palette.textMute,
          fontSize: 13,
          border: `1px dashed ${palette.border}`,
          borderRadius: 8,
        }}>
          No cost data in the last 24 hours.
        </div>
      )}

      {hasData && (
        <div className="dash-grid">

          {/* Donut — visual cost split */}
          <ChartFrame
            title={isSubMode ? "rate-card breakdown · 24h" : "cost breakdown · 24h"}
            hint={isSubMode
              ? "API rate-card cost — your subscription bills a flat price"
              : "by Anthropic rate component"}
            accent={palette.magenta}
          >
            <DonutChart
              data={slices.map((s) => ({ label: s.label, value: s.value }))}
              valueFormat="dollars-2dp"
              centerValue={fmtUsd(Math.round(breakdown.total / 1000))}
              centerLabel={isSubMode ? "rate-card" : "total"}
            />
          </ChartFrame>

          {/* Detail table */}
          <Card>
            <CardHeader
              title="component detail"
              hint="auditable decomposition — sums to the cost shown above"
            />
            <CostDetailTable breakdown={breakdown} />
          </Card>

        </div>
      )}
    </div>
  );
}

function CostDetailTable({
  breakdown,
}: { breakdown: import("@/lib/pricing").CostBreakdownMillicents }): ReactElement {
  const rows: { label: string; rate: string; ms: number; color: string }[] = [
    { label: "input",            rate: "1.00× model rate",  ms: breakdown.input,              color: palette.cyan    },
    { label: "output",           rate: "1.00× output rate", ms: breakdown.output,             color: palette.magenta },
    { label: "reasoning",        rate: "1.00× output rate", ms: breakdown.reasoning,          color: palette.purple  },
    { label: "cache read",       rate: "0.10× input rate",  ms: breakdown.cache_read,         color: palette.green   },
    { label: "cache write · 5m", rate: "1.25× input rate",  ms: breakdown.cache_5m_write,     color: palette.amber   },
    { label: "cache write · 1h", rate: "2.00× input rate",  ms: breakdown.cache_1h_write,     color: palette.amber   },
    { label: "cache (legacy)",   rate: "1.25-2× input",     ms: breakdown.cache_write_legacy, color: palette.textDim },
  ].filter((r) => r.ms > 0);

  const total = breakdown.total || 1;

  return (
    <div style={{ marginTop: space.x3 }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: `1px solid ${palette.border}` }}>
            <th style={th}>component</th>
            <th style={th}>rate</th>
            <th style={{ ...th, textAlign: "right" }}>$</th>
            <th style={{ ...th, textAlign: "right" }}>%</th>
            <th style={{ ...th, width: "30%" }}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const pct = (r.ms / total) * 100;
            return (
              <tr key={r.label} style={{ borderBottom: `1px dashed ${palette.border}` }}>
                <td style={td}>
                  <span style={{ color: r.color }}>●</span>
                  <span style={{ color: palette.text, marginLeft: 8 }}>{r.label}</span>
                </td>
                <td style={{ ...td, color: palette.textMute, fontSize: 11 }}>{r.rate}</td>
                <td style={{ ...td, textAlign: "right", color: palette.text, fontVariantNumeric: "tabular-nums" }}>
                  {fmtUsd(Math.round(r.ms / 1000))}
                </td>
                <td style={{ ...td, textAlign: "right", color: palette.textDim, fontVariantNumeric: "tabular-nums" }}>
                  {pct.toFixed(1)}%
                </td>
                <td style={td}>
                  <div style={{ height: 6, background: palette.bgRaised, borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.min(100, pct)}%`, background: r.color, transition: "width 0.5s ease" }} />
                  </div>
                </td>
              </tr>
            );
          })}
          <tr style={{ borderTop: `1px solid ${palette.border}` }}>
            <td style={{ ...td, color: palette.text, fontWeight: 500 }}>total</td>
            <td style={td}></td>
            <td style={{ ...td, textAlign: "right", color: palette.magenta, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
              {fmtUsd(Math.round(breakdown.total / 1000))}
            </td>
            <td style={{ ...td, textAlign: "right", color: palette.textDim }}>100%</td>
            <td style={td}></td>
          </tr>
        </tbody>
      </table>

      {breakdown.cache_5m_write + breakdown.cache_1h_write + breakdown.cache_write_legacy >
        breakdown.input + breakdown.output + breakdown.reasoning && (
        <div style={{ marginTop: space.x3, fontSize: 11, color: palette.textMute, lineHeight: 1.5 }}>
          Cache writes ({fmtUsd(Math.round((breakdown.cache_5m_write + breakdown.cache_1h_write + breakdown.cache_write_legacy) / 1000))}) outweigh input + output + reasoning ({fmtUsd(Math.round((breakdown.input + breakdown.output + breakdown.reasoning) / 1000))}). Anthropic charges 5-minute cache writes at 1.25× and 1-hour writes at 2.00× input rate, so cmux + long-context flows pay more for caching context than for the model invocations themselves.
        </div>
      )}
    </div>
  );
}

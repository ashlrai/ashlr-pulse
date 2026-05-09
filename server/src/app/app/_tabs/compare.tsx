/**
 * Compare tab — model mix donut, top tools horizontal bar.
 *
 * Receives pre-loaded data from the shell (page.tsx).
 */

import type { ReactElement } from "react";

import { palette, space } from "@/lib/theme";

import { ChartFrame } from "@/components/charts/ChartFrame";
import { DonutChart } from "@/components/charts/DonutChart";
import { HBarChart } from "@/components/charts/HBarChart";

import { abbrev } from "../_components/dashboard-format";
import type { TabProps } from "./types";

export function CompareTab({ data }: TabProps): ReactElement {
  return (
    <div className="dash-grid" style={{ marginTop: space.x4 }}>

      {/* Model mix donut */}
      <ChartFrame title="model mix · last 7d" hint="tokens by model" accent={palette.cyan}>
        {data.modelMix.length > 0 ? (
          <DonutChart
            data={data.modelMix}
            valueFormat="abbrev"
            centerValue={abbrev(data.modelMix.reduce((a, b) => a + b.value, 0))}
            centerLabel="tokens"
          />
        ) : (
          <EmptyChart label="No model data yet." />
        )}
      </ChartFrame>

      {/* Top tools horizontal bar */}
      <ChartFrame title="top tools · last 7d" hint="tool calls" accent={palette.purple} minHeight={240}>
        {data.topTools.length > 0 ? (
          <HBarChart data={data.topTools} uniformColor={palette.purple} />
        ) : (
          <EmptyChart label="No tool-call data yet." />
        )}
      </ChartFrame>

      {/* Top repos horizontal bar */}
      <ChartFrame title="top repos · last 7d" hint="events" accent={palette.magenta}>
        {data.topRepos.length > 0 ? (
          <HBarChart data={data.topRepos} uniformColor={palette.magenta} />
        ) : (
          <EmptyChart label="No repo data yet." />
        )}
      </ChartFrame>

    </div>
  );
}

function EmptyChart({ label }: { label: string }): ReactElement {
  return (
    <div style={{
      height: 180,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: palette.textMute,
      fontSize: 12,
      border: `1px dashed ${palette.border}`,
      borderRadius: 6,
    }}>
      {label}
    </div>
  );
}

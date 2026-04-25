/**
 * /opengraph-image — auto-generated OG image at request time.
 *
 * Next.js 15 picks this file up by convention and serves the rendered
 * 1200x630 PNG at /opengraph-image. Add metadata.openGraph.images: ["/opengraph-image"]
 * to layout.tsx (already present via metadata default) and crawlers see
 * a branded card when this URL gets shared.
 *
 * Pure server-rendered SVG via Next's ImageResponse — no canvas, no
 * headless browser, fast cold starts.
 */

import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const alt = "Pulse · shared mission control for agentic-engineering teams";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const MONO =
  "ui-monospace, SFMono-Regular, Menlo, monospace";

export default async function Image(): Promise<ImageResponse> {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background:
            "radial-gradient(80% 80% at 50% 0%, rgba(124,255,160,0.10), rgba(124,255,160,0) 60%), #050505",
          color: "#fff",
          fontFamily: MONO,
          padding: 80,
          position: "relative",
        }}
      >
        {/* Grid background */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
            display: "flex",
          }}
        />

        {/* Brand row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            position: "relative",
            zIndex: 1,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 56,
              height: 56,
              background: "#0a0a0a",
              border: "1px solid #1f1f1f",
              borderRadius: 12,
            }}
          >
            <svg width={36} height={36} viewBox="0 0 32 32">
              <path
                d="M4 17 L9 17 L11 11 L14.5 22 L16.5 14 L19 18 L21 14.5 L24 14.5 L26 11 L28 11"
                stroke="#7CFFA0"
                strokeWidth={2.4}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 30 }}>
            <span style={{ fontWeight: 700, letterSpacing: "-1px" }}>pulse</span>
            <span style={{ color: "#444" }}>·</span>
            <span style={{ color: "#888", fontSize: 22 }}>ashlr.ai</span>
          </div>
        </div>

        {/* Tagline */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: "auto",
            position: "relative",
            zIndex: 1,
          }}
        >
          <div
            style={{
              fontSize: 64,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: "-2.5px",
              color: "#fff",
              maxWidth: 1000,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div style={{ display: "flex" }}>shared mission control</div>
            <div style={{ display: "flex" }}>
              for{" "}
              <span style={{ color: "#7CFFA0", marginLeft: 18 }}>agentic</span>
              <span style={{ marginLeft: 10 }}>-engineering teams.</span>
            </div>
          </div>

          <div
            style={{
              marginTop: 36,
              fontSize: 22,
              color: "#9a9a9a",
              display: "flex",
              gap: 24,
              alignItems: "center",
            }}
          >
            <span style={{ color: "#7CFFA0" }}>·</span>
            <span>configurable peer-share</span>
            <span style={{ color: "#FF60D6" }}>·</span>
            <span>hard privacy floor</span>
            <span style={{ color: "#7CD0FF" }}>·</span>
            <span>OTel-native</span>
          </div>
        </div>

        {/* Scanlines */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "repeating-linear-gradient(0deg, rgba(255,255,255,0.03) 0px, rgba(255,255,255,0.03) 1px, transparent 1px, transparent 4px)",
            display: "flex",
          }}
        />
      </div>
    ),
    { ...size },
  );
}

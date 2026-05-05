//! OTLP/HTTP-JSON exporter.
//!
//! Builds spans from the typed builders in `span.rs` and POSTs them to
//! `POST <pulse_url>/api/otlp/v1/traces` with `Authorization: Bearer <pat>`.

use std::time::Instant;

use anyhow::{Context, Result};
use reqwest::Client;
use tracing::{debug, info, warn};

use crate::span::OtlpTracesPayload;

pub struct OtlpExporter {
    client: Client,
    endpoint: String,
    pat: String,
}

impl OtlpExporter {
    pub fn new(server_url: &str, pat: &str) -> Self {
        let endpoint = format!("{}/api/otlp/v1/traces", server_url.trim_end_matches('/'));
        OtlpExporter {
            client: Client::new(),
            endpoint,
            pat: pat.to_string(),
        }
    }

    /// POST a traces payload. Returns the raw response body on success.
    ///
    /// All failure paths emit a structured `event = "export_failed"` warn
    /// so log tooling can pivot on it without grepping freeform messages.
    /// Watermarks (claude.rs / git.rs / shell.rs) only advance on success,
    /// so a failure here is retried by the next tail iteration.
    pub async fn export(&self, payload: &OtlpTracesPayload) -> Result<String> {
        let span_count: usize = payload
            .resource_spans
            .iter()
            .flat_map(|rs| rs.scope_spans.iter())
            .map(|sg| sg.spans.len())
            .sum();
        let body = serde_json::to_string(payload).context("serializing OTLP payload")?;
        let bytes = body.len();
        debug!(endpoint = %self.endpoint, bytes, span_count, "exporting OTLP traces");

        let started = Instant::now();
        let resp = match self
            .client
            .post(&self.endpoint)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", self.pat))
            .body(body)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                warn!(
                    event = "export_failed",
                    reason = "network",
                    endpoint = %self.endpoint,
                    bytes,
                    span_count,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    err = %e,
                    "OTLP export failed before HTTP response"
                );
                return Err(e).context("sending OTLP request");
            }
        };

        let status = resp.status();
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let text = resp.text().await.unwrap_or_default();

        if !status.is_success() {
            warn!(
                event = "export_failed",
                reason = "http_status",
                endpoint = %self.endpoint,
                status = %status,
                bytes,
                span_count,
                elapsed_ms,
                body = %text,
                "OTLP ingest returned non-2xx"
            );
            anyhow::bail!("OTLP ingest error {status}: {text}");
        }

        if span_count > 0 {
            info!(span_count, elapsed_ms, status = %status, "OTLP export OK");
        } else {
            debug!(status = %status, elapsed_ms, "OTLP export OK (empty)");
        }
        Ok(text)
    }

    /// Send an empty payload to validate connectivity and auth. The server
    /// should return 200 with rejected_spans=0.
    pub async fn ping(&self) -> Result<String> {
        let empty = OtlpTracesPayload { resource_spans: vec![] };
        self.export(&empty).await
    }
}

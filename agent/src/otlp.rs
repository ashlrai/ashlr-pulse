//! OTLP/HTTP-JSON exporter.
//!
//! Builds spans from the typed builders in `span.rs` and POSTs them to
//! `POST <pulse_url>/api/otlp/v1/traces` with `Authorization: Bearer <pat>`.

use anyhow::{Context, Result};
use reqwest::Client;
use tracing::{debug, warn};

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
    pub async fn export(&self, payload: &OtlpTracesPayload) -> Result<String> {
        let body = serde_json::to_string(payload).context("serializing OTLP payload")?;
        debug!(endpoint = %self.endpoint, bytes = body.len(), "exporting OTLP traces");

        let resp = self
            .client
            .post(&self.endpoint)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", self.pat))
            .body(body)
            .send()
            .await
            .context("sending OTLP request")?;

        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();

        if !status.is_success() {
            warn!(status = %status, body = %text, "OTLP ingest returned non-2xx");
            anyhow::bail!("OTLP ingest error {status}: {text}");
        }

        debug!(status = %status, "OTLP export OK");
        Ok(text)
    }

    /// Send an empty payload to validate connectivity and auth. The server
    /// should return 200 with rejected_spans=0.
    pub async fn ping(&self) -> Result<String> {
        let empty = OtlpTracesPayload { resource_spans: vec![] };
        self.export(&empty).await
    }
}

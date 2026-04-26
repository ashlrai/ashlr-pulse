//! Heartbeat task: POSTs /api/agent/heartbeat every 60s so the dashboard
//! can show "agent: alive 30s ago" instead of going silently stale when
//! the agent dies.
//!
//! Carries the agent_label (from hostname) and agent_version (from
//! Cargo.toml) so a multi-machine user can distinguish their agents.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use serde::Serialize;
use tracing::{debug, warn};

const INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Serialize)]
struct HeartbeatBody {
    agent_label: Option<String>,
    agent_version: &'static str,
}

pub async fn run(
    server_url: String,
    pat: String,
    label: Option<String>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    // Reuse a single client so connection pool warms up.
    let client = Arc::new(
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("reqwest client"),
    );
    let url = format!("{}/api/agent/heartbeat", server_url.trim_end_matches('/'));
    let body = HeartbeatBody {
        agent_label: label,
        agent_version: env!("CARGO_PKG_VERSION"),
    };

    // Initial ping so the dashboard shows "alive" right after start
    // instead of waiting up to 60s for the first interval to fire.
    if let Err(e) = ping(&client, &url, &pat, &body).await {
        warn!("heartbeat: initial ping failed: {e:#}");
    }

    let mut tick = tokio::time::interval(INTERVAL);
    tick.tick().await; // skip the immediate fire (we already pinged)
    loop {
        tokio::select! {
            _ = tick.tick() => {
                if let Err(e) = ping(&client, &url, &pat, &body).await {
                    warn!("heartbeat: ping failed: {e:#}");
                }
            }
            _ = shutdown.changed() => {
                debug!("heartbeat shutting down");
                return;
            }
        }
    }
}

async fn ping(
    client: &reqwest::Client,
    url: &str,
    pat: &str,
    body: &HeartbeatBody,
) -> Result<()> {
    let res = client
        .post(url)
        .bearer_auth(pat)
        .json(body)
        .send()
        .await?;
    if !res.status().is_success() {
        anyhow::bail!("heartbeat HTTP {}", res.status());
    }
    debug!(status = %res.status(), "heartbeat ok");
    Ok(())
}

/// Best-effort hostname for the agent_label field. Falls back to
/// $HOSTNAME or "agent" so the heartbeat never lacks a label.
pub fn hostname_label() -> String {
    if let Ok(h) = std::env::var("HOSTNAME") {
        if !h.is_empty() { return h; }
    }
    if let Ok(out) = std::process::Command::new("hostname").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() { return s; }
        }
    }
    "agent".to_string()
}

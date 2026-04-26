//! Browser-mediated onboarding: `pulse-agent init --url https://...`.
//!
//! Replaces the awkward `bun run mint-pat.ts <user_uuid> <name>` flow that
//! requires the user to ssh into the server, find their UUID, and copy a
//! token through their shell history.
//!
//! Flow:
//!   1. POST /api/agent-onboard/start { agent_label } → { code, url }
//!   2. Print the URL, attempt to open it in the user's browser
//!   3. Poll GET /api/agent-onboard/poll?code=XXX every 2s
//!   4. On approved → server returns { pat: "pulse_pat_..." }; we store
//!      it in the OS keyring and write a stub config.

use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::auth;
use crate::config;

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const POLL_MAX:      Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Serialize)]
struct StartReq<'a> {
    agent_label: &'a str,
}

#[derive(Debug, Deserialize)]
struct StartResp {
    code: String,
    url: String,
    #[allow(dead_code)]
    expires_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum PollResp {
    Pending,
    Approved {
        pat: String,
        #[allow(dead_code)]
        pat_id: String,
    },
}

pub async fn run(server_url: &str) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?;

    let label = hostname_label();

    // 1. start
    let start_url = format!("{}/api/agent-onboard/start", server_url.trim_end_matches('/'));
    let resp = client
        .post(&start_url)
        .json(&StartReq { agent_label: &label })
        .send()
        .await
        .with_context(|| format!("POST {start_url}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        bail!("/api/agent-onboard/start returned {status}: {body}");
    }
    let start: StartResp = resp.json().await.context("parsing start response")?;

    println!();
    println!("== Ashlr Pulse — agent onboarding ==");
    println!();
    println!("Open this URL in your browser to approve this machine:");
    println!();
    println!("    {}", start.url);
    println!();
    println!("Code: {}", start.code);
    println!("Hostname/label: {label}");
    println!();
    let _ = open_in_browser(&start.url);

    // 2. poll
    let poll_url = format!(
        "{}/api/agent-onboard/poll?code={}",
        server_url.trim_end_matches('/'),
        start.code,
    );
    let started_at = Instant::now();
    print!("Waiting for approval");
    use std::io::Write;
    let _ = std::io::stdout().flush();

    loop {
        if started_at.elapsed() > POLL_MAX {
            println!();
            bail!("timed out waiting for approval (5 minutes)");
        }
        tokio::time::sleep(POLL_INTERVAL).await;
        print!(".");
        let _ = std::io::stdout().flush();

        let r = client.get(&poll_url).send().await;
        let r = match r {
            Ok(r) => r,
            Err(e) => {
                warn!("poll error (will retry): {e}");
                continue;
            }
        };
        if r.status() == reqwest::StatusCode::NOT_FOUND {
            println!();
            bail!("code expired or was consumed elsewhere; re-run `pulse-agent init`");
        }
        if r.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            println!();
            bail!("rate limited by server; try again in a minute");
        }
        if !r.status().is_success() {
            let s = r.status();
            let body = r.text().await.unwrap_or_default();
            warn!("poll {s}: {body}");
            continue;
        }
        let body: PollResp = match r.json().await {
            Ok(b) => b,
            Err(e) => {
                warn!("malformed poll response: {e}");
                continue;
            }
        };
        match body {
            PollResp::Pending => continue,
            PollResp::Approved { pat, .. } => {
                println!(" approved!");
                // 3. store + write stub config
                auth::keyring_set(server_url, &pat).context("storing PAT in keyring")?;
                let cfg = config::Config::write_stub(server_url)?;
                println!();
                println!("PAT stored in OS keyring (service=ashlr-pulse, username={server_url})");
                println!("Config: {}", cfg.display());
                println!();
                println!("Next: run `pulse-agent doctor` to verify, then `pulse-agent run`.");
                return Ok(());
            }
        }
    }
}

/// Try the platform's "open this URL" helper. Best-effort: print a
/// fallback message on failure.
fn open_in_browser(url: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    let cmd = ("open", &[url] as &[&str]);
    #[cfg(target_os = "linux")]
    let cmd = ("xdg-open", &[url] as &[&str]);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let cmd = ("echo", &[url] as &[&str]);

    match std::process::Command::new(cmd.0)
        .args(cmd.1)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(mut child) => {
            let _ = child.wait();
            Ok(())
        }
        Err(_) => Ok(()), // user can paste the URL manually
    }
}

fn hostname_label() -> String {
    // Best-effort hostname; falls back to "agent" so the PAT name is
    // never empty.
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

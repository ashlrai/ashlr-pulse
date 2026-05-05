//! `pulse-agent invite <email>` — create a one-shot invite link from the
//! TTY. Wraps POST /api/agent/invite (PAT-authenticated; mirrors
//! /api/invite/create which is session-only). The agent doesn't email
//! anything — it prints the URL for the user to send via whatever
//! channel they prefer.
//!
//! Per AGENTS.md: invitee gets the link → signs in via GitHub → their
//! peer-share defaults are pre-suggested from `suggested_*` fields.
//!
//! Privacy floor: this code never logs the PAT or response token at
//! anything below the TTY-print level.
//!
//! Errors are surfaced verbatim from the server (the route already
//! returns user-facing messages like "Free tier capped at 1 member.
//! Upgrade to Pro at /billing.").
//!
//! See agent/tests/invite.rs for the integration test against a mocked
//! HTTP server.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Serialize)]
pub struct InviteRequest<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_scope_type: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_scope_value: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_granularity: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_fields: Option<&'a [String]>,
}

#[derive(Debug, Deserialize)]
pub struct InviteResponse {
    pub token: String,
    pub url: String,
    pub expires_at: String,
    #[serde(default)]
    pub label: Option<String>,
}

/// POST the invite request and return the parsed response.
///
/// Surfaces the server's error body on non-2xx so the user sees plan-gate
/// / member-cap messages directly.
pub async fn create(
    server_url: &str,
    pat: &str,
    req: &InviteRequest<'_>,
) -> Result<InviteResponse> {
    let url = format!("{}/api/agent/invite", server_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .context("building http client")?;

    let resp = client
        .post(&url)
        .bearer_auth(pat)
        .json(req)
        .send()
        .await
        .with_context(|| format!("POST {url}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        // Try to surface a clean `error` field; otherwise echo the body.
        let detail = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_owned))
            .unwrap_or_else(|| body.trim().to_owned());
        return Err(anyhow!("invite failed: HTTP {status} — {detail}"));
    }

    let parsed: InviteResponse = resp.json().await.context("parsing invite response")?;
    Ok(parsed)
}

/// CLI entry point — calls `create()` and prints the result.
pub async fn run(
    server_url: &str,
    pat: &str,
    email: Option<&str>,
    label: Option<&str>,
) -> Result<()> {
    let req = InviteRequest {
        email,
        label,
        ..Default::default()
    };
    let resp = create(server_url, pat, &req).await?;

    println!("✓ invite created");
    if let Some(addr) = email {
        println!("  send to:    {addr}");
    }
    println!("  url:        {}", resp.url);
    println!("  expires at: {}", resp.expires_at);
    if let Some(lbl) = resp.label.as_deref() {
        println!("  label:      {lbl}");
    }
    println!();
    println!("They sign in via GitHub at the URL above; peer-share defaults");
    println!("are pre-suggested when they accept.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invite_request_skips_none_fields() {
        let req = InviteRequest {
            email: Some("test@example.com"),
            ..Default::default()
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("test@example.com"));
        // None fields must be elided so the server-side zod schema
        // (which rejects unknown / null on optional enums) is happy.
        assert!(!json.contains("label"));
        assert!(!json.contains("suggested_scope_type"));
        assert!(!json.contains("suggested_fields"));
    }
}

//! PAT storage and lookup.
//!
//! Precedence (highest to lowest):
//!   1. `$PULSE_PAT` environment variable
//!   2. `config.server.pat` in config.toml
//!   3. OS keyring (service = "ashlr-pulse", username = server URL)
//!
//! We never accept a PAT as a CLI flag — it would appear in `ps aux`.

use anyhow::{anyhow, Result};
use keyring::Entry;

const KEYRING_SERVICE: &str = "ashlr-pulse";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PatSource {
    Env,
    Config,
    Keyring,
}

impl std::fmt::Display for PatSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PatSource::Env     => write!(f, "env ($PULSE_PAT)"),
            PatSource::Config  => write!(f, "config.toml"),
            PatSource::Keyring => write!(f, "OS keyring"),
        }
    }
}

/// Retrieve the PAT following the precedence chain.
/// Returns `(pat, source)` or an error if none is found.
pub fn get_pat(server_url: &str, config_pat: Option<&str>) -> Result<(String, PatSource)> {
    // 1. Environment variable
    if let Ok(v) = std::env::var("PULSE_PAT") {
        if !v.is_empty() {
            return Ok((v, PatSource::Env));
        }
    }
    // 2. Config file (acceptable for non-shared machines, but keyring preferred)
    if let Some(p) = config_pat {
        if !p.is_empty() {
            return Ok((p.to_string(), PatSource::Config));
        }
    }
    // 3. OS keyring
    match keyring_get(server_url) {
        Ok(p) if !p.is_empty() => return Ok((p, PatSource::Keyring)),
        _ => {}
    }

    Err(anyhow!(
        "No PAT found. Run `pulse-agent login --url {server_url}` or set $PULSE_PAT."
    ))
}

/// Store a PAT in the OS keyring.
pub fn keyring_set(server_url: &str, pat: &str) -> Result<()> {
    let entry = Entry::new(KEYRING_SERVICE, server_url)?;
    entry.set_password(pat)?;
    Ok(())
}

/// Retrieve a PAT from the OS keyring. Returns an error if not found.
pub fn keyring_get(server_url: &str) -> Result<String> {
    let entry = Entry::new(KEYRING_SERVICE, server_url)?;
    Ok(entry.get_password()?)
}

/// Validate that a string looks like a pulse PAT.
pub fn validate_pat(pat: &str) -> bool {
    pat.starts_with("pulse_pat_") && pat.len() == 42 // "pulse_pat_" + 32 hex
}

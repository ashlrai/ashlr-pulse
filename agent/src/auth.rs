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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Env-mutating tests must not race; cargo test parallelizes by default.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn validate_pat_accepts_well_formed() {
        let pat = format!("pulse_pat_{}", "0123456789abcdef0123456789abcdef");
        assert_eq!(pat.len(), 42);
        assert!(validate_pat(&pat));
    }

    #[test]
    fn validate_pat_rejects_wrong_prefix() {
        let pat = format!("anthropic_{}", "0123456789abcdef0123456789abcdef");
        assert!(!validate_pat(&pat));
    }

    #[test]
    fn validate_pat_rejects_wrong_length() {
        assert!(!validate_pat("pulse_pat_short"));
        assert!(!validate_pat(&format!("pulse_pat_{}", "x".repeat(64))));
    }

    #[test]
    fn validate_pat_rejects_empty() {
        assert!(!validate_pat(""));
    }

    #[test]
    fn pat_source_display_is_human_readable() {
        // Shown to users in `pulse-agent doctor` and structured logs;
        // must read as a hint, not Debug-format.
        assert_eq!(format!("{}", PatSource::Env), "env ($PULSE_PAT)");
        assert_eq!(format!("{}", PatSource::Config), "config.toml");
        assert_eq!(format!("{}", PatSource::Keyring), "OS keyring");
    }

    #[test]
    fn get_pat_env_wins_over_config() {
        let _g = ENV_LOCK.lock().unwrap();
        let prev = std::env::var("PULSE_PAT").ok();
        // SAFETY: process-wide env mutation is unsafe in modern Rust.
        // We hold ENV_LOCK so no other env-touching test interleaves.
        unsafe { std::env::set_var("PULSE_PAT", "env-value"); }
        let result = get_pat("https://example.com", Some("config-value"));
        match prev {
            Some(v) => unsafe { std::env::set_var("PULSE_PAT", v); }
            None => unsafe { std::env::remove_var("PULSE_PAT"); }
        }
        let (pat, src) = result.expect("env-set PAT should resolve");
        assert_eq!(pat, "env-value");
        assert_eq!(src, PatSource::Env);
    }

    #[test]
    fn get_pat_falls_back_to_config_when_env_unset() {
        let _g = ENV_LOCK.lock().unwrap();
        let prev = std::env::var("PULSE_PAT").ok();
        unsafe { std::env::remove_var("PULSE_PAT"); }
        let result = get_pat("https://no-such-keyring-key.invalid", Some("config-value"));
        if let Some(v) = prev { unsafe { std::env::set_var("PULSE_PAT", v); } }
        let (pat, src) = result.expect("config PAT should resolve");
        assert_eq!(pat, "config-value");
        assert_eq!(src, PatSource::Config);
    }

    #[test]
    fn get_pat_skips_empty_env() {
        // PULSE_PAT="" must NOT be treated as a valid PAT — fall through.
        let _g = ENV_LOCK.lock().unwrap();
        let prev = std::env::var("PULSE_PAT").ok();
        unsafe { std::env::set_var("PULSE_PAT", ""); }
        let result = get_pat("https://no-such-keyring-key.invalid", Some("config-value"));
        match prev {
            Some(v) => unsafe { std::env::set_var("PULSE_PAT", v); }
            None => unsafe { std::env::remove_var("PULSE_PAT"); }
        }
        let (pat, src) = result.expect("config fallback");
        assert_eq!(pat, "config-value");
        assert_eq!(src, PatSource::Config);
    }
}

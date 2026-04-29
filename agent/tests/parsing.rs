//! Integration tests for the agent's user-facing parsing surfaces:
//! ISO-8601 timestamps from Claude JSONL, git remote-URL → repo-name
//! mapping (used by both Claude tailer and shell hook for repo
//! attribution), and project-path hashing for de-duplication.
//!
//! These run with `cargo test` — no server, no network.

use pulse_agent::claude::{
    parse_iso8601_to_ns, project_path_hash, remote_url_to_repo_name,
};

// ── parse_iso8601_to_ns ────────────────────────────────────────────────────

#[test]
fn parses_z_suffixed_iso8601_into_ns_since_epoch() {
    // 2026-04-25T05:00:00Z = 1_777_093_200 seconds since epoch.
    let ns = parse_iso8601_to_ns("2026-04-25T05:00:00Z").expect("should parse");
    assert_eq!(ns, 1_777_093_200_u128 * 1_000_000_000);
}

#[test]
fn parses_iso8601_with_subsecond_precision() {
    let ns = parse_iso8601_to_ns("2026-04-25T05:00:00.123Z").expect("should parse");
    // 1777438800.123s → ends in 123_000_000 ns.
    assert_eq!(ns % 1_000_000_000, 123_000_000);
}

#[test]
fn rejects_unparseable_strings_without_panicking() {
    assert!(parse_iso8601_to_ns("not-a-date").is_none());
    assert!(parse_iso8601_to_ns("").is_none());
}

// ── remote_url_to_repo_name ────────────────────────────────────────────────

#[test]
fn maps_https_github_url_to_owner_repo() {
    assert_eq!(
        remote_url_to_repo_name("https://github.com/ashlrai/ashlr-pulse.git"),
        "ashlrai/ashlr-pulse"
    );
    assert_eq!(
        remote_url_to_repo_name("https://github.com/ashlrai/ashlr-pulse"),
        "ashlrai/ashlr-pulse"
    );
}

#[test]
fn maps_ssh_github_url_to_owner_repo() {
    assert_eq!(
        remote_url_to_repo_name("git@github.com:ashlrai/ashlr-pulse.git"),
        "ashlrai/ashlr-pulse"
    );
}

// ── project_path_hash ─────────────────────────────────────────────────────

#[test]
fn project_path_hash_is_stable_and_deterministic() {
    let a = project_path_hash("/Users/mason/code/ashlr-pulse");
    let b = project_path_hash("/Users/mason/code/ashlr-pulse");
    assert_eq!(a, b, "same path must hash identically across calls");
    // Hex-encoded sha256 → 64 lowercase hex chars.
    assert!(
        a.chars().all(|c| c.is_ascii_hexdigit()),
        "hash must be hex, got {a:?}"
    );
}

#[test]
fn project_path_hash_distinguishes_different_paths() {
    let a = project_path_hash("/Users/mason/code/ashlr-pulse");
    let b = project_path_hash("/Users/mason/code/cotidie");
    assert_ne!(a, b, "different paths should hash to different values");
}

//! `pulse-agent onboard` — unified setup orchestrator.
//!
//! End-to-end: server-reach → PAT mint (browser-mediated, idempotent if
//! a PAT already exists in keyring) → repo auto-discovery → shell-hook
//! install → background-service install → optional GitHub connect →
//! final smoke test.
//!
//! Each step is idempotent (safe to re-run) and emits one of:
//!   - `[N/M] description... ✓` on success
//!   - `[N/M] description... → SKIPPED (reason)` when not applicable
//!   - a multi-line "HUMAN ACTION REQUIRED" block when the AI must hand off
//!
//! The structured output shape is documented in AGENTS.md so AI agents
//! driving the CLI can parse progress + know when to surface a handoff
//! block to the user verbatim.
//!
//! `--skip-<step>` flags exist for every step that touches state outside
//! the user's home directory.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};

use crate::{auth, config, onboard, otlp, repo_discover, service_install, shell_install};

#[derive(Debug, Default)]
pub struct OnboardOpts {
    pub url: String,
    pub skip_repo_scan: bool,
    pub skip_shell_hook: bool,
    pub skip_service: bool,
    pub skip_github: bool,
    pub yes: bool,           // assume "yes" for non-destructive prompts
}

const TOTAL_STEPS: usize = 6;

pub async fn run(opts: OnboardOpts) -> Result<()> {
    print_banner(&opts.url);

    // ── 1/6: server reachability ─────────────────────────────────────────
    step(1, "Checking server reachability");
    match probe_server(&opts.url).await {
        Ok(()) => println!(" ✓"),
        Err(e) => {
            println!(" ✗");
            println!();
            println!("  Failed to reach {url}/api/healthz", url = opts.url);
            println!("  Error: {e:#}");
            println!("  Resolution: confirm the URL is correct and the server is deployed.");
            anyhow::bail!("server unreachable");
        }
    }

    // ── 2/6: PAT mint (or reuse) ─────────────────────────────────────────
    step(2, "Authenticating");
    match auth::get_pat(&opts.url, None) {
        Ok((_pat, src)) => {
            println!(" ✓ existing PAT in {src}");
        }
        Err(_) => {
            println!(" → minting via browser approval");
            // Hand off to existing onboard flow which prints its own
            // human-action URL.
            onboard::run(&opts.url).await.context("PAT mint via onboard")?;
        }
    }

    // ── 3/6: repo auto-discovery ─────────────────────────────────────────
    step(3, "Scanning for git repos to track");
    if opts.skip_repo_scan {
        println!(" → skipped (--skip-repo-scan)");
    } else {
        let cfg = config::Config::load().context("loading config")?;
        let already: Vec<String> = cfg.repos.iter().map(|r| r.path.clone()).collect();
        let found = repo_discover::discover(&already);
        if found.is_empty() {
            println!(" ✓ no new repos found ({} already configured)", already.len());
        } else {
            println!(" → found {} new repos", found.len());
            for r in &found {
                let label = r.repo_name.clone().unwrap_or_else(|| {
                    r.path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
                });
                println!("     {label:<40}  {}", r.path.display());
            }
            // Append them to config.toml. We don't ASK because re-running
            // the orchestrator is idempotent + the user can manually
            // remove any they don't want.
            append_repos_to_config(&found)?;
            println!("     ✓ appended to {}", config::config_path()?.display());
        }
    }

    // ── 4/6: shell hook ──────────────────────────────────────────────────
    step(4, "Installing shell hook (captures terminal AI CLIs)");
    if opts.skip_shell_hook {
        println!(" → skipped (--skip-shell-hook)");
    } else {
        match shell_install::install()? {
            shell_install::InstallResult::Installed => {
                let shell = shell_install::detect();
                let rc = shell_install::rc_file_for(shell).map(|p| p.display().to_string()).unwrap_or_default();
                println!(" ✓ added to {rc}  (open a new terminal to activate)");
            }
            shell_install::InstallResult::AlreadyPresent => {
                println!(" ✓ already present");
            }
            shell_install::InstallResult::UnsupportedShell => {
                println!(" → skipped (unsupported $SHELL — supported: zsh, bash)");
            }
            shell_install::InstallResult::NoRcFile(rc) => {
                println!(" → skipped ({} doesn't exist)", rc.display());
            }
        }
    }

    // ── 5/6: background service ──────────────────────────────────────────
    step(5, "Installing background service");
    if opts.skip_service {
        println!(" → skipped (--skip-service)");
    } else {
        let bin = match resolve_pulse_agent_bin() {
            Some(p) => p,
            None => {
                println!(" → skipped (couldn't find pulse-agent in PATH; run `pulse-agent run` manually for now)");
                std::path::PathBuf::new()
            }
        };
        if !bin.as_os_str().is_empty() {
            match service_install::install(&bin) {
                service_install::InstallResult::Installed { service_path, started, log_path } => {
                    if started {
                        println!(" ✓ installed + started ({})", service_path.display());
                        println!("     logs at {}", log_path.display());
                    } else {
                        println!(" ✓ installed at {} (starting failed; run manually)", service_path.display());
                    }
                }
                service_install::InstallResult::AlreadyInstalled { service_path } => {
                    println!(" ✓ already installed at {}", service_path.display());
                }
                service_install::InstallResult::Unsupported(why) => {
                    println!(" → skipped ({why})");
                }
                service_install::InstallResult::Error(e) => {
                    println!(" ✗ {e}");
                }
            }
        }
    }

    // ── 6/6: GitHub connect (opt-in, requires browser) ───────────────────
    step(6, "GitHub connect (commits + PRs)");
    if opts.skip_github {
        println!(" → skipped (--skip-github)");
    } else {
        let connect_url = format!("{}/github", opts.url.trim_end_matches('/'));
        println!(" → human action required");
        println!();
        println!("  === HUMAN ACTION REQUIRED ===");
        println!("  Action:    Click 'Connect GitHub' to authorize commit/PR ingest");
        println!("  Where:     {connect_url}");
        println!("  Expected:  /github page shows 'last synced: <timestamp>' within 60s");
        println!("  Resume:    AI: continue when user confirms 'connected'");
        println!("  =============================");
    }

    println!();
    println!("Onboarding complete. Visit {url}/app — the agent's heartbeat badge",
        url = opts.url.trim_end_matches('/'));
    println!("should turn green within 60s.");
    println!();
    println!("Next: tomorrow at 9am you'll get a daily digest by email.");
    println!("Need to backfill the last week? Run `pulse-agent backfill --since 7d`.");

    Ok(())
}

// ── helpers ────────────────────────────────────────────────────────────────

fn step(n: usize, label: &str) {
    use std::io::Write;
    print!("[{n}/{TOTAL_STEPS}] {label}...");
    let _ = std::io::stdout().flush();
}

fn print_banner(url: &str) {
    println!();
    println!("== Ashlr Pulse onboarding ==");
    println!("  Server:  {url}");
    println!("  Steps:   server-reach, auth, repos, shell hook, service, github");
    println!();
}

async fn probe_server(url: &str) -> Result<()> {
    let healthz = format!("{}/api/healthz", url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()?;
    let res = client.get(&healthz).send().await.context("fetching /api/healthz")?;
    if !res.status().is_success() {
        anyhow::bail!("/api/healthz returned {}", res.status());
    }
    let body = res.json::<serde_json::Value>().await.context("parsing healthz body")?;
    if body.get("ok") != Some(&serde_json::Value::Bool(true)) {
        anyhow::bail!("/api/healthz body: {body}");
    }
    Ok(())
}

fn append_repos_to_config(repos: &[repo_discover::DiscoveredRepo]) -> Result<()> {
    let path = config::config_path()?;
    let mut existing = std::fs::read_to_string(&path).unwrap_or_default();
    if !existing.is_empty() && !existing.ends_with('\n') { existing.push('\n'); }
    existing.push_str("\n# Auto-added by `pulse-agent onboard`\n");
    for r in repos {
        existing.push_str("[[repos]]\n");
        existing.push_str(&format!("path = {:?}\n", r.path.to_string_lossy()));
        if let Some(name) = &r.repo_name {
            existing.push_str(&format!("repo_name = {name:?}\n"));
        }
        existing.push('\n');
    }
    std::fs::write(&path, existing)?;
    Ok(())
}

fn resolve_pulse_agent_bin() -> Option<std::path::PathBuf> {
    // 1. Use the running binary's own path (most reliable when invoked
    //    via `pulse-agent onboard`).
    if let Ok(p) = std::env::current_exe() {
        if p.is_file() { return Some(p); }
    }
    // 2. Fall back to $PATH lookup for "pulse-agent".
    let path = std::env::var("PATH").ok()?;
    for dir in path.split(':') {
        let candidate = Path::new(dir).join("pulse-agent");
        if candidate.is_file() { return Some(candidate); }
    }
    None
}

/// Suppress unused-import lint when otlp isn't actually exercised in
/// every code path of this module yet (we'll wire health pings via it later).
#[allow(dead_code)]
fn _otlp_dummy(_: Arc<otlp::OtlpExporter>) {}

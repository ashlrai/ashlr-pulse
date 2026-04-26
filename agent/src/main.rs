//! pulse-agent — local background agent for Ashlr Pulse.
//!
//! Subcommands:
//!   run     — foreground watcher; handles SIGTERM/INT cleanly
//!   doctor  — validates config + connectivity, prints status
//!   login   — stores PAT in OS keyring, writes stub config

use pulse_agent::{auth, backfill, claude, config, git, heartbeat, onboard, otlp, shell, state};

use std::sync::Arc;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use tokio::sync::watch;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(
    name = "pulse-agent",
    version,
    about = "Ashlr Pulse local agent — captures Claude Code activity and git commits"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the agent in the foreground. Send SIGTERM or Ctrl-C to stop.
    Run,

    /// Validate config, ping ingest, list repo watermarks.
    Doctor,

    /// Store a PAT in the OS keyring and write a stub config if needed.
    Login {
        #[arg(long, help = "Pulse server URL (e.g. http://localhost:3001)")]
        url: String,
    },

    /// Browser-mediated onboarding — opens the Pulse approval page so
    /// you can mint a PAT without ssh-ing into the server.
    Init {
        #[arg(long, help = "Pulse server URL (e.g. https://pulse.ashlr.ai)")]
        url: String,
    },

    /// Re-tail every Claude session JSONL since a chosen point in time,
    /// ignoring the per-file watermark. Idempotent — safe to run while
    /// `pulse-agent run` is also active.
    Backfill {
        #[arg(long, default_value = "7d", help = "Window: 24h, 7d, 30m, or YYYY-MM-DD")]
        since: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse().unwrap()))
        .init();

    let cli = Cli::parse();

    match cli.command {
        Command::Run    => cmd_run().await,
        Command::Doctor => cmd_doctor().await,
        Command::Login { url } => cmd_login(&url).await,
        Command::Init  { url } => onboard::run(&url).await,
        Command::Backfill { since } => cmd_backfill(&since).await,
    }
}

// ── backfill ────────────────────────────────────────────────────────────────

async fn cmd_backfill(since: &str) -> Result<()> {
    let cfg = config::Config::load().context("loading config")?;
    let (pat, pat_src) = auth::get_pat(&cfg.server.url, cfg.server.pat.as_deref())
        .context("resolving PAT")?;
    info!(url = %cfg.server.url, pat_source = %pat_src, since, "backfill starting");
    let exporter = std::sync::Arc::new(otlp::OtlpExporter::new(&cfg.server.url, &pat));
    backfill::run(since, &cfg, exporter).await
}

// ── run ─────────────────────────────────────────────────────────────────────

async fn cmd_run() -> Result<()> {
    let cfg = config::Config::load().context("loading config")?;
    let (pat, pat_src) = auth::get_pat(&cfg.server.url, cfg.server.pat.as_deref())
        .context("resolving PAT")?;

    info!(url = %cfg.server.url, pat_source = %pat_src, "pulse-agent starting");

    let exporter = Arc::new(otlp::OtlpExporter::new(&cfg.server.url, &pat));
    let state    = Arc::new(state::StateDb::open().context("opening state db")?);

    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    let claude_exporter = exporter.clone();
    let claude_state    = state.clone();
    let claude_rx       = shutdown_rx.clone();
    let projects_dir    = cfg.claude_projects_dir();

    let git_exporter = exporter.clone();
    let git_state    = state.clone();
    let git_rx       = shutdown_rx.clone();
    let repos        = cfg.repos.clone();

    let claude_handle = tokio::spawn(async move {
        claude::run(projects_dir, claude_exporter, claude_state, claude_rx).await;
    });

    let git_handle = tokio::spawn(async move {
        git::run(repos, git_exporter, git_state, git_rx).await;
    });

    // Heartbeat — pings the server every 60s so the dashboard can show
    // "agent: alive 30s ago" instead of going silently stale.
    let heartbeat_rx = shutdown_rx.clone();
    let heartbeat_url = cfg.server.url.clone();
    let heartbeat_pat = pat.clone();
    let heartbeat_label = Some(heartbeat::hostname_label());
    let heartbeat_handle = tokio::spawn(async move {
        heartbeat::run(heartbeat_url, heartbeat_pat, heartbeat_label, heartbeat_rx).await;
    });

    // Shell-hook tailer — opt-in via shell.enabled (default true).
    let shell_handle = if cfg.shell.enabled {
        let shell_exporter = exporter.clone();
        let shell_state    = state.clone();
        let shell_rx       = shutdown_rx.clone();
        let buffer_path    = cfg.shell_buffer_path();
        info!(buffer = %buffer_path.display(), "shell tailer enabled");
        Some(tokio::spawn(async move {
            shell::run(buffer_path, shell_exporter, shell_state, shell_rx).await;
        }))
    } else {
        info!("shell tailer disabled by config");
        None
    };

    tokio::signal::ctrl_c().await.context("waiting for signal")?;
    info!("shutdown signal received; stopping workers");
    let _ = shutdown_tx.send(true);

    let _ = tokio::join!(claude_handle, git_handle, heartbeat_handle);
    if let Some(h) = shell_handle {
        let _ = h.await;
    }
    info!("pulse-agent stopped");
    Ok(())
}

// ── doctor ──────────────────────────────────────────────────────────────────

async fn cmd_doctor() -> Result<()> {
    let cfg = config::Config::load().context("loading config")?;

    println!("=== pulse-agent doctor ===\n");

    let cfg_path = config::config_path()?;
    println!("config path  : {}", cfg_path.display());
    println!("config exists: {}", cfg_path.exists());
    println!("server url   : {}", cfg.server.url);

    let pat_result = auth::get_pat(&cfg.server.url, cfg.server.pat.as_deref());
    match &pat_result {
        Ok((pat, src)) => {
            let masked = format!("{}...", &pat[..std::cmp::min(14, pat.len())]);
            println!("PAT source   : {src}");
            println!("PAT (masked) : {masked}");
        }
        Err(e) => {
            println!("PAT source   : MISSING — {e}");
        }
    }

    println!("\nconfigured repos: {}", cfg.repos.len());
    if let Ok(db) = state::StateDb::open() {
        for repo in &cfg.repos {
            let wm = db.get_git_watermark(&repo.path).unwrap_or(None);
            let sha_display = wm.as_deref().map(|s| &s[..std::cmp::min(8, s.len())]).unwrap_or("(none)");
            println!("  {} — last commit: {sha_display}", repo.path);
        }

        let offsets = db.list_file_offsets().unwrap_or_default();
        println!("\nclaude session files tracked: {}", offsets.len());
        if let Some((path, offset)) = offsets.last() {
            println!("  last: {} @ {} bytes", path, offset);
        }
    }

    print!("\npinging {} ... ", cfg.server.url);
    if let Ok((pat, _)) = pat_result {
        let exporter = otlp::OtlpExporter::new(&cfg.server.url, &pat);
        match exporter.ping().await {
            Ok(body) => println!("OK — {}", body.trim()),
            Err(e)   => println!("FAIL — {e:#}"),
        }
    } else {
        println!("SKIP (no PAT)");
    }

    Ok(())
}

// ── login ───────────────────────────────────────────────────────────────────

async fn cmd_login(url: &str) -> Result<()> {
    use std::io::{self, Write};

    println!("Ashlr Pulse login");
    println!("Server: {url}");
    println!();
    print!("Enter PAT (pulse_pat_...): ");
    io::stdout().flush()?;

    let mut pat = String::new();
    io::stdin().read_line(&mut pat)?;
    let pat = pat.trim().to_string();

    if !auth::validate_pat(&pat) {
        eprintln!("warning: PAT doesn't look like a valid pulse PAT (expected pulse_pat_<32 hex>)");
    }

    auth::keyring_set(url, &pat).context("storing PAT in keyring")?;
    println!("PAT stored in OS keyring (service=ashlr-pulse, username={url})");

    let config_path = config::Config::write_stub(url)?;
    println!("Config: {}", config_path.display());
    println!();
    println!("Run `pulse-agent doctor` to verify connectivity.");

    Ok(())
}

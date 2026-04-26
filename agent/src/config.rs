//! Configuration file (~/.config/pulse/config.toml) load + defaults.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Config {
    #[serde(default)]
    pub server: ServerConfig,

    #[serde(default)]
    pub claude: ClaudeConfig,

    #[serde(default)]
    pub repos: Vec<RepoConfig>,

    #[serde(default)]
    pub shell: ShellConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ShellConfig {
    /// Enable the shell-hook tailer. Defaults to true; set to false to
    /// disable even if the buffer file exists.
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// Path to the JSONL buffer that the shell hook appends to.
    /// Defaults to `~/.local/share/pulse-agent/shell-events.jsonl`.
    pub buffer_path: Option<String>,
}

impl Default for ShellConfig {
    fn default() -> Self {
        ShellConfig { enabled: true, buffer_path: None }
    }
}

fn default_true() -> bool { true }

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ServerConfig {
    pub url: String,
    /// Optional PAT stored in config (anti-pattern; keyring is preferred).
    pub pat: Option<String>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        ServerConfig {
            url: "http://localhost:3001".to_string(),
            pat: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ClaudeConfig {
    /// Directory that contains the `projects/` subdirectory.
    /// Defaults to `~/.claude`.
    pub projects_dir: Option<String>,
}

impl Default for ClaudeConfig {
    fn default() -> Self {
        ClaudeConfig { projects_dir: None }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RepoConfig {
    pub path: String,
    /// Override for the repo name sent to the server. If absent, derived from
    /// `git remote.origin.url` or the directory basename.
    pub repo_name: Option<String>,
}

impl Config {
    /// Load config from `~/.config/pulse/config.toml`, returning defaults if
    /// the file does not exist.
    pub fn load() -> Result<Self> {
        let path = config_path()?;
        if !path.exists() {
            return Ok(Config::default());
        }
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("reading config at {}", path.display()))?;
        let cfg: Config = toml::from_str(&text)
            .with_context(|| format!("parsing config at {}", path.display()))?;
        Ok(cfg)
    }

    /// Write a stub config (used by `pulse-agent login`).
    pub fn write_stub(url: &str) -> Result<PathBuf> {
        let path = config_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating config dir {}", parent.display()))?;
        }
        if path.exists() {
            // Don't overwrite existing config.
            return Ok(path);
        }
        let stub = format!(
            r#"[server]
url = "{url}"

[claude]
# projects_dir = "~/.claude"

# [[repos]]
# path = "/path/to/your/repo"
"#
        );
        std::fs::write(&path, stub)
            .with_context(|| format!("writing stub config to {}", path.display()))?;
        Ok(path)
    }

    /// Resolved projects directory for Claude session files.
    pub fn claude_projects_dir(&self) -> PathBuf {
        match &self.claude.projects_dir {
            Some(p) => expand_tilde(p),
            None => {
                let mut p = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
                p.push(".claude");
                p
            }
        }
    }

    /// Resolved shell-hook buffer path. Defaults to
    /// `~/.local/share/pulse-agent/shell-events.jsonl` (matches what the
    /// hook script writes to).
    pub fn shell_buffer_path(&self) -> PathBuf {
        match &self.shell.buffer_path {
            Some(p) => expand_tilde(p),
            None    => crate::shell::default_buffer_path(),
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Config {
            server: ServerConfig::default(),
            claude: ClaudeConfig::default(),
            repos: Vec::new(),
            shell: ShellConfig::default(),
        }
    }
}

pub fn config_path() -> Result<PathBuf> {
    let mut p = dirs::config_dir()
        .context("could not determine config directory")?;
    p.push("pulse");
    p.push("config.toml");
    Ok(p)
}

pub fn expand_tilde(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        let mut home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        home.push(rest);
        home
    } else {
        PathBuf::from(p)
    }
}

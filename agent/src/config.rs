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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_have_sensible_server_url() {
        let c = Config::default();
        // localhost:3001 is the dev convention used everywhere in the
        // repo (server runs on :3001 in dev to avoid collision with the
        // user's other Next.js work).
        assert_eq!(c.server.url, "http://localhost:3001");
        assert!(c.server.pat.is_none());
    }

    #[test]
    fn defaults_have_shell_enabled() {
        // Shell-hook tailing must default ON — otherwise users who never
        // edit config.toml lose terminal-CLI ingest entirely.
        let c = Config::default();
        assert!(c.shell.enabled);
        assert!(c.shell.buffer_path.is_none());
    }

    #[test]
    fn defaults_have_no_repos() {
        let c = Config::default();
        assert_eq!(c.repos.len(), 0);
    }

    #[test]
    fn parses_minimal_config() {
        let toml_text = r#"
[server]
url = "https://pulse.example.com"
"#;
        let c: Config = toml::from_str(toml_text).expect("parse");
        assert_eq!(c.server.url, "https://pulse.example.com");
        assert!(c.shell.enabled, "shell.enabled defaults to true on partial config");
    }

    #[test]
    fn parses_repos_block() {
        let toml_text = r#"
[server]
url = "https://x.test"

[[repos]]
path = "/Users/x/code/foo"

[[repos]]
path = "/Users/x/code/bar"
repo_name = "bar-renamed"
"#;
        let c: Config = toml::from_str(toml_text).expect("parse");
        assert_eq!(c.repos.len(), 2);
        assert_eq!(c.repos[0].path, "/Users/x/code/foo");
        assert!(c.repos[0].repo_name.is_none());
        assert_eq!(c.repos[1].repo_name.as_deref(), Some("bar-renamed"));
    }

    #[test]
    fn parses_shell_disabled() {
        let toml_text = r#"
[server]
url = "https://x.test"

[shell]
enabled = false
"#;
        let c: Config = toml::from_str(toml_text).expect("parse");
        assert!(!c.shell.enabled);
    }

    #[test]
    fn rejects_garbage_toml() {
        let result: Result<Config, _> = toml::from_str("this is not toml at all == == ==");
        assert!(result.is_err());
    }

    #[test]
    fn expand_tilde_replaces_home_prefix() {
        let p = expand_tilde("~/foo/bar");
        let home = dirs::home_dir().expect("home");
        assert_eq!(p, home.join("foo/bar"));
    }

    #[test]
    fn expand_tilde_passes_through_absolute() {
        let p = expand_tilde("/etc/hosts");
        assert_eq!(p, PathBuf::from("/etc/hosts"));
    }

    #[test]
    fn expand_tilde_does_not_treat_bare_tilde_as_home() {
        // Only "~/" is the home prefix. A bare "~" is a literal filename.
        let p = expand_tilde("~");
        assert_eq!(p, PathBuf::from("~"));
    }
}

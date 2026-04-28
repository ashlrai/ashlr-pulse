//! Install the shell hook by appending a `source` line to the user's
//! shell rc file. Idempotent — checks if the line is already present.

use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Shell { Zsh, Bash, Other }

pub fn detect() -> Shell {
    match std::env::var("SHELL").unwrap_or_default().as_str() {
        s if s.ends_with("/zsh") => Shell::Zsh,
        s if s.ends_with("/bash") => Shell::Bash,
        _ => Shell::Other,
    }
}

pub fn rc_file_for(shell: Shell) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(match shell {
        Shell::Zsh => home.join(".zshrc"),
        Shell::Bash => home.join(".bashrc"),
        Shell::Other => return None,
    })
}

pub fn hook_path_for(shell: Shell) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let dir = home.join(".local").join("share").join("pulse-agent");
    Some(match shell {
        Shell::Zsh => dir.join("pulse-hook.zsh"),
        Shell::Bash => dir.join("pulse-hook.bash"),
        Shell::Other => return None,
    })
}

pub fn source_line_for(shell: Shell) -> Option<String> {
    let path = hook_path_for(shell)?;
    let p = path.to_string_lossy();
    Some(match shell {
        Shell::Zsh | Shell::Bash => format!(
            "[ -f {p:?} ] && source {p:?}  # ashlr-pulse shell hook"
        ),
        Shell::Other => return None,
    })
}

#[derive(Debug)]
pub enum InstallResult {
    Installed,
    AlreadyPresent,
    UnsupportedShell,
    NoRcFile(PathBuf),
}

pub fn install() -> std::io::Result<InstallResult> {
    let shell = detect();
    if shell == Shell::Other {
        return Ok(InstallResult::UnsupportedShell);
    }
    let rc = match rc_file_for(shell) {
        Some(p) => p,
        None => return Ok(InstallResult::UnsupportedShell),
    };
    let line = match source_line_for(shell) {
        Some(l) => l,
        None => return Ok(InstallResult::UnsupportedShell),
    };

    // Read existing rc, check for marker. Use a stable comment marker
    // so we recognize OUR line even if the user moved/edited the source path.
    let existing = std::fs::read_to_string(&rc).unwrap_or_default();
    if existing.contains("ashlr-pulse shell hook") {
        return Ok(InstallResult::AlreadyPresent);
    }
    if existing.is_empty() && !rc.exists() {
        return Ok(InstallResult::NoRcFile(rc));
    }

    let mut updated = existing.clone();
    if !updated.is_empty() && !updated.ends_with('\n') { updated.push('\n'); }
    updated.push_str("\n# Capture terminal AI-CLI invocations (claude, codex, aider, ...)\n");
    updated.push_str(&line);
    updated.push('\n');
    std::fs::write(&rc, updated)?;
    Ok(InstallResult::Installed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_is_one_of_three() {
        // Just smoke-test that the function doesn't panic
        let _ = detect();
    }

    #[test]
    fn source_line_includes_marker() {
        let line = source_line_for(Shell::Zsh).unwrap();
        assert!(line.contains("ashlr-pulse shell hook"));
        assert!(line.contains("pulse-hook.zsh"));
    }
}

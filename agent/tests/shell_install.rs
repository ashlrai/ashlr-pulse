//! Tests for shell hook install / detect / idempotency.
//!
//! Each test that modifies $SHELL or $HOME runs serially via a global mutex
//! to avoid flaky cross-test interference (env vars are process-global).

use pulse_agent::shell_install::{
    detect, hook_path_for, install, rc_file_for, source_line_for, InstallResult, Shell,
};
use std::fs;
use std::sync::Mutex;
use tempfile::TempDir;

/// Global lock so tests that mutate $SHELL or $HOME don't race each other.
static ENV_LOCK: Mutex<()> = Mutex::new(());

// ── detect() ──────────────────────────────────────────────────────────────

#[test]
fn detect_zsh_from_shell_env() {
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("SHELL", "/usr/bin/zsh");
    assert!(matches!(detect(), Shell::Zsh));
}

#[test]
fn detect_bash_from_shell_env() {
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("SHELL", "/bin/bash");
    assert!(matches!(detect(), Shell::Bash));
}

#[test]
fn detect_other_for_fish() {
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("SHELL", "/usr/local/bin/fish");
    assert!(matches!(detect(), Shell::Other));
}

#[test]
fn detect_other_when_shell_unset() {
    let _g = ENV_LOCK.lock().unwrap();
    std::env::remove_var("SHELL");
    assert!(matches!(detect(), Shell::Other));
}

// ── rc_file_for() + hook_path_for() ───────────────────────────────────────
// These read HOME (via dirs::home_dir()) but don't mutate it, so no lock needed.

#[test]
fn rc_file_for_zsh_is_zshrc() {
    let home = dirs::home_dir().expect("home");
    assert_eq!(rc_file_for(Shell::Zsh), Some(home.join(".zshrc")));
}

#[test]
fn rc_file_for_bash_is_bashrc() {
    let home = dirs::home_dir().expect("home");
    assert_eq!(rc_file_for(Shell::Bash), Some(home.join(".bashrc")));
}

#[test]
fn rc_file_for_other_is_none() {
    assert_eq!(rc_file_for(Shell::Other), None);
}

#[test]
fn hook_path_for_zsh_ends_with_zsh() {
    let p = hook_path_for(Shell::Zsh).expect("some");
    assert!(p.to_string_lossy().ends_with("pulse-hook.zsh"));
}

#[test]
fn hook_path_for_bash_ends_with_bash() {
    let p = hook_path_for(Shell::Bash).expect("some");
    assert!(p.to_string_lossy().ends_with("pulse-hook.bash"));
}

#[test]
fn hook_path_for_other_is_none() {
    assert_eq!(hook_path_for(Shell::Other), None);
}

// ── source_line_for() ─────────────────────────────────────────────────────
// These call dirs::home_dir() via hook_path_for() — no HOME mutation needed.

#[test]
fn source_line_for_zsh_contains_marker() {
    let line = source_line_for(Shell::Zsh).expect("some");
    assert!(
        line.contains("ashlr-pulse shell hook"),
        "marker missing: {line}"
    );
    assert!(line.contains("pulse-hook.zsh"), "wrong file: {line}");
}

#[test]
fn source_line_for_bash_contains_marker() {
    let line = source_line_for(Shell::Bash).expect("some");
    assert!(line.contains("ashlr-pulse shell hook"));
    assert!(line.contains("pulse-hook.bash"));
}

#[test]
fn source_line_for_other_is_none() {
    assert_eq!(source_line_for(Shell::Other), None);
}

// ── install() helpers ──────────────────────────────────────────────────────

/// Set up a temp HOME with a pre-created rc file and configure $SHELL.
/// Returns (TempDir, rc_path). Must be called while holding ENV_LOCK.
fn setup_home_with_rc(shell_path: &str, rc_name: &str) -> (TempDir, std::path::PathBuf) {
    let dir = TempDir::new().expect("tempdir");
    std::env::set_var("HOME", dir.path());
    std::env::set_var("SHELL", shell_path);
    let rc = dir.path().join(rc_name);
    fs::write(&rc, "# existing content\n").expect("create rc");
    (dir, rc)
}

// ── install() — happy path ─────────────────────────────────────────────────

#[test]
fn install_zsh_writes_to_zshrc() {
    let _g = ENV_LOCK.lock().unwrap();
    let (_dir, zshrc) = setup_home_with_rc("/usr/bin/zsh", ".zshrc");

    let result = install().expect("install");
    assert!(
        matches!(result, InstallResult::Installed),
        "expected Installed, got {result:?}"
    );

    let content = fs::read_to_string(&zshrc).expect("read");
    assert!(content.contains("ashlr-pulse shell hook"), "marker missing");
    assert!(content.contains("# existing content"), "original content wiped");
}

#[test]
fn install_bash_writes_to_bashrc() {
    let _g = ENV_LOCK.lock().unwrap();
    let (_dir, bashrc) = setup_home_with_rc("/bin/bash", ".bashrc");

    let result = install().expect("install");
    assert!(matches!(result, InstallResult::Installed));

    let content = fs::read_to_string(&bashrc).expect("read");
    assert!(content.contains("ashlr-pulse shell hook"));
}

// ── install() — idempotency ────────────────────────────────────────────────

#[test]
fn install_twice_returns_already_present() {
    let _g = ENV_LOCK.lock().unwrap();
    let (_dir, _rc) = setup_home_with_rc("/usr/bin/zsh", ".zshrc");

    let r1 = install().expect("first install");
    assert!(matches!(r1, InstallResult::Installed), "first: {r1:?}");

    let r2 = install().expect("second install");
    assert!(
        matches!(r2, InstallResult::AlreadyPresent),
        "second install should be AlreadyPresent, got {r2:?}"
    );
}

#[test]
fn install_idempotent_content_unchanged() {
    let _g = ENV_LOCK.lock().unwrap();
    let (_dir, rc) = setup_home_with_rc("/usr/bin/zsh", ".zshrc");

    install().expect("first");
    let after_first = fs::read_to_string(&rc).expect("read after first");

    install().expect("second");
    let after_second = fs::read_to_string(&rc).expect("read after second");

    assert_eq!(after_first, after_second, "rc file must not change on second install");
}

#[test]
fn install_marker_appears_exactly_once() {
    let _g = ENV_LOCK.lock().unwrap();
    let (_dir, rc) = setup_home_with_rc("/usr/bin/zsh", ".zshrc");

    for _ in 0..3 {
        install().expect("install");
    }

    let content = fs::read_to_string(&rc).expect("read");
    let count = content.matches("ashlr-pulse shell hook").count();
    assert_eq!(count, 1, "marker must appear exactly once; found {count}");
}

// ── install() — edge cases ─────────────────────────────────────────────────

#[test]
fn install_returns_unsupported_for_fish() {
    let _g = ENV_LOCK.lock().unwrap();
    let _dir = TempDir::new().expect("tempdir");
    std::env::set_var("HOME", _dir.path());
    std::env::set_var("SHELL", "/usr/local/bin/fish");

    let result = install().expect("no io error");
    assert!(
        matches!(result, InstallResult::UnsupportedShell),
        "fish should return UnsupportedShell, got {result:?}"
    );
}

#[test]
fn install_with_missing_rc_file_returns_no_rc_or_installed() {
    let _g = ENV_LOCK.lock().unwrap();
    let dir = TempDir::new().expect("tempdir");
    std::env::set_var("HOME", dir.path());
    // Do NOT create .zshrc
    std::env::set_var("SHELL", "/usr/bin/zsh");

    let result = install().expect("no io error");
    // Either NoRcFile or Installed — must not panic or error.
    match result {
        InstallResult::NoRcFile(_) | InstallResult::Installed => {}
        other => panic!("unexpected result with missing rc: {other:?}"),
    }
}

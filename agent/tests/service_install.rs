//! Tests for service install file generation.
//!
//! Tests that mutate $HOME run serially via ENV_LOCK to avoid races on the
//! process-global environment.

use pulse_agent::service_install::InstallResult;
use std::path::PathBuf;
use std::sync::Mutex;
use tempfile::TempDir;

/// Global lock for tests that mutate $HOME / $XDG_DATA_HOME.
static ENV_LOCK: Mutex<()> = Mutex::new(());

fn set_temp_home() -> TempDir {
    let dir = TempDir::new().expect("tempdir");
    std::env::set_var("HOME", dir.path());
    #[cfg(target_os = "linux")]
    std::env::set_var("XDG_DATA_HOME", dir.path());
    dir
}

// ── cross-platform: InstallResult variants are Debug ──────────────────────

#[test]
fn install_result_debug_format_is_stable() {
    let installed = InstallResult::Installed {
        service_path: PathBuf::from("/tmp/test.service"),
        started: true,
        log_path: PathBuf::from("/tmp/test.log"),
    };
    let already = InstallResult::AlreadyInstalled {
        service_path: PathBuf::from("/tmp/test.service"),
    };
    let unsupported = InstallResult::Unsupported("test platform");
    let error = InstallResult::Error("something broke".into());

    assert!(format!("{installed:?}").contains("Installed"));
    assert!(format!("{already:?}").contains("AlreadyInstalled"));
    assert!(format!("{unsupported:?}").contains("Unsupported"));
    assert!(format!("{error:?}").contains("Error"));
}

// ── unsupported platform ───────────────────────────────────────────────────

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
#[test]
fn install_returns_unsupported_on_unknown_platform() {
    let bin = PathBuf::from("/fake/pulse-agent");
    let result = pulse_agent::service_install::install(&bin);
    assert!(
        matches!(result, InstallResult::Unsupported(_)),
        "non-mac/linux should return Unsupported"
    );
}

// ── macOS launchd plist ────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    use super::*;

    fn get_service_path(result: &InstallResult) -> PathBuf {
        match result {
            InstallResult::Installed { service_path, .. } => service_path.clone(),
            InstallResult::AlreadyInstalled { service_path } => service_path.clone(),
            InstallResult::Unsupported(why) => panic!("Unsupported: {why}"),
            InstallResult::Error(e) => panic!("Error: {e}"),
        }
    }

    #[test]
    fn launchd_plist_is_written_to_launch_agents() {
        let _g = ENV_LOCK.lock().unwrap();
        let _home_dir = set_temp_home();
        let home = dirs::home_dir().expect("home");

        let fake_bin = home.join("pulse-agent");
        std::fs::write(&fake_bin, b"#!/bin/sh\n").expect("write stub");

        let result = pulse_agent::service_install::install(&fake_bin);
        let plist_path = get_service_path(&result);

        assert!(plist_path.exists(), "plist file must be written");
        let expected_dir = home.join("Library").join("LaunchAgents");
        assert_eq!(
            plist_path.parent().unwrap(),
            expected_dir,
            "plist must be in LaunchAgents dir"
        );
        assert_eq!(
            plist_path.file_name().unwrap().to_str().unwrap(),
            "ai.ashlr.pulse-agent.plist"
        );
    }

    #[test]
    fn launchd_plist_contains_required_keys() {
        let _g = ENV_LOCK.lock().unwrap();
        let _home_dir = set_temp_home();
        let home = dirs::home_dir().expect("home");
        let fake_bin = home.join("pulse-agent");
        std::fs::write(&fake_bin, b"#!/bin/sh\n").expect("write stub");

        let result = pulse_agent::service_install::install(&fake_bin);
        let plist_path = get_service_path(&result);

        let content = std::fs::read_to_string(&plist_path).expect("read plist");
        assert!(content.contains("ai.ashlr.pulse-agent"), "missing Label");
        assert!(content.contains("<key>RunAtLoad</key>"), "missing RunAtLoad");
        assert!(content.contains("<key>KeepAlive</key>"), "missing KeepAlive");
        assert!(
            content.contains(fake_bin.to_string_lossy().as_ref()),
            "plist must contain the binary path"
        );
        assert!(content.contains("<string>run</string>"), "plist must pass 'run' arg");
    }

    #[test]
    fn launchd_install_is_idempotent() {
        let _g = ENV_LOCK.lock().unwrap();
        let _home_dir = set_temp_home();
        let home = dirs::home_dir().expect("home");
        let fake_bin = home.join("pulse-agent");
        std::fs::write(&fake_bin, b"#!/bin/sh\n").expect("write stub");

        let r1 = pulse_agent::service_install::install(&fake_bin);
        let path1 = get_service_path(&r1);
        let content1 = std::fs::read_to_string(&path1).expect("read 1");

        let r2 = pulse_agent::service_install::install(&fake_bin);
        let path2 = get_service_path(&r2);
        let content2 = std::fs::read_to_string(&path2).expect("read 2");

        assert_eq!(path1, path2, "plist path must be stable");
        assert_eq!(content1, content2, "plist content must be stable on re-install");
    }
}

// ── Linux systemd unit ─────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod linux {
    use super::*;

    fn get_service_path(result: &InstallResult) -> PathBuf {
        match result {
            InstallResult::Installed { service_path, .. } => service_path.clone(),
            InstallResult::AlreadyInstalled { service_path } => service_path.clone(),
            InstallResult::Unsupported(why) => panic!("Unsupported: {why}"),
            InstallResult::Error(e) => panic!("Error: {e}"),
        }
    }

    #[test]
    fn systemd_unit_is_written_to_user_dir() {
        let _g = ENV_LOCK.lock().unwrap();
        let _home_dir = set_temp_home();
        let home = dirs::home_dir().expect("home");
        let fake_bin = home.join("pulse-agent");
        std::fs::write(&fake_bin, b"#!/bin/sh\n").expect("write stub");

        let result = pulse_agent::service_install::install(&fake_bin);
        let unit_path = get_service_path(&result);

        assert!(unit_path.exists(), "unit file must be written");
        let expected_dir = home.join(".config").join("systemd").join("user");
        assert_eq!(unit_path.parent().unwrap(), expected_dir);
        assert_eq!(
            unit_path.file_name().unwrap().to_str().unwrap(),
            "pulse-agent.service"
        );
    }

    #[test]
    fn systemd_unit_contains_required_sections() {
        let _g = ENV_LOCK.lock().unwrap();
        let _home_dir = set_temp_home();
        let home = dirs::home_dir().expect("home");
        let fake_bin = home.join("pulse-agent");
        std::fs::write(&fake_bin, b"#!/bin/sh\n").expect("write stub");

        let result = pulse_agent::service_install::install(&fake_bin);
        let unit_path = get_service_path(&result);

        let content = std::fs::read_to_string(&unit_path).expect("read unit");
        assert!(content.contains("[Unit]"), "missing [Unit]");
        assert!(content.contains("[Service]"), "missing [Service]");
        assert!(content.contains("[Install]"), "missing [Install]");
        assert!(content.contains("Restart=on-failure"), "missing Restart policy");
        assert!(
            content.contains(fake_bin.to_string_lossy().as_ref()),
            "unit must reference binary path"
        );
        assert!(content.contains("run"), "unit must pass 'run' subcommand");
        assert!(content.contains("WantedBy=default.target"), "missing WantedBy");
    }

    #[test]
    fn systemd_install_is_idempotent_content() {
        let _g = ENV_LOCK.lock().unwrap();
        let _home_dir = set_temp_home();
        let home = dirs::home_dir().expect("home");
        let fake_bin = home.join("pulse-agent");
        std::fs::write(&fake_bin, b"#!/bin/sh\n").expect("write stub");

        let r1 = pulse_agent::service_install::install(&fake_bin);
        let p1 = get_service_path(&r1);
        let c1 = std::fs::read_to_string(&p1).expect("read 1");

        let r2 = pulse_agent::service_install::install(&fake_bin);
        let p2 = get_service_path(&r2);
        let c2 = std::fs::read_to_string(&p2).expect("read 2");

        assert_eq!(p1, p2);
        assert_eq!(c1, c2);
    }
}

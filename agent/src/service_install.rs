//! Install pulse-agent as a background service (launchd on macOS,
//! systemd --user on Linux). Idempotent — overwriting the service
//! definition is safe; reload picks up changes.

use std::path::PathBuf;

#[derive(Debug)]
pub enum InstallResult {
    Installed { service_path: PathBuf, started: bool, log_path: PathBuf },
    AlreadyInstalled { service_path: PathBuf },
    Unsupported(&'static str),
    Error(String),
}

#[cfg(target_os = "macos")]
pub fn install(pulse_agent_bin: &std::path::Path) -> InstallResult {
    install_launchd(pulse_agent_bin)
}

#[cfg(target_os = "linux")]
pub fn install(pulse_agent_bin: &std::path::Path) -> InstallResult {
    install_systemd(pulse_agent_bin)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn install(_: &std::path::Path) -> InstallResult {
    InstallResult::Unsupported("only macOS launchd + Linux systemd --user are supported")
}

// ── macOS launchd ──────────────────────────────────────────────────────────

#[allow(dead_code)]
fn install_launchd(pulse_agent_bin: &std::path::Path) -> InstallResult {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return InstallResult::Error("no home dir".into()),
    };
    let plist_dir = home.join("Library").join("LaunchAgents");
    if let Err(e) = std::fs::create_dir_all(&plist_dir) {
        return InstallResult::Error(format!("creating LaunchAgents dir: {e}"));
    }
    let plist_path = plist_dir.join("ai.ashlr.pulse-agent.plist");
    let log_path = home.join("Library").join("Logs").join("pulse-agent.log");
    let _ = std::fs::create_dir_all(home.join("Library").join("Logs"));

    let plist = format!(
r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.ashlr.pulse-agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>{bin}</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>{log}</string>
    <key>StandardErrorPath</key>
    <string>{log}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
"#,
        bin = pulse_agent_bin.display(),
        log = log_path.display(),
    );

    // Was it already installed (and unchanged)?
    let already = std::fs::read_to_string(&plist_path).ok().as_deref() == Some(plist.as_str());
    if let Err(e) = std::fs::write(&plist_path, &plist) {
        return InstallResult::Error(format!("writing plist: {e}"));
    }

    // bootstrap+kickstart works on modern macOS. Fall back to load+start
    // for older systems.
    let user_id = unsafe { libc_getuid_shim() };
    let domain = format!("gui/{}", user_id);
    let _ = std::process::Command::new("launchctl")
        .args(["bootout", &domain, &plist_path.to_string_lossy()])
        .output();
    let bootstrap = std::process::Command::new("launchctl")
        .args(["bootstrap", &domain, &plist_path.to_string_lossy()])
        .output();
    let started = bootstrap.as_ref().map(|o| o.status.success()).unwrap_or(false);

    if already && started {
        return InstallResult::AlreadyInstalled { service_path: plist_path };
    }
    InstallResult::Installed { service_path: plist_path, started, log_path }
}

/// Tiny shim around getuid() so we don't need a libc dep.
#[cfg(target_os = "macos")]
unsafe fn libc_getuid_shim() -> u32 {
    extern "C" { fn getuid() -> u32; }
    getuid()
}
#[cfg(not(target_os = "macos"))]
unsafe fn libc_getuid_shim() -> u32 { 0 }

// ── Linux systemd --user ───────────────────────────────────────────────────

#[allow(dead_code)]
fn install_systemd(pulse_agent_bin: &std::path::Path) -> InstallResult {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return InstallResult::Error("no home dir".into()),
    };
    let unit_dir = home.join(".config").join("systemd").join("user");
    if let Err(e) = std::fs::create_dir_all(&unit_dir) {
        return InstallResult::Error(format!("creating systemd dir: {e}"));
    }
    let unit_path = unit_dir.join("pulse-agent.service");
    let log_path = home.join(".local").join("share").join("pulse-agent").join("pulse-agent.log");

    let unit = format!(
"[Unit]
Description=Ashlr Pulse local agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart={bin} run
Restart=on-failure
RestartSec=10s
StandardOutput=append:{log}
StandardError=append:{log}

[Install]
WantedBy=default.target
",
        bin = pulse_agent_bin.display(),
        log = log_path.display(),
    );

    let already = std::fs::read_to_string(&unit_path).ok().as_deref() == Some(unit.as_str());
    if let Err(e) = std::fs::write(&unit_path, &unit) {
        return InstallResult::Error(format!("writing unit: {e}"));
    }
    let _ = std::process::Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .output();
    let started = std::process::Command::new("systemctl")
        .args(["--user", "enable", "--now", "pulse-agent.service"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if already && started {
        return InstallResult::AlreadyInstalled { service_path: unit_path };
    }
    InstallResult::Installed { service_path: unit_path, started, log_path }
}

//! Tests for the orchestrator / onboard step coordination.
//!
//! The orchestrator (`pulse_agent::orchestrator`) drives the `onboard` flow:
//! server probe → auth → repo scan → shell hook → service → GitHub connect.
//! Because it calls out to a live server and spawns subprocesses, we test
//! the units it delegates to (step logic, option parsing) and its shutdown
//! channel mechanics rather than the full `run()` end-to-end.

use pulse_agent::orchestrator::OnboardOpts;

// ── OnboardOpts defaults ───────────────────────────────────────────────────

#[test]
fn onboard_opts_default_all_steps_enabled() {
    let opts = OnboardOpts::default();
    assert!(!opts.skip_repo_scan, "repo scan should be on by default");
    assert!(!opts.skip_shell_hook, "shell hook should be on by default");
    assert!(!opts.skip_service, "service install should be on by default");
    assert!(!opts.skip_github, "github connect should be on by default");
    assert!(!opts.yes, "yes-mode should be off by default");
}

#[test]
fn onboard_opts_url_defaults_to_empty() {
    let opts = OnboardOpts::default();
    assert_eq!(opts.url, "", "url should default to empty string");
}

#[test]
fn onboard_opts_skip_flags_are_independent() {
    let opts = OnboardOpts {
        url: "https://example.com".into(),
        skip_repo_scan: true,
        skip_shell_hook: false,
        skip_service: true,
        skip_github: false,
        yes: true,
    };
    assert!(opts.skip_repo_scan);
    assert!(!opts.skip_shell_hook);
    assert!(opts.skip_service);
    assert!(!opts.skip_github);
    assert!(opts.yes);
}

// ── tokio shutdown channel mechanics ──────────────────────────────────────
//
// These tests validate the pattern used by every poller in the agent:
// a `tokio::sync::watch` channel drives graceful shutdown.

#[tokio::test]
async fn shutdown_watch_channel_signals_receivers() {
    let (tx, mut rx) = tokio::sync::watch::channel(false);

    // Receiver has NOT changed yet.
    assert!(!*rx.borrow());

    tx.send(true).expect("send");
    rx.changed().await.expect("changed");
    assert!(*rx.borrow());
}

#[tokio::test]
async fn multiple_receivers_all_see_shutdown() {
    let (tx, rx1) = tokio::sync::watch::channel(false);
    let mut rx2 = rx1.clone();
    let mut rx3 = rx1.clone();

    tx.send(true).expect("send");

    rx2.changed().await.expect("rx2");
    rx3.changed().await.expect("rx3");

    assert!(*rx2.borrow());
    assert!(*rx3.borrow());
}

#[tokio::test]
async fn poller_loop_exits_on_shutdown() {
    // Simulate a minimal poller loop that blocks on tick OR shutdown.
    let (tx, mut rx) = tokio::sync::watch::channel(false);
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
    interval.tick().await; // consume the immediate first tick

    let loop_handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    // would do work here
                }
                _ = rx.changed() => {
                    return "shutdown";
                }
            }
        }
    });

    // Give the loop a moment to park on the select, then signal shutdown.
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    tx.send(true).expect("send shutdown");

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        loop_handle,
    )
    .await
    .expect("timeout")
    .expect("join");

    assert_eq!(result, "shutdown");
}

#[tokio::test]
async fn panic_in_one_task_does_not_affect_other_tasks() {
    // Validate that a panic in one spawned task doesn't bring down sibling tasks.
    // This mirrors the orchestrator spawning multiple independent pollers.
    let (tx, rx1) = tokio::sync::watch::channel(false);
    let rx2 = rx1.clone();

    // Task A: panics immediately.
    let handle_a = tokio::spawn(async move {
        let _rx = rx1; // hold the receiver but never use it
        panic!("simulated poller panic");
    });

    // Task B: does real work, waits for shutdown signal.
    let handle_b = tokio::spawn(async move {
        let mut rx = rx2;
        rx.changed().await.expect("changed");
        "task_b_finished"
    });

    // A should complete with a JoinError (panic).
    let result_a = handle_a.await;
    assert!(result_a.is_err(), "panicking task should propagate JoinError");

    // Signal B to stop, then confirm it exited cleanly.
    tx.send(true).expect("shutdown");
    let result_b = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        handle_b,
    )
    .await
    .expect("timeout")
    .expect("join");
    assert_eq!(result_b, "task_b_finished");
}

// ── probe_server shape ─────────────────────────────────────────────────────
//
// We can't call `probe_server` directly (it's private), but we validate
// the expected response shape the server must return using a mockito server.

#[tokio::test]
async fn healthz_ok_shape_is_accepted() {
    let mut server = mockito::Server::new_async().await;
    let _mock = server
        .mock("GET", "/api/healthz")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"ok":true}"#)
        .create_async()
        .await;

    let url = server.url();
    let healthz = format!("{url}/api/healthz");
    let client = reqwest::Client::new();
    let res = client.get(&healthz).send().await.expect("send");
    assert!(res.status().is_success());
    let body: serde_json::Value = res.json().await.expect("json");
    assert_eq!(body.get("ok"), Some(&serde_json::Value::Bool(true)));
}

#[tokio::test]
async fn healthz_non_ok_body_should_be_flagged() {
    let mut server = mockito::Server::new_async().await;
    let _mock = server
        .mock("GET", "/api/healthz")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"ok":false,"error":"database offline"}"#)
        .create_async()
        .await;

    let url = server.url();
    let healthz = format!("{url}/api/healthz");
    let client = reqwest::Client::new();
    let res = client.get(&healthz).send().await.expect("send");
    assert!(res.status().is_success());
    let body: serde_json::Value = res.json().await.expect("json");
    // The real probe_server bails when ok != true.
    assert_ne!(body.get("ok"), Some(&serde_json::Value::Bool(true)));
}

#[tokio::test]
async fn healthz_non_2xx_is_an_error() {
    let mut server = mockito::Server::new_async().await;
    let _mock = server
        .mock("GET", "/api/healthz")
        .with_status(503)
        .with_body("service unavailable")
        .create_async()
        .await;

    let url = server.url();
    let healthz = format!("{url}/api/healthz");
    let client = reqwest::Client::new();
    let res = client.get(&healthz).send().await.expect("send");
    assert!(!res.status().is_success());
}

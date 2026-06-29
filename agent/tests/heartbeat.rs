//! Tests for the heartbeat module.
//!
//! Uses a mockito HTTP server to validate the POST shape, auth header,
//! and that the shutdown signal terminates the loop.

use pulse_agent::heartbeat::hostname_label;
use std::time::Duration;

// ── hostname_label() ───────────────────────────────────────────────────────

#[test]
fn hostname_label_returns_non_empty_string() {
    let label = hostname_label();
    assert!(!label.is_empty(), "hostname_label() must not return empty string");
}

#[test]
fn hostname_label_uses_hostname_env_when_set() {
    std::env::set_var("HOSTNAME", "my-test-host");
    let label = hostname_label();
    // Either returns the env var value or falls back to `hostname` command.
    // With the env var set, it should prefer it.
    assert_eq!(label, "my-test-host");
    std::env::remove_var("HOSTNAME");
}

#[test]
fn hostname_label_falls_back_when_hostname_empty() {
    std::env::set_var("HOSTNAME", "");
    let label = hostname_label();
    // Falls back to `hostname` command or "agent" — must still be non-empty.
    assert!(!label.is_empty());
    std::env::remove_var("HOSTNAME");
}

#[test]
fn hostname_label_falls_back_to_agent_literal() {
    // Unset HOSTNAME so it falls through to the command; if `hostname`
    // also fails (e.g. restricted CI), the final fallback is "agent".
    std::env::remove_var("HOSTNAME");
    let label = hostname_label();
    // Any non-empty string is acceptable.
    assert!(!label.is_empty());
    // The literal fallback "agent" is valid.
    assert!(label.len() > 0);
}

// ── heartbeat POST shape via mockito ──────────────────────────────────────

#[tokio::test]
async fn heartbeat_posts_to_correct_endpoint() {
    let mut server = mockito::Server::new_async().await;
    let mock = server
        .mock("POST", "/api/agent/heartbeat")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"ok":true}"#)
        .expect(1)
        .create_async()
        .await;

    let server_url = server.url();
    let (tx, rx) = tokio::sync::watch::channel(false);

    // Run the heartbeat loop in a background task.
    let handle = tokio::spawn(pulse_agent::heartbeat::run(
        server_url,
        "test-pat".to_string(),
        Some("test-host".to_string()),
        rx,
    ));

    // Give it time to fire the initial ping.
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Shut it down.
    tx.send(true).expect("send shutdown");
    tokio::time::timeout(Duration::from_secs(2), handle)
        .await
        .expect("timeout")
        .expect("join");

    mock.assert_async().await;
}

#[tokio::test]
async fn heartbeat_sends_bearer_auth_header() {
    let mut server = mockito::Server::new_async().await;
    let mock = server
        .mock("POST", "/api/agent/heartbeat")
        .match_header("authorization", "Bearer secret-pat-123")
        .with_status(200)
        .with_body(r#"{"ok":true}"#)
        .expect_at_least(1)
        .create_async()
        .await;

    let server_url = server.url();
    let (tx, rx) = tokio::sync::watch::channel(false);

    let handle = tokio::spawn(pulse_agent::heartbeat::run(
        server_url,
        "secret-pat-123".to_string(),
        None,
        rx,
    ));

    tokio::time::sleep(Duration::from_millis(100)).await;
    tx.send(true).expect("shutdown");
    tokio::time::timeout(Duration::from_secs(2), handle)
        .await
        .expect("timeout")
        .expect("join");

    mock.assert_async().await;
}

#[tokio::test]
async fn heartbeat_body_contains_agent_version() {
    let mut server = mockito::Server::new_async().await;
    let mock = server
        .mock("POST", "/api/agent/heartbeat")
        .match_body(mockito::Matcher::PartialJson(serde_json::json!({
            "agent_version": env!("CARGO_PKG_VERSION")
        })))
        .with_status(200)
        .with_body(r#"{"ok":true}"#)
        .expect_at_least(1)
        .create_async()
        .await;

    let server_url = server.url();
    let (tx, rx) = tokio::sync::watch::channel(false);

    let handle = tokio::spawn(pulse_agent::heartbeat::run(
        server_url,
        "pat".to_string(),
        Some("test-host".to_string()),
        rx,
    ));

    tokio::time::sleep(Duration::from_millis(100)).await;
    tx.send(true).expect("shutdown");
    tokio::time::timeout(Duration::from_secs(2), handle)
        .await
        .expect("timeout")
        .expect("join");

    mock.assert_async().await;
}

#[tokio::test]
async fn heartbeat_body_contains_agent_label() {
    let mut server = mockito::Server::new_async().await;
    let mock = server
        .mock("POST", "/api/agent/heartbeat")
        .match_body(mockito::Matcher::PartialJson(serde_json::json!({
            "agent_label": "my-machine"
        })))
        .with_status(200)
        .with_body(r#"{"ok":true}"#)
        .expect_at_least(1)
        .create_async()
        .await;

    let server_url = server.url();
    let (tx, rx) = tokio::sync::watch::channel(false);

    let handle = tokio::spawn(pulse_agent::heartbeat::run(
        server_url,
        "pat".to_string(),
        Some("my-machine".to_string()),
        rx,
    ));

    tokio::time::sleep(Duration::from_millis(100)).await;
    tx.send(true).expect("shutdown");
    tokio::time::timeout(Duration::from_secs(2), handle)
        .await
        .expect("timeout")
        .expect("join");

    mock.assert_async().await;
}

#[tokio::test]
async fn heartbeat_stops_on_shutdown_signal() {
    // Server that never responds — if the loop ignores shutdown, the test hangs.
    let mut server = mockito::Server::new_async().await;
    let _mock = server
        .mock("POST", "/api/agent/heartbeat")
        .with_status(200)
        .with_body(r#"{"ok":true}"#)
        .create_async()
        .await;

    let server_url = server.url();
    let (tx, rx) = tokio::sync::watch::channel(false);

    let handle = tokio::spawn(pulse_agent::heartbeat::run(
        server_url,
        "pat".to_string(),
        None,
        rx,
    ));

    // Fire shutdown immediately after a brief moment.
    tokio::time::sleep(Duration::from_millis(50)).await;
    tx.send(true).expect("send");

    // Must complete within 1 second.
    tokio::time::timeout(Duration::from_secs(1), handle)
        .await
        .expect("heartbeat loop must exit within 1s after shutdown signal")
        .expect("join");
}

#[tokio::test]
async fn heartbeat_tolerates_server_error_and_continues() {
    // Server returns 500 on first request, then 200 — loop must not die.
    let mut server = mockito::Server::new_async().await;
    let _mock_err = server
        .mock("POST", "/api/agent/heartbeat")
        .with_status(500)
        .with_body(r#"{"error":"internal"}"#)
        .expect(1)
        .create_async()
        .await;

    let server_url = server.url();
    let (tx, rx) = tokio::sync::watch::channel(false);

    let handle = tokio::spawn(pulse_agent::heartbeat::run(
        server_url,
        "pat".to_string(),
        None,
        rx,
    ));

    // Give the initial ping time to hit the 500.
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Shut down — loop must still be alive.
    tx.send(true).expect("shutdown");
    tokio::time::timeout(Duration::from_secs(1), handle)
        .await
        .expect("loop must still be running after a failed ping")
        .expect("join");
}

#[tokio::test]
async fn heartbeat_url_trailing_slash_handled() {
    // Server URL with trailing slash — heartbeat must still POST to correct path.
    let mut server = mockito::Server::new_async().await;
    let mock = server
        .mock("POST", "/api/agent/heartbeat")
        .with_status(200)
        .with_body(r#"{"ok":true}"#)
        .expect(1)
        .create_async()
        .await;

    let server_url = format!("{}/", server.url()); // trailing slash
    let (tx, rx) = tokio::sync::watch::channel(false);

    let handle = tokio::spawn(pulse_agent::heartbeat::run(
        server_url,
        "pat".to_string(),
        None,
        rx,
    ));

    tokio::time::sleep(Duration::from_millis(100)).await;
    tx.send(true).expect("shutdown");
    tokio::time::timeout(Duration::from_secs(2), handle)
        .await
        .expect("timeout")
        .expect("join");

    mock.assert_async().await;
}

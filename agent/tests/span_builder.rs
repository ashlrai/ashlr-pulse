//! Integration-level tests for span construction.
//!
//! These run with `cargo test` — no server needed.

use pulse_agent::span::{SpanBuilder, OtlpTracesPayload, now_ns};

#[test]
fn claude_span_has_required_attributes() {
    let ts = 1_713_827_400_000_000_000u128;
    let payload = SpanBuilder::new("gen_ai.request", ts, ts + 1_500_000_000)
        .attr_str("gen_ai.system", "anthropic")
        .attr_str("gen_ai.request.model", "claude-opus-4-7")
        .attr_int("gen_ai.usage.input_tokens", 1280)
        .attr_int("gen_ai.usage.output_tokens", 640)
        .attr_int("gen_ai.usage.cache_read_tokens", 8192)
        .attr_str("claude.session.id", "sess-abc-1")
        .attr_str("claude.repo.name", "ashlrai/ashlr-pulse")
        .attr_str("claude.git.branch", "main")
        .build();

    let span = &payload.resource_spans[0].scope_spans[0].spans[0];
    assert_eq!(span.name, "gen_ai.request");
    assert_eq!(span.start_time_unix_nano, ts.to_string());
    assert_eq!(span.end_time_unix_nano, (ts + 1_500_000_000).to_string());

    let attr_map: std::collections::HashMap<_, _> = span.attributes
        .iter()
        .filter_map(|kv| {
            use pulse_agent::span::AnyValue;
            match &kv.value {
                AnyValue::String { string_value } => Some((kv.key.as_str(), string_value.clone())),
                _ => None,
            }
        })
        .collect();

    assert_eq!(attr_map.get("gen_ai.system").map(|s| s.as_str()), Some("anthropic"));
    assert_eq!(attr_map.get("gen_ai.request.model").map(|s| s.as_str()), Some("claude-opus-4-7"));
    assert_eq!(attr_map.get("claude.session.id").map(|s| s.as_str()), Some("sess-abc-1"));
    assert_eq!(attr_map.get("claude.repo.name").map(|s| s.as_str()), Some("ashlrai/ashlr-pulse"));
    assert_eq!(attr_map.get("claude.git.branch").map(|s| s.as_str()), Some("main"));
}

#[test]
fn git_span_has_ashlr_source_git() {
    let ts = 1_714_100_000_000_000_000u128;
    let payload = SpanBuilder::new("git.commit", ts, ts)
        .attr_str("gen_ai.system", "anthropic")
        .attr_str("ashlr.source", "git")
        .attr_str("claude.repo.name", "ashlrai/ashlr-pulse")
        .attr_str("claude.git.branch", "main")
        .build();

    let span = &payload.resource_spans[0].scope_spans[0].spans[0];
    assert_eq!(span.name, "git.commit");
    // Zero-duration: start == end.
    assert_eq!(span.start_time_unix_nano, span.end_time_unix_nano);

    let has_source_git = span.attributes.iter().any(|kv| {
        use pulse_agent::span::AnyValue;
        kv.key == "ashlr.source"
            && matches!(&kv.value, AnyValue::String { string_value } if string_value == "git")
    });
    assert!(has_source_git, "ashlr.source=git attribute missing from git span");
}

#[test]
fn empty_payload_serializes_correctly() {
    let payload = OtlpTracesPayload { resource_spans: vec![] };
    let json = serde_json::to_string(&payload).unwrap();
    assert_eq!(json, r#"{"resourceSpans":[]}"#);
}

#[test]
fn int_attributes_serialize_as_string() {
    // OTLP/JSON spec: intValue must be a string (to handle 64-bit precision
    // without JSON integer loss).
    let payload = SpanBuilder::new("gen_ai.request", 1, 2)
        .attr_int("gen_ai.usage.input_tokens", 99999)
        .build();

    let json = serde_json::to_string(&payload).unwrap();
    // The intValue should appear as a quoted string, not a bare number.
    assert!(json.contains(r#""intValue":"99999""#), "intValue not quoted in: {json}");
}

#[test]
fn remote_url_to_repo_name_handles_ssh_and_https() {
    use pulse_agent::claude::remote_url_to_repo_name;

    assert_eq!(
        remote_url_to_repo_name("git@github.com:ashlrai/ashlr-pulse.git"),
        "ashlrai/ashlr-pulse"
    );
    assert_eq!(
        remote_url_to_repo_name("https://github.com/ashlrai/ashlr-pulse.git"),
        "ashlrai/ashlr-pulse"
    );
    assert_eq!(
        remote_url_to_repo_name("https://github.com/ashlrai/ashlr-pulse"),
        "ashlrai/ashlr-pulse"
    );
}

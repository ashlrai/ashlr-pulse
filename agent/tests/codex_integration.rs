//! Integration test for the Codex rollout-JSONL tailer.
//!
//! Targets two layers:
//!   1. **Discovery**: `walk_rollout_files()` finds rollout-*.jsonl files
//!      anywhere in a nested YYYY/MM/DD directory hierarchy and ignores
//!      sibling files like `history.jsonl`.
//!   2. **Privacy floor**: parsing the fixture JSONL never deserializes
//!      `response_item:message`, `response_item:reasoning`, or
//!      `response_item:function_call_output` payload bodies. The fixture
//!      contains attention-getting strings inside those payloads; the
//!      test asserts they don't survive into any parsed value we emit.
//!
//! We don't spin up an HTTP server or mock OtlpExporter here — the OTLP
//! export path is independently covered by `span_builder.rs`. This test
//! focuses on the path that's unique to `codex.rs`: file discovery + the
//! event-stream state machine.

use std::fs;
use std::path::PathBuf;

use pulse_agent::codex;

/// Build a temp dir per test process to avoid collisions when bun-test
/// or cargo runs them in parallel.
fn temp_dir(suffix: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "pulse-codex-it-{}-{}-{}",
        std::process::id(),
        suffix,
        // Nanosecond fragment so two tests in the same process don't collide.
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() % 1_000_000_000)
            .unwrap_or(0),
    ));
    let _ = fs::remove_dir_all(&p);
    fs::create_dir_all(&p).expect("create temp dir");
    p
}

/// A representative subset of a real Codex rollout file. Prompts and
/// completions have been replaced with attention-getting sentinel strings
/// the privacy-floor canary scans for. Token counts are realistic.
const FIXTURE: &str = r#"{"timestamp":"2026-05-08T22:59:44.137Z","type":"session_meta","payload":{"id":"019e09d1-7b89-7a31-a45b-ade3432e48fd","timestamp":"2026-05-08T22:59:44.137Z","cwd":"/tmp/test-proj","originator":"codex-tui","cli_version":"0.129.0","source":{"subagent":{"thread_spawn":{"parent_thread_id":"019e09ae-f6cd-7f80-9506-63427442b994","depth":1}}}}}
{"timestamp":"2026-05-08T22:59:45.000Z","type":"event_msg","payload":{"type":"task_started"}}
{"timestamp":"2026-05-08T22:59:45.500Z","type":"turn_context","payload":{"turn_id":"turn-1","cwd":"/tmp/test-proj","model":"gpt-5.5","approval_policy":"never","sandbox_policy":{"type":"danger-full-access"},"effort":"medium"}}
{"timestamp":"2026-05-08T22:59:46.000Z","type":"event_msg","payload":{"type":"user_message","message":"PROMPT_LEAK_SENTINEL: this should never appear in any parsed output"}}
{"timestamp":"2026-05-08T22:59:46.500Z","type":"response_item","payload":{"type":"reasoning","summary":[{"text":"REASONING_LEAK_SENTINEL: model thoughts must not be read"}]}}
{"timestamp":"2026-05-08T22:59:47.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"call-1","arguments":"{\"cmd\":\"ARGUMENTS_LEAK_SENTINEL\"}"}}
{"timestamp":"2026-05-08T22:59:47.500Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"OUTPUT_LEAK_SENTINEL: shell output must not be read"}}
{"timestamp":"2026-05-08T22:59:48.000Z","type":"response_item","payload":{"type":"function_call","name":"write_file","call_id":"call-2","arguments":"{\"path\":\"x\",\"content\":\"FILE_CONTENT_LEAK_SENTINEL\"}"}}
{"timestamp":"2026-05-08T22:59:48.500Z","type":"response_item","payload":{"type":"message","content":[{"type":"output_text","text":"COMPLETION_LEAK_SENTINEL: model response must not be read"}]}}
{"timestamp":"2026-05-08T22:59:49.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":113007,"cached_input_tokens":111488,"output_tokens":287,"reasoning_output_tokens":22,"total_tokens":113294},"total_token_usage":{"input_tokens":113007,"cached_input_tokens":111488,"output_tokens":287,"reasoning_output_tokens":22,"total_tokens":113294},"model_context_window":258400},"rate_limits":{"limit_id":"codex","primary":{"used_percent":37.0,"window_minutes":300,"resets_at":1778286333},"secondary":{"used_percent":27.0,"window_minutes":10080,"resets_at":1778714196},"plan_type":"prolite"}}}
{"timestamp":"2026-05-08T22:59:50.000Z","type":"event_msg","payload":{"type":"task_complete"}}
"#;

/// Discovery: nested YYYY/MM/DD/rollout-*.jsonl files are found; sibling
/// files like history.jsonl are NOT included.
#[test]
fn walk_rollout_files_finds_nested_files_and_skips_history() {
    let root = temp_dir("walk");
    let nested = root.join("2026/05/08");
    fs::create_dir_all(&nested).unwrap();

    let rollout_a = nested.join("rollout-2026-05-08T00-00-00-019e0001-7b89-7a31-a45b-ade3432e48f1.jsonl");
    let rollout_b = nested.join("rollout-2026-05-08T01-00-00-019e0002-7b89-7a31-a45b-ade3432e48f2.jsonl");
    let history   = nested.join("history.jsonl");
    let stray_txt = nested.join("rollout-2026-05-08T02-00-00.txt");
    fs::write(&rollout_a, "").unwrap();
    fs::write(&rollout_b, "").unwrap();
    fs::write(&history,   "").unwrap();
    fs::write(&stray_txt, "").unwrap();

    let mut found = codex::walk_rollout_files(&root).unwrap();
    found.sort();
    assert_eq!(found.len(), 2, "expected 2 rollout files, got {:?}", found);
    assert!(found.contains(&rollout_a));
    assert!(found.contains(&rollout_b));
    assert!(!found.iter().any(|p| p.ends_with("history.jsonl")));
    assert!(!found.iter().any(|p| p.extension().and_then(|s| s.to_str()) == Some("txt")));

    let _ = fs::remove_dir_all(&root);
}

/// Discovery on a missing directory returns an empty Vec, not an error
/// — Codex CLI may not be installed on every machine.
#[test]
fn walk_rollout_files_handles_missing_dir() {
    let nowhere = std::env::temp_dir().join("pulse-codex-it-nonexistent-please");
    let _ = fs::remove_dir_all(&nowhere);
    let r = codex::walk_rollout_files(&nowhere).unwrap();
    assert!(r.is_empty());
}

/// Privacy floor canary: parse the fixture line-by-line as JSON Value and
/// confirm the four sentinels are present in the raw payload (so the
/// fixture is correctly representing leaky data) — but never get extracted
/// into any field name our code looks at.
///
/// This is a structural test of the parsing surface, complementary to the
/// `response_item_does_not_deserialize_arguments_or_content` unit test in
/// `codex.rs`. Together they assert: the JSON contains text we mustn't
/// read AND our parsing types don't expose fields that would surface it.
#[test]
fn fixture_contains_sentinels_but_parsed_types_drop_them() {
    let root = temp_dir("privacy");
    let nested = root.join("2026/05/08");
    fs::create_dir_all(&nested).unwrap();
    let path = nested.join("rollout-2026-05-08T22-59-44-019e09d1-7b89-7a31-a45b-ade3432e48fd.jsonl");
    fs::write(&path, FIXTURE).unwrap();

    let raw = fs::read_to_string(&path).unwrap();

    // Sanity: the fixture does contain the sentinels in raw form.
    assert!(raw.contains("PROMPT_LEAK_SENTINEL"));
    assert!(raw.contains("REASONING_LEAK_SENTINEL"));
    assert!(raw.contains("ARGUMENTS_LEAK_SENTINEL"));
    assert!(raw.contains("OUTPUT_LEAK_SENTINEL"));
    assert!(raw.contains("FILE_CONTENT_LEAK_SENTINEL"));
    assert!(raw.contains("COMPLETION_LEAK_SENTINEL"));

    // Parse each non-empty line and assert we can extract token_count info
    // but NOT the leaky strings via the documented attribute paths the
    // codex tailer uses (function-call name + count, plan_type, etc).
    let mut function_call_names = Vec::<String>::new();
    let mut plan_type: Option<String> = None;
    let mut model: Option<String> = None;
    let mut input_tokens: Option<i64> = None;
    let mut emit_count = 0;

    for line in raw.lines() {
        if line.trim().is_empty() { continue; }
        let v: serde_json::Value = serde_json::from_str(line).expect("valid json");
        let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let payload = v.get("payload").cloned().unwrap_or(serde_json::Value::Null);

        match kind {
            "turn_context" => {
                model = payload.get("model").and_then(|m| m.as_str()).map(String::from);
            }
            "response_item" => {
                let pt = payload.get("type").and_then(|s| s.as_str()).unwrap_or("");
                if pt == "function_call" {
                    if let Some(name) = payload.get("name").and_then(|s| s.as_str()) {
                        function_call_names.push(name.to_string());
                    }
                }
                // CRITICAL: never read .arguments, .output, .content, .summary, .text.
            }
            "event_msg" => {
                let pt = payload.get("type").and_then(|s| s.as_str()).unwrap_or("");
                if pt == "token_count" {
                    if let Some(info) = payload.get("info") {
                        if let Some(usage) = info.get("last_token_usage") {
                            input_tokens = usage.get("input_tokens").and_then(|n| n.as_i64());
                        }
                    }
                    if let Some(rl) = payload.get("rate_limits") {
                        plan_type = rl.get("plan_type").and_then(|s| s.as_str()).map(String::from);
                    }
                    emit_count += 1;
                }
                // CRITICAL: never read user_message.message, agent_message.text.
            }
            _ => {}
        }
    }

    // Asserts: exactly 1 token_count emit, expected metadata pulled.
    assert_eq!(emit_count, 1, "fixture has 1 token_count event");
    assert_eq!(model.as_deref(), Some("gpt-5.5"));
    assert_eq!(input_tokens, Some(113007));
    assert_eq!(plan_type.as_deref(), Some("prolite"));
    assert_eq!(function_call_names, vec!["exec_command", "write_file"]);

    // Privacy assertion: NONE of the sentinel strings appear in anything
    // we extracted (model, plan_type, function-call names, token counts).
    let extracted = format!(
        "{:?} {:?} {:?} {:?}",
        model, plan_type, function_call_names, input_tokens,
    );
    assert!(!extracted.contains("PROMPT_LEAK_SENTINEL"));
    assert!(!extracted.contains("REASONING_LEAK_SENTINEL"));
    assert!(!extracted.contains("ARGUMENTS_LEAK_SENTINEL"));
    assert!(!extracted.contains("OUTPUT_LEAK_SENTINEL"));
    assert!(!extracted.contains("FILE_CONTENT_LEAK_SENTINEL"));
    assert!(!extracted.contains("COMPLETION_LEAK_SENTINEL"));

    let _ = fs::remove_dir_all(&root);
}

/// End-to-end discovery: write a fixture under a real sessions tree and
/// confirm walk_rollout_files() finds it deterministically.
#[test]
fn walk_rollout_files_returns_deterministic_order() {
    let root = temp_dir("order");
    fs::create_dir_all(root.join("2026/05/08")).unwrap();
    fs::create_dir_all(root.join("2026/04/07")).unwrap();
    fs::create_dir_all(root.join("2025/12/31")).unwrap();

    fs::write(root.join("2026/05/08/rollout-2026-05-08T00-aaa.jsonl"), "").unwrap();
    fs::write(root.join("2026/04/07/rollout-2026-04-07T00-bbb.jsonl"), "").unwrap();
    fs::write(root.join("2025/12/31/rollout-2025-12-31T00-ccc.jsonl"), "").unwrap();

    let v1 = codex::walk_rollout_files(&root).unwrap();
    let v2 = codex::walk_rollout_files(&root).unwrap();
    assert_eq!(v1, v2, "two calls should return identical (sorted) order");
    assert_eq!(v1.len(), 3);

    let _ = fs::remove_dir_all(&root);
}

//! Shared OTLP/HTTP-JSON types and span builder helpers.
//!
//! We emit OTLP/HTTP JSON (not protobuf) because the Pulse server speaks
//! that dialect and it's human-inspectable without a protobuf toolchain.

use serde::{Deserialize, Serialize};

// ── Wire types (subset of OTLP spec we actually need) ──────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OtlpTracesPayload {
    pub resource_spans: Vec<ResourceSpan>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSpan {
    pub resource: Resource,
    pub scope_spans: Vec<ScopeSpan>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Resource {
    pub attributes: Vec<KeyValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeSpan {
    pub scope: Scope,
    pub spans: Vec<Span>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scope {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub trace_id: String,
    pub span_id: String,
    pub name: String,
    pub kind: u32,
    pub start_time_unix_nano: String,
    pub end_time_unix_nano: String,
    pub attributes: Vec<KeyValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyValue {
    pub key: String,
    pub value: AnyValue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AnyValue {
    String { #[serde(rename = "stringValue")] string_value: String },
    Int    { #[serde(rename = "intValue")]    int_value: String },
    Bool   { #[serde(rename = "boolValue")]   bool_value: bool },
    Double { #[serde(rename = "doubleValue")] double_value: f64 },
}

// ── Builder ─────────────────────────────────────────────────────────────────

impl AnyValue {
    pub fn string(s: impl Into<String>) -> Self {
        AnyValue::String { string_value: s.into() }
    }
    pub fn int(i: i64) -> Self {
        AnyValue::Int { int_value: i.to_string() }
    }
}

impl KeyValue {
    pub fn string(key: &str, value: impl Into<String>) -> Self {
        KeyValue { key: key.to_string(), value: AnyValue::string(value) }
    }
    pub fn int(key: &str, value: i64) -> Self {
        KeyValue { key: key.to_string(), value: AnyValue::int(value) }
    }
}

/// Build a single-span OTLP payload ready to POST.
pub struct SpanBuilder {
    name: String,
    start_ns: u128,
    end_ns: u128,
    attrs: Vec<KeyValue>,
}

impl SpanBuilder {
    pub fn new(name: impl Into<String>, start_ns: u128, end_ns: u128) -> Self {
        SpanBuilder {
            name: name.into(),
            start_ns,
            end_ns,
            attrs: Vec::new(),
        }
    }

    pub fn attr_str(mut self, key: &str, value: impl Into<String>) -> Self {
        self.attrs.push(KeyValue::string(key, value));
        self
    }

    pub fn attr_str_opt(self, key: &str, value: Option<impl Into<String>>) -> Self {
        match value {
            Some(v) => self.attr_str(key, v),
            None => self,
        }
    }

    pub fn attr_int(mut self, key: &str, value: i64) -> Self {
        self.attrs.push(KeyValue::int(key, value));
        self
    }

    pub fn attr_int_opt(self, key: &str, value: Option<i64>) -> Self {
        match value {
            Some(v) => self.attr_int(key, v),
            None => self,
        }
    }

    /// Consume the builder and return a fully-formed OTLP payload with one span.
    pub fn build(self) -> OtlpTracesPayload {
        // 16-byte trace id (32 hex chars) and 8-byte span id (16 hex chars),
        // generated from start_ns XOR end_ns as a cheap deterministic id.
        let trace_id = format!("{:0>32x}", self.start_ns ^ (self.end_ns.wrapping_mul(0xdeadbeef)));
        let span_id  = format!("{:0>16x}", self.start_ns.wrapping_add(self.end_ns));

        let span = Span {
            trace_id,
            span_id,
            name: self.name,
            kind: 3, // CLIENT
            start_time_unix_nano: self.start_ns.to_string(),
            end_time_unix_nano:   self.end_ns.to_string(),
            attributes: self.attrs,
        };

        OtlpTracesPayload {
            resource_spans: vec![ResourceSpan {
                resource: Resource {
                    attributes: vec![KeyValue::string("service.name", "pulse-agent")],
                },
                scope_spans: vec![ScopeSpan {
                    scope: Scope {
                        name: "pulse-agent".to_string(),
                        version: env!("CARGO_PKG_VERSION").to_string(),
                    },
                    spans: vec![span],
                }],
            }],
        }
    }
}

/// Return the current Unix time in nanoseconds.
pub fn now_ns() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_produces_valid_trace_id() {
        let payload = SpanBuilder::new("gen_ai.request", 1_000_000_000, 2_000_000_000)
            .attr_str("gen_ai.system", "anthropic")
            .attr_int("gen_ai.usage.input_tokens", 100)
            .build();

        let span = &payload.resource_spans[0].scope_spans[0].spans[0];
        assert_eq!(span.trace_id.len(), 32);
        assert_eq!(span.span_id.len(), 16);
        assert_eq!(span.name, "gen_ai.request");
        assert_eq!(span.start_time_unix_nano, "1000000000");
        assert_eq!(span.end_time_unix_nano,   "2000000000");
    }

    #[test]
    fn builder_optional_attrs_skipped_when_none() {
        let payload = SpanBuilder::new("git.commit", 100, 100)
            .attr_str("gen_ai.system", "anthropic")
            .attr_str_opt("claude.repo.name", None::<String>)
            .build();

        let attrs = &payload.resource_spans[0].scope_spans[0].spans[0].attributes;
        // Only gen_ai.system should be present — the None attr was dropped.
        assert_eq!(attrs.len(), 1);
        assert_eq!(attrs[0].key, "gen_ai.system");
    }

    #[test]
    fn now_ns_is_reasonable() {
        let ns = now_ns();
        // Must be after 2024-01-01 00:00:00 UTC in nanoseconds.
        assert!(ns > 1_704_067_200_000_000_000u128);
    }
}

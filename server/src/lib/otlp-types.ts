/**
 * Minimal OTLP/HTTP-JSON type shapes — only the subset we consume.
 *
 * The full proto is at https://github.com/open-telemetry/opentelemetry-proto
 * but for v0.1 ingest we only read GenAI-shaped spans and we never emit
 * OTLP, so we keep a hand-rolled subset rather than bringing in the whole
 * transformer lib.
 */

export interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string | number;   // OTLP encodes int64 as string on the wire
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OtlpAnyValue[] };
  kvlistValue?: { values: OtlpSpanAttribute[] };
}

export interface OtlpSpanAttribute {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: number;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: OtlpSpanAttribute[];
  status?: { code?: number; message?: string };
}

export interface OtlpScopeSpans {
  scope?: { name?: string; version?: string };
  spans: OtlpSpan[];
}

export interface OtlpResourceSpans {
  resource?: { attributes?: OtlpSpanAttribute[] };
  scopeSpans?: OtlpScopeSpans[];
  // The older "instrumentationLibrarySpans" field is also accepted by some
  // collectors; modern exporters emit scopeSpans. We handle both on ingest.
  instrumentationLibrarySpans?: OtlpScopeSpans[];
}

export interface OtlpTracesPayload {
  resourceSpans?: OtlpResourceSpans[];
}

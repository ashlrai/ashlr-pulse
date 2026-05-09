"use client";

import { useState, type FormEvent, type ReactElement } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Input";
import { palette, space } from "@/lib/theme";

type Scope = "ingest" | "heartbeat" | "invite:create";

interface MintResponse {
  id: string;
  token: string;
  name: string;
  scopes: Scope[];
}

export function TokenMintForm(): ReactElement {
  const [created, setCreated] = useState<MintResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formEl = event.currentTarget;
    setPending(true);
    setError(null);
    setCreated(null);

    const form = new FormData(formEl);
    const scopes = form.getAll("scopes").map(String);
    try {
      const res = await fetch("/api/pat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: String(form.get("name") ?? "").trim(),
          scopes,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof body.error === "string" ? body.error : "token creation failed");
        return;
      }
      setCreated(body as MintResponse);
      formEl.reset();
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader title="new token" />
      <form onSubmit={onSubmit}>
        <div style={{ display: "flex", gap: space.x3, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 260px" }}>
            <Field label="name">
              <Input name="name" type="text" required placeholder="laptop, CI, etc." />
            </Field>
          </div>
          <Button type="submit" variant="primary" disabled={pending} style={{ marginBottom: space.x4 }}>
            {pending ? "creating..." : "create"}
          </Button>
        </div>

        <fieldset style={fieldset}>
          <legend style={legend}>scopes</legend>
          <label style={checkLabel}>
            <input name="scopes" type="checkbox" value="ingest" defaultChecked /> ingest
          </label>
          <label style={checkLabel}>
            <input name="scopes" type="checkbox" value="heartbeat" defaultChecked /> heartbeat
          </label>
          <label style={checkLabel}>
            <input name="scopes" type="checkbox" value="invite:create" /> invite:create
          </label>
        </fieldset>
      </form>

      {created && (
        <div style={{ marginTop: space.x3 }}>
          <Banner variant="success" title="token created — copy it now, it won't be shown again">
            <code style={tokenBox}>{created.token}</code>
          </Banner>
        </div>
      )}
      {error && (
        <div style={{ marginTop: space.x3 }}>
          <Banner variant="danger">{error}</Banner>
        </div>
      )}
    </Card>
  );
}

const fieldset: React.CSSProperties = {
  border: `1px solid ${palette.border}`,
  borderRadius: 4,
  display: "flex",
  gap: space.x3,
  flexWrap: "wrap",
  margin: 0,
  padding: `${space.x2}px ${space.x3}px`,
};

const legend: React.CSSProperties = {
  color: palette.textDim,
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.8px",
};

const checkLabel: React.CSSProperties = {
  color: palette.text,
  fontSize: 12,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

const tokenBox: React.CSSProperties = {
  display: "block",
  padding: "10px 12px",
  background: palette.bgRaised,
  border: `1px solid ${palette.border}`,
  borderRadius: 4,
  fontSize: 12,
  wordBreak: "break-all",
  color: palette.green,
};

/**
 * email.ts — minimal Resend client.
 *
 * We don't take Resend's SDK as a dependency: their REST API is one
 * POST and the SDK pulls in extra surface we don't need. If RESEND_API_KEY
 * is unset we no-op and return { skipped: true } so dev environments don't
 * have to wire Resend just to exercise the digest code path.
 *
 * Privacy: subject + body are user-facing copy generated from data the
 * user has already consented to see. We do NOT log them — Resend gets
 * them, and that's it.
 */

import { log } from "./logger";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type SendEmailResult =
  | { ok: true; id: string }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; error: string; status: number };

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.PULSE_DIGEST_FROM_EMAIL;
  if (!apiKey || !from) {
    return {
      ok: false,
      skipped: true,
      reason: !apiKey ? "RESEND_API_KEY unset" : "PULSE_DIGEST_FROM_EMAIL unset",
    };
  }

  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ msg: "email: network error", err: msg });
    return { ok: false, status: 0, error: msg };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    log.warn({ msg: "email: send failed", status: res.status, detail: detail.slice(0, 200) });
    return { ok: false, status: res.status, error: detail.slice(0, 500) };
  }

  const body = (await res.json().catch(() => ({}))) as { id?: string };
  return { ok: true, id: body.id ?? "" };
}

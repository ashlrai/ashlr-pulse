/**
 * email.ts — minimal SendGrid v3 client.
 *
 * We don't take @sendgrid/mail as a dependency: their REST API is one
 * POST and the SDK pulls in extra surface we don't need. If
 * SENDGRID_API_KEY (or PULSE_DIGEST_FROM_EMAIL) is unset we no-op and
 * return { skipped: true } so dev environments don't have to wire
 * SendGrid just to exercise the digest code path.
 *
 * SendGrid returns 202 Accepted with an empty body on success, with the
 * actual message id in the `X-Message-Id` response header. We surface
 * that as `id` so logs can correlate with SendGrid's activity feed.
 *
 * Privacy: subject + body are user-facing copy generated from data the
 * user has already consented to see. We do NOT log them — SendGrid
 * gets them, and that's it.
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
  const apiKey = process.env.SENDGRID_API_KEY;
  const from = process.env.PULSE_DIGEST_FROM_EMAIL;
  if (!apiKey || !from) {
    return {
      ok: false,
      skipped: true,
      reason: !apiKey ? "SENDGRID_API_KEY unset" : "PULSE_DIGEST_FROM_EMAIL unset",
    };
  }

  let res: Response;
  try {
    res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: input.to }] }],
        from: { email: from },
        subject: input.subject,
        // SendGrid requires text/plain BEFORE text/html (RFC 1341 § 7.2.3
        // ordering: least-rich first). Reversing this triggers a 400.
        content: [
          { type: "text/plain", value: input.text },
          { type: "text/html",  value: input.html },
        ],
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ msg: "email: network error", err: msg });
    return { ok: false, status: 0, error: msg };
  }

  // SendGrid returns 202 Accepted on success with an empty body.
  if (res.status !== 202) {
    const detail = await res.text().catch(() => "");
    log.warn({ msg: "email: send failed", status: res.status, detail: detail.slice(0, 200) });
    return { ok: false, status: res.status, error: detail.slice(0, 500) };
  }

  return { ok: true, id: res.headers.get("x-message-id") ?? "" };
}

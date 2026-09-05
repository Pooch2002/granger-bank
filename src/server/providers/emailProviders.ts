import "server-only";
import type { EmailProvider } from "./types";

/**
 * Development-only convenience adapter: logs the email to the server
 * console instead of sending it, so registration/password-reset flows are
 * testable locally without real SMTP credentials.
 *
 * This is NOT a financial provider and does not simulate any banking
 * function — it is standard practice for local development email testing,
 * and is never selected in production (see registry.ts, which requires
 * EMAIL_PROVIDER_API_URL/KEY to be set in production or every email send
 * fails closed via UnconfiguredEmailProvider instead of this class).
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console-email-dev-only";

  async send(message: { to: string; subject: string; text: string; html?: string }): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(
      `\n[dev email] to=${message.to} subject="${message.subject}"\n${message.text}\n`
    );
  }
}

/**
 * Sends transactional email through a real HTTP email API. Never logs the
 * response body on failure — it may echo back the recipient address(es) —
 * only the status code is included in the thrown error.
 */
export class HttpEmailProvider implements EmailProvider {
  readonly name = "http-email";

  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
    private readonly fromAddress: string
  ) {}

  async send(message: { to: string; subject: string; text: string; html?: string }): Promise<void> {
    const res = await fetch(this.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.fromAddress,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      }),
    });

    if (!res.ok) {
      throw new Error(`Email provider request failed with status ${res.status}`);
    }
  }
}

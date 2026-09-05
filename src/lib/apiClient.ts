"use client";

/**
 * Thin client-side fetch wrapper: attaches the CSRF header on every
 * mutating request (see src/server/security/csrf.ts) and normalizes error
 * handling against the { error: { code, message } } shape every route
 * handler returns via toSafeErrorResponse.
 */

let cachedCsrfToken: string | null = null;

export async function getCsrfToken(): Promise<string> {
  if (cachedCsrfToken) return cachedCsrfToken;
  const res = await fetch("/api/auth/csrf");
  const data = await res.json();
  cachedCsrfToken = data.csrfToken;
  return cachedCsrfToken as string;
}

export class ApiError extends Error {
  code?: string;
  status: number;
  /** Per-field messages on a 422, e.g. `{ dateOfBirth: "Invalid date" }` —
   * present when the server could attribute the failure to specific fields. */
  fields?: Record<string, string>;
  constructor(message: string, code: string | undefined, status: number, fields?: Record<string, string>) {
    super(message);
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

export async function apiFetch<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");

  if (method !== "GET") {
    headers.set("x-csrf-token", await getCsrfToken());
  }

  const res = await fetch(path, { ...options, method, headers, credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(
      data?.error?.message ?? "Something went wrong. Please try again.",
      data?.error?.code,
      res.status,
      data?.error?.fields
    );
  }
  return data as T;
}

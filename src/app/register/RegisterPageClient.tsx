"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ShieldCheck, ArrowLeft, CheckCircle2 } from "lucide-react";
import { Logo } from "@/components/layout/Logo";
import { Button } from "@/components/ui/Button";
import { apiFetch, ApiError } from "@/lib/apiClient";

type FormState = {
  email: string;
  password: string;
  confirmPassword: string;
  legalFirstName: string;
  legalLastName: string;
  dateOfBirth: string;
  country: string;
  addressLine1: string;
  city: string;
  region: string;
  postalCode: string;
};

const initialState: FormState = {
  email: "",
  password: "",
  confirmPassword: "",
  legalFirstName: "",
  legalLastName: "",
  dateOfBirth: "",
  country: "US",
  addressLine1: "",
  city: "",
  region: "",
  postalCode: "",
};

export function RegisterPageClient() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(initialState);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setFieldErrors((f) => {
      if (!(key in f)) return f;
      const next = { ...f };
      delete next[key];
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setFieldErrors({});

    if (form.password !== form.confirmPassword) {
      setFieldErrors({ confirmPassword: "Passwords don't match." });
      return;
    }

    setLoading(true);
    try {
      await apiFetch("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          email: form.email,
          password: form.password,
          legalFirstName: form.legalFirstName,
          legalLastName: form.legalLastName,
          dateOfBirth: form.dateOfBirth,
          country: form.country.toUpperCase(),
          addressLine1: form.addressLine1,
          city: form.city,
          region: form.region,
          postalCode: form.postalCode,
        }),
      });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.fields) {
        setFieldErrors(err.fields);
        setError(err.fields._root ?? "");
      } else {
        setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ink px-6 py-16">
        <div className="w-full max-w-md rounded-2xl border border-gold/20 bg-ink-3 p-10 text-center">
          <CheckCircle2 className="mx-auto text-gold" size={40} />
          <h1 className="mt-6 font-display text-2xl">Check your email</h1>
          <p className="mt-3 text-sm leading-relaxed text-mist">
            We&apos;ve sent a verification link to <span className="text-ivory">{form.email}</span>.
            Verify your address, then sign in to continue onboarding.
          </p>
          <p className="mt-4 text-xs text-mist">
            In this environment, no email provider is configured — the
            verification link was printed to the server console instead of
            delivered.
          </p>
          <Button href="/login" size="lg" className="mt-8 w-full">
            Go to Sign In
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center bg-ink px-6 py-16">
      <div className="w-full max-w-xl">
        <Link href="/" className="mb-8 flex items-center gap-2 text-sm text-ivory-dim hover:text-ivory">
          <ArrowLeft size={16} /> Back to home
        </Link>

        <div className="mb-8 flex justify-center">
          <Logo />
        </div>

        <div className="rounded-2xl border border-line bg-ink-3 p-8 sm:p-10">
          <h1 className="font-display text-3xl">Open an account</h1>
          <p className="mt-2 text-sm text-mist">
            Tell us a little about yourself. You&apos;ll verify your identity in the next step.
          </p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="First name" value={form.legalFirstName} onChange={(v) => set("legalFirstName", v)} required error={fieldErrors.legalFirstName} />
              <Field label="Last name" value={form.legalLastName} onChange={(v) => set("legalLastName", v)} required error={fieldErrors.legalLastName} />
            </div>

            <Field label="Email" type="email" value={form.email} onChange={(v) => set("email", v)} required error={fieldErrors.email} />

            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Password" type="password" value={form.password} onChange={(v) => set("password", v)} required error={fieldErrors.password} />
              <Field
                label="Confirm password"
                type="password"
                value={form.confirmPassword}
                onChange={(v) => set("confirmPassword", v)}
                required
                error={fieldErrors.confirmPassword}
              />
            </div>
            <p className="-mt-3 text-xs text-mist">
              At least 12 characters, with upper case, lower case and a number.
            </p>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Date of birth" type="date" value={form.dateOfBirth} onChange={(v) => set("dateOfBirth", v)} required error={fieldErrors.dateOfBirth} />
              <Field label="Country (ISO code)" value={form.country} onChange={(v) => set("country", v)} required maxLength={2} error={fieldErrors.country} />
            </div>

            <Field label="Address" value={form.addressLine1} onChange={(v) => set("addressLine1", v)} required error={fieldErrors.addressLine1} />

            <div className="grid gap-5 sm:grid-cols-3">
              <Field label="City" value={form.city} onChange={(v) => set("city", v)} required error={fieldErrors.city} />
              <Field label="State / Region" value={form.region} onChange={(v) => set("region", v)} required error={fieldErrors.region} />
              <Field label="Postal code" value={form.postalCode} onChange={(v) => set("postalCode", v)} required error={fieldErrors.postalCode} />
            </div>

            {error && <p className="text-sm text-danger">{error}</p>}

            <Button type="submit" size="lg" className="w-full" disabled={loading}>
              {loading ? "Creating account…" : "Create Account"}
            </Button>

            <p className="text-center text-xs text-mist">
              Already have an account?{" "}
              <Link href="/login" className="text-gold hover:text-gold-2">
                Sign in
              </Link>
            </p>
          </form>
        </div>

        <div className="mt-6 flex items-start gap-3 rounded-xl border border-line bg-ink-3 p-4">
          <ShieldCheck size={18} className="mt-0.5 shrink-0 text-gold" />
          <p className="text-xs leading-relaxed text-mist">
            Opening an account here creates a real, password-protected record in a
            development database. It does not open a real bank account, move money,
            or complete identity verification — this is an architecture and security
            demonstration, not a licensed financial product.
          </p>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  required,
  maxLength,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
  maxLength?: number;
  error?: string;
}) {
  return (
    <div>
      <label className="mb-2 block text-xs uppercase tracking-[0.14em] text-mist">{label}</label>
      <input
        type={type}
        required={required}
        maxLength={maxLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        className={`w-full rounded-xl border bg-ink-2 px-4 py-3 text-sm text-ivory placeholder:text-mist-dim focus:outline-none ${
          error ? "border-danger focus:border-danger" : "border-line focus:border-gold/50"
        }`}
      />
      {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
    </div>
  );
}

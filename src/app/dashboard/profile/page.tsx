"use client";

import { useEffect, useState } from "react";
import { PageHeading } from "@/components/dashboard/PageHeading";
import { Badge } from "@/components/dashboard/Badge";
import { apiFetch } from "@/lib/apiClient";

type Profile = {
  legalFirstName: string;
  legalLastName: string;
  email: string;
  country: string | null;
  addressLine1: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  segment: string;
  kycStatus: string;
  memberSince: string;
};

export default function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);

  useEffect(() => {
    apiFetch<{ profile: Profile }>("/api/profile").then((d) => setProfile(d.profile));
  }, []);

  if (!profile) return <p className="text-sm text-mist">Loading…</p>;

  const initials = `${profile.legalFirstName[0] ?? ""}${profile.legalLastName[0] ?? ""}`;

  return (
    <div>
      <PageHeading title="Profile" subtitle="Your account details on record." />

      <div className="grid gap-6 lg:grid-cols-[0.4fr_0.6fr]">
        <div className="rounded-2xl border border-line bg-ink-3 p-8 text-center">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-gold-2 via-gold to-gold-3 font-display text-2xl text-ink">
            {initials}
          </div>
          <p className="mt-4 font-display text-xl text-ivory">
            {profile.legalFirstName} {profile.legalLastName}
          </p>
          <p className="text-sm text-mist">
            {profile.segment.charAt(0) + profile.segment.slice(1).toLowerCase()} client since{" "}
            {new Date(profile.memberSince).getFullYear()}
          </p>
          <div className="mt-4 flex justify-center">
            <Badge tone={profile.kycStatus === "APPROVED" ? "positive" : "gold"}>
              Verification: {profile.kycStatus.replace(/_/g, " ")}
            </Badge>
          </div>
        </div>

        <div className="space-y-5 rounded-2xl border border-line bg-ink-3 p-8">
          <Row label="Email" value={profile.email} />
          <Row
            label="Mailing Address"
            value={
              profile.addressLine1
                ? `${profile.addressLine1}, ${profile.city}, ${profile.region} ${profile.postalCode}`
                : "Not on file — added when you complete identity verification"
            }
          />
          <Row label="Country" value={profile.country ?? "Not on file"} />
          <p className="pt-2 text-xs text-mist">
            To update your personal information, contact support — profile changes on a real
            banking platform typically require identity re-verification.
          </p>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-[0.14em] text-mist">{label}</p>
      <p className="mt-1 text-sm text-ivory">{value}</p>
    </div>
  );
}

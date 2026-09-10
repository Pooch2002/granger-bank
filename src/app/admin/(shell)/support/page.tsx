"use client";

import { useEffect, useState } from "react";
import { PageHeading } from "@/components/dashboard/PageHeading";
import { Button } from "@/components/ui/Button";
import { apiFetch, ApiError } from "@/lib/apiClient";

type ConversationListItem = {
  id: string;
  status: string;
  lastMessageAt: string;
  customerProfile: { legalFirstName: string; legalLastName: string };
  messages: Array<{ id: string; body: string; createdAt: string }>;
};

type ConversationMessage = {
  id: string;
  body: string;
  createdAt: string;
  sender: { email: string; role: string };
};

type ConversationDetail = {
  id: string;
  status: string;
  customerProfile: { legalFirstName: string; legalLastName: string };
  messages: ConversationMessage[];
};

export default function AdminSupportPage() {
  const [conversations, setConversations] = useState<ConversationListItem[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch<{ conversations: ConversationListItem[] }>("/api/admin/support").then((d) =>
      setConversations(d.conversations)
    );
  }, []);

  useEffect(() => {
    if (!selectedId) return;

    let cancelled = false;
    function loadDetail() {
      apiFetch<{ conversation: ConversationDetail }>(`/api/admin/support/${selectedId}`)
        .then((d) => {
          if (!cancelled) setDetail(d.conversation);
        })
        .catch(() => {
          // Keep showing the last known detail if a poll fails.
        });
    }

    loadDetail();
    const interval = setInterval(loadDetail, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedId]);

  function selectConversation(id: string) {
    setSelectedId(id);
    setDetail(null);
    setInput("");
    setError("");
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    const body = input.trim();
    if (!body) return;

    setSending(true);
    setError("");
    try {
      await apiFetch(`/api/admin/support/${selectedId}`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      setInput("");
      const refreshed = await apiFetch<{ conversation: ConversationDetail }>(`/api/admin/support/${selectedId}`);
      setDetail(refreshed.conversation);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      <PageHeading title="Support" subtitle="Open customer conversations." />

      <div className="grid gap-6 lg:grid-cols-[0.4fr_0.6fr]">
        <div className="overflow-hidden rounded-2xl border border-line bg-ink-3">
          {conversations === null && <p className="p-6 text-sm text-mist">Loading…</p>}

          {conversations !== null && conversations.length === 0 && (
            <p className="p-6 text-sm text-mist">No open conversations.</p>
          )}

          {conversations !== null && conversations.length > 0 && (
            <div className="divide-y divide-line">
              {conversations.map((c) => {
                const preview = c.messages[0]?.body ?? "No messages yet.";
                return (
                  <button
                    key={c.id}
                    onClick={() => selectConversation(c.id)}
                    className={`block w-full px-6 py-5 text-left transition-colors ${
                      selectedId === c.id ? "bg-ink-4" : "hover:bg-ink-4/50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm text-ivory">
                        {c.customerProfile.legalFirstName} {c.customerProfile.legalLastName}
                      </p>
                      <span className="shrink-0 text-xs text-mist">
                        {new Date(c.lastMessageAt).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-mist">{preview}</p>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-line bg-ink-3 p-6">
          {!selectedId && <p className="text-sm text-mist">Select a conversation to view the message thread.</p>}

          {selectedId && !detail && <p className="text-sm text-mist">Loading…</p>}

          {selectedId && detail && (
            <div className="flex flex-col">
              <p className="text-sm text-ivory">
                {detail.customerProfile.legalFirstName} {detail.customerProfile.legalLastName}
              </p>

              <div className="mt-4 h-96 space-y-2 overflow-y-auto rounded-xl border border-line bg-ink-2 p-3">
                {detail.messages.length === 0 && <p className="text-xs text-mist">No messages yet.</p>}
                {detail.messages.map((m) => {
                  const fromAdmin = m.sender.role === "ADMIN";
                  return (
                    <div key={m.id} className={`flex ${fromAdmin ? "justify-end" : "justify-start"}`}>
                      <div
                        className={`max-w-[80%] rounded-xl px-3 py-2 text-xs leading-relaxed ${
                          fromAdmin ? "bg-gold/15 text-ivory" : "bg-ink-3 text-ivory-dim"
                        }`}
                      >
                        {m.body}
                      </div>
                    </div>
                  );
                })}
              </div>

              {error && <p className="mt-2 text-xs text-danger">{error}</p>}

              <form onSubmit={handleSend} className="mt-3 flex gap-2">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Type a reply…"
                  className="flex-1 rounded-xl border border-line bg-ink-2 px-3 py-2 text-sm text-ivory placeholder:text-mist-dim focus:border-gold/50 focus:outline-none"
                />
                <Button type="submit" size="md" disabled={sending || !input.trim()}>
                  Send
                </Button>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

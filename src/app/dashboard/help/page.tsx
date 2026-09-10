"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Headset, MessageSquare, Phone } from "lucide-react";
import { PageHeading } from "@/components/dashboard/PageHeading";
import { Button } from "@/components/ui/Button";
import { apiFetch } from "@/lib/apiClient";

type ChatMessage = { id: string; body: string; senderUserId: string; createdAt: string };

const faqs = [
  { q: "How do I dispute a transaction?", a: "Go to Transactions, select the transaction in question, and choose \"Report an issue.\" A specialist will follow up within one business day." },
  { q: "How long do transfers take?", a: "Transfers between your own Granger Bank accounts are instant. External transfers typically settle within 1-3 business days." },
  { q: "How do I increase my card limit?", a: "Visit Cards → Manage Limits, or speak with your relationship advisor for private client limit increases." },
  { q: "Is my money insured?", a: "Deposits are protected up to the applicable limit under our member protection program, mirroring FDIC-style coverage." },
];

export default function HelpPage() {
  const [open, setOpen] = useState<number | null>(0);

  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ authenticated: boolean; user?: { id: string } }>("/api/auth/session").then((d) => {
      if (d.user) setCurrentUserId(d.user.id);
    });
  }, []);

  useEffect(() => {
    if (!chatOpen) return;

    let cancelled = false;
    function loadMessages() {
      apiFetch<{ messages: ChatMessage[] }>("/api/support")
        .then((d) => {
          if (!cancelled) setMessages(d.messages);
        })
        .catch(() => {
          // Keep showing the last known messages if a poll fails.
        });
    }

    loadMessages();
    const interval = setInterval(loadMessages, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [chatOpen]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const body = input.trim();
    if (!body) return;

    setLoading(true);
    try {
      const data = await apiFetch<{ message: ChatMessage }>("/api/support", {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      setMessages((prev) => [...prev, data.message]);
      setInput("");
    } catch {
      // The next poll will reconcile state either way.
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <PageHeading title="Help & Support" subtitle="Get answers, or reach a real person — 24/7." />

      <div className="grid gap-6 lg:grid-cols-[1fr_0.7fr]">
        <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-ink-3">
          {faqs.map((faq, i) => (
            <div key={faq.q}>
              <button
                onClick={() => setOpen(open === i ? null : i)}
                className="flex w-full items-center justify-between px-6 py-5 text-left"
              >
                <span className="text-sm text-ivory">{faq.q}</span>
                <ChevronDown
                  size={16}
                  className={`shrink-0 text-mist transition-transform ${open === i ? "rotate-180 text-gold" : ""}`}
                />
              </button>
              {open === i && (
                <p className="px-6 pb-5 text-sm leading-relaxed text-mist">{faq.a}</p>
              )}
            </div>
          ))}
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border border-line bg-ink-3 p-6">
            <Headset className="text-gold" size={22} />
            <p className="mt-4 text-sm text-ivory">24/7 Private Support</p>
            <p className="mt-1 text-xs text-mist">A relationship specialist is always available.</p>
            <Button variant="secondary" size="md" className="mt-4 w-full">
              <Phone size={14} /> 1-800-555-0142
            </Button>
          </div>
          <div className="rounded-2xl border border-line bg-ink-3 p-6">
            {!chatOpen ? (
              <>
                <MessageSquare className="text-gold" size={22} />
                <p className="mt-4 text-sm text-ivory">Live Chat</p>
                <p className="mt-1 text-xs text-mist">Average response time: under 2 minutes.</p>
                <Button size="md" className="mt-4 w-full" onClick={() => setChatOpen(true)}>
                  Start a Chat
                </Button>
              </>
            ) : (
              <div className="flex flex-col">
                <div className="flex items-center gap-2">
                  <MessageSquare className="text-gold" size={18} />
                  <p className="text-sm text-ivory">Live Chat</p>
                </div>

                <div className="mt-4 h-64 space-y-2 overflow-y-auto rounded-xl border border-line bg-ink-2 p-3">
                  {messages.length === 0 && (
                    <p className="text-xs text-mist">
                      A specialist will be with you shortly. Send a message to get started.
                    </p>
                  )}
                  {messages.map((m) => {
                    const mine = m.senderUserId === currentUserId;
                    return (
                      <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                        <div
                          className={`max-w-[80%] rounded-xl px-3 py-2 text-xs leading-relaxed ${
                            mine ? "bg-gold/15 text-ivory" : "bg-ink-3 text-ivory-dim"
                          }`}
                        >
                          {m.body}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <form onSubmit={handleSend} className="mt-3 flex gap-2">
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Type a message…"
                    className="flex-1 rounded-xl border border-line bg-ink-2 px-3 py-2 text-sm text-ivory placeholder:text-mist-dim focus:border-gold/50 focus:outline-none"
                  />
                  <Button type="submit" size="md" disabled={loading || !input.trim()}>
                    Send
                  </Button>
                </form>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

import Vapi from "@vapi-ai/web";
import { useEffect, useRef, useState } from "react";

// Public values only: NEXT_PUBLIC_* is inlined into the browser bundle at build time.
const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY;
const ASSISTANT_ID = process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID;

type Status = "idle" | "connecting" | "live" | "ending";
type Line = { role: "caller" | "iris"; text: string };

const MAX_LINES = 4;

function errorMessage(err: unknown): string {
  const text = String((err as { error?: { message?: string }; message?: string })?.error?.message ?? (err as Error)?.message ?? err);
  if (/permission|notallowed|microphone/i.test(text)) {
    return "Iris needs access to your microphone. Allow it in your browser settings and try again.";
  }
  return "The call couldn't connect. Please try again in a moment.";
}

export function CallPanel() {
  const vapiRef = useRef<Vapi | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!PUBLIC_KEY) return;
    const vapi = new Vapi(PUBLIC_KEY);
    vapiRef.current = vapi;

    vapi.on("call-start", () => {
      setStatus("live");
      setError(null);
    });
    vapi.on("call-end", () => {
      setStatus("idle");
      setSpeaking(false);
      setMuted(false);
    });
    vapi.on("speech-start", () => setSpeaking(true));
    vapi.on("speech-end", () => setSpeaking(false));
    vapi.on("message", (message: { type?: string; transcriptType?: string; role?: string; transcript?: string }) => {
      if (message.type !== "transcript" || message.transcriptType !== "final" || !message.transcript) return;
      const line: Line = { role: message.role === "assistant" ? "iris" : "caller", text: message.transcript };
      setLines((prev) => [...prev, line].slice(-MAX_LINES));
    });
    vapi.on("error", (err: unknown) => {
      setError(errorMessage(err));
      setStatus("idle");
    });

    return () => {
      void vapi.stop();
      vapiRef.current = null;
    };
  }, []);

  const configured = Boolean(PUBLIC_KEY && ASSISTANT_ID);

  async function start() {
    if (!vapiRef.current || !ASSISTANT_ID) return;
    setError(null);
    setLines([]);
    setStatus("connecting");
    try {
      // A short-lived start token: the agent refuses web calls without one (design §8).
      const res = await fetch("/api/call-token", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
      if (!res.ok || !body.token) {
        setStatus("idle");
        setError(body.error ?? "The call couldn't connect. Please try again in a moment.");
        return;
      }
      const call = await vapiRef.current.start(ASSISTANT_ID, { metadata: { callToken: body.token } });
      if (!call) {
        setStatus("idle");
        setError("The call couldn't connect. Please try again in a moment.");
      }
    } catch (err) {
      setStatus("idle");
      setError(errorMessage(err));
    }
  }

  async function end() {
    setStatus("ending");
    await vapiRef.current?.stop();
  }

  function toggleMute() {
    if (!vapiRef.current) return;
    const next = !muted;
    vapiRef.current.setMuted(next);
    setMuted(next);
  }

  const statusText =
    status === "connecting"
      ? "Connecting…"
      : status === "ending"
        ? "Ending call…"
        : status === "live"
          ? muted
            ? "You're muted"
            : speaking
              ? "Iris is speaking"
              : "Listening"
          : "Ready when you are";

  return (
    <section className="mt-8 rounded-lg border border-border bg-surface p-5 sm:p-6" aria-live="polite">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span
            className={`h-2.5 w-2.5 rounded-full ${status === "live" ? "bg-accent" : status === "idle" ? "bg-border" : "bg-muted"}`}
            aria-hidden="true"
          />
          <div>
            <p className="text-[15px] font-medium">Iris</p>
            <p className="text-[13px] text-muted">{configured ? statusText : "Voice calling isn't set up yet."}</p>
          </div>
        </div>

        <div className="flex gap-2">
          {status === "live" && (
            <button
              type="button"
              onClick={toggleMute}
              className="h-10 rounded-md border border-border px-4 text-[14px] font-medium hover:bg-background"
            >
              {muted ? "Unmute" : "Mute"}
            </button>
          )}
          {status === "live" || status === "ending" ? (
            <button
              type="button"
              onClick={end}
              disabled={status === "ending"}
              className="h-10 rounded-md bg-danger px-5 text-[14px] font-medium text-white disabled:opacity-60"
            >
              End call
            </button>
          ) : (
            <button
              type="button"
              onClick={start}
              disabled={!configured || status === "connecting"}
              className="h-10 rounded-md bg-primary px-5 text-[14px] font-medium text-white hover:bg-primary-hover disabled:opacity-60"
            >
              {status === "connecting" ? "Connecting…" : "Start call"}
            </button>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-4 text-[14px] text-danger">
          {error}
        </p>
      )}

      {lines.length > 0 && (
        <div className="mt-5 border-t border-border pt-4">
          <p className="text-[12px] font-medium uppercase tracking-wide text-muted">Live transcript</p>
          <dl className="mt-2 space-y-2 text-[14px] leading-6">
            {lines.map((line, i) => (
              <div key={i} className="flex gap-3">
                <dt className="w-12 shrink-0 text-muted">{line.role === "iris" ? "Iris" : "You"}</dt>
                <dd>{line.text}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </section>
  );
}

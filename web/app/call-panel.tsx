"use client";

import Vapi from "@vapi-ai/web";
import { useEffect, useRef, useState } from "react";

// Public values only: NEXT_PUBLIC_* is inlined into the browser bundle at build time.
const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY;
const ASSISTANT_ID = process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID;

type Status = "idle" | "connecting" | "live" | "ending" | "ended";
type Role = "caller" | "iris";
type Line = { role: Role; text: string };

const CONNECT_FAILED = "The call didn't connect. Check your connection and start the call again.";
const MIC_BLOCKED = "Iris needs your microphone. Allow microphone access for this site, then start the call again.";
const NOT_TAKEN = "Iris couldn't take the call just now. Try again in a minute.";
const DROPPED = "The call dropped. Start a new call to carry on.";

// Vapi nests the text at different depths depending on the source (Daily, the API, the SDK).
function errorText(err: unknown): string {
  const e = err as { error?: { errorMsg?: unknown; msg?: unknown; message?: unknown }; errorMsg?: unknown; message?: unknown };
  const found = [e?.error?.errorMsg, e?.error?.msg, e?.error?.message, e?.errorMsg, e?.message].find((v) => typeof v === "string");
  return typeof found === "string" ? found : String(err);
}

// Vapi reports its own normal hang-up ("meeting has ended", ejection) as an error event.
const isNormalEnd = (text: string) => /meeting (has )?ended|ejected|ejection/i.test(text);

const NO_MIC = "No microphone found. Connect one, then start the call again.";
const MIC_BUSY = "Your microphone is in use by another app or tab. Close it, then start the call again.";
const MIC_SILENT = "We can't hear your microphone. Check it's connected, unmuted and selected in your browser, then try again.";

/**
 * Checks the microphone before the call: Vapi hangs up after 0s if no audio arrives.
 * A working mic always picks up some background noise; a dead, muted or wrong device sends exact zeros.
 * Returns an error message, or null when the mic is sending audio.
 */
async function checkMicrophone(): Promise<string | null> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === "NotFoundError" || name === "OverconstrainedError") return NO_MIC;
    if (name === "NotReadableError" || name === "AbortError") return MIC_BUSY;
    return MIC_BLOCKED;
  }
  const ctx = new AudioContext();
  try {
    const analyser = ctx.createAnalyser();
    ctx.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      analyser.getFloatTimeDomainData(samples);
      if (samples.some((v) => v !== 0)) return null;
    }
    return MIC_SILENT;
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  }
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function CallPanel({ signedIn }: { signedIn: boolean }) {
  const vapiRef = useRef<Vapi | null>(null);
  const statusRef = useRef<Status>("idle");
  const logRef = useRef<HTMLOListElement | null>(null);
  const [status, setStatusState] = useState<Status>("idle");
  const [speaking, setSpeaking] = useState(false);
  const [volume, setVolume] = useState(0);
  const [muted, setMuted] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [partial, setPartial] = useState<Line | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);

  const setStatus = (s: Status) => {
    statusRef.current = s;
    setStatusState(s);
  };

  useEffect(() => {
    if (!PUBLIC_KEY) return;
    const vapi = new Vapi(PUBLIC_KEY);
    vapiRef.current = vapi;

    vapi.on("call-start", () => {
      setStatus("live");
      setError(null);
    });
    vapi.on("call-end", () => {
      setStatus(statusRef.current === "connecting" ? "idle" : "ended");
      setSpeaking(false);
      setVolume(0);
      setMuted(false);
      setPartial(null);
    });
    vapi.on("speech-start", () => setSpeaking(true));
    vapi.on("speech-end", () => setSpeaking(false));
    vapi.on("volume-level", (v: number) => setVolume(v));
    vapi.on("message", (m: { type?: string; transcriptType?: string; role?: string; transcript?: string }) => {
      if (m.type !== "transcript" || !m.transcript) return;
      const line: Line = { role: m.role === "assistant" ? "iris" : "caller", text: m.transcript };
      if (m.transcriptType === "final") {
        setPartial(null);
        setLines((prev) => [...prev, line]);
      } else {
        setPartial(line);
      }
    });
    vapi.on("error", (err: unknown) => {
      const text = errorText(err);
      const was = statusRef.current;
      // Vapi ending a live call is a normal hang-up; ending it before it starts is a failure.
      if (isNormalEnd(text) && was !== "connecting") return;
      // The page shows a friendly message; the raw one is kept for debugging.
      console.warn("Vapi error:", err);
      if (/permission|notallowed|microphone/i.test(text)) setError(MIC_BLOCKED);
      else if (isNormalEnd(text)) setError(NOT_TAKEN);
      else setError(was === "live" || was === "ending" ? DROPPED : CONNECT_FAILED);
      setStatus(was === "live" ? "ended" : "idle");
    });

    return () => {
      void vapi.stop();
      vapiRef.current = null;
    };
  }, []);

  // Call timer.
  useEffect(() => {
    if (status !== "live") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [status]);

  // Keep the newest line in view.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, partial]);

  const configured = Boolean(PUBLIC_KEY && ASSISTANT_ID);
  const inCall = status === "live" || status === "ending";

  async function start() {
    if (!vapiRef.current || !ASSISTANT_ID) return;
    setError(null);
    setLines([]);
    setPartial(null);
    setSeconds(0);
    setStatus("connecting");
    const micProblem = await checkMicrophone();
    if (micProblem) {
      setStatus("idle");
      setError(micProblem);
      return;
    }
    try {
      // A short-lived start token: the agent refuses web calls without one (design §8).
      const res = await fetch("/api/call-token", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
      if (!res.ok || !body.token) {
        setStatus("idle");
        setError(body.error ?? CONNECT_FAILED);
        return;
      }
      const call = await vapiRef.current.start(ASSISTANT_ID, { metadata: { callToken: body.token } });
      if (!call) {
        setStatus("idle");
        setError(CONNECT_FAILED);
      }
    } catch (err) {
      console.warn("Vapi start failed:", err);
      setStatus("idle");
      setError(/permission|notallowed|microphone/i.test(errorText(err)) ? MIC_BLOCKED : CONNECT_FAILED);
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

  const statusText = !configured
    ? "Voice calling isn't set up yet."
    : status === "connecting"
      ? "Connecting to Iris"
      : status === "ending"
        ? "Ending the call"
        : status === "live"
          ? muted
            ? "You're muted"
            : speaking
              ? "Iris is speaking"
              : "Iris is listening"
          : status === "ended"
            ? `Call ended after ${clock(seconds)}`
            : "Iris is available now";

  // The ring follows the voice level; teal while Iris speaks, blue while she listens.
  const ringScale = inCall && !muted ? 1 + Math.min(volume, 1) * 0.35 : 1;
  const ringColor = speaking ? "var(--accent)" : "var(--primary)";

  return (
    <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-12">
      {/* Call controls */}
      <section aria-label="Call" className="flex flex-col items-center rounded-xl border border-border bg-surface px-6 py-10 sm:py-12">
        <div className="relative grid h-40 w-40 place-items-center">
          <span
            aria-hidden="true"
            className="absolute inset-3 rounded-full border-2 transition-[transform,border-color,opacity] duration-150 ease-out motion-reduce:transition-none"
            style={{ transform: `scale(${ringScale})`, borderColor: ringColor, opacity: inCall ? 0.55 : 0 }}
          />
          <button
            type="button"
            onClick={inCall ? end : start}
            disabled={!configured || status === "connecting" || status === "ending"}
            aria-label={inCall ? "End call" : "Start call"}
            className={`relative grid h-28 w-28 place-items-center rounded-full text-white transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30 disabled:opacity-60 ${
              inCall ? "bg-danger hover:bg-[#8c3030]" : "bg-primary hover:bg-primary-hover"
            }`}
          >
            {status === "connecting" ? (
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/40 border-t-white motion-reduce:animate-none" />
            ) : (
              <PhoneIcon hangUp={inCall} />
            )}
          </button>
        </div>

        <p className="mt-6 text-[17px] font-semibold tracking-tight" aria-live="polite">
          {statusText}
        </p>
        <p className="mt-1 h-5 text-[14px] tabular-nums text-muted">
          {inCall ? clock(seconds) : status === "idle" && configured ? "Press the button to start a voice call" : ""}
        </p>

        <div className="mt-6 flex h-10 gap-2">
          {inCall && (
            <button
              type="button"
              onClick={toggleMute}
              aria-pressed={muted}
              className="h-10 rounded-md border border-border px-4 text-[14px] font-medium hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {muted ? "Unmute" : "Mute"}
            </button>
          )}
          {status === "ended" && (
            <button
              type="button"
              onClick={start}
              className="h-10 rounded-md bg-primary px-5 text-[14px] font-medium text-white hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Start a new call
            </button>
          )}
        </div>

        {error && (
          <p role="alert" className="mt-4 max-w-xs text-center text-[14px] leading-6 text-danger">
            {error}
          </p>
        )}

        <p className="mt-8 max-w-xs text-center text-[13px] leading-5 text-muted">
          {signedIn
            ? "You're signed in, so Iris can look at your account with you."
            : "You're not signed in. Iris can answer general questions; sign in to talk about your account."}
        </p>
      </section>

      {/* Transcript */}
      <section aria-label="Conversation" className="flex min-h-0 flex-col rounded-xl border border-border bg-surface">
        <h2 className="border-b border-border px-5 py-3.5 text-[14px] font-semibold">Conversation</h2>
        <ol
          ref={logRef}
          aria-live="polite"
          className={`space-y-4 overflow-y-auto px-5 py-5 text-[15px] leading-6 lg:h-[26rem] ${lines.length || partial || inCall ? "h-80" : "h-32"}`}
        >
          {lines.length === 0 && !partial && (
            <li className="grid h-full place-items-center text-center text-[14px] text-muted">
              {inCall ? "Say hello. What you and Iris say appears here." : "What you and Iris say appears here during the call."}
            </li>
          )}
          {lines.map((line, i) => (
            <TranscriptLine key={i} line={line} />
          ))}
          {partial && <TranscriptLine line={partial} pending />}
        </ol>
      </section>
    </div>
  );
}

function TranscriptLine({ line, pending = false }: { line: Line; pending?: boolean }) {
  return (
    <li className="grid grid-cols-[3rem_minmax(0,1fr)] gap-3">
      <span className={`pt-px text-[13px] font-semibold ${line.role === "iris" ? "text-accent" : "text-muted"}`}>
        {line.role === "iris" ? "Iris" : "You"}
      </span>
      <span className={pending ? "text-muted" : undefined}>{line.text}</span>
    </li>
  );
}

function PhoneIcon({ hangUp }: { hangUp: boolean }) {
  return (
    <svg
      width="34"
      height="34"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`transition-transform duration-200 motion-reduce:transition-none ${hangUp ? "rotate-[135deg]" : ""}`}
    >
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />
    </svg>
  );
}

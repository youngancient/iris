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
const NO_AUDIO =
  "Iris couldn't hear you, so the call didn't start. Check your microphone is selected and not used by another app, refresh the page, and try again.";
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

export function CallPanel({ signedIn, available: availableAtLoad }: { signedIn: boolean; available: boolean }) {
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
  // Starts from the page's reading of the kill switch; the call-token route can turn it off later.
  const [available, setAvailable] = useState(availableAtLoad);
  // The first attempt failed and the page is trying once more.
  const [retrying, setRetrying] = useState(false);

  const setStatus = (s: Status) => {
    statusRef.current = s;
    setStatusState(s);
  };

  // Close any call still open when the page goes away.
  useEffect(() => () => void vapiRef.current?.stop(), []);

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

  /**
   * One attempt: a fresh Vapi (and Daily) connection every time, so a failed attempt
   * can't leave state behind for the next. Resolves when the attempt is over or live.
   */
  async function connect(attempt: number): Promise<void> {
    if (!PUBLIC_KEY || !ASSISTANT_ID) return;
    const trace = (stage: string, detail?: unknown) => console.info(`[call] attempt ${attempt}: ${stage}`, detail ?? "");

    // A short-lived start token: the agent refuses web calls without one (design §8). Single use, so one per attempt.
    trace("requesting call token");
    const res = await fetch("/api/call-token", { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string; unavailable?: boolean };
    if (body.unavailable) {
      setStatus("idle");
      setAvailable(false);
      return;
    }
    if (!res.ok || !body.token) {
      setStatus("idle");
      setError(body.error ?? CONNECT_FAILED);
      return;
    }

    const vapi = new Vapi(PUBLIC_KEY);
    vapiRef.current = vapi;
    const current = () => vapiRef.current === vapi;
    // Iris speaking (or any transcript) proves audio is flowing both ways.
    let heard = false;
    let settled = false;

    // Before Iris has said anything, a drop is a failed connection: retry once, then explain.
    const failed = async (why: string, message: string) => {
      if (settled || !current()) return;
      settled = true;
      clearTimeout(watchdog);
      trace(`failed: ${why}`);
      vapiRef.current = null;
      await vapi.stop().catch(() => {});
      if (attempt === 1) {
        setRetrying(true);
        return connect(2);
      }
      setRetrying(false);
      setStatus("idle");
      setError(message);
    };

    // Iris greets the caller a second or two after joining. Silence well past that means the
    // caller's audio never reached Vapi (it hangs up itself at 15s): retry before that.
    const watchdog = setTimeout(() => void failed("no greeting within 12s", NO_AUDIO), 12_000);

    vapi.on("call-start-progress", (e: { stage: string; status: string }) => trace(`${e.stage} ${e.status}`));
    vapi.on("call-start", () => {
      if (!current()) return;
      trace("joined");
      const local = vapi.getDailyCallObject()?.participants()?.local;
      trace("microphone track", local?.tracks?.audio?.state);
    });
    vapi.on("speech-start", () => {
      if (!current()) return;
      if (!heard) {
        heard = true;
        settled = true;
        clearTimeout(watchdog);
        trace("Iris is speaking: call is live");
        setRetrying(false);
        setStatus("live");
        setError(null);
      }
      setSpeaking(true);
    });
    vapi.on("speech-end", () => current() && setSpeaking(false));
    vapi.on("volume-level", (v: number) => current() && setVolume(v));
    vapi.on("message", (m: { type?: string; transcriptType?: string; role?: string; transcript?: string }) => {
      if (!current() || m.type !== "transcript" || !m.transcript) return;
      const line: Line = { role: m.role === "assistant" ? "iris" : "caller", text: m.transcript };
      if (m.transcriptType === "final") {
        setPartial(null);
        setLines((prev) => [...prev, line]);
      } else {
        setPartial(line);
      }
    });
    vapi.on("call-end", () => {
      if (!current()) return;
      if (!heard) return void failed("ended before Iris spoke", NO_AUDIO);
      trace("ended");
      vapiRef.current = null;
      setStatus("ended");
      setSpeaking(false);
      setVolume(0);
      setMuted(false);
      setPartial(null);
    });
    vapi.on("error", (err: unknown) => {
      if (!current()) return;
      const text = errorText(err);
      // Vapi reports its own normal hang-up as an error: call-end handles that.
      if (isNormalEnd(text)) return;
      // The page shows a friendly message; the raw one is kept for debugging.
      console.warn("Vapi error:", err);
      if (/permission|notallowed|microphone/i.test(text)) {
        settled = true;
        clearTimeout(watchdog);
        vapiRef.current = null;
        void vapi.stop();
        setRetrying(false);
        setStatus("idle");
        setError(MIC_BLOCKED);
        return;
      }
      if (!heard) return void failed(`error: ${text}`, CONNECT_FAILED);
      setError(DROPPED);
      setStatus("ended");
    });

    try {
      trace("starting");
      const call = await vapi.start(ASSISTANT_ID, { metadata: { callToken: body.token } });
      if (!call) await failed("start returned no call", CONNECT_FAILED);
    } catch (err) {
      console.warn("Vapi start failed:", err);
      if (/permission|notallowed|microphone/i.test(errorText(err))) {
        settled = true;
        clearTimeout(watchdog);
        vapiRef.current = null;
        setRetrying(false);
        setStatus("idle");
        setError(MIC_BLOCKED);
        return;
      }
      await failed("start threw", CONNECT_FAILED);
    }
  }

  async function start() {
    if (!ASSISTANT_ID) return;
    setError(null);
    setLines([]);
    setPartial(null);
    setSeconds(0);
    setRetrying(false);
    setStatus("connecting");
    const micProblem = await checkMicrophone();
    if (micProblem) {
      setStatus("idle");
      setError(micProblem);
      return;
    }
    try {
      await connect(1);
    } catch (err) {
      console.warn("Call setup failed:", err);
      setRetrying(false);
      setStatus("idle");
      setError(CONNECT_FAILED);
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
    : !available && !inCall
      ? "Iris is unavailable right now"
    : status === "connecting"
      ? retrying
        ? "Reconnecting to Iris"
        : "Connecting to Iris"
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
            disabled={!configured || (!available && !inCall) || status === "connecting" || status === "ending"}
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
        <p className="mt-1 min-h-5 max-w-xs text-center text-[14px] leading-5 tabular-nums text-muted">
          {inCall
            ? clock(seconds)
            : !available
              ? "You can still reach support from your RelayPay dashboard."
              : status === "idle" && configured
                ? "Press the button to start a voice call"
                : ""}
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
          {status === "ended" && available && (
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

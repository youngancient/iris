import { useEffect, useState } from "react";
import { assistantId, vapi } from "./vapi";

type Status = "idle" | "connecting" | "listening" | "speaking";
type Line = { role: "user" | "assistant"; text: string };

const statusLabel: Record<Status, string> = {
  idle: "Ready when you are",
  connecting: "Connecting…",
  listening: "Listening",
  speaking: "Iris is speaking",
};

export function App() {
  const [status, setStatus] = useState<Status>("idle");
  const [lines, setLines] = useState<Line[]>([]);

  useEffect(() => {
    vapi.on("call-start", () => setStatus("listening"));
    vapi.on("call-end", () => setStatus("idle"));
    vapi.on("speech-start", () => setStatus("speaking"));
    vapi.on("speech-end", () => setStatus("listening"));
    vapi.on("message", (m: { type: string; transcriptType?: string; role?: Line["role"]; transcript?: string }) => {
      if (m.type === "transcript" && m.transcriptType === "final" && m.role && m.transcript) {
        setLines((prev) => [...prev, { role: m.role!, text: m.transcript! }].slice(-6));
      }
    });
    vapi.on("error", (e) => {
      console.error(e);
      setStatus("idle");
    });
    return () => void vapi.removeAllListeners();
  }, []);

  const inCall = status !== "idle";

  return (
    <main className="page">
      <header className="header">
        <span className="logo">RelayPay</span>
        <span className="tag">Support</span>
      </header>

      <section className="panel">
        <h1>Talk to RelayPay support</h1>
        <p className="muted">Ask about payments, payouts, invoicing, fees, or your account.</p>

        <button
          className={inCall ? "button button-secondary" : "button"}
          onClick={() => (inCall ? vapi.stop() : (setLines([]), setStatus("connecting"), vapi.start(assistantId)))}
        >
          {inCall ? "End call" : "Start call"}
        </button>

        <p className="status" aria-live="polite">
          <span className={`dot dot-${status}`} /> {statusLabel[status]}
        </p>

        {lines.length > 0 && (
          <ul className="transcript">
            {lines.map((l, i) => (
              <li key={i}>
                <span className="who">{l.role === "user" ? "You" : "Iris"}</span> {l.text}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

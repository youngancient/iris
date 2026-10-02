"use client";

// Catches anything a dashboard page throws, so staff keep the sidebar and can retry
// instead of seeing Next's generic "This page couldn't load".
export default function DashboardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-[14px] leading-6 text-muted">
        This page couldn&apos;t be loaded. If it keeps happening, sign out and back in.
      </p>
      <button type="button" onClick={reset} className="mt-4 h-10 rounded-md bg-primary px-5 text-[14px] font-medium text-white hover:bg-primary-hover">
        Try again
      </button>
    </div>
  );
}

import { verifyAdmin } from "@/lib/dal";
import { getAdminCounts } from "@/lib/adminCounts";
import { getMaintenance } from "@/lib/settings";
import { signOut } from "../actions";
import { Sidebar } from "./nav";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const admin = await verifyAdmin();
  // A failed count just hides the badges; the pages themselves still load.
  const [maintenance, counts] = await Promise.all([getMaintenance().catch(() => null), getAdminCounts().catch(() => null)]);

  const signOutButton = (
    <form action={signOut}>
      <button type="submit" className="w-full rounded-md border border-border px-3 py-1.5 text-left hover:bg-background">Sign out</button>
    </form>
  );

  return (
    <div className="flex min-h-full flex-1 flex-col md:flex-row">
      <Sidebar email={admin.email} signOut={signOutButton} counts={counts} />
      <div className="flex min-w-0 flex-1 flex-col">
        {maintenance?.on && (
          <div role="status" className="bg-danger px-4 py-2 text-center text-[14px] font-medium text-white">
            Iris is stopped. Callers hear &quot;Support is temporarily unavailable&quot;. Turn her back on in Settings.
          </div>
        )}
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-8">{children}</main>
      </div>
    </div>
  );
}

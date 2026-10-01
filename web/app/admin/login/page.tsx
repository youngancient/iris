import { LoginForm } from "./login-form";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-16">
      <p className="text-[15px] font-semibold tracking-tight text-primary">RelayPay</p>
      <h1 className="mt-4 text-xl font-semibold">Support dashboard</h1>
      <p className="mt-1 text-[14px] text-muted">Sign in with your staff account.</p>
      <LoginForm notAllowed={error === "not-allowed"} />
    </main>
  );
}

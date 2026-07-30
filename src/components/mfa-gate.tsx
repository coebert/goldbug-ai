import { useCallback, useEffect, useState } from "react";
import { useLocation } from "@tanstack/react-router";
import { Loader2, ShieldAlert } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Factor = { id: string; friendly_name?: string | null; status: string };

/**
 * App-wide second-factor gate.
 *
 * Once an account has a verified authenticator, Supabase reports
 * `nextLevel === "aal2"` for every session that has not yet passed the second
 * step. Until that session is upgraded, nothing but this screen renders —
 * dashboards, portfolios and trading controls all sit behind it.
 *
 * Accounts with no enrolled factor pass straight through (nextLevel is aal1),
 * so enrolment in Settings is what turns enforcement on.
 */
export function MfaGate({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const [checking, setChecking] = useState(true);
  const [needsStepUp, setNeedsStepUp] = useState(false);
  const [factors, setFactors] = useState<Factor[]>([]);
  const [factorId, setFactorId] = useState<string>("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // /auth must stay reachable: the first factor is only known after sign-in.
  const exempt = pathname.startsWith("/auth");

  const evaluate = useCallback(async () => {
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session) {
      setNeedsStepUp(false);
      setChecking(false);
      return;
    }
    const { data, error: aalError } =
      await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalError || !data) {
      setNeedsStepUp(false);
      setChecking(false);
      return;
    }
    const stepUp = data.nextLevel === "aal2" && data.currentLevel !== "aal2";
    setNeedsStepUp(stepUp);
    if (stepUp) {
      const list = await supabase.auth.mfa.listFactors();
      const verified = ((list.data?.all ?? []) as Factor[]).filter(
        (f) => f.status === "verified",
      );
      setFactors(verified);
      setFactorId((cur) => cur || verified[0]?.id || "");
    }
    setChecking(false);
  }, []);

  useEffect(() => {
    void evaluate();
    const { data } = supabase.auth.onAuthStateChange(() => {
      void evaluate();
    });
    return () => data.subscription.unsubscribe();
  }, [evaluate]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setBusy(true);
    setError(null);
    const challenge = await supabase.auth.mfa.challenge({ factorId });
    if (challenge.error) {
      setBusy(false);
      setError(challenge.error.message);
      return;
    }
    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.data.id,
      code: code.replace(/\s/g, ""),
    });
    setBusy(false);
    if (verifyError) {
      setError("That code was not accepted. Check the clock on your device and try again.");
      return;
    }
    setCode("");
    await evaluate();
  }

  if (exempt) return <>{children}</>;

  if (checking) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!needsStepUp) return <>{children}</>;

  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6"
      >
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <ShieldAlert className="h-5 w-5 text-primary" />
            Two-factor required
          </h1>
          <p className="text-sm text-muted-foreground">
            Enter the 6-digit code from your authenticator app to continue.
          </p>
        </div>

        {factors.length > 1 && (
          <div className="space-y-1">
            <Label htmlFor="gate-factor">Authenticator</Label>
            <select
              id="gate-factor"
              value={factorId}
              onChange={(e) => setFactorId(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {factors.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.friendly_name ?? "Authenticator"}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="space-y-1">
          <Label htmlFor="gate-code">Verification code</Label>
          <Input
            id="gate-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={6}
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <Button
          type="submit"
          className="w-full"
          disabled={busy || code.replace(/\s/g, "").length < 6}
        >
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Verify
        </Button>

        <Button
          type="button"
          variant="ghost"
          className="w-full"
          onClick={() => void supabase.auth.signOut()}
        >
          Sign out
        </Button>
      </form>
    </div>
  );
}

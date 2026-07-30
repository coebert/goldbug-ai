import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Factor = {
  id: string;
  friendly_name?: string | null;
  status: string;
  created_at?: string;
};

type Enrolling = {
  factorId: string;
  qr: string;
  secret: string;
  uri: string;
};

/**
 * Time-based one-time password (TOTP) enrolment for the signed-in account.
 *
 * Backup strategy: Supabase Auth has no built-in single-use recovery codes, so
 * the supported way to avoid a lockout is a SECOND enrolled authenticator
 * ("Backup app") held on a different device. This card therefore allows up to
 * two factors and nudges for the backup once the first is verified.
 */
export function MfaCard() {
  const [factors, setFactors] = useState<Factor[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [enrolling, setEnrolling] = useState<Enrolling | null>(null);
  const [code, setCode] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) {
      toast.error(`Could not load two-factor status: ${error.message}`);
      setFactors([]);
    } else {
      setFactors((data?.all ?? []) as Factor[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const verified = factors.filter((f) => f.status === "verified");

  async function startEnroll(friendlyName: string) {
    setBusy(true);
    // Clear any half-finished factor with the same name — Supabase rejects
    // duplicate friendly names.
    const stale = factors.find(
      (f) => f.friendly_name === friendlyName && f.status !== "verified",
    );
    if (stale) await supabase.auth.mfa.unenroll({ factorId: stale.id });

    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName,
    });
    setBusy(false);
    if (error || !data) {
      toast.error(`Enrolment failed: ${error?.message ?? "unknown error"}`);
      return;
    }
    setCode("");
    setEnrolling({
      factorId: data.id,
      qr: data.totp.qr_code,
      secret: data.totp.secret,
      uri: data.totp.uri,
    });
  }

  async function confirmEnroll() {
    if (!enrolling) return;
    setBusy(true);
    const challenge = await supabase.auth.mfa.challenge({
      factorId: enrolling.factorId,
    });
    if (challenge.error) {
      setBusy(false);
      toast.error(`Challenge failed: ${challenge.error.message}`);
      return;
    }
    const { error } = await supabase.auth.mfa.verify({
      factorId: enrolling.factorId,
      challengeId: challenge.data.id,
      code: code.replace(/\s/g, ""),
    });
    setBusy(false);
    if (error) {
      toast.error(`That code was not accepted: ${error.message}`);
      return;
    }
    toast.success("Two-factor authentication is now active.");
    setEnrolling(null);
    setCode("");
    await refresh();
  }

  async function remove(factorId: string) {
    setBusy(true);
    const { error } = await supabase.auth.mfa.unenroll({ factorId });
    setBusy(false);
    if (error) {
      toast.error(`Could not remove: ${error.message}`);
      return;
    }
    toast.success("Authenticator removed.");
    await refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4 text-primary" />
          Two-factor authentication
          {verified.length > 0 ? (
            <Badge variant="secondary">On</Badge>
          ) : (
            <Badge variant="destructive">Off</Badge>
          )}
        </CardTitle>
        <CardDescription>
          Requires a 6-digit code from your authenticator app in addition to your
          password. Strongly recommended: this account can place real orders.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking status…
          </p>
        ) : (
          <>
            {verified.length > 0 && (
              <ul className="space-y-2">
                {verified.map((f) => (
                  <li
                    key={f.id}
                    className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <KeyRound className="h-4 w-4 text-muted-foreground" />
                      {f.friendly_name ?? "Authenticator"}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void remove(f.id)}
                      aria-label={`Remove ${f.friendly_name ?? "authenticator"}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {enrolling ? (
              <div className="space-y-3 rounded-md border border-border p-3">
                <p className="text-sm">
                  Scan this with your authenticator app, then enter the 6-digit
                  code it shows.
                </p>
                <img
                  src={enrolling.qr}
                  alt="QR code for enrolling this account in your authenticator app"
                  className="h-44 w-44 rounded bg-background p-2"
                />
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">
                    Can&apos;t scan? Enter this key manually
                  </Label>
                  <code className="block break-all rounded bg-muted px-2 py-1 text-xs">
                    {enrolling.secret}
                  </code>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="mfa-code">Verification code</Label>
                  <Input
                    id="mfa-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="123456"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={busy || code.replace(/\s/g, "").length < 6}
                    onClick={() => void confirmEnroll()}
                  >
                    {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Activate
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      void supabase.auth.mfa.unenroll({
                        factorId: enrolling.factorId,
                      });
                      setEnrolling(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {verified.length === 0 && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void startEnroll("Primary authenticator")}
                  >
                    Set up two-factor
                  </Button>
                )}
                {verified.length === 1 && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void startEnroll("Backup authenticator")}
                  >
                    Add backup authenticator
                  </Button>
                )}
              </div>
            )}

            {verified.length === 1 && !enrolling && (
              <p className="text-xs text-muted-foreground">
                You have one authenticator. Add a second one on a different
                device — it is the only lockout protection available, as there
                are no printable recovery codes.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

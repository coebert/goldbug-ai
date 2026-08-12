import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * The signed-in user's email, or null. Read after mount only so the
 * SSR/prerender pass and the first client render agree.
 *
 * Pages use this purely to populate the header's account menu — route
 * protection itself lives in the MFA/auth gate.
 */
export function useSessionEmail(): string | null {
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (alive) setEmail(data.session?.user.email ?? null);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => {
      setEmail(s?.user.email ?? null);
    });
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, []);

  return email;
}

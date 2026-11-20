"use client";

// Shown when REQUIRE_AUTH_FOR_READS=1 and this screen has no device cookie.
// One correct parent PIN unlocks the screen for 30 days.

import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import Keypad from "@/components/Keypad";
import { safeNext } from "@/lib/safe-next";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "@/lib/weak-pin";

function UnlockForm() {
  const params = useSearchParams();
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const submit = async () => {
    setPending(true);
    setError("");
    const res = await fetch("/api/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    }).catch(() => null);
    setPending(false);
    setPin("");
    if (!res?.ok) {
      const data = res ? await res.json().catch(() => ({})) : {};
      setError(
        res?.status === 429 && typeof data.error === "string"
          ? data.error
          : "That PIN didn't work. After 5 wrong tries this screen has to wait a bit."
      );
      return;
    }
    // A full page load, not router.replace: while the screen was locked, the
    // router prefetched the tab-bar pages and cached their redirect back to
    // /unlock, so a client-side move would land here again. The new cookie
    // only takes effect on a fresh request.
    window.location.replace(safeNext(params.get("next"), window.location.origin));
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-cream">
      <h1 className="text-4xl font-extrabold">Unlock this screen</h1>
      <p className="max-w-xl text-center text-2xl opacity-80">
        This hub asks for the parent PIN once on each screen. The screen then stays unlocked for 30 days.
      </p>
      <Keypad value={pin} onChange={setPin} maxLength={PIN_MAX_LENGTH} masked />
      {error && <div className="max-w-xl text-center text-2xl font-bold text-ember-deep">{error}</div>}
      <button
        onClick={submit}
        disabled={pending || pin.length < PIN_MIN_LENGTH}
        className="btn-primary px-12 py-5 text-3xl disabled:opacity-40"
      >
        Unlock
      </button>
    </div>
  );
}

export default function UnlockPage() {
  return (
    <Suspense>
      <UnlockForm />
    </Suspense>
  );
}

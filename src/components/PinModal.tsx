"use client";

// Shared parent-PIN gate. Verifies against /api/pin, then hands the verified
// PIN back so the caller can include it in its mutation request.

import { useState } from "react";
import Modal from "./Modal";
import Keypad from "./Keypad";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "@/lib/weak-pin";

interface PinModalProps {
  open: boolean;
  onClose: () => void;
  onUnlock: (pin: string) => void;
  title?: string;
}

export default function PinModal({ open, onClose, onUnlock, title = "Parents Only" }: PinModalProps) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  const close = () => {
    setPin("");
    setError("");
    onClose();
  };

  const submit = async () => {
    const res = await fetch("/api/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(typeof data.error === "string" ? data.error : "Wrong PIN. Try again.");
      setPin("");
      return;
    }
    const verified = pin;
    setPin("");
    setError("");
    onUnlock(verified);
  };

  return (
    <Modal open={open} onClose={close} title={title}>
      <div className="flex flex-col items-center gap-5">
        <Keypad value={pin} onChange={setPin} maxLength={PIN_MAX_LENGTH} masked />
        {error && <div className="text-2xl font-bold text-ember-deep">{error}</div>}
        <button
          onClick={submit}
          disabled={pin.length < PIN_MIN_LENGTH}
          className="btn-primary px-12 py-5 text-3xl disabled:opacity-40"
        >
          Unlock
        </button>
      </div>
    </Modal>
  );
}

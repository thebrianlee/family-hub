"use client";

// The old root Today view was superseded by the /today dashboard (R4).
// Keep / as a redirect so the kiosk and old links land in the right place.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function RootRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/today"); }, [router]);
  return null;
}

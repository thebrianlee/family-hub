"use client";

// Rewards was folded into Routines — tap a kid's header there for the full
// drill-down. This route stays only to redirect any old deep links.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function ProgressRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace("/my-day"); }, [router]);
  return null;
}

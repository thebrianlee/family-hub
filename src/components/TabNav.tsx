"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import AddSheet from "./AddSheet";
import { useModules } from "./ModulesProvider";

// The tabs are the modules that are switched on (Settings → Modules), in the
// order src/modules/registry.ts gives them. Rewards folded into Routines (tap a
// kid's header for the drill-down). Today is the dashboard the wall wakes to.

// One consistent rounded icon set (stroke style, 2.5 weight).
function iconProps(active: boolean) {
  return {
    width: 44,
    height: 44,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: active ? "" : "opacity-80",
  };
}

function SunIcon({ active }: { active: boolean }) {
  return (
    <svg {...iconProps(active)}>
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2.5v2.5M12 19v2.5M2.5 12h2.5M19 12h2.5M5 5l1.8 1.8M17.2 17.2 19 19M19 5l-1.8 1.8M6.8 17.2 5 19" />
    </svg>
  );
}
function CalendarIcon({ active }: { active: boolean }) {
  return (
    <svg {...iconProps(active)}>
      <rect x="3.5" y="4.5" width="17" height="16" rx="3" />
      <path d="M3.5 9h17M8 3v3.5M16 3v3.5" />
    </svg>
  );
}
function MealIcon({ active }: { active: boolean }) {
  return (
    <svg {...iconProps(active)}>
      <path d="M6 3v8M6 3a2 2 0 0 0-2 2v3a2 2 0 0 0 4 0V5a2 2 0 0 0-2-2ZM6 11v10" />
      <path d="M17 3c-1.5 0-2.5 1.8-2.5 4S15.5 12 17 12v9" />
    </svg>
  );
}
function ListIcon({ active }: { active: boolean }) {
  return (
    <svg {...iconProps(active)}>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="m3.5 6 1 1 1.8-2M3.5 12h.01M3.5 18h.01" />
    </svg>
  );
}
function CheckIcon({ active }: { active: boolean }) {
  return (
    <svg {...iconProps(active)}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
      <path d="m8.5 12.5 2.5 2.5 4.8-5.3" />
    </svg>
  );
}
function BulbIcon({ active }: { active: boolean }) {
  return (
    <svg {...iconProps(active)}>
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6.5 6.5 0 0 0-4 11.6c.8.65 1.3 1.4 1.5 2.4h5c.2-1 .7-1.75 1.5-2.4A6.5 6.5 0 0 0 12 3Z" />
    </svg>
  );
}
// One icon per module that has a tab.
const ICONS: Record<string, (props: { active: boolean }) => React.ReactElement> = {
  core: SunIcon,
  calendar: CalendarIcon,
  routines: CheckIcon,
  meals: MealIcon,
  lists: ListIcon,
  ask: BulbIcon,
};

function MoonIcon() {
  return (
    <svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
    </svg>
  );
}

export default function TabNav() {
  const pathname = usePathname();
  const { tabs, isOn } = useModules();
  // The Add button makes events (Calendar) and routines or jobs (Routines).
  const canEvent = isOn("calendar");
  const canRoutine = isOn("routines");
  const [addOpen, setAddOpen] = useState(false);
  const [addStep, setAddStep] = useState<"choose" | "event" | "routine">("choose");
  const [addType, setAddType] = useState<"routine" | "job">("routine");
  useEffect(() => {
    const a = new URLSearchParams(window.location.search).get("add");
    if (a === "1" || a === "event" || a === "routine") {
      setAddStep(a === "1" ? "choose" : a);
      setAddOpen(true);
    } else if (a === "job") {
      setAddStep("routine");
      setAddType("job");
      setAddOpen(true);
    }
  }, []);
  return (
    <nav className="flex gap-4 px-8 pb-7 pt-3 shrink-0">
      {(canEvent || canRoutine) && (
        <AddSheet open={addOpen} onClose={() => setAddOpen(false)} initialStep={addStep} initialType={addType} />
      )}
      {tabs.map((tab) => {
        const active = pathname === tab.href;
        const Icon = ICONS[tab.id] ?? CheckIcon;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`touch-target flex-1 flex flex-col items-center justify-center gap-1.5 rounded-card py-4 text-2xl font-bold transition-colors ${
              active
                ? "bg-ink text-cream shadow-card"
                : "bg-cream-raised text-ink-soft shadow-tile active:bg-cream-sunken"
            }`}
          >
            <Icon active={active} />
            {tab.label}
          </Link>
        );
      })}
      {/* Parent settings (asks for the PIN). */}
      <Link
        href="/settings"
        aria-label="Parent settings"
        className={`touch-target w-[110px] flex flex-col items-center justify-center gap-1.5 rounded-card py-4 shadow-tile ${
          pathname === "/settings" ? "bg-ink text-cream" : "bg-cream-raised text-ink-faint active:bg-cream-sunken"
        }`}
      >
        <svg width={38} height={38} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3.2" />
          <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7" />
        </svg>
      </Link>
      {/* Instant screensaver — guests over, photos up. */}
      <button
        onClick={() => window.dispatchEvent(new CustomEvent("sproutwall:sleep"))}
        aria-label="Start screensaver"
        className="touch-target w-[110px] flex flex-col items-center justify-center gap-1.5 rounded-card py-4 bg-cream-raised text-ink-faint shadow-tile active:bg-cream-sunken"
      >
        <MoonIcon />
      </button>
      {/* Universal input — create an event or routine by touch */}
      {(canEvent || canRoutine) && (
      <button
        onClick={() => {
          // Context-aware: open straight to the type that fits the current tab.
          if (pathname === "/calendar") setAddStep("event");
          else if (pathname === "/my-day") { setAddStep("routine"); setAddType("routine"); }
          else setAddStep("choose");
          setAddOpen(true);
        }}
        aria-label="Add event or routine"
        className="touch-target w-[128px] flex flex-col items-center justify-center gap-1.5 rounded-card py-4 bg-ember text-white shadow-card active:scale-95 transition-transform"
      >
        <svg width={40} height={40} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        Add
      </button>
      )}
    </nav>
  );
}

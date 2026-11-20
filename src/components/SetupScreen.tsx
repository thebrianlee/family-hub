"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import ModuleToggles from "@/components/ModuleToggles";
import PersonEditor, { MAX_NAME, type PersonRow } from "@/components/PersonEditor";
import { MEMBER_PALETTE, PARENT_COLOR_ORDER, nextUnusedColor } from "@/lib/member-theme";
import { TOGGLEABLE_MODULES, applyModuleChanges, defaultModuleState, type ModuleState } from "@/modules/registry";

const SAMPLE_NAME = "The Calder family";
const SAMPLE_GREETING = "Calders";
const MAX_KIDS = 8;
const MAX_PARENTS = 4;

type Mode = "sample" | "custom";

export default function SetupScreen() {
  const router = useRouter();
  const [familyName, setFamilyName] = useState(SAMPLE_NAME);
  const [greeting, setGreeting] = useState(SAMPLE_GREETING);
  const [currency, setCurrency] = useState("Family Bucks");
  const [timezone, setTimezone] = useState("America/Chicago");
  const [latitude, setLatitude] = useState("39.10");
  const [longitude, setLongitude] = useState("-94.58");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  // "Your family": keep the sample Calders, or type in the real household.
  const [mode, setMode] = useState<Mode>("sample");
  const nextKey = useRef(3);
  const [kids, setKids] = useState<PersonRow[]>([
    { key: 1, name: "", age: "", preReader: false, color: MEMBER_PALETTE[0].hex },
  ]);
  const [parents, setParents] = useState<PersonRow[]>([
    { key: 2, name: "", age: "", preReader: false, color: PARENT_COLOR_ORDER[0] },
  ]);
  const usedColors = () => [...kids, ...parents].map((p) => p.color);

  // "What should your wall show?": one answer. Skipping keeps the recommended
  // set (every module but Ask) and sends "recommended".
  const [modules, setModules] = useState<ModuleState>(defaultModuleState);
  const [modulesSkipped, setModulesSkipped] = useState(false);
  const houseRef = useRef<HTMLHeadingElement>(null);
  const offNames = TOGGLEABLE_MODULES.filter((m) => !modules[m.id]).map((m) => m.name);

  // Start from this browser's timezone instead of a fixed US zone. Done after
  // mount so the server-rendered HTML and the first client render match.
  useEffect(() => {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (local) setTimezone(local);
  }, []);

  function chooseMode(next: Mode) {
    setMode(next);
    setError("");
    // The sample household name only fits the sample family.
    if (next === "custom") {
      if (familyName === SAMPLE_NAME) setFamilyName("");
      if (greeting === SAMPLE_GREETING) setGreeting("");
    } else {
      if (!familyName.trim()) setFamilyName(SAMPLE_NAME);
      if (!greeting.trim()) setGreeting(SAMPLE_GREETING);
    }
  }

  function addPerson(role: "kid" | "parent") {
    const color = nextUnusedColor(usedColors(), role === "kid" ? undefined : PARENT_COLOR_ORDER);
    const row = { key: nextKey.current++, name: "", age: "", preReader: false, color };
    if (role === "kid") setKids((k) => (k.length < MAX_KIDS ? [...k, row] : k));
    else setParents((p) => (p.length < MAX_PARENTS ? [...p, row] : p));
  }

  function localProblem(): string {
    if (mode === "sample") return "";
    const people = [...kids, ...parents];
    if (people.some((p) => !p.name.trim())) return "Every person needs a name.";
    if (people.some((p) => p.name.trim().length > MAX_NAME)) return `Keep names to ${MAX_NAME} characters.`;
    const names = people.map((p) => p.name.trim().toLocaleLowerCase());
    if (new Set(names).size !== names.length) return "Give each person a different name.";
    for (const k of kids) {
      const a = Number(k.age);
      if (k.age.trim() === "" || !Number.isInteger(a) || a < 0 || a > 18) {
        return `${k.name.trim()}'s age should be a whole number from 0 to 18.`;
      }
    }
    return "";
  }

  async function submit() {
    setError("");
    if (pin !== confirm) {
      setError("Those PINs do not match.");
      return;
    }
    const problem = localProblem();
    if (problem) {
      setError(problem);
      return;
    }
    setPending(true);
    try {
      const household =
        mode === "sample"
          ? { mode }
          : {
              mode,
              kids: kids.map((k) => ({ name: k.name, age: Number(k.age), preReader: k.preReader, color: k.color })),
              parents: parents.map((p) => ({ name: p.name, color: p.color })),
            };
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pin,
          familyName,
          greeting,
          currency,
          timezone,
          latitude,
          longitude,
          household,
          modules: modulesSkipped ? "recommended" : modules,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "Setup did not save.");
        setPending(false);
        return;
      }
      // refresh() makes the server layout re-read setup_complete.
      router.replace("/today");
      router.refresh();
    } catch {
      setError("Could not reach Sproutwall.");
      setPending(false);
    }
  }

  return (
    <main className="screen-fit overflow-y-auto bg-cream text-ink px-8 py-10">
      <div className="mx-auto max-w-3xl">
        <div className="eyebrow mb-2">Sproutwall</div>
        <h1 className="text-6xl font-extrabold tracking-tight">Set up the house</h1>
        <p className="mt-4 text-2xl leading-snug text-ink-soft">
          Try the board with the sample family, or add your own people. Choose a parent PIN before anything can be
          changed. There is no default.
        </p>

        <h2 className="mt-10 text-4xl font-extrabold tracking-tight">Your family</h2>
        <div className="mt-4 grid grid-cols-2 gap-4" role="radiogroup" aria-label="Your family">
          <Choice
            on={mode === "sample"}
            onClick={() => chooseMode("sample")}
            title="Try it with the sample family"
            detail="The fictional Calders, with their sample routines, events and points. Good for a first look."
          />
          <Choice
            on={mode === "custom"}
            onClick={() => chooseMode("custom")}
            title="Set up my family"
            detail="Your kids and parents. The sample family and everything of theirs is removed."
          />
        </div>

        {mode === "custom" && (
          <div className="mt-6 grid gap-6">
            <section className="grid gap-4">
              <div className="eyebrow">Kids</div>
              {kids.map((k, i) => (
                <PersonEditor
                  key={k.key}
                  role="kid"
                  index={i}
                  row={k}
                  canRemove={kids.length > 1}
                  onChange={(row) => setKids((all) => all.map((x) => (x.key === row.key ? row : x)))}
                  onRemove={() => setKids((all) => all.filter((x) => x.key !== k.key))}
                />
              ))}
              {kids.length < MAX_KIDS && (
                <button type="button" onClick={() => addPerson("kid")} className="btn-soft h-16 text-2xl">
                  ＋ Add a kid
                </button>
              )}
            </section>
            <section className="grid gap-4">
              <div className="eyebrow">Parents</div>
              {parents.map((p, i) => (
                <PersonEditor
                  key={p.key}
                  role="parent"
                  index={i}
                  row={p}
                  canRemove={parents.length > 1}
                  onChange={(row) => setParents((all) => all.map((x) => (x.key === row.key ? row : x)))}
                  onRemove={() => setParents((all) => all.filter((x) => x.key !== p.key))}
                />
              ))}
              {parents.length < MAX_PARENTS && (
                <button type="button" onClick={() => addPerson("parent")} className="btn-soft h-16 text-2xl">
                  ＋ Add a parent
                </button>
              )}
            </section>
          </div>
        )}

        <h2 className="mt-10 text-4xl font-extrabold tracking-tight">What should your wall show?</h2>
        {modulesSkipped ? (
          <div className="mt-4 flex items-center justify-between gap-4 rounded-card bg-cream-raised px-6 py-5 shadow-tile">
            <p className="text-xl leading-snug text-ink-soft">
              The recommended set: everything except Ask the Hub. You can change this any time in Settings → Modules.
            </p>
            <button type="button" onClick={() => setModulesSkipped(false)} className="btn-soft h-14 shrink-0 px-6 text-xl">
              Choose
            </button>
          </div>
        ) : (
          <>
            <p className="mt-3 text-xl leading-snug text-ink-soft">
              Turn off what your family won&apos;t use. Nothing is deleted, and you can change this any time in Settings →
              Modules.
            </p>
            <div className="mt-4">
              <ModuleToggles
                state={modules}
                firstRun
                onToggle={(id, on) => setModules((current) => applyModuleChanges(current, { [id]: on }))}
              />
            </div>
            {offNames.length > 0 && <p className="mt-3 text-xl text-ink-faint">Off: {offNames.join(", ")}.</p>}
            <button
              type="button"
              onClick={() => {
                setModules(defaultModuleState());
                setModulesSkipped(true);
                houseRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              className="btn-soft mt-4 h-16 w-full text-2xl"
            >
              Skip, use recommended
            </button>
          </>
        )}

        <h2 ref={houseRef} className="mt-10 text-4xl font-extrabold tracking-tight">The house</h2>
        <div className="mt-4 grid gap-5">
          <Field label="Household name" value={familyName} onChange={setFamilyName} />
          <Field label="Greeting name" value={greeting} onChange={setGreeting} />
          <Field label="Points name" value={currency} onChange={setCurrency} />
          <Field label="Timezone" value={timezone} onChange={setTimezone} />
          <div className="grid grid-cols-2 gap-4">
            <Field label="Latitude" value={latitude} onChange={setLatitude} />
            <Field label="Longitude" value={longitude} onChange={setLongitude} />
          </div>
          <p className="text-xl text-ink-faint">
            Sample City is a placeholder downtown, not a home. Weather comes from Open-Meteo.
          </p>
          <Field label="Parent PIN" value={pin} onChange={setPin} secret />
          <Field label="PIN again" value={confirm} onChange={setConfirm} secret />
          {error ? <p className="text-2xl font-bold text-ember-deep">{error}</p> : null}
          <button
            type="button"
            disabled={pending}
            onClick={submit}
            className="btn-primary h-20 text-3xl disabled:opacity-60"
          >
            {pending ? "Saving" : "Open the wall"}
          </button>
        </div>
      </div>
    </main>
  );
}

function Choice({ on, onClick, title, detail }: { on: boolean; onClick: () => void; title: string; detail: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={`touch-target rounded-card px-6 py-5 text-left shadow-tile transition-colors ${
        on ? "bg-ink text-cream" : "bg-cream-raised text-ink active:bg-cream-sunken"
      }`}
    >
      <span className="block text-2xl font-extrabold leading-tight">{title}</span>
      <span className={`mt-2 block text-xl leading-snug ${on ? "text-cream/80" : "text-ink-soft"}`}>{detail}</span>
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  secret = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secret?: boolean;
}) {
  return (
    <label className="block text-2xl font-bold">
      {label}
      <input
        value={value}
        type={secret ? "password" : "text"}
        inputMode={secret ? "numeric" : undefined}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 h-16 w-full rounded-card border border-cream-line bg-cream-raised px-4 text-2xl font-semibold outline-none"
      />
    </label>
  );
}

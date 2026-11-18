"use client";

// Parent settings: household, location and timezone, calendar links, which
// modules are on, Ask the Hub privacy, and the PIN. Everything here is
// parent-only; the page asks for the PIN first and locks again when the parent
// leaves.

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";

import ModuleToggles from "@/components/ModuleToggles";
import PersonEditor, { type PersonRow } from "@/components/PersonEditor";
import PinModal from "@/components/PinModal";
import { MEMBER_PALETTE, PARENT_COLOR_ORDER, nextUnusedColor } from "@/lib/member-theme";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "@/lib/weak-pin";
import { applyModuleChanges, getModule, type ModuleState } from "@/modules/registry";

type Household = {
  familyName: string;
  greeting: string;
  currency: string;
  timezone: string;
  latitude: number;
  longitude: number;
};
type Calendar = { id: string; label: string; linked: boolean; host: string | null };
type Member = { id: string; name: string; role: "kid" | "parent"; age: number | null; preReader: boolean; color: string };
type Snapshot = {
  household: Household;
  calendars: Calendar[];
  privacy: { askShareFirstName: boolean };
  members: Member[];
};

type PostResult = { ok: boolean; error?: string; data?: Snapshot };

// The parent session lasts 15 minutes. When it runs out mid-edit, saves get a
// 403: the page shows the PIN keypad again and the parent taps Save again.
const SessionExpired = createContext<() => void>(() => {});
const EXPIRED = "Your parent session ended. Enter the PIN, then tap Save again.";

async function postRaw(body: Record<string, unknown>): Promise<PostResult & { status: number }> {
  const res = await fetch("/api/settings/parent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!res) return { ok: false, status: 0, error: "The hub didn't answer. Check the connection." };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, status: res.status, error: typeof data.error === "string" ? data.error : "That didn't save." };
  }
  return { ok: true, status: res.status, data };
}

/** post() for settings cards: re-asks for the PIN when the parent session ran out. */
function usePost(): (body: Record<string, unknown>) => Promise<PostResult> {
  const expired = useContext(SessionExpired);
  return async (body) => {
    const res = await postRaw(body);
    if (res.status === 403 && res.error === "Parent PIN required") {
      expired();
      return { ok: false, error: EXPIRED };
    }
    return res;
  };
}

export default function SettingsPage() {
  const router = useRouter();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [needPin, setNeedPin] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/settings/parent", { cache: "no-store" }).catch(() => null);
    if (res?.status === 403) {
      setNeedPin(true);
      return;
    }
    if (res?.ok) {
      setSnap(await res.json());
      setNeedPin(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const leave = async () => {
    await fetch("/api/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "lock" }),
    }).catch(() => null);
    router.push("/today");
  };

  return (
    <SessionExpired.Provider value={() => setNeedPin(true)}>
    <div className="h-full overflow-y-auto">
      <PinModal open={needPin} onClose={() => router.push("/today")} onUnlock={() => void load()} title="Parent settings" />
      <div className="mx-auto max-w-4xl">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="eyebrow mb-2">Parents only</div>
            <h1 className="text-6xl font-extrabold tracking-tight">Settings</h1>
            <p className="mt-3 text-xl text-ink-soft">
              Typing is easiest from a phone or laptop on your home Wi-Fi: open this same page there.
            </p>
          </div>
          <button onClick={() => void leave()} className="btn-primary h-16 px-8 text-2xl shrink-0">
            Done
          </button>
        </div>
        {snap ? (
          <div className="mt-8 grid gap-6 pb-16">
            <HouseholdCard initial={snap.household} onSaved={setSnap} />
            <FamilyCard
              members={snap.members}
              onSaved={(next) => {
                setSnap(next);
                // The layout passes members to every screen; re-render it.
                router.refresh();
              }}
            />
            <CalendarsCard calendars={snap.calendars} onSaved={setSnap} />
            <ModulesCard />
            <PrivacyCard share={snap.privacy.askShareFirstName} onSaved={setSnap} />
            <PinCard />
            <AboutCard />
          </div>
        ) : null}
      </div>
    </div>
    </SessionExpired.Provider>
  );
}

function Card({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <section className="card p-8">
      <h2 className="text-4xl font-extrabold tracking-tight">{title}</h2>
      {note ? <p className="mt-2 text-xl text-ink-soft">{note}</p> : null}
      <div className="mt-6 grid gap-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "password" | "url";
  placeholder?: string;
}) {
  return (
    <label className="block text-2xl font-bold">
      {label}
      <input
        value={value}
        type={type}
        placeholder={placeholder}
        inputMode={type === "password" ? "numeric" : undefined}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 h-16 w-full rounded-card border border-cream-line bg-cream-raised px-4 text-2xl font-semibold outline-none"
      />
    </label>
  );
}

function Status({ error, saved }: { error: string; saved: string }) {
  if (error) return <p className="text-2xl font-bold text-ember-deep">{error}</p>;
  if (saved) return <p className="text-2xl font-bold text-ink-soft">{saved}</p>;
  return null;
}

function HouseholdCard({ initial, onSaved }: { initial: Household; onSaved: (s: Snapshot) => void }) {
  const post = usePost();
  const [form, setForm] = useState({
    familyName: initial.familyName,
    greeting: initial.greeting,
    currency: initial.currency,
    timezone: initial.timezone,
    latitude: String(initial.latitude),
    longitude: String(initial.longitude),
  });
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved("");
  };
  const browserZone = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "";

  const save = async () => {
    setBusy(true);
    setError("");
    const res = await post({ section: "household", ...form });
    setBusy(false);
    if (!res.ok || !res.data) return setError(res.error ?? "That didn't save.");
    onSaved(res.data);
    setSaved("Saved.");
  };

  return (
    <Card title="Household">
      <Field label="Household name" value={form.familyName} onChange={set("familyName")} />
      <div className="grid grid-cols-2 gap-4">
        <Field label="Greeting" value={form.greeting} onChange={set("greeting")} />
        <Field label="Name for points" value={form.currency} onChange={set("currency")} />
      </div>
      <Field label="Timezone" value={form.timezone} onChange={set("timezone")} placeholder="America/Chicago" />
      {browserZone && browserZone !== form.timezone ? (
        <button onClick={() => set("timezone")(browserZone)} className="justify-self-start text-xl font-bold underline">
          Use this device&apos;s timezone ({browserZone})
        </button>
      ) : null}
      <div className="grid grid-cols-2 gap-4">
        <Field label="Latitude" value={form.latitude} onChange={set("latitude")} placeholder="41.88" />
        <Field label="Longitude" value={form.longitude} onChange={set("longitude")} placeholder="-87.63" />
      </div>
      <p className="text-xl text-ink-faint">
        For the weather. In a map app, press and hold on your home and copy the two numbers it shows.
      </p>
      <Status error={error} saved={saved} />
      <button onClick={() => void save()} disabled={busy} className="btn-primary h-16 text-2xl disabled:opacity-60">
        {busy ? "Saving…" : "Save household"}
      </button>
    </Card>
  );
}

function CalendarsCard({ calendars, onSaved }: { calendars: Calendar[]; onSaved: (s: Snapshot) => void }) {
  return (
    <Card
      title="Calendars"
      note="Paste each person's secret iCal address (Google: calendar settings → Secret address in iCal format; Apple: share the calendar as a public calendar). The address stays on the hub and is never shown again."
    >
      {calendars.map((c) => (
        <CalendarRow key={c.id} calendar={c} onSaved={onSaved} />
      ))}
    </Card>
  );
}

function CalendarRow({ calendar, onSaved }: { calendar: Calendar; onSaved: (s: Snapshot) => void }) {
  const post = usePost();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async (value: string) => {
    setBusy(true);
    setError("");
    const res = await post({ section: "calendar", owner: calendar.id, url: value });
    setBusy(false);
    if (!res.ok || !res.data) return setError(res.error ?? "That didn't save.");
    setUrl("");
    onSaved(res.data);
  };

  return (
    <div className="rounded-card bg-cream-raised p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="text-2xl font-extrabold">{calendar.label}</div>
        <div className="text-xl text-ink-soft">
          {calendar.linked ? `Linked${calendar.host ? ` (${calendar.host})` : ""}` : "No calendar"}
        </div>
      </div>
      <div className="mt-3 flex gap-3">
        <input
          value={url}
          type="url"
          placeholder={calendar.linked ? "Paste a new link to replace it" : "https://… or webcal://…"}
          autoComplete="off"
          onChange={(e) => setUrl(e.target.value)}
          className="h-14 flex-1 rounded-card border border-cream-line bg-cream px-4 text-xl font-semibold outline-none"
        />
        <button
          onClick={() => void save(url)}
          disabled={busy || !url.trim()}
          className="btn-primary h-14 px-6 text-xl disabled:opacity-60"
        >
          {busy ? "Checking…" : "Save"}
        </button>
        {calendar.linked ? (
          <button
            onClick={() => void save("")}
            disabled={busy}
            className="touch-target h-14 rounded-card bg-cream-sunken px-6 text-xl font-bold disabled:opacity-60"
          >
            Remove
          </button>
        ) : null}
      </div>
      {error ? <p className="mt-2 text-xl font-bold text-ember-deep">{error}</p> : null}
    </div>
  );
}

function PrivacyCard({ share, onSaved }: { share: boolean; onSaved: (s: Snapshot) => void }) {
  const post = usePost();
  const [error, setError] = useState("");
  const toggle = async () => {
    setError("");
    const res = await post({ section: "privacy", askShareFirstName: !share });
    if (!res.ok || !res.data) return setError(res.error ?? "That didn't save.");
    onSaved(res.data);
  };
  return (
    <Card
      title="Ask the Hub privacy"
      note="Questions go to the AI service you configured. By default the hub sends the question only, not who asked."
    >
      <label className="flex items-center gap-4 text-2xl font-bold">
        <input type="checkbox" checked={share} onChange={() => void toggle()} className="h-8 w-8" />
        Include the child&apos;s first name so answers can be personal
      </label>
      <Status error={error} saved="" />
    </Card>
  );
}

/**
 * Settings → Modules: switch built-in features on or off. Off only hides a
 * module from the wall; its data stays. Turning one off that others need asks
 * first. After a change the layout re-renders, so the tab bar follows.
 */
function ModulesCard() {
  const router = useRouter();
  const expired = useContext(SessionExpired);
  const [state, setState] = useState<ModuleState | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; alsoOff: string[] } | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);

  const toState = (data: { modules?: { id: string; enabled: boolean }[] }): ModuleState =>
    Object.fromEntries((data.modules ?? []).map((m) => [m.id, m.enabled]));

  useEffect(() => {
    let live = true;
    void fetch("/api/settings/modules", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live && d) setState(toState(d));
      })
      .catch(() => null);
    return () => {
      live = false;
    };
  }, []);

  const name = (id: string) => getModule(id)?.name ?? id;

  const save = async (id: string, on: boolean) => {
    if (!state) return;
    setConfirm(null);
    setBusy(true);
    setError("");
    setSaved("");
    const res = await fetch("/api/settings/modules", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modules: { [id]: on } }),
    }).catch(() => null);
    setBusy(false);
    if (!res) return setError("The hub didn't answer. Check the connection.");
    const data = await res.json().catch(() => ({}));
    if (res.status === 403 && data.error === "Parent PIN required") {
      expired();
      return setError(EXPIRED);
    }
    if (!res.ok) return setError(typeof data.error === "string" ? data.error : "That didn't save.");
    const next = toState(data);
    const alsoOn = Object.keys(next).filter((m) => m !== id && next[m] && !state[m]);
    setState(next);
    setSaved(
      on
        ? `${name(id)} is on.${alsoOn.length ? ` ${alsoOn.map(name).join(" and ")} turned on too, because ${name(id)} needs it.` : ""}`
        : "Hidden from the wall. Nothing is deleted; turn it back on any time."
    );
    // The layout passes the module state to every screen; re-render it.
    router.refresh();
  };

  const toggle = (id: string, on: boolean) => {
    if (!state) return;
    if (!on) {
      const next = applyModuleChanges(state, { [id]: false });
      const alsoOff = Object.keys(next).filter((m) => m !== id && state[m] && !next[m]);
      if (alsoOff.length) return setConfirm({ id, alsoOff });
    }
    void save(id, on);
  };

  return (
    <Card
      title="Modules"
      note="Choose what the wall shows. Turning a module off hides it from the wall; nothing is deleted, and turning it back on brings everything back."
    >
      {state ? <ModuleToggles state={state} onToggle={toggle} busy={busy} /> : <p className="text-xl text-ink-soft">Loading…</p>}
      {confirm ? (
        <div className="grid gap-4 rounded-card border-2 border-ember p-6">
          <p className="text-2xl font-bold">
            Turning off {name(confirm.id)} also turns off {confirm.alsoOff.map(name).join(" and ")}. Nothing is deleted.
          </p>
          <div className="flex gap-3">
            <button onClick={() => void save(confirm.id, false)} className="btn-primary h-16 flex-1 text-2xl">
              Turn them off
            </button>
            <button onClick={() => setConfirm(null)} className="btn-soft h-16 px-8 text-2xl">
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <Status error={error} saved={saved} />
    </Card>
  );
}

/** App version and data format, read from the public health check. */
function AboutCard() {
  const [info, setInfo] = useState<{ version: string; schema: number } | null>(null);
  useEffect(() => {
    let live = true;
    void fetch("/api/health", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (live && typeof d.version === "string" && typeof d.schema === "number") {
          setInfo({ version: d.version, schema: d.schema });
        }
      })
      .catch(() => null);
    return () => {
      live = false;
    };
  }, []);
  return (
    <Card title="About">
      <p className="text-xl text-ink-soft">
        {info ? `Version ${info.version} · data format ${info.schema}` : "Checking the version…"}
      </p>
    </Card>
  );
}

function PinCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);

  const change = async () => {
    setError("");
    setSaved("");
    if (next !== again) return setError("The new PINs don't match.");
    setBusy(true);
    const res = await fetch("/api/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "change", pin: current, newPin: next }),
    }).catch(() => null);
    setBusy(false);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok) return setError(typeof data.error === "string" ? data.error : "The PIN didn't change.");
    setCurrent("");
    setNext("");
    setAgain("");
    setSaved("PIN changed. Every other screen will ask for the new PIN.");
  };

  return (
    <Card
      title="Parent PIN"
      note={`${PIN_MIN_LENGTH}–${PIN_MAX_LENGTH} digits. Changing it signs out every other screen. Forgot it? Run "npm run reset-pin" on the machine that runs the hub.`}
    >
      <Field label="Current PIN" value={current} onChange={setCurrent} type="password" />
      <div className="grid grid-cols-2 gap-4">
        <Field label="New PIN" value={next} onChange={setNext} type="password" />
        <Field label="New PIN again" value={again} onChange={setAgain} type="password" />
      </div>
      <Status error={error} saved={saved} />
      <button
        onClick={() => void change()}
        disabled={busy || !current || !next}
        className="btn-primary h-16 text-2xl disabled:opacity-60"
      >
        {busy ? "Changing…" : "Change PIN"}
      </button>
    </Card>
  );
}

// ---------- family members ----------

let rowKey = 1000;
const toRow = (m: Member): PersonRow => ({
  key: rowKey++,
  name: m.name,
  age: m.age === null ? "" : String(m.age),
  preReader: m.preReader,
  color: m.color,
});
const emptyRow = (color: string): PersonRow => ({ key: rowKey++, name: "", age: "", preReader: false, color });
const payload = (r: PersonRow) => ({ name: r.name, age: r.age, preReader: r.preReader, color: r.color });

function FamilyCard({ members, onSaved }: { members: Member[]; onSaved: (s: Snapshot) => void }) {
  const post = usePost();
  const kids = members.filter((m) => m.role === "kid");
  const parents = members.filter((m) => m.role === "parent");
  const used = members.map((m) => m.color);
  const [adding, setAdding] = useState<{ role: "kid" | "parent"; row: PersonRow } | null>(null);
  const [error, setError] = useState("");

  const add = async () => {
    if (!adding) return;
    setError("");
    const res = await post({ section: "member-add", role: adding.role, ...payload(adding.row) });
    if (!res.ok || !res.data) return setError(res.error ?? "That didn't save.");
    setAdding(null);
    onSaved(res.data);
  };

  return (
    <Card title="Family" note="Changes show on every screen right away. Removing someone hides them; their history stays.">
      {[...kids, ...parents].map((m) => (
        <MemberRow
          key={`${m.id}:${m.name}:${m.color}:${m.age}:${m.preReader}`}
          member={m}
          canRemove={(m.role === "kid" ? kids : parents).length > 1}
          onSaved={onSaved}
        />
      ))}
      {adding ? (
        <div className="grid gap-3">
          <PersonEditor
            role={adding.role}
            index={0}
            label={adding.role === "kid" ? "New kid" : "New parent"}
            row={adding.row}
            canRemove
            onChange={(row) => setAdding({ ...adding, row })}
            onRemove={() => setAdding(null)}
          />
          <button onClick={() => void add()} className="btn-primary h-16 text-2xl">
            Add {adding.row.name.trim() || (adding.role === "kid" ? "kid" : "parent")}
          </button>
        </div>
      ) : (
        <div className="flex gap-3">
          <button
            onClick={() => setAdding({ role: "kid", row: emptyRow(nextUnusedColor(used)) })}
            className="btn-soft h-16 flex-1 text-2xl"
          >
            + Add a kid
          </button>
          <button
            onClick={() => setAdding({ role: "parent", row: emptyRow(nextUnusedColor(used, PARENT_COLOR_ORDER)) })}
            className="btn-soft h-16 flex-1 text-2xl"
          >
            + Add a parent
          </button>
        </div>
      )}
      <Status error={error} saved="" />
      <StartOver onSaved={onSaved} />
    </Card>
  );
}

function MemberRow({ member, canRemove, onSaved }: { member: Member; canRemove: boolean; onSaved: (s: Snapshot) => void }) {
  const post = usePost();
  const [row, setRow] = useState<PersonRow>(() => toRow(member));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const original = toRow(member);
  const changed =
    row.name !== original.name || row.age !== original.age || row.preReader !== original.preReader || row.color !== original.color;

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    const res = await post(body);
    setBusy(false);
    if (!res.ok || !res.data) return setError(res.error ?? "That didn't save.");
    onSaved(res.data);
  };

  return (
    <div className="grid gap-2">
      <PersonEditor
        role={member.role}
        index={0}
        label={member.role === "kid" ? "Kid" : "Parent"}
        row={row}
        canRemove={canRemove}
        onChange={setRow}
        onRemove={() => void send({ section: "member-remove", id: member.id })}
      />
      {changed ? (
        <button
          onClick={() => void send({ section: "member-update", id: member.id, ...payload(row) })}
          disabled={busy}
          className="btn-primary h-14 text-xl disabled:opacity-60"
        >
          {busy ? "Saving…" : `Save ${row.name.trim() || "changes"}`}
        </button>
      ) : null}
      {error ? <p className="text-xl font-bold text-ember-deep">{error}</p> : null}
    </div>
  );
}

function StartOver({ onSaved }: { onSaved: (s: Snapshot) => void }) {
  const post = usePost();
  const [open, setOpen] = useState(false);
  const [kids, setKids] = useState<PersonRow[]>(() => [emptyRow(MEMBER_PALETTE[0].hex)]);
  const [parents, setParents] = useState<PersonRow[]>(() => [emptyRow(PARENT_COLOR_ORDER[0])]);
  const [sure, setSure] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="justify-self-start text-xl font-bold underline text-ink-soft">
        Start over with a different family (for example, replace the sample family)
      </button>
    );
  }

  const replace = async () => {
    setBusy(true);
    setError("");
    const res = await post({
      section: "household-replace",
      confirm: "replace",
      pin,
      household: { kids: kids.map(payload), parents: parents.map(payload) },
    });
    setBusy(false);
    setPin("");
    if (!res.ok || !res.data) return setError(res.error ?? "That didn't save.");
    setOpen(false);
    setSure(false);
    onSaved(res.data);
  };

  const editors = (role: "kid" | "parent", rows: PersonRow[], set: (rows: PersonRow[]) => void) =>
    rows.map((row, i) => (
      <PersonEditor
        key={row.key}
        role={role}
        index={i}
        row={row}
        canRemove={rows.length > 1}
        onChange={(next) => set(rows.map((r) => (r.key === row.key ? next : r)))}
        onRemove={() => set(rows.filter((r) => r.key !== row.key))}
      />
    ));

  return (
    <div className="mt-4 grid gap-4 rounded-card border-2 border-ember p-6">
      <h3 className="text-3xl font-extrabold">Start over with a new family</h3>
      <p className="text-xl text-ink-soft">
        Everyone listed above is replaced, with their routines, points, books, calendar links and history. Family-wide
        rewards, meals, lists and rules stay.
      </p>
      {editors("kid", kids, setKids)}
      <button
        onClick={() => setKids([...kids, emptyRow(nextUnusedColor([...kids, ...parents].map((r) => r.color)))])}
        className="btn-soft h-14 text-xl"
      >
        + Another kid
      </button>
      {editors("parent", parents, setParents)}
      <button
        onClick={() =>
          setParents([...parents, emptyRow(nextUnusedColor([...kids, ...parents].map((r) => r.color), PARENT_COLOR_ORDER))])
        }
        className="btn-soft h-14 text-xl"
      >
        + Another parent
      </button>
      <label className="flex items-center gap-3 text-xl font-bold">
        <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} className="h-7 w-7" />
        I understand this removes everyone above and their history
      </label>
      <Field label="Parent PIN" value={pin} onChange={setPin} type="password" />
      <Status error={error} saved="" />
      <div className="flex gap-3">
        <button
          onClick={() => void replace()}
          disabled={!sure || !pin || busy}
          className="h-16 flex-1 rounded-card bg-ember text-2xl font-extrabold text-white disabled:opacity-50"
        >
          {busy ? "Replacing…" : "Replace the family"}
        </button>
        <button onClick={() => setOpen(false)} className="btn-soft h-16 px-8 text-2xl">
          Cancel
        </button>
      </div>
    </div>
  );
}

# Skills (plugins): design

> **Status: Proposal, not implemented yet.** Nothing on this page exists in the code. Names, file layouts and APIs may change before the first skill ships. Open an issue labeled `skill/plugin` to discuss it.

A **skill** is a small add-on that gives Sproutwall a new card, tab, daily job or Ask the Hub source. Examples: a piano practice timer, a quiz of the day, a chore rotation. The goal is that a contributor can add a skill without touching the core app, and a parent can see exactly what a skill may do before turning it on.

## Prerequisites

Skills need a stable core API first. Two changes come before any skill work:

1. **Members as data.** Household members live in a `members` table (`src/lib/household.ts`) instead of hardcoded TypeScript lists. Done.
2. **Domain modules.** `src/lib/queries.ts` is split into modules per domain (routines, rewards and ledger, reading, meals, calendar, settings, Ask). Planned after launch.

## Goals

- Contributors can add a feature as a self-contained folder, with its own tests, without editing core files.
- Parents decide per household which skills are on. Every skill is off by default.
- Before a parent turns a skill on, the hub shows what data it can read or change, which internet hosts it contacts, and which third parties receive any child data.
- A skill's data can be deleted on its own.
- A family device never runs code downloaded at runtime.

## Non-goals

- **No runtime download.** There is no skill store, no "install from URL", and no code loaded from the database or the network.
- **No sandbox in v1.** Skills are TypeScript compiled into the app and run in the same Node.js process. The permission model is enforced by review, lint rules, CI and the narrow `ctx` API, not by process isolation. A malicious skill that passed review could do anything the app can. Review is the security boundary.
- **No direct database access.** Skills do not get the SQLite handle or core tables.
- **Not a theme system.** Skills add features; they do not restyle the app.

## How it fits together

```text
skills/
  _template/          starting point for a new skill
  practice-timer/
    skill.json        manifest: identity, permissions, settings, slots
    index.ts          defineSkill({ setup, routes, cards, jobs })
    tests/            the skill's own Vitest tests
```

At build time the app discovers the folders under `skills/`, validates each manifest, and registers the skill's cards, routes and jobs. At runtime, a skill does nothing until a parent enables it.

## The manifest (`skill.json`)

| Field | Meaning |
| --- | --- |
| `id` | Lowercase id, unique, matches the folder name |
| `name`, `description` | Shown to parents in the enable dialog |
| `version` | Semver. Bump it when the manifest or stored data changes. |
| `author` | GitHub handle of the skill owner |
| `permissions.network` | Allowlist of hosts the skill may fetch, for example `["api.example.org"]`. Empty means no network. |
| `permissions.data` | Data scopes the skill needs, for example `members:read`, `routines:write`, `ledger:award` |
| `settings` | Schema for the skill's settings form. Fields marked `secret` are never sent back to the browser. |
| `slots` | Where it appears: `today-card`, `kid-tab`, `ask-source`, `daily-job` |
| `sendsChildDataTo` | Third parties that receive any child data. Empty list if none. Required, even when empty. |

Example:

```json
{
  "id": "practice-timer",
  "name": "Practice timer",
  "description": "A timer for piano or language practice that awards points when a session is done.",
  "version": "0.1.0",
  "author": "example-contributor",
  "permissions": {
    "network": [],
    "data": ["members:read", "ledger:award"]
  },
  "settings": {
    "minutes": { "type": "number", "default": 15, "min": 5, "max": 60 },
    "points": { "type": "number", "default": 5, "min": 0, "max": 50 }
  },
  "slots": ["kid-tab"],
  "sendsChildDataTo": []
}
```

## Permission model

**Data scopes.** Each scope unlocks one group of `ctx` methods. A skill gets only the methods for the scopes it declares.

| Scope | Allows |
| --- | --- |
| `members:read` | Read members: id, first name, role, age band, color |
| `routines:read`, `routines:write` | Read routines; add or check off routine items |
| `ledger:award` | Award points through the audited ledger. No deductions, no redemptions. |
| `calendar:read` | Read the merged calendar for a date range |

The list grows only by maintainer review. Parent-only powers (redeeming rewards, changing rules, settings, the PIN) are never available to skills.

**Network.** `ctx.fetch` accepts only hosts in `permissions.network`. It goes through the same guard the core uses for calendars and covers (`safeGet` in `src/lib/safe-fetch.ts`): public addresses only, a size cap and a timeout.

**Third parties and child data.** If any member data, or anything a child typed, leaves the machine, the receiving service must be listed in `sendsChildDataTo`. The enable dialog shows that list in plain words.

**Who can use a skill's routes.** Skill routes sit behind `src/proxy.ts` like every other route: an unlocked screen for reads, and the parent PIN for writes unless the skill's route is declared kid-safe and a maintainer agrees.

**Enforcement.**

- At runtime: `ctx` exposes only the granted methods, and `ctx.fetch` checks hosts.
- In CI: the manifest is validated, and a check compares the `ctx` calls in the skill's code with its declared permissions.
- In lint: code under `skills/` may not import core internals (`@/lib/db`, `@/lib/queries`), `node:fs`, `node:child_process` or `node:net`, or call the global `fetch`.

## The context API (`ctx`)

Sketch only:

```ts
interface SkillContext {
  skillId: string;
  storage: {
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T): void;
    delete(key: string): void;
  };
  members?: { list(): Member[]; get(id: string): Member | undefined }; // members:read
  awardPoints?(kidId: string, amount: number, reason: string): void;   // ledger:award
  fetch?(url: string, init?: SafeFetchInit): Promise<SafeResponse>;    // permissions.network
  settings: Record<string, unknown>;                                   // validated against the schema
  log(message: string): void;                                          // never logs child data
}

export default defineSkill({
  setup(ctx) {},
  routes: {},  // mounted under /api/skills/<id>/...
  cards: {},   // React components for the declared slots
  jobs: {},    // e.g. { daily: (ctx) => ... }
});
```

- **Storage** is namespaced: one `skill_data` table keyed by skill id. A skill cannot read another skill's rows.
- **Members** are read-only.
- **`awardPoints`** writes through the same ledger as the core app, with the skill id recorded as the source.
- **Jobs** run on the hub's schedule (for example once a day), only while the skill is enabled.
- **Settings** come from a form the hub generates from the manifest's schema.

## Lifecycle

1. **Build.** The skill's folder is in the repository. The build validates its manifest and compiles it in.
2. **Enable.** A parent turns it on in parent settings. The dialog shows the description, data scopes, network hosts and `sendsChildDataTo`. Enabling needs the parent PIN.
3. **Setup.** `setup(ctx)` runs once on enable and again after each start of the hub.
4. **Run.** Cards render in their slots; routes answer; jobs run on schedule.
5. **Disable.** Cards, routes and jobs stop. Stored data stays, so turning it back on loses nothing.
6. **Delete data.** A separate parent action removes the skill's rows from `skill_data` and its settings.
7. **Upgrade.** A new `version` may migrate the skill's own stored data. A version that asks for new permissions stays off until a parent approves them.

## Kids' data rules

These apply to every skill and are checked in review:

- Store only what the feature needs. Prefer an age band to an exact age, and a member id to a name.
- Nothing about a child leaves the machine unless the receiving service is in `sendsChildDataTo`, the parent saw it in the enable dialog, and the README entry for the skill says what is sent.
- No analytics, tracking or advertising services. No third-party scripts in the browser.
- No free-text input from children sent to third parties without that being the skill's stated purpose.
- Logs never contain names, ages, questions or anything a child typed.
- A skill's data must be deletable with its delete action.

## Contributing a skill

1. Open an issue labeled `skill/plugin` with what the skill does and which permissions it needs. Agree on scope before writing code.
2. Copy `skills/_template/` to `skills/<your-id>/`.
3. Fill in `skill.json`, write `index.ts`, and add tests in the skill's `tests/` folder.
4. Open a pull request. CI validates the manifest, checks the declared permissions against the `ctx` calls, and runs the skill's tests.
5. Review: the skill owner (you) is listed in `CODEOWNERS` for your folder. Any change to the core still needs a maintainer review, and a new skill needs a maintainer review too.

Good first skills use only existing APIs and need no network, for example a piano or language practice timer, or a quiz of the day from a fixed list.

## v1 and v2

| | v1 | v2 |
| --- | --- | --- |
| Where skills live | In this repository, `skills/<id>/` | Also npm packages named `sproutwall-skill-*` |
| How they are added | Merged by pull request | Installed by the parent at build time, then the image is rebuilt |
| Runtime download | Never | Never |
| Manifest | `skill.json` | The same manifest, inside the package |
| Review | Maintainer and skill owner | The package author; the parent decides to install |

v2 starts only after v1 has shipped several skills and the API has held still.

## Open questions

- **Routes in the App Router.** Next.js needs route files at build time. One catch-all route (`/api/skills/[id]/[...path]`) that dispatches to skills, or generated route files?
- **Permission checks in CI.** Is a TypeScript-level check (the `ctx` type narrowed by the manifest) enough, or is an AST check needed?
- **Ask sources.** An `ask-source` skill could add text to Ask the Hub prompts. How do we show parents what extra data reaches the model?
- **Per-kid enable.** Should a parent be able to turn a skill on for one child only?
- **Secrets.** Where do secret settings live, and how are they kept out of backups shared for support?
- **Review load.** With one maintainer, how many skills can be reviewed well? Do we need a small group of skill reviewers first?
- **v2 supply chain.** How do we verify npm packages (provenance, lockfile pinning) before suggesting v2?

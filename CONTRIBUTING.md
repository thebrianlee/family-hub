# Contributing

Family Hub is a small self-hosted app. Changes should stay understandable to a reviewer who has not seen the screen before.

## Setup

```bash
npm ci
cp .env.example .env
npm run dev
```

Open http://127.0.0.1:3847. The first page asks you to name the household and choose a PIN. You can keep the sample Calder family.

## Checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
node scripts/check-pii.mjs
```

A CI workflow is not active yet; `docs/ci/github-ci.yml` holds a draft.

## Data and secrets

- Do not commit `.env`, `data/`, or pictures from `photos/`.
- Do not put real names, schools, calendar links, tokens, or home addresses in issues, fixtures, or prompts.
- The sample family (seeded in `src/lib/db.ts`) is fictional. Keep it that way.
- The assistant prompt lives in `bridge/prompt.mjs`. It must not grow a specific household inside the source.

## Product notes

- People, colors, and roles are stored in the database, not in TypeScript types named after a person.
- Calendars are iCal URLs. There is no desktop calendar command-line sync.
- Photos are a folder on disk. There is no cloud photo sync.
- Weather comes from Open-Meteo.

## Pull requests

Describe what changed and how you tried it. Screenshots of the sample family are welcome. Screenshots of a real household are not.

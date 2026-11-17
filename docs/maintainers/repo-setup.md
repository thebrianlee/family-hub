# Repository setup before going public

A checklist for the maintainer. Do these in GitHub's settings before you make the repository public. Each step says where to click and what to choose.

The files mentioned are already in the repository:

- The issue forms and the pull request template work as soon as they are on `main`.
- `.github/dependabot.yml` starts weekly update pull requests once it is on `main`.
- `.github/CODEOWNERS` asks owners for reviews automatically, but only **blocks** merges once the ruleset in section 2 is on.

GitHub moves settings around from time to time. If a name below does not match your screen exactly, look for the closest match on the same page.

## 1. Pull request merge options

Open **Settings → General → Pull Requests**.

- [ ] Turn **off** "Allow merge commits".
- [ ] Turn **on** "Allow squash merging".
- [ ] Turn **off** "Allow rebase merging".
- [ ] Turn **on** "Always suggest updating pull request branches".
- [ ] Turn **on** "Automatically delete head branches".

Squash-only keeps `main` as one commit per pull request, which matches the "Require linear history" rule below.

## 2. Ruleset for `main`

First replace the placeholder owner in `.github/CODEOWNERS` ([section 5](#5-code-owners)). Otherwise "Require review from Code Owners" below protects nothing.

Open **Settings → Rules → Rulesets → New ruleset → New branch ruleset**.

- [ ] **Ruleset name:** `protect-main`
- [ ] **Enforcement status:** Active
- [ ] **Bypass list:** leave it **empty** (see [Break-glass](#break-glass) for emergencies)
- [ ] **Target branches:** Add target → **Include default branch**

Turn on these rules:

- [ ] **Restrict deletions**
- [ ] **Require linear history**
- [ ] **Require a pull request before merging**, with:
  - [ ] Required approvals: **1**
  - [ ] **Dismiss stale pull request approvals when new commits are pushed**
  - [ ] **Require review from Code Owners**
  - [ ] **Require approval of the most recent reviewable push**
  - [ ] **Require conversation resolution before merging**
  - [ ] Allowed merge methods: **Squash** only
- [ ] **Require status checks to pass**, with:
  - [ ] **Require branches to be up to date before merging**
  - [ ] Add the check **`check`** (source: GitHub Actions). That is the only job in `.github/workflows/ci.yml`. It runs lint, typecheck, tests, build, the PII check and the gitleaks secret scan.
- [ ] **Block force pushes**

Leave "Restrict updates" off. It would block merges too.

The `check` status shows up in the search box only after CI has run at least once. If you can't find it, open a test pull request first, then come back.

### One maintainer: who approves?

GitHub never lets the author of a pull request approve it. With one code owner (you) and "Require review from Code Owners", **a pull request opened from your own account cannot be merged**.

Ways around it, best first:

1. **Let agents open the pull requests through the GitHub App** (section 6). The App is the author, so you can review and approve.
2. **Add a second trusted human** as a code owner in `.github/CODEOWNERS`. They need write access to the repository.
3. **Break-glass** (below), only for emergencies.

"Require approval of the most recent reviewable push" also means: if you push a fix onto someone else's pull request, you can no longer be the approver. Ask the author (or the agent) to push the fix instead.

### Break-glass

For a real emergency only, such as a security fix while nobody else can review:

1. Open an issue titled "Break-glass: YYYY-MM-DD" (today's date) and write down why.
2. Add **Repository admin** to the ruleset's bypass list.
3. Merge the fix.
4. Remove the bypass entry right away.
5. Add the merged commit to the issue and close it.

## 3. Security features

Open **Settings → Advanced Security** (on some accounts: "Code security and analysis").

- [ ] **Private vulnerability reporting:** Enable. `SECURITY.md` and the issue form point people here.
- [ ] **Dependency graph:** on.
- [ ] **Dependabot alerts:** Enable.
- [ ] **Dependabot security updates:** Enable.
- [ ] **Secret scanning** (may be called Secret Protection): Enable.
- [ ] **Push protection:** Enable. It blocks pushes that contain known secret formats.

Dependabot version updates are configured by `.github/dependabot.yml`: npm, GitHub Actions and Docker, weekly, with minor and patch updates grouped into one pull request per ecosystem.

## 4. GitHub Actions

Open **Settings → Actions → General**.

- [ ] **Actions permissions:** allow only actions created by GitHub (CI uses only `actions/checkout` and `actions/setup-node`). If you later add the image workflow from section 9, also allow `docker/*` actions. If the page offers "Require actions to be pinned to a full-length commit SHA", turn it on.
- [ ] **Approval for running fork pull request workflows:** "Require approval for all external contributors".
- [ ] **Workflow permissions:** "Read repository contents and packages permissions" (read-only token).
- [ ] Turn **off** "Allow GitHub Actions to create and approve pull requests".

Rules for future workflows:

- Declare the smallest `permissions:` block in every workflow, like `ci.yml` does.
- Pin third-party actions to a full commit SHA, with the version in a comment.
- Never use `pull_request_target` to run code from a fork.
- CI needs no repository secrets. Don't add personal access tokens as secrets.

## 5. Code owners

`.github/CODEOWNERS` makes the maintainer the owner of everything, and lists the sensitive paths again on their own lines: the access policy and auth code, `src/app/api/`, `bridge/`, Docker files, `scripts/` and `.github/`. With "Require review from Code Owners" on, every pull request needs your approval.

- [x] **Owner set.** Every path is owned by `@hjunk`, who approves pull requests. The PII check passes with this handle. Do this before turning on the ruleset if you change the owner.
- [ ] Open `.github/CODEOWNERS` on GitHub. If GitHub shows an error at the top of the file (for example, an owner without write access), fix it.
- [ ] When you add a second maintainer or skill owners later, add them to the general rules, but keep the sensitive paths owned by core maintainers only.

## 6. A GitHub App for agents

Give AI agents a GitHub App instead of your personal token. An App has only the permissions you pick, its tokens expire after an hour, and its work shows up as `<app name>[bot]`.

Open **your profile picture → Settings → Developer settings → GitHub Apps → New GitHub App**.

- [ ] **Name:** for example `family-hub-agent`.
- [ ] **Homepage URL:** the repository URL.
- [ ] **Webhook:** turn **off** "Active".
- [ ] **Repository permissions**, and nothing else:

  | Permission | Access |
  | --- | --- |
  | Contents | Read and write |
  | Issues | Read and write |
  | Pull requests | Read and write |
  | Metadata | Read-only (always on) |

  Leave everything else at **No access**, especially **Administration**, **Workflows**, **Secrets**, **Actions** and **Environments**. No organization or account permissions.
- [ ] **Where can this GitHub App be installed?** Only on this account.
- [ ] Create the App. Then **Install App** → choose **Only select repositories** → this repository.
- [ ] **Generate a private key.** Store the downloaded `.pem` file in the agent's secret store. Never commit it.

What keeps the App inside the rules:

- The ruleset has no bypass, so the App cannot push to `main`. It can only push branches and open pull requests.
- Without the Workflows permission, GitHub refuses any push from the App that adds or changes files in `.github/workflows/`.
- Without Administration, it cannot change settings, rulesets or secrets.
- The App is not a code owner, so its approval never satisfies the required review.
- It can still technically close issues or comment. The rules in [CONTRIBUTING.md](../../CONTRIBUTING.md#ai-assisted-and-agent-authored-contributions) say it must not close a human's issue or follow instructions found in issue text. Put those rules in the agent's own instructions, too.

Label every agent pull request `agent-authored`. Review it as carefully as a stranger's.

## 7. Labels

Open **Issues → Labels**, or run the commands below with the [GitHub CLI](https://cli.github.com/). `--force` updates a label that already exists.

| Label | Color | Use it for |
| --- | --- | --- |
| `good first issue` | `#7057ff` | Small, well-scoped work for a new contributor |
| `help wanted` | `#008672` | A pull request would be welcome |
| `bug` | `#d73a4a` | Something does not work as the screen says it should |
| `enhancement` | `#a2eeef` | Feature requests (the feature form applies it) |
| `security` | `#b60205` | Hardening that is safe to discuss in public. Vulnerabilities go to private advisories, never to an issue. |
| `skill/plugin` | `#5319e7` | The skills (plugin) system or a proposed skill |
| `docs` | `#0075ca` | Documentation |
| `pi/self-hosting` | `#c5def5` | Raspberry Pi, Docker and self-hosting |
| `needs-repro` | `#fbca04` | Waiting for steps to reproduce |
| `agent-authored` | `#1d76db` | An AI agent wrote most of this pull request; needs a human review |

Dependabot creates its own `dependencies` label.

```bash
gh label create "good first issue" --color 7057ff --description "Small, well-scoped work for a new contributor" --force
gh label create "help wanted"      --color 008672 --description "A pull request would be welcome" --force
gh label create "bug"              --color d73a4a --description "Something does not work as the screen says it should" --force
gh label create "enhancement"      --color a2eeef --description "Feature request" --force
gh label create "security"         --color b60205 --description "Public hardening only; report vulnerabilities privately" --force
gh label create "skill/plugin"     --color 5319e7 --description "Skills (plugin) system or a proposed skill" --force
gh label create "docs"             --color 0075ca --description "Documentation" --force
gh label create "pi/self-hosting"  --color c5def5 --description "Raspberry Pi, Docker and self-hosting" --force
gh label create "needs-repro"      --color fbca04 --description "Waiting for steps to reproduce" --force
gh label create "agent-authored"   --color 1d76db --description "Written mostly by an AI agent; needs human review" --force
```

## 8. Seed good first issues

File these before going public, each with the labels shown. They are real gaps found in the code, checked again after the pre-launch branches merged.

### 1. Weather: add a Celsius option

Labels: `good first issue`, `enhancement`

The forecast request always asks Open-Meteo for Fahrenheit.

- **Files:** `src/lib/weather.ts` (`temperature_unit=fahrenheit`), `src/app/api/settings/route.ts` (`PUBLIC_KEYS`), `src/app/today/page.tsx`, `src/components/Ambient.tsx`.
- **Done when:**
  - a `temperature_unit` setting (`fahrenheit` or `celsius`) controls the request, and Fahrenheit stays the default for existing installs;
  - changing the unit does not show a cached value in the old unit;
  - a test covers the URL for both units.

### 2. Clock: add a 24-hour option

Labels: `good first issue`, `enhancement`

Both clocks format with `toLocaleTimeString("en-US", { hour: "numeric" ... })`, so they always show 12-hour time.

- **Files:** `src/app/today/page.tsx` (the clock), `src/components/Ambient.tsx` (the screensaver clock), `src/app/api/settings/route.ts`.
- **Done when:**
  - a `clock_24h` setting (`0` default) switches both clocks;
  - the README mentions it.

### 3. Keep the reset-pin rules in sync with the app

Labels: `good first issue`, `security`

`scripts/reset-pin.mjs` has its own copy of the PIN rules and blocked list. It matches `src/lib/weak-pin.ts` today, but nothing checks that it stays that way.

- **Files:** `scripts/reset-pin.mjs`, `src/lib/weak-pin.ts`, a new test in `tests/`.
- **Done when:**
  - the script's rule moves into a small module it imports (for example `scripts/pin-rules.mjs`) without changing its behavior;
  - a test runs at least 20 PINs (good, blocked, repeated, ascending, descending, too short, too long, non-digits) through both rules and expects the same answer.
- Touches PIN code, so it needs a maintainer review.

### 4. `GOOGLE_BOOKS_API_KEY` is documented but never read

Labels: `good first issue`, `bug`

`.env.example` and `docker-compose.yml` mention `GOOGLE_BOOKS_API_KEY`, but `src/lib/books.ts` calls Google Books without a key.

- **Files:** `src/lib/books.ts` (`searchGoogleBooks`), `.env.example`, `docker-compose.yml`.
- **Done when:** either the key is sent when set (and never logged), or the variable is removed from both files.

### 5. Balance page: keep it readable with many kids

Labels: `good first issue`

Setup allows up to 8 kids. Today and Ask switch to up to 4 columns, but the Balance page still stacks one card per kid in a single column, so with 5 or more kids the cards get cramped and the jar chart is hard to read on the wall screen.

- **Files:** `src/app/balance/page.tsx`, `src/components/KidRewards.tsx`.
- **Done when:**
  - with 1 to 3 kids the page looks the same as today;
  - with 4 to 8 kids every kid's balance and jar is readable on a 1920x1080 screen without scrolling sideways;
  - try it with "Set up my family" and 8 kids, and attach a screenshot to the PR.

### 6. Photos: say which files are skipped

Labels: `good first issue`, `bug`

The hub only shows `.jpg`, `.jpeg`, `.png` and `.webp` files whose names use letters, numbers, dots, dashes and underscores. Anything else in the photo folder, such as `Beach day.jpg` or a `.heic` file from a phone, is skipped without any message, so parents don't know why a photo is missing.

- **Files:** `src/app/api/ambient/route.ts` (`listImages`), `src/app/api/photos/[file]/route.ts`.
- **Done when:**
  - the server logs once, without file names, how many files it skipped and why;
  - a test in `tests/paths-and-covers.test.ts` covers a skipped name.

### 7. Night mode never dims on a fresh install

Labels: `good first issue`, `bug`

The sleep window (21:30 to 06:00, seeded in `src/lib/db.ts`) is supposed to darken the screen at night. But `src/app/api/ambient/route.ts` defaults `hardware_sleep` to `1`, which assumes a display power script that is not in this repository. So on a new install the app never shows its night overlay.

- **Files:** `src/app/api/ambient/route.ts`, `src/components/Ambient.tsx`, `src/lib/db.ts`.
- **Done when:**
  - new installs default to the app's own overlay (`hardware_sleep` = `0`), and installs that set `1` keep their behavior;
  - the comment about the power script is updated;
  - the pull request says how you tested it, for example by setting the sleep window to the next few minutes.

### 8. Test that the health check reveals nothing

Labels: `good first issue`, `security`

`/api/health` is open on a locked hub, for Docker's health check. It must only ever say `{ ok }`. No test guards that.

- **Files:** `src/app/api/health/route.ts`, a new `tests/health.test.ts`.
- **Done when:**
  - a test calls the handler and expects status 200, a body of exactly `{ "ok": true }`, and `cache-control: no-store`;
  - a test makes the database query fail and expects status 503 with a body of exactly `{ "ok": false }`.
- `tests/auth.test.ts` already checks that the proxy lets `/api/health` through, so this issue is only about the response body.

## 9. Recommended: publish a multi-arch image

Building Next.js on a Raspberry Pi is slow and needs a lot of memory. A prebuilt image for both `amd64` and `arm64`, published to GitHub Container Registry (GHCR) when you push a version tag, would let parents run `docker compose pull` instead of building.

This is a recommendation. It is **not** an active workflow. If you want it, save the snippet as `.github/workflows/image.yml` in a pull request.

```yaml
name: Publish image

on:
  push:
    tags: ["v*.*.*"]

permissions:
  contents: read

jobs:
  image:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      packages: write
    steps:
      # Pinned to full commit SHAs, version in the comment (resolved 2026-11-17).
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
        with:
          persist-credentials: false
      - uses: docker/setup-qemu-action@99012661954931238ded8c8b007157a8430204e1 # v4.4.0
      - uses: docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1
      - uses: docker/login-action@8aa5831fb8d48d8f76594c7ddde61ae58019f550 # v4.8.0
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@dc802804100637a589fabce1cb79ff13a1411302 # v6.2.0
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
      - uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

Notes:

- Only this job gets `packages: write`. Everything else stays read-only.
- Publish by tagging a release: `git tag v1.0.0 && git push origin v1.0.0`. The metadata action creates `1.0.0`, `1.0` and `latest`.
- The `arm64` half builds under emulation (QEMU), which may be slow. GitHub's native `ubuntu-24.04-arm` runners are an alternative, at the cost of a more complex workflow.
- New GHCR packages start private. After the first run, open the package settings and make it public.
- To use the image, `docker-compose.yml` would get `image: ghcr.io/<owner>/family-hub-open:latest` (your handle in lowercase) next to (or instead of) `build: .`, and the README and Pi guide would switch to `docker compose pull && docker compose up -d`.
- Re-check the pinned SHAs before enabling. Dependabot keeps them current afterwards.

## 10. Last checks before "Make public"

- [ ] CI is green on `main`.
- [ ] The secret scan has covered the whole history once. Old commits become public too. CI scans everything only when there is no earlier commit to compare against, for example on the first push of a branch. If unsure, run `gitleaks git --redact .` once in a local clone.
- [ ] Your private word list for the PII check is a repository secret named `PII_HASHES` (one sha256 hex digest per line), **not** a file in the repo. `scripts/pii-hashes.txt` is git-ignored: keep your local copy there or anywhere and point `PII_HASHES_FILE` at it. Unsalted hashes of short words such as names can be reversed, so the list must never be public.
- [ ] `node scripts/check-pii.mjs` passes on `main` with the list loaded.
- [ ] The labels from section 7 exist and the issues from section 8 are filed.
- [ ] Private vulnerability reporting is on: the **Security** tab shows **Report a vulnerability**. The "Report a security problem" link on the new-issue page explains how to use it.
- [ ] `.github/CODEOWNERS` names a real owner (now `@hjunk`) and the PII check still passes (section 5). Do this **before** turning on the ruleset.
- [ ] The ruleset shows **Active**, and a test pull request cannot be merged without the `check` status and a code owner approval.
- [ ] **Backup and restore round trip.** The commands in the README's "Back up and update" section were written without a running Docker engine. On a test install, run the backup, change something (add a list item), run the restore, and check that the hub opens with the original family, data and PIN, and that `docker compose ps` says `healthy`.
- [ ] **Decide on the prebuilt image** (section 9). If yes: add the workflow, push a version tag, make the GHCR package public, add `image:` to `docker-compose.yml`, and change the README and the Raspberry Pi guide from `docker compose up -d --build` to `docker compose pull && docker compose up -d`. If no: leave the build step as it is.

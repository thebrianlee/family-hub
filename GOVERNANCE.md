# Governance

Sproutwall is a small open-source project. This page says who decides what, and how a change gets into `main`.

## People and accounts

| Who | Role |
| --- | --- |
| [@thebrianlee](https://github.com/thebrianlee) | Founder and repository owner. Product direction and repository settings. |
| [@hjunk](https://github.com/hjunk) | Maintainer. The human who reviews code and merges it. |
| AI agents | Write code, review each other's work, triage issues and summarize pull requests for the maintainer. They use models from more than one vendor, so a change is never reviewed by the same kind of model that wrote it. |
| [@ari-hjunk](https://github.com/ari-hjunk) | The maintainer's agent reviewer account. It approves only pull requests opened from @hjunk, after an independent agent review has passed. It never pushes code. |

## How a change gets into `main`

Every change is a pull request. `main` is protected: the `check` CI job must pass, pull requests are squash-merged, history stays linear, and nobody can force-push.

Who approves depends on who opened the pull request:

- **Contributors and Dependabot.** @hjunk reviews and approves. Agents may comment with findings, but they never approve these pull requests.
- **The maintainer's agents** (opened from @hjunk). GitHub won't let @hjunk approve his own pull request, so:
  1. An AI review runs on the exact head commit. It is done by a model from a different vendor than the one that wrote the change.
  2. If it passes, @ari-hjunk approves that commit. The approval goes through a fixed script that refuses forks, other authors, changes to `.github/` or this file, a failing `check` and missing reviews (see [repo-setup.md, section 2](docs/maintainers/repo-setup.md#2-ruleset-for-main)). A later push cancels the approval.
  3. @hjunk reads the review and merges.

  An @ari-hjunk approval means "an independent agent review passed at this commit". It is not a human review.
- **Changes to `.github/` and to this file** (CI workflows, CODEOWNERS, these rules). These always get @hjunk's own review. If @hjunk opened the pull request, the repository owner merges it through the documented [break-glass path](docs/maintainers/repo-setup.md#break-glass), after @hjunk names the pull request and its commit in writing.

What GitHub enforces and what the project promises:

- GitHub enforces the CI check and an approval from a code owner.
- GitHub does not limit which pull requests @ari-hjunk may approve outside `.github/` and this file. The fixed script and this page do.
- GitHub does not enforce who clicks merge. "@hjunk merges" is a project rule.

## Decisions

- **Code, reviews and merges:** @hjunk.
- **Product direction, naming, licensing and repository settings:** @thebrianlee and @hjunk together.
- **Changes to this file:** both of them. CODEOWNERS requires @hjunk's own approval; @thebrianlee's agreement is a project rule.

## Releases

There are no releases yet. Before the first one, a RELEASING.md file will describe how versions are numbered, how a release is made and which versions get security fixes.

## Becoming a maintainer

Contribute for a while and review other people's pull requests carefully. The maintainers may then invite you. A new maintainer gets write access and is added to `.github/CODEOWNERS`.

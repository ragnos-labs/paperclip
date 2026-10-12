# RAGnos internal development

This fork serves one operator's internal stack. Use a short-lived branch and
one pull request per logical change. Search for overlapping work, preserve
unrelated changes, and describe the change, verification and risks in the
existing PR template. No separate issue, Discord discussion, review-bot score
or independent approval is required for an authorized internal change.

Run focused tests while editing. Run `pnpm check` once for the final candidate;
it uses the existing local typecheck, Vitest and build commands. Browser suites
remain opt-in for changed browser behavior. Documentation-only changes need
link and instruction checks. Do not repeat passed checks on unchanged inputs.

Commit the lockfile with intentional dependency changes and install with
`pnpm install --frozen-lockfile`. Use `pnpm check:dependencies` for production
dependency changes; retain the existing advisory baseline and investigate any
new finding. Routine Dependabot version-update PRs are disabled; security
updates and alerts remain available. Custom GitHub Actions are retired.

Internal deployment uses one image for the actual target architecture, selected
by digest. Preserve a verified backup, update only the affected service, check
health and one representative user path, and retain the prior image for rollback.
No npm publication, GitHub prerelease, platform matrix, SBOM/provenance, typed
confirmation or release-environment approval is required. Existing release
assets remain available for recovery. See [local image delivery](doc/RAGNOS-ALPHA-RELEASE.md).

Company isolation, authorization, budget controls, activity logging and data
recovery remain mandatory. Source delivery does not itself deploy or migrate
a database. [AGENTS.md](AGENTS.md) owns product and API invariants.

Contributions to the upstream `paperclipai/paperclip` project follow its own
current contribution policy; that policy does not gate this internal fork.

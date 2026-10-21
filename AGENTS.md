# AGENTS.md — Fluent API

## Docs

See `docs/README.md` for the docs directory convention. Brainstorming and
writing-plans skill output goes to `docs/features/<slug>/`
(`proposal.md`/`design.md`/`plan.md`/`tickets/`), not the skill's built-in
`docs/superpowers/...` default.

## Code standards

Rules with IDs (`FA-L*` lint, `FA-C*` CI, `FA-R*` review) are in
`docs/guides/code-standards.md`. Read it before writing code in `src/`. Before opening a PR
or marking one ready, follow `.claude/skills/pre-pr-standards/SKILL.md`: `npm run verify`,
then a verdict for every `FA-R` rule.

## Agent skills

### Issue tracker

Issues are tracked as GitHub issues in this repo (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

# TTS licence ingestion — plan

See [design.md](design.md) for the decisions. Intended implementer: Joshua.
Each ticket below becomes one GitHub issue in the repo that owns the code
(per `fluent-platform/docs/guides/ticket-workflow.md`): add it to the **Fluent**
board (project #4) at `In Progress (Product)`; the lead confirms the QA path at
`Product Ready`.

All work happens on (or branches from) the `feat/tts-licence-ingestion` branch in each repo, which carries this plan, the design and ADR 0003; PRs target that branch, and it merges to `main` per phase.

| #     | Ticket                                                                                                                                               | Repo       | Phase | Blocked by                         | Suggested labels                            | QA path   | Priority |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----- | ---------------------------------- | ------------------------------------------- | --------- | -------- |
| API-1 | [DBL sync writes text-Bible licence facts](tickets/2026-10-20-api-1-dbl-sync-licence-facts.md)                                                       | fluent-api | 1     | —                                  | `enhancement`, `ready-for-agent`            | `DevQA`   | P0       |
| API-2 | [All-rights-reserved sweep](tickets/2026-10-20-api-2-all-rights-reserved-sweep.md)                                                                   | fluent-api | 1     | API-1                              | `enhancement`, `ready-for-agent`            | `DevQA`   | P0       |
| WEB-1 | [Licence message in audio settings](../../../../fluent-web/docs/features/tts-licence-ingestion/tickets/2026-10-20-web-1-settings-licence-message.md) | fluent-web | 1     | — (meaningful once API-1 is on QA) | `enhancement`, `web-app`, `ready-for-agent` | `Full QA` | P1       |
| API-3 | [AI licence classification pass](tickets/2026-10-20-api-3-ai-licence-classification-pass.md)                                                         | fluent-api | 2     | API-1 run on prod                  | `enhancement`, `ready-for-human`            | `DevQA`   | P1       |
| API-4 | [Licence classifications + derived status (deny-by-default)](tickets/2026-10-20-api-4-licence-classifications-derived-status.md)                     | fluent-api | 2     | API-3                              | `enhancement`, `ready-for-agent`            | `DevQA`   | P1       |

## Sequencing

```
Phase 1 (summit)                     Phase 2
API-1 ──► API-2 ──► run on dev/QA/prod ──► API-3 (offline AI pass, human review)
WEB-1 (parallel)                                  │
                                                  ▼
                                            API-4 (table + data + derived sync)
```

- **API-1 + API-2 ship together** in one release. Deployment task, at
  `Passed QA` → `To Deploy`: run `npm run db:sync:dbl` against QA, then prod,
  after the release lands. The sweep runs as the sync's last step, so no
  separate command can be forgotten.
- **API-3 needs prod's real notices**, so it starts after Phase 1 has run on prod.
- **API-4 must not deploy without API-3's reviewed data.** Derived status turns
  every unclassified notice into `unknown`; shipping the code without the data
  would switch TTS off for every Bible. API-4's migration loads the data.

## Out of scope

Server-side enforcement on `/ai/tts/generate`, the public takedown notice,
YouVersion secondary Bibles — see design.md § Follow-ups.

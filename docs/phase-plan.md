# RaidSphere phase plan and progress

As of 2026-10-27. Phase 1 is complete and merged into `main`, which is the base for all later work. Next: every module owner branches from `main`, and the team starts Phase 2 (local MVP).

## Current status

| Area | Status and evidence |
| --- | --- |
| Codebase | Three workspaces: `shared/`, `server/`, and `overlay/`; strict TypeScript and npm workspaces. |
| Contracts | Zod 4 schemas and versioned events; F1–F5 included. Event names, fields, and rules unchanged. |
| Backend | Fastify; `/health` returns 200 with `no-store`; `/ws` returns 503 until authorization exists; typed error handler (V4). Listens only on `127.0.0.1`. |
| Overlay | Globe centered at load and after resizing (V5–V7); transparent background verified in a browser and in OBS 32.2.2 (~1% CPU at 30 FPS). |
| Dependencies | Lockfile included; `light-my-request` 6.6.0 override (V1), Vitest 4.1.12 (V2), Zod 4.6.7 (V3); `npm audit` 0 vulnerabilities (previously 4). |
| Checks | 63/63 tests (38 contract, 25 server), typecheck, and build pass, with no test modifications; repeated on `main` after the merge. |
| Version control | Phase 1 merged into `main` through PR #1 (`b89ed23`). `main` is the official base; `feature/project-foundation` (`4219a21`) is obsolete. |

This status is based on local verification, Git history, and [Phase 1 decisions](phase-1-decisions.md). Twitch, raids, translation, and deployment are not implemented yet.

Phase 2 backend decisions are recorded in [Phase 2 backend decisions](phase-2-backend-decisions.md).

## Development phases

| Phase | Goal and deliverable | Status |
| --- | --- | --- |
| Phase 0 — Definition | Proposal, MVP scope, modules A/B/C/D, architecture, and collaboration. | Essentially complete |
| Phase 1 — Foundation | Workspaces, contracts, minimal backend, static overlay, tests, and verification. | Complete; merged into `main` |
| Phase 2 — Local MVP | End-to-end roulette with synthetic channels, 30 s voting, selection, and a synchronized globe. | Next |
| Phase 3 — Real Twitch | OAuth, EventSub/chat, commands, eligibility, raid requests, and observed arrivals. | Pending |
| Phase 4 — AI translation | Bilingual messages, emote preservation, moderation, and the 15-minute window. | Pending |
| Phase 5 — Final integration | QA, OBS performance, security, demo, documentation, and hackathon submission. | Pending |

## Phase 1 close-out

- [x] Publish the verification branch with the lockfile (`64cd824`).
- [x] Review the diff and dependencies and merge with team approval (PR #1, merge `b89ed23` into `main`).
- [x] Make `main` the official base from Phase 1 onward.
- [x] Update `AGENTS.md`, `README.md`, and `docs/phase-1-decisions.md` so they name `main` as the base.
- [x] Re-run on `main` after the merge: `npm install --ignore-scripts` (lockfile unchanged), `npm audit` (0 vulnerabilities), typecheck, 63/63 tests, and build.

## Module assignments

| Module | Next responsibility | First deliverable |
| --- | --- | --- |
| A — Overlay and globe | Animations, languages, candidate selection, countdown, cards, and messages. Already included: V5–V7. | Show the roulette and results from simulated events. |
| B — Twitch | OAuth, chat/EventSub, commands, participating channels, and raids. | Typed adapter for events/requests; real integration later. |
| C — AI translation | Language detection, fragments/emotes, queue, expiry, moderation. | Translation interface and controlled simulation; real provider later. |
| D — Backend | Coordinator, sessions, candidates, votes, selection, and authorization. | Local roulette flow with authoritative state and agreed rules. |

## Decisions before parallel development

- **Public contracts:** require `sessionId` on raid errors; validate `roulette:chosen.toCountry` against the candidate; derive the language maximum from the enum instead of the number 7.
- **Business rules:** ties, zero votes, eligibility, streamer/moderator authorization, timeouts, and uncertain Twitch API outcomes.
- **Internal B/C/D contracts:** normalized chat, commands, arrival events, moderation, translation requests/results, and the Twitch adapter.
- **Access control:** the WebSocket and overlay must not subscribe to or control channels until authentication/authorization exists; never expose tokens in public events.
- **Compatibility:** everyone uses Zod 4 for new schemas (for example, `z.partialRecord`); keep the agreed public names and fields; keep the `light-my-request` override while on Node 20.18.

## Path to the first demonstrable MVP

| Milestone | Visible success criterion | Status |
| --- | --- | --- |
| M1 — Integrated base | Phase 1 reviewed and merged; docs, rules, and lockfile aligned. | Done |
| M2 — Controlled simulation | `!roulette` starts in local mode, voting lasts 30 s, and the backend counts valid votes. | Next |
| M3 — Connected overlay | The globe shows the session, languages, countdown, and chosen candidate from validated events. | Pending |
| M4 — Twitch integration | Real flow only for authorized participating channels; raid requests are distinguished from observed arrivals. | Pending |
| M5 — Translation and demo | Original/translated messages, 15-minute expiry, moderation, and demo rehearsal. | Pending |

Phases 2–5 and the milestone order are a recommended plan, not completed deliverables.

## Risks and priorities

| Priority | Risk | Response |
| --- | --- | --- |
| High | Mistaking the skeleton tests for functional tests of the roulette, Twitch, or translation. | Report implemented and verified work separately; those features do not exist yet. |
| High | Using outdated Twitch scopes or permissions. | Validate them before integrating OAuth or starting raids; limit to authorized participating channels. |
| Medium | Branching from the obsolete `feature/project-foundation` (`4219a21`). | Always branch from the latest `main`; that branch lacks V1–V7 and the lockfile. |
| Medium | ~2.04 MB overlay bundle (~578 kB gzip) and a low-contrast purple halo. | Code splitting and visual tuning in Module A. |
| Medium | npm over HTTPS failed in one environment. | It worked in the verification environment; never disable TLS or certificates. |
| Medium | SQLite and deployment undecided. | Not required for the synthetic local demo; decide later. |

## Next actions

1. **Whole team:** create module branches from `main` (`feature/globe-overlay`, `feature/twitch-integration`, `feature/ai-translation`, `feature/backend-core`) and agree on the three contract adjustments and the internal B/C/D contracts.
2. **A + D owners:** first build a local roulette with synthetic candidates and visible states on the globe (M2–M3).
3. **B + C owners:** prepare adapters and services against the contracts without blocking the initial prototype.

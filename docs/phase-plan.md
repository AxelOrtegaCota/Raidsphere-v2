# RaidSphere phase plan and progress

As of 2026-10-29. Phase 1 is complete and merged into `main`. Phase 2 (local MVP) is code complete and verified in a browser and in OBS, on `feature/phase4-translation`; it still needs a reviewed pull request into `main`. Phase 3 (real Twitch) has started on `railway`, and Phase 4 (translation) has started with the translation window and the overlay bubbles. Details: [Phase 2 progress](PHASE2_PROGRESS.md).

## Current status

| Area | Status and evidence |
| --- | --- |
| Codebase | Three workspaces: `shared/`, `server/`, and `overlay/`; strict TypeScript and npm workspaces. |
| Contracts | Zod 4 schemas and versioned events; F1–F5 included. Event names, fields, and rules unchanged. |
| Backend | Fastify. Roulette coordinator with authoritative in-memory state, 30 s voting, selection, and simulated raids; the Module B parser and raid gateway are connected through adapters to the Module D ports. A confirmed arrival opens a 15-minute translation window. `/ws` is read-only with per-channel viewing credentials (D2-11); `/health` reports `mode: 'simulation'`. Local demo: `npm run demo`. The `railway` branch adds Twitch OAuth and Helix reads and allows `HOST=0.0.0.0` for deployment. |
| Overlay | OBS mode by default: transparent, globe paused when idle, Simulation label. The globe shows candidate markers, the winner, an animated raid arc, and camera moves; vote bars per language and a winner card; translation bubbles. Verified in OBS 32.2.2 at 1920 × 1080 and 30 FPS (OBS CPU 0.9–1.3%, no dropped frames). `?mode=interactive` keeps the discovery panel from `railway`. |
| Dependencies | Lockfile included; `light-my-request` 6.6.0 override (V1), Vitest 4.1.12 (V2), Zod 4.6.7 (V3); `@fastify/static` 10.1.8 with `content-disposition` pinned to 2.0.1 so it loads on Node 20.18; `npm audit` 0 vulnerabilities. |
| Checks | Phase 1: 63/63 tests, typecheck, and build on `main` after the merge. `feature/phase4-translation`: 556/556 tests, typecheck, build, and audit. |
| Version control | Phase 1 merged into `main` through PR #1 (`b89ed23`); Module D merged through PR #4. Modules A–C, their integration, and the Phase 3 and 4 work are on `feature/phase4-translation`, pending review. `main` is the official base; `feature/project-foundation` (`4219a21`) is obsolete. |

This status is based on local verification, Git history, [Phase 1 decisions](phase-1-decisions.md), and [Phase 2 backend decisions](phase-2-backend-decisions.md). Real raids, real chat, AI translation, and persistence are not implemented yet; Twitch OAuth and Helix reads exist on `railway` but are not connected to the roulette.

Phase 2 backend decisions are recorded in [Phase 2 backend decisions](phase-2-backend-decisions.md), and their build order and progress in the [Phase 2 backend plan](phase-2-backend-plan.md).

## Development phases

| Phase | Goal and deliverable | Status |
| --- | --- | --- |
| Phase 0 — Definition | Proposal, MVP scope, modules A/B/C/D, architecture, and collaboration. | Essentially complete |
| Phase 1 — Foundation | Workspaces, contracts, minimal backend, static overlay, tests, and verification. | Complete; merged into `main` |
| Phase 2 — Local MVP | End-to-end roulette with synthetic channels, 30 s voting, selection, and a synchronized globe. | Code complete and verified (browser and OBS); pending review and merge into `main` |
| Phase 3 — Real Twitch | OAuth, EventSub/chat, commands, eligibility, raid requests, and observed arrivals. | In progress on `railway`: OAuth and Helix discovery work; EventSub and real raids are not connected |
| Phase 4 — AI translation | Bilingual messages, emote preservation, moderation, and the 15-minute window. | Started: translation window, overlay bubbles, and the chat pipeline work in simulation; AI provider, language detection, moderation, and real chat pending |
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
| A — Overlay and globe | Phase 2 done (globe session, vote bars, winner card, OBS mode). Next: code splitting, a narrow-width layout, and the arc for viewers who connect mid-raid. | Done for Phase 2; verified in OBS. |
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
| M2 — Controlled simulation | `!roulette` starts in local mode, voting lasts 30 s, and the backend counts valid votes. | Done (Phase 2: tests and `npm run demo:auto`) |
| M3 — Connected overlay | The globe shows the session, languages, countdown, and chosen candidate from validated events. | Done: globe markers, raid arc, vote bars, and winner card from validated events (browser and OBS checks) |
| M4 — Twitch integration | Real flow only for authorized participating channels; raid requests are distinguished from observed arrivals. | Pending |
| M5 — Translation and demo | Original/translated messages, 15-minute expiry, moderation, and demo rehearsal. | Pending |

Phases 2–5 and the milestone order are a recommended plan, not completed deliverables.

## Risks and priorities

| Priority | Risk | Response |
| --- | --- | --- |
| High | Mistaking the simulated Phase 2 flow for real Twitch behavior. | Report implemented and verified work separately; Twitch, real raids, and translation do not exist yet, and simulated timings must be recalibrated against Twitch in Phase 3. |
| High | Using outdated Twitch scopes or permissions. | Validate them before integrating OAuth or starting raids; limit to authorized participating channels. |
| Medium | Branching from the obsolete `feature/project-foundation` (`4219a21`). | Always branch from the latest `main`; that branch lacks V1–V7 and the lockfile. |
| High | The `railway` status report says the Twitch client secret was exposed. | Rotate it in the Twitch developer console before any further use; never commit, log, or paste secrets. |
| Medium | ~2 MB overlay bundle and a low-contrast purple halo. | Code splitting and visual tuning in Module A. |
| Medium | `railway` relaxes `exactOptionalPropertyTypes` for the server and prints viewing-credential URLs to the server log, which a hosted deployment keeps. | Restore the strict setting and stop printing credentials when deployed. |
| Medium | npm over HTTPS failed in one environment. | It worked in the verification environment; never disable TLS or certificates. |
| Medium | SQLite and deployment undecided. | Not required for the synthetic local demo; decide later. |

## Phase 4 modules

| # | Module | Status |
| --- | --- | --- |
| 1 | AI provider (server-only key, timeout, validated output, prompt-injection resistance) | Pending: provider and model to be chosen |
| 2 | Language detection (unknown when unsure; never assume English) | Pending: library or model call to be decided |
| 3 | 15-minute translation window, opened only by a confirmed arrival | Done (`5a2deed`) |
| 4 | Chat pipeline: message → filters and limits → translation → `translate:bubble`, with a last check before publishing | Done in simulation with simulated chat and the mock provider; connecting EventSub is pending (Phase 3) |
| 5 | Moderation: deleted messages, bans and timeouts, chat clears | Pending: can start in simulation |
| 6 | Translation bubbles in the overlay | Done (`b24440d`) |

## Next actions

1. **Rotate the Twitch client secret** reported as exposed.
2. **Module owners:** review the Phase 2 changes to files outside their module and merge Phase 2 into `main` through a pull request.
3. **Modules B and D:** connect Phase 3 (EventSub chat, Helix candidates, real raids, `channel.raid` arrivals) through the existing ports in `server/src/application/ports.ts`.
4. **Module C:** choose the AI provider and model, then build Phase 4 modules 1 and 2.

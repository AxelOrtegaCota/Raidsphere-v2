# RaidSphere phase plan and progress

As of 2026-11-01. Phases 1 and 2 are complete and merged into `main`, and the app is deployed on Railway. Development continues in `AxelOrtegaCota/Raidsphere-v2`. Phase 3 (real Twitch) and Phase 4 (translation) are partial. Details: [Phase 2 progress](PHASE2_PROGRESS.md).

## Current status

| Area | Status and evidence |
| --- | --- |
| Codebase | Three workspaces: `shared/`, `server/`, and `overlay/`; strict TypeScript and npm workspaces. |
| Contracts | Zod 4 schemas and versioned events; F1–F5 included. Event names, fields, and rules unchanged. |
| Backend | Fastify. Roulette coordinator with authoritative in-memory state, 30 s voting, selection, and simulated raids; the Module B parser and raid gateway are connected through adapters to the Module D ports. A confirmed arrival opens a 15-minute translation window. `/ws` is read-only with per-channel viewing credentials (D2-11); `/health` reports `mode: 'simulation'`, or `'live'` when real raids are enabled. Local demo: `npm run demo`. OAuth, Helix reads, and `HOST=0.0.0.0` for deployment are in `main`; EventSub chat, real candidates, real raids, and Azure translation are opt-in. |
| Overlay | OBS mode by default: transparent, globe paused when idle, Simulation label. The globe shows candidate markers, the winner, an animated raid arc, and camera moves; vote bars per language and a winner card; translation bubbles. Verified in OBS 32.2.2 at 1920 × 1080 and 30 FPS (OBS CPU 0.9–1.3%, no dropped frames). `?mode=interactive` keeps the discovery panel from `railway`. |
| Dependencies | Lockfile included; `light-my-request` 6.6.0 override (V1), Vitest 4.1.12 (V2), Zod 4.6.7 (V3); `@fastify/static` 10.1.8 with `content-disposition` pinned to 2.0.1 so it loads on Node 20.18 and `glob` pinned to 14.0.3 for a security advisory; `npm audit` 0 vulnerabilities. |
| Checks | Phase 1: 63/63 tests, typecheck, and build on `main` after the merge. `main` after PR #2: 599/599 tests, typecheck, build, and audit (2026-10-31, on Node.js 20.18.0). `main` after PR #9 (`f5c24cd`): typecheck and 700/700 tests (2026-11-01). |
| Version control | Development continues in `AxelOrtegaCota/Raidsphere-v2`, a copy of `Articnn/Raidsphere`. Its PR #2 (`852e4e2`) brought Phases 2, 3, and 4 into `main`; later PRs #3–#9 added the Phase 3 and 4 work. `feature/project-foundation` (`4219a21`) is obsolete. |

This status is based on local verification, Git history, [Phase 1 decisions](phase-1-decisions.md), and [Phase 2 backend decisions](phase-2-backend-decisions.md). Real candidates and real raids are wired behind `TWITCH_REAL_CANDIDATES_ENABLED` and `TWITCH_REAL_RAIDS_ENABLED` but real raids are not tried against Twitch yet, so translation has not reached real chat; Azure translation runs when `AZURE_TRANSLATOR_KEY` is set. Persistence is not implemented.

Phase 2 backend decisions are recorded in [Phase 2 backend decisions](phase-2-backend-decisions.md), and their build order and progress in the [Phase 2 backend plan](phase-2-backend-plan.md).

## Development phases

| Phase | Goal and deliverable | Status |
| --- | --- | --- |
| Phase 0 — Definition | Proposal, MVP scope, modules A/B/C/D, architecture, and collaboration. | Essentially complete |
| Phase 1 — Foundation | Workspaces, contracts, minimal backend, static overlay, tests, and verification. | Complete; merged into `main` |
| Phase 2 — Local MVP | End-to-end roulette with synthetic channels, 30 s voting, selection, and a synchronized globe. | Complete; merged into `main` (PRs #2 and #3 of `Raidsphere-v2`) |
| Phase 3 — Real Twitch | OAuth, EventSub/chat, commands, eligibility, raid requests, and observed arrivals. | In progress: OAuth and Helix discovery work; EventSub chat is wired behind `TWITCH_EVENTSUB_ENABLED`, and broadcaster commands worked against Twitch; registered live candidates are wired behind `TWITCH_REAL_CANDIDATES_ENABLED`; real raids are wired behind `TWITCH_REAL_RAIDS_ENABLED` and not tried against Twitch |
| Phase 4 — AI translation | Bilingual messages, emote preservation, moderation, and the 15-minute window. | Started: translation window, overlay bubbles, chat pipeline, and moderation work in simulation; Azure translation and language detection verified with synthetic phrases; real chat pending (Phase 3) |
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
| M4 — Twitch integration | Real flow only for authorized participating channels; raid requests are distinguished from observed arrivals. | In progress: wired behind flags; real raids not tried |
| M5 — Translation and demo | Original/translated messages, 15-minute expiry, moderation, and demo rehearsal. | In progress: Azure verified with synthetic phrases; real chat and rehearsal pending |

Phases 2–5 and the milestone order are a recommended plan, not completed deliverables.

## Risks and priorities

| Priority | Risk | Response |
| --- | --- | --- |
| High | Mistaking the simulated Phase 2 flow for real Twitch behavior. | Report implemented and verified work separately; real Twitch chat, raids, and translation exist behind flags but are only partly tried against Twitch, and simulated timings must be recalibrated against Twitch in Phase 3. |
| High | Using outdated Twitch scopes or permissions. | Validate them before integrating OAuth or starting raids; limit to authorized participating channels. |
| Medium | Branching from the obsolete `feature/project-foundation` (`4219a21`). | Always branch from the latest `main`; that branch lacks V1–V7 and the lockfile. |
| Medium | The Twitch client secret was shared with a teammate's AI assistant. It was not published, and it has not been rotated. | Rotate it in the Twitch developer console before production; never commit, log, or paste secrets, including into AI tools. |
| Medium | ~2 MB overlay bundle and a low-contrast purple halo. | Code splitting and visual tuning in Module A. |
| Resolved | `railway` relaxed `exactOptionalPropertyTypes` for the server and printed viewing-credential URLs to the server log, which a hosted deployment keeps. | Fixed on `feature/batch_resolve`: the strict setting is restored, and URLs are printed only on a loopback binding. |
| Medium | npm over HTTPS failed in one environment. | It worked in the verification environment; never disable TLS or certificates. |
| Medium | SQLite and deployment undecided. | Not required for the synthetic local demo; decide later. |

## Phase 4 modules

| # | Module | Status |
| --- | --- | --- |
| 1 | AI provider (server-only key, timeout, validated output, prompt-injection resistance) | Done: Azure AI Translator ([D4-01](phase-4-decisions.md)), verified against a real F0 resource with synthetic phrases; real Twitch chat pending (Phase 3) |
| 2 | Language detection (unknown when unsure; never assume English) | Done: Azure detection with a score threshold and a chat slang filter ([D4-01](phase-4-decisions.md)), verified against Azure with synthetic phrases; threshold not calibrated on real chat |
| 3 | 15-minute translation window, opened only by a confirmed arrival | Done (`5a2deed`) |
| 4 | Chat pipeline: message → filters and limits → translation → `translate:bubble`, with a last check before publishing | Done in simulation; EventSub chat is connected behind `TWITCH_EVENTSUB_ENABLED`, not tried with real raider chat |
| 5 | Moderation: deleted messages, bans and timeouts, chat clears, with a memory so late or early events cannot show a moderated message | Done in simulation; the EventSub moderation events are subscribed behind `TWITCH_EVENTSUB_ENABLED`, not tried against Twitch |
| 6 | Translation bubbles in the overlay | Done (`b24440d`) |

## Next actions

1. **Rotate the Twitch client secret**, which was shared with a teammate's AI assistant. A scan of tracked files and Git history found no committed credential.
2. **Phase 5 follow-ups from Phase 2:** repeat the OBS check, including the bubble queue and reconnection after a refresh, and have module owners review the changes outside their modules.
3. **Modules B and D:** run the end-to-end test on Twitch: two live channels, `!roulette`, a real raid, the `channel.raid` arrival, and translated raider chat.
4. **Module C:** once real chat reaches a translation window, calibrate the detection threshold and the slang list.

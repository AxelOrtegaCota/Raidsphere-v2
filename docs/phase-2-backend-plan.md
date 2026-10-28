# Phase 2 backend implementation plan (Module D)

This plan describes how and in what order the decisions in [Phase 2 backend decisions](phase-2-backend-decisions.md) are built on `feature/backend-core`. The decision record says *what* was decided; this plan says *how* it is built and tracks progress. If the two disagree, the decision record wins, and this plan is updated.

Goal: milestones M2 (controlled simulation) and M3 (connected overlay) in the [phase plan](phase-plan.md).

## Principles

- **Small steps, each with its own tests.** Every step ends with type checking and tests passing. The project owner commits after each step.
- **Inside out.** Pure rules first, then orchestration, then network and overlay. The easiest code to test comes first.
- **No new dependencies.** `ws`, Zod, Fastify, and `node:crypto` are enough.
- **Commands need approval.** `npm run typecheck` and `npm test` after each step; `npm run build` and manual checks at the end. Each command batch is approved before it runs (`AGENTS.md`).

## Steps

| # | What is built | Decisions | Files | Main tests | Status |
| --- | --- | --- | --- | --- | --- |
| 0 | **Baseline.** Confirm this branch is still green before any change. | — | None | typecheck, 63/63 tests, build | Done |
| 1 | **Shared contract follow-ups.** | D2-14 | `shared/events.ts`, `shared/test/events.test.ts` | Raid error without `sessionId` rejected; other errors without it accepted; `toCountry` mismatch rejected; `NO_ELIGIBLE_CANDIDATES` accepted without `sessionId` and rejected with one; all 7 languages accepted (more than 7 always contains a duplicate, already rejected) | Done |
| 2 | **Ports and injectable runtime.** Clock, scheduler, random source, chat commands, candidate source, raid gateway, arrivals. Real implementations use `node:crypto` for randomness; fakes for tests. | D2-09, D2-13 | `server/src/application/ports.ts`, `server/src/application/runtime.ts`, `server/test/support/fakes.ts` | Fake timers advance manually and can be cancelled; fake random source is deterministic | Done |
| 3 | **In-memory repositories and synthetic fixtures.** | D2-12 | `server/src/persistence/memory.ts`, `server/src/simulation/fixtures.ts` | `compareAndSave` enforces version and one active session; records validated on write and read; fixtures are schema-valid and use the `rsdemo_` prefix | Done |
| 4 | **Pure rules.** Eligibility, vote acceptance, tie-break, and candidate selection. | D2-02, D2-03, D2-04, D2-06 | `server/src/application/eligibility.ts`, `server/src/application/votes.ts`, `server/src/application/selection.ts` | First vote fixed; invalid and late votes ignored; viewer range; `acceptsOtherLanguages`; sample of 100; ties; zero votes | Done |
| 5 | **Event publisher.** | D2-10 | `server/src/application/publisher.ts` | Per-channel `sequence`; UUID `eventId`; invalid events not delivered; channel isolation; unsubscribe | Pending |
| 6 | **Roulette coordinator.** State machine, commands, deadlines, vote broadcasts, raid request, arrival, and snapshots. | D2-05, D2-07, D2-08, D2-15 (rules 4–5) | `server/src/application/roulette.ts` | Full flow; cancel in each state; unauthorized and out-of-place commands; duplicates; at most one vote broadcast per second plus the final one; no eligible candidates emits the error; missing arrival leads to `unknown`; stale timers have no effect; the three `cancelRaid` results | Pending |
| 7 | **Simulators.** Commands, candidates, raid gateway, and arrivals, all configurable. | D2-13 (rule 7), D2-15 | `server/src/simulation/commands.ts`, `server/src/simulation/raid-gateway.ts` | Each configurable outcome; countdown between 0 and 120; arrival delivered or withheld | Pending |
| 8 | **Read-only `/ws` and `/health`.** Credentials, origin check, handshake, limits, ping, snapshot, and live events. `createApp` receives its dependencies; `index.ts` composes everything and prints the demo OBS URLs. | D2-11, D2-15 (rule 6), D2-16 | `server/src/viewing/credentials.ts`, `server/src/websocket.ts`, `server/src/app.ts`, `server/src/index.ts`, `server/test/app.test.ts`, `server/test/websocket.test.ts` | Wrong or missing origin; late or invalid `auth`; wrong credential; snapshot first, then live events; any other message closes; limits 4 and 16; no request data reflected; `/health` with `mode` and `channelSubscriptions: true`. The two existing tests that change are updated. | Pending |
| 9 | **Demo script.** Runs the server in simulation mode with a scripted flow (for example `!roulette` on `rsdemo_es_01`, simulated votes, 10-second countdown). In process only; no remote control. The demo source's preferences keep its eligible pool small, so few destination URLs are printed (D2-16). | D2-05 (rule 5), D2-15 (rule 7), D2-16 | `server/src/simulation/demo.ts`, a new script in `server/package.json` and `package.json` | Manual review; the logic is already covered by steps 6 and 7 | Pending |
| 10 | **Overlay, Module A (minimal).** WebSocket client that reads `#cred`, removes it from the address bar, validates every event with `serverEventSchema`, and shows the state as text, plus the "Simulation" label. Globe animation, vote bars, and cards remain later Module A work. | D2-11 (rules 7–8), D2-15 (rule 6) | `overlay/src/connection.ts`, `overlay/src/main.ts`, `overlay/src/styles.css`, `overlay/index.html` | typecheck; manual check in a browser and in OBS | Pending |
| 11 | **Close-out.** Update decision statuses (IMPLEMENTED or VERIFIED with evidence) and milestones M2 and M3. | — | `docs/phase-2-backend-decisions.md`, `docs/phase-plan.md`, `README.md` | Full build; manual check with two overlays in OBS | Pending |

## Operational notes

- **Exact origin.** Only `http://127.0.0.1:5173` is accepted. Opening the overlay as `localhost:5173` sends a different origin and is rejected. This is documented in `README.md` during step 11.
- **Vite development server only.** The built preview (`vite preview`, port 4173) is not supported in Phase 2.
- **Printed URLs.** Only demo channel URLs are printed (D2-16). Do not share them or screen-share the terminal (D2-11).
- **WebSocket tests.** They use a real server on `127.0.0.1` with a random port and the `ws` client. Traffic stays local; no internet access.
- **Commits.** The project owner commits; a commit message is proposed at the end of each step.

## Progress log

Record each completed step with its date, the checks that were run, and their results.

| Date | Step | Checks run | Result |
| --- | --- | --- | --- |
| 2026-10-28 | 0 | `npm run typecheck`, `npm test`, `npm run build` | All passed: typecheck clean; 63/63 tests (2 files); build succeeded. Same warnings as Phase 1 (overlay bundle ~2.04 MB, ~578 kB gzip) plus two harmless Rollup notices about comment placement inside `zod`. |
| 2026-10-28 | 1 | `npm run typecheck`, `npm test` | All passed: typecheck clean; 67/67 tests (63 existing unchanged, 4 new contract tests). |
| 2026-10-28 | 2 | `npm run typecheck`, `npm test` | All passed: typecheck clean; 77/77 tests (10 new in `server/test/runtime.test.ts`). Ports are types only; the call timeout for `requestRaid`/`cancelRaid` is enforced by the coordinator in step 6. |
| 2026-10-28 | 3 | `npm run typecheck`, `npm test` | All passed: typecheck clean; 90/90 tests (10 in `server/test/memory.test.ts`, 3 in `server/test/fixtures.test.ts`). Added `findLatestByChannel` to `RouletteRepository` for snapshots (D2-07 rule 7). `RaidRepository` and `TranslationWindowRepository` not implemented (D2-17). The demo source's eligible pool is checked in step 4. |
| 2026-10-28 | 4 | `npm run typecheck`, `npm test` | All passed: typecheck clean; 108/108 tests (6 each in `eligibility`, `votes`, and `selection` tests). Demo source pool confirmed: `rsdemo_en_01`, `rsdemo_es_02`, `rsdemo_pt_01`, `rsdemo_ja_01`, `rsdemo_ko_02`. |

# RaidSphere

An interactive Twitch raid discovery platform connecting small streamers worldwide through globe-based voting and real-time AI chat translation.

RaidSphere is being developed for the Codex × TwitchCon Hackathon 2026 by a four-person team.

## Team Handoff — Phase 2 Local MVP

Phase 2 adds a complete local roulette in simulation mode: the backend runs `!roulette`, 30-second voting, selection, and a simulated raid on synthetic channels, and the overlay follows it read-only over `/ws`. Decisions and evidence are in [Phase 2 backend decisions](docs/phase-2-backend-decisions.md) and the [Phase 2 backend plan](docs/phase-2-backend-plan.md). Twitch OAuth, real raids, AI translation, persistence, and the visual globe synchronization are not yet implemented.

The Phase 1 foundation was verified with Node.js 20.18.0 and npm 10.8.2, including an OBS browser source check; see [Phase 1 verification results](docs/phase-1-decisions.md#phase-1-verification-results).

npm registry HTTPS requests previously failed in one developer environment; the cause remains unknown. Installation succeeded in another environment without changing any security setting. Security controls, including TLS certificate verification, must not be disabled or bypassed.

Before development, read [AGENTS.md](AGENTS.md), [docs/phase-1-decisions.md](docs/phase-1-decisions.md), [docs/phase-2-backend-decisions.md](docs/phase-2-backend-decisions.md), and the [phase plan](docs/phase-plan.md). Create your own feature branch from the latest `main`, protect credentials, and coordinate changes to the shared contracts before implementation.

## Current status

Phase 1 is complete and was merged into `main` through PR #1. Phase 2 is complete on `feature/backend-core` and pending review and merge into `main`. `package-lock.json` records the resolved dependency graph; Phase 2 added no dependencies.

Included source:

- Private npm workspaces and strict TypeScript configuration.
- Shared public models and versioned Zod 4 notification contracts.
- Fastify health entry point (`mode: 'simulation'`).
- Roulette coordinator with authoritative in-memory state, vote rules, deadlines, selection, and simulated raid outcomes, behind ports that real Twitch adapters will implement.
- Synthetic `rsdemo_` channels; no real channel data.
- Read-only `/ws` with per-channel viewing credentials generated at startup and kept in memory (D2-11).
- Transparent globe overlay with a text panel, a permanent Simulation label, and a read-only WebSocket client.
- Persistence interfaces with in-memory implementations; contract, backend, and WebSocket tests.

The earlier F1–F5 static-review corrections are covered by passing regression tests. Verification added dependency corrections (a `light-my-request` override, Vitest 4, Zod 4), a typed Fastify error handler, and three overlay rendering fixes.

Pending functionality includes Twitch OAuth, EventSub, real chat commands, real candidate discovery, real raid execution/cancellation/arrival, the globe animation of the session, AI translation, broadcaster control over the network, and persistence. SQLite remains the future persistence target; Phase 1 does not install, configure, or open it.

## Architecture and ownership

```text
overlay/   Module A: globe rendering and OBS interface
server/    Module B: future Twitch adapters
           Module C: future AI translation
           Module D: backend composition and authoritative application state
shared/    Public models, runtime schemas, and events.ts contracts
docs/      Approved decisions and available project documentation
```

The backend coordinates Twitch and translation and will publish validated, channel-scoped events. Overlays never receive Twitch credentials or make raid decisions. Chat commands are `!roulette`, `!vote`, and `!cancel`; in Phase 2 they come only from the in-process demo, never from the network.

Read [AGENTS.md](AGENTS.md) for engineering and authorization rules and [Phase 1 decisions](docs/phase-1-decisions.md) for authoritative Phase 1 choices, contract differences, verification results, and limitations. `RAIDSPHERE_CONTEXT.md` is preserved historical design context. The original PDF was unavailable in the most recently inspected checkout.

## Prerequisites

- Verified baseline: Node.js 20.18.0 and npm 10.8.2.
- `.nvmrc` records that Node version; do not upgrade runtimes automatically.
- No Twitch account, AI credential, environment file, or database is needed for the foundation checks.

## Setup and verification

Run from the repository root:

```sh
npm install --ignore-scripts --no-audit --no-fund
npm audit
npm run typecheck
npm test
npm run build
```

Installation disables dependency lifecycle scripts; none was required. A dependency requiring a script needs separate review and approval. No automated fix or dependency upgrade is implied.

Verified results: type checking passes, 155 of 155 tests pass, and the build succeeds (Phase 2, 2026-10-28). `npm audit` reported 0 vulnerabilities in Phase 1; Phase 2 added no dependencies and did not re-run it. Vite warns that the overlay bundle exceeds 500 kB, mostly because of three.js; this is expected for now.

The root scripts build shared exports before consumers. `npm run typecheck` therefore also writes shared declarations/JavaScript to `shared/dist/`, then checks all workspace source, shared/backend tests, and Vite configuration. Test/tooling configurations use `noEmit`; production builds continue excluding tests.

Tests cover contract compatibility, invalid payloads, snapshot invariants, channel isolation, canonical validator exports, translation result states, strict decimal ports, health behavior, vote and selection rules, the roulette state machine, simulated raids, event publication, and the `/ws` origin, credential, handshake, and connection-limit checks.

Windows notes:

- In PowerShell, `npm` runs through `npm.cmd`, which strips `^` from arguments. Query registry metadata by major or exact version (for example, `npm view vite@6 version`) rather than with `^` ranges.
- If the repository lives in a synchronized OneDrive folder, pause synchronization while installing and building.

## Shared-contract compatibility

Import `serverEventSchema` or `clientMessageSchema` from `@raidsphere/shared` and use their `parse` or `safeParse` methods at event boundaries. Per-event structural schemas are private so event consumers cannot accidentally skip cross-field checks. Named public event types remain exported; wire event names and fields are unchanged.

Snapshots reject empty voting/selection pools, unavailable vote languages, premature selection, and mismatched selected identities/languages. Refreshed title/viewer metadata is permitted. Empty failed/cancelled states require empty votes and no selection.

The shared contracts use Zod 4. New schemas in any module must use Zod 4 APIs; for example, partial records keyed by an enum use `z.partialRecord`.

An explicitly supplied `PORT` must contain one to five ASCII decimal digits and represent a port from 1 to 65535. Missing `PORT` defaults to 3000. Leading zeroes within five characters are allowed; whitespace, signs, hexadecimal, exponent, fractional, and non-ASCII forms are rejected. The host remains loopback-only.

## Local demo

Use two terminals at the repository root:

```sh
npm run demo
```

```sh
npm run dev:overlay
```

The demo starts the server in simulation mode on loopback port 3000 and prints one overlay URL per demo channel: the source `rsdemo_es_01` and its five possible destinations. In the demo terminal, press Enter for `!roulette`, `c` + Enter for `!cancel`, and `q` + Enter to quit. A round takes 30 seconds of scripted voting, then a simulated raid with a 10-second countdown. `npm run demo:auto` runs one round without the keyboard and stops.

Open the source URL, and optionally a destination URL, in a browser or as an OBS Browser source at 1920 × 1080. The source overlay shows the voting, the chosen channel, and the raid; a destination overlay shows the arrival. All channels and raids are synthetic.

Notes:

- **Exact origin.** Use the URL exactly as printed, with `127.0.0.1`. `localhost:5173` sends a different origin and is rejected.
- **Credentials.** Each URL contains a read-only viewing credential after `#cred=`. Do not share the URLs or screen-share the terminal. Credentials change on every restart, so paste the new URLs after restarting.
- **Reloading.** The overlay removes the credential from the address bar, so reloading a browser tab loses it; open the printed URL again. An OBS source keeps its configured URL, so it is expected to reconnect on refresh (not yet verified in OBS).
- **PowerShell.** Windows PowerShell removes a bare `--` before calling npm, so `npm run demo -- --auto` loses `--auto`; use `npm run demo:auto`.
- **Vite development server only.** The built preview (`vite preview`) is not supported.

`npm run dev:server` starts the same server without the demo keyboard, so no roulette can be started from it. Neither command watches for changes; restart after server changes, and restart the overlay command after shared-contract changes. This build is not ready for public deployment.

## Security and collaboration

- Keep all development communication and deliverables in English.
- Explain and obtain approval for commands, edits, dependency installation, execution, and network access.
- Branch from the latest `main` and change `main` only through reviewed pull requests; commits, pushes, merges, and deployment need separate approval.
- Coordinate changes to `shared/events.ts` across all four module owners.
- Never put real credentials or private information in code, fixtures, public payloads, URLs, or logs.
- Keep viewing permissions separate from broadcaster control permissions.
- `.gitignore` excludes local secrets and generated files; it cannot protect secrets already tracked by Git.
- Preserve other developers' work and distinguish authored code from verified functionality.

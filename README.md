# RaidSphere

An interactive Twitch raid discovery platform connecting small streamers worldwide through globe-based voting and real-time AI chat translation.

RaidSphere is being developed for the Codex × TwitchCon Hackathon 2026 by a four-person team.

## Team Handoff — UNVERIFIED WORK IN PROGRESS

The Phase 1 foundation and F1–F5 corrections have been authored but have not been tested or built. Dependency installation, lockfile generation, type checking, tests, builds, and runtime verification remain pending. Twitch OAuth, raid integration, roulette logic, AI translation, and persistence are not yet implemented.

TCP connectivity to the npm registry succeeded, but HTTPS requests through PowerShell and curl failed. The cause remains unknown; these results do not establish a defect in RaidSphere or its dependencies. Security controls, including TLS certificate verification, must not be disabled or bypassed.

Before development, read [AGENTS.md](AGENTS.md) and [docs/phase-1-decisions.md](docs/phase-1-decisions.md). Use your own feature branch, protect credentials, and coordinate changes to the shared contracts before implementation.

## Current status

Phase 1 foundation source has been authored on `feature/project-foundation`. Dependencies, compilation, tests, browser rendering, and OBS behavior have **not been verified**. No lockfile has been generated.

Included source:

- Private npm workspaces and strict TypeScript configuration.
- Shared public models and versioned Zod notification contracts.
- Fastify health entry point and a WebSocket upgrade boundary that rejects all access until authorization is implemented.
- Transparent static globe preview without remote textures or live channel data.
- Persistence interfaces and initial contract/backend tests.

The targeted F1–F5 static-review corrections have also been authored, including stricter snapshots, canonical event validators, expanded type-check coverage, decimal-only ports, and additional credential ignore patterns. These corrections and their regression tests remain unverified.

Pending functionality includes Twitch OAuth, EventSub, chat commands, roulette/voting, candidate discovery, raid execution/cancellation/arrival, AI translation, authenticated real-time connections, and persistence. SQLite remains the future persistence target; Phase 1 does not install, configure, or open it.

## Architecture and ownership

```text
overlay/   Module A: globe rendering and OBS interface
server/    Module B: future Twitch adapters
           Module C: future AI translation
           Module D: backend composition and authoritative application state
shared/    Public models, runtime schemas, and events.ts contracts
docs/      Approved decisions and available project documentation
```

The backend coordinates Twitch and translation and will publish validated, channel-scoped events. Overlays never receive Twitch credentials or make raid decisions. Canonical future chat commands are `!roulette`, `!vote`, and `!cancel`; no command handler is implemented yet.

Read [AGENTS.md](AGENTS.md) for engineering and authorization rules and [Phase 1 decisions](docs/phase-1-decisions.md) for authoritative Phase 1 choices, contract differences, and limitations. `RAIDSPHERE_CONTEXT.md` is preserved historical design context. The original PDF was unavailable in the most recently inspected checkout.

## Prerequisites

- Installed baseline: Node.js 20.18.0 and npm 10.8.2.
- `.nvmrc` records that Node version; do not upgrade runtimes automatically.
- Dependency versions and engine compatibility must be reviewed before installation.
- No Twitch account, AI credential, environment file, or database is needed for the foundation checks.

## Setup and verification

The following commands are documented for later, explicitly authorized execution. They have not been run for this foundation. Installation creates a lockfile and dependencies; checks/builds create generated output. Review package metadata and security advisories before proceeding.

```sh
npm install --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run build
```

Installation disables dependency lifecycle scripts. A dependency requiring a script needs separate review and approval. No automated fix or dependency upgrade is implied.

The root scripts build shared exports before consumers. `npm run typecheck` therefore also writes shared declarations/JavaScript to `shared/dist/`, then checks all workspace source, shared/backend tests, and Vite configuration. Test/tooling configurations use `noEmit`; production builds continue excluding tests. These checks have not been executed.

Written tests cover contract compatibility, invalid payloads, snapshot invariants, channel isolation, canonical validator exports, translation result states, strict decimal ports, health behavior, and rejection of unauthenticated upgrades. They are currently unexecuted.

## Shared-contract compatibility

Import `serverEventSchema` or `clientMessageSchema` from `@raidsphere/shared` and use their `parse` or `safeParse` methods at event boundaries. Per-event structural schemas are now private so event consumers cannot accidentally skip cross-field checks. Named public event types remain exported; wire event names and fields are unchanged.

Snapshots now reject empty voting/selection pools, unavailable vote languages, premature selection, and mismatched selected identities/languages. Refreshed title/viewer metadata is permitted. Empty failed/cancelled states require empty votes and no selection. Other developers should update fixtures and parser imports accordingly; this is stricter acceptance, not a wire-format migration.

An explicitly supplied `PORT` must contain one to five ASCII decimal digits and represent a port from 1 to 65535. Missing `PORT` defaults to 3000. Leading zeroes within five characters are allowed; whitespace, signs, hexadecimal, exponent, fractional, and non-ASCII forms are rejected. The host remains loopback-only.

## Local preview

Only after separate authorization and successful installation/verification, use two terminals at the repository root:

```sh
npm run dev:server
```

```sh
npm run dev:overlay
```

The server binds to loopback port 3000 by default; `/health` reports foundation health. The overlay development server binds to loopback port 5173 and supports the planned `/{channel}/overlay` browser route through Vite's SPA fallback. Configure OBS to 1920 × 1080 with a transparent background when preview testing is approved.

The server development command compiles then starts once; it does not watch for changes. Restart it after server changes, and restart the overlay command after shared-contract changes. The preview has no active WebSocket connection: `/ws` upgrades deliberately return 503 until viewing authorization exists. This foundation is not ready for public deployment.

## Security and collaboration

- Keep all development communication and deliverables in English.
- Explain and obtain approval for commands, edits, dependency installation, execution, and network access.
- Keep Phase 1 implementation on `feature/project-foundation`; commits, pushes, merges, and deployment need separate approval.
- Coordinate changes to `shared/events.ts` across all four module owners.
- Never put real credentials or private information in code, fixtures, public payloads, URLs, or logs.
- Keep viewing permissions separate from broadcaster control permissions.
- `.gitignore` excludes local secrets and generated files; it cannot protect secrets already tracked by Git.
- Preserve other developers' work and distinguish authored code from verified functionality.

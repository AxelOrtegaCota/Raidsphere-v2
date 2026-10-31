# Phase 2 progress — local MVP

As of 2026-10-30. Phase 2 code is complete and verified locally and in OBS. It is not yet merged into `main`: the integration work lives on branches that still need a reviewed pull request (see [Close-out](#close-out)). The Batch 4 and 5 close-out (disconnection tests, hosted-deployment hardening, and documentation) is on `feature/batch_resolve`.

Everything in Phase 2 runs in **simulation mode**: synthetic `rsdemo_` channels, a simulated chat, simulated raids, and a mock translation provider. No Twitch request, real raid, or AI call happens in the Phase 2 flow. Real Twitch work belongs to Phase 3 and is reported separately below.

## What Phase 2 delivers

One local roulette round, end to end: the broadcaster types `!roulette` in a simulated chat, viewers vote for a language for 30 seconds, the backend picks a channel, requests a simulated raid, and observes a simulated arrival. The OBS overlay follows every step read-only.

| Module | Delivered | Location |
| --- | --- | --- |
| A — Overlay | OBS mode (transparent, no discovery tools, globe paused when idle); globe markers, winner highlight, animated raid arc, and camera moves; vote bars per language with channels; winner card; text status panel; permanent Simulation label | `overlay/src/` |
| B — Twitch (simulated) | Chat command parser (`!roulette`, `!vote`, `!cancel` and aliases); simulated raid gateway with queued, arrived, rejected, cancelled, timed-out, and unknown outcomes; adapters to the Module D ports; in-process simulated chat | `server/src/twitch/` |
| C — Translation (mock) | Translation service with fragment and emote preservation, cache (500 entries, 5-minute TTL), bounded concurrency (5 running, queue of 100), sessions, and invalidation; mock provider that marks its output as simulated | `server/src/translation/` |
| D — Backend | Authoritative roulette coordinator, vote rules, selection, deadlines, event publisher, in-memory repositories, read-only `/ws` with per-channel viewing credentials, local demo | `server/src/application/`, `server/src/persistence/`, `server/src/websocket.ts`, `server/src/simulation/` |

Decisions for Module D are recorded in [Phase 2 backend decisions](phase-2-backend-decisions.md) and its build order in the [Phase 2 backend plan](phase-2-backend-plan.md).

## Integration (connected in Phase 2)

| Connection | Status |
| --- | --- |
| Simulated chat → B parser → D coordinator | Connected through `toChatCommand`. Roles come from adapter metadata, never from message text; a broadcaster flag counts only for the channel owner (finding F3). |
| D coordinator → B raid gateway | Connected through `RaidGatewayAdapter` behind the D `RaidGateway` port: one request per session, unknown outcome on submission failure, bounded public countdown. |
| D coordinator → overlay | Connected over read-only `/ws`; the overlay validates every event with the shared schemas. |
| C translation → D / overlay | Connected in Phase 4 (module 4) with simulated chat and the mock provider; real chat is pending. |

## Verification

| Check | Result |
| --- | --- |
| Type checking | Passes, including the server with `exactOptionalPropertyTypes` restored |
| Tests | 598 of 598 pass (28 files): contracts, backend, roulette, raids, adapters, translation, moderation, `/ws` (including heartbeat and outgoing-buffer limit), overlay state, and overlay reconnection |
| Build | Passes; Vite warns that the overlay bundle exceeds 500 kB (three.js) |
| `npm audit` | 0 vulnerabilities after upgrading `@fastify/static` to 10.1.8 |
| Runtime used | The 2026-10-30 run used Node.js 22.15.0 and npm 10.9.2, because Node.js 20.18.0 was not installed on that machine; earlier runs used the 20.18.0 baseline |
| Local demo | `npm run demo:auto`: start, votes, choice, simulated raid, and arrival |
| Browser | One round against the real runtime at 1920 × 1080 |
| OBS 32.2.2 | Browser source at 1920 × 1080 and 30 FPS over a colour source: transparent background, no dropped frames, OBS CPU 0.9% idle, 1.1% voting, 0.9% raid pending, 1.3% on arrival |

Mutation checks confirmed that the tests fail when the F3 role rule, the translation moderation guard, the replaced-timer guard, or the `/ws` heartbeat termination is removed.

Reconnection is covered by automated tests: the overlay retries a lost connection after 1, 2, 4, 8, 16, then 30 seconds; resets the delay after a fresh snapshot; stops on a rejected credential; and the server drops a viewer that stops answering pings and frees its channel slot. Reconnection after refreshing an OBS source is still not checked by hand.

## Known limitations

- An overlay that connects in the middle of a raid shows no arc: the snapshot does not carry the source country, so the camera goes to the destination only.
- Below about 800 px wide, the overlay panels overlap. At 1080p they do not.
- The overlay bundle is about 2 MB; code splitting is still pending.
- `npm run dev:server` uses the default Module B simulation, which rejects about 10% of raids and loses about 5% of arrivals on purpose. The demo forces both to 100%.
- globe.gl 2.32 never advances its own camera transitions, so the overlay moves the camera itself.
- Sessions, roulette state, and translation windows live in process memory and are lost on restart.
- Reconnection of an OBS browser source after a refresh is covered by automated client tests but not checked by hand in OBS.

## Phase 3 work on the same branches (not part of Phase 2)

The `railway` branch adds Twitch OAuth, sessions, Helix reads, and a candidate discovery panel. These are real Twitch integrations, but they are **not connected to the roulette**: the roulette still uses synthetic channels and simulated raids, and EventSub chat exists only as unconnected code. The discovery panel is available only in `?mode=interactive`. See [PHASE_STATUS.md](../PHASE_STATUS.md) and [raid candidate discovery](raid-candidate-discovery.md).

## Phase 4 work already started

- Module 3: a confirmed arrival opens a 15-minute translation window on the destination (`5a2deed`).
- Module 6: the overlay shows translation bubbles while the window is active (`b24440d`).
- Module 4: chat messages go through filters and limits to the translation service and back as bubbles, with a last check before publishing.
- Module 5: deleted messages, cleared users, and chat clears cancel running translations and remove bubbles; a memory stops late or early events from showing a moderated message.

All of this runs on simulated chat and the mock provider; real chat needs Phase 3 EventSub, and real translation needs an AI provider.

## Close-out

- [x] Modules A–D implemented and connected in simulation.
- [x] Type checking, tests, build, and audit pass.
- [x] Browser and OBS verification.
- [x] Disconnection tests for the overlay client and the `/ws` heartbeat and buffer limit (Batch 4).
- [x] Hosted-deployment hardening from the `railway` review: the server no longer prints viewing-credential URLs when bound to `0.0.0.0`, and the server again compiles with `exactOptionalPropertyTypes`.
- [x] `npm run demo:auto` exits on its own again: the OAuth session store's hourly cleanup timer (from `railway`) kept the process alive after "Demo stopped."; it is now unreferenced (`server/test/sessions.test.ts`). Checked end to end on 2026-10-30 through the Vite proxy with source, destination, and uninvolved overlay connections.
- [x] Secret scan of tracked files and Git history: no credential found; `.env` is ignored and was never committed.
- [ ] Rotate the Twitch client secret reported as exposed (Twitch developer console; owner action).
- [ ] Review by the module owners of the files changed outside their own module (`roulette.ts`, `memory.ts`, `view-state.ts`, `main.ts`, `index.html`, `styles.css`, `composition.ts`, `demo.ts`).
- [ ] Merge into `main` through a reviewed pull request. Decide whether the Phase 3 work from `railway` goes in the same pull request or a separate one.
- [ ] Re-run type checking, tests, build, and audit on `main` after the merge.

## Branches and commits

| Branch | Contains |
| --- | --- |
| `main` | Phase 1 and Module D (PR #4) |
| `fix_twitch-integration` | Modules B and C (Batches 1–3B) and their adapters to Module D (`c2e6b4f`) |
| `railway` | Phase 3 OAuth, Helix discovery, and deployment configuration |
| `Test` | `railway` merged with `fix_twitch-integration`, plus the `@fastify/static` security upgrade (`46650ae`) |
| `feature/phase4-translation` | `Test` plus the translation window (`5a2deed`), translation bubbles (`b24440d`), the completed Phase 2 overlay (`e7c598c`), the chat translation pipeline and moderation (`69e7eab`, `2488973`), public discovery hardening (`4c39d8d`), and the `glob` pin (`04b9ab4`) |
| `feature/batch_resolve` | `feature/phase4-translation` plus the Batch 4 and 5 close-out: disconnection tests, hosted-deployment hardening, and documentation updates |

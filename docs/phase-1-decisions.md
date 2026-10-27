# Phase 1 foundation decisions

## Status and authority

This record describes the approved direction, the foundation source written for it, and remaining limitations. The foundation was subsequently installed, type-checked, tested, built, and smoke-tested; see [Phase 1 verification results](#phase-1-verification-results). Verification covers only the checks listed there.

The project owner approved TypeScript, a modular monolith, Fastify, Vite, globe.gl, ws, top-level `overlay/`, `server/`, `shared/`, canonical commands `!roulette`, `!vote`, `!cancel`, and contracts in `shared/events.ts`. The owner subsequently approved npm workspaces and shared Zod contracts for file implementation.

The installed baseline previously inspected was Node.js 20.18.0 and npm 10.8.2. `.nvmrc` records that baseline; no runtime or package-manager upgrade is authorized. Engine declarations are not a claim about upstream support status.

Phase 1 implementation was developed on `feature/project-foundation`, created from the previously verified matching local `main` and locally recorded `origin/main`. The owner approved one exception: Phase 1 verification and its corrections were completed on `feature/project-foundation-complete-phase1`, created from the same foundation commit (`4219a21`).

Phase 1 was integrated into `main` through reviewed pull request #1 (merge `b89ed23`, 2026-10-27). `main` is the base for all later work. `feature/project-foundation` remains at `4219a21`, without the verification changes, and must not be used as a starting point.

`RAIDSPHERE_CONTEXT.md` remains unchanged. This record documents the approved Phase 1 differences from its historical examples. The original specification was previously reviewed, but `docs/Raidsphere.pdf` was absent from the latest inspected checkout. It has not been recreated or reread for this implementation stage.

## Architecture and ownership

| Module | Ownership | Foundation status |
| --- | --- | --- |
| A | Browser rendering and OBS presentation in `overlay/` | Static globe preview and transparent responsive canvas |
| B | Twitch OAuth, EventSub, chat, discovery, and raid adapters | Deferred; future boundary `server/src/twitch/` |
| C | Detection, translation, fragment preservation, provider limits, and cache | Deferred; future boundary `server/src/translation/` |
| D | Server composition, authoritative application state, voting, deadlines, and persistence | Health entry point, restricted upgrade boundary, and persistence interfaces only |

The backend remains the authoritative state owner. The overlay does not select a destination or execute a raid. Modules B and C do not own roulette state. A owns rendering; C will produce validated translation results.

The workspaces are private packages. Shared code is built before server/overlay consumers resolve its JavaScript and declaration exports. Backend and shared imports use ECMAScript modules with explicit `.js` relative specifiers. Vite handles browser bundling.

## Differences from historical documentation

| Historical example | Phase 1 decision |
| --- | --- |
| `packages/` layout | Approved top-level workspace directories |
| pnpm workspace commands | npm workspaces using the already installed package manager |
| Express/Fastify alternatives | Fastify |
| JSON persistence and an in-memory database | Interfaces only in this phase; SQLite remains the later persistence direction |
| WebSocket port separate from HTTP | Future `/ws` upgrades share the Fastify HTTP server; upgrades currently fail closed |
| Browser roulette start/cancel commands | No overlay control capability; future control authorization needs a separate design |
| Unconnected envelope examples | Strict discriminated event union with runtime and cross-field validation |
| `channel` versus `candidate` | `candidate` is the canonical selection payload field |
| Language display names in votes | Canonical language codes; names are presentation concerns |
| Generic timestamps and countdown authority | Explicit millisecond fields and an optional estimated countdown |
| Missing `RouletteState` | Defined sanitized `PublicRouletteState` |
| `Map` in domain state | JSON-safe public counts; server-only individual votes stay outside snapshots |
| Failure treated as cancellation | Errors/unknown state are distinct from confirmed cancellation |
| Undeclared `state:request` | Future snapshots are server-initiated after authorization; no request message in this version |

`README.md` is updated for the actual foundation and links here. No correction to the preserved context document is implied.

## Runtime validation and public models

`shared/schemas.ts` owns the Zod schemas. `shared/models.ts` infers public TypeScript types. `shared/events.ts` composes payloads and envelopes and exports `serverEventSchema`, the canonical inbound notification validator for consumers.

Objects reject unknown fields rather than stripping them. Counts are nonnegative safe integers; timestamps are Unix milliseconds; identifiers are bounded opaque strings. Public avatars are optional HTTPS metadata. No foundation component downloads them.

Version 1 supports `en`, `es`, `pt`, `fr`, `de`, `ja`, and `ko`. This is a deliberately bounded MVP set, not a complete Twitch language list. Additional languages require coordinated schema changes. Country codes represent illustrative map locations, never verified nationality or physical location. Unknown/ambiguous source language is represented by `null` while pending; completed results require a supported detected language.

Public streamer and candidate models exclude credentials. Public roulette state exposes aggregate counts, not individual votes. Persistence records that include individual votes remain server-only. A future repository adapter must validate records at its input/output boundaries; TypeScript interfaces alone do not validate stored data.

## Event protocol

Channel notifications carry `version`, `type`, `eventId`, `channelId`, `occurredAtMs`, `sequence`, `payload`, and a required `sessionId` for roulette and raid notifications. IDs in tests are synthetic fixtures.

Sequences increase within a channel stream during one server lifetime. They are not durable replay cursors. Future clients must replace state with a snapshot after each authorized connection. Publisher sequencing, deduplication, backpressure, and reconnect behavior are not implemented in this phase.

| Event | Payload contract |
| --- | --- |
| `roulette:start` | Eligible candidates/languages and `votingEndsAtMs` |
| `roulette:votes` | Aggregate language counts and a matching total |
| `roulette:chosen` | Candidate using the winning language and illustrative map locations |
| `raid:started` | Destination identity, request timestamp, nullable estimated countdown; request acceptance only |
| `raid:cancelled` | Confirmed user cancellation or session cancellation before a request |
| `raid:arrived` | Correlated source/destination, observed viewers, source language, and arrival timestamp; routed to destination |
| `translate:bubble` | Original-first message and fragments, then completed translation or explicit unavailability |
| `translate:remove` | One message identity for moderation removal |
| `translate:clear` | All channel bubbles or a specified user's bubbles |
| `translation:window` | Active/expired window and absolute expiration |
| `state:snapshot` | Nullable public roulette state and channel-owned translation window |
| `error` | Bounded safe message, enumerated code, recoverability |

Translation fragments must reconstruct the original message exactly. Text, emote, mention, and link fragments preserve their identities/order; provider translation logic is deferred. A completed result needs nonempty translated text. Pending/unavailable results cannot carry a fabricated translation.

The separate future viewing handshake contains a bounded viewing credential. It is a schema, not authentication. It grants no control permissions and is not accepted by the current server. Never log handshake input or forward it to a browser notification.

The schemas establish structural constraints and selected invariants. They do not replace command authorization, voting policy, session transition enforcement, channel ownership checks at publication, or external event correlation.

## Minimal HTTP and WebSocket behavior

The backend binds to `127.0.0.1`, defaults to port 3000, and permits an explicit valid `PORT` value. No environment file loader is installed. `/health` reports process health and explicitly unavailable channel/control capabilities; it does not assert readiness for Twitch or AI.

A ws server is constructed in no-server mode with compression disabled and a bounded incoming payload setting. HTTP upgrade requests to `/ws` receive 503 before any WebSocket is accepted. Other upgrade paths receive 404. Request details are not reflected. This is an intentionally unavailable authorization boundary, not a working authenticated real-time connection. Origin checks, credential verification, subscription ownership, frame validation, and connection limits must precede enabling upgrades.

The Vite development server also defaults to loopback. The overlay uses a static, procedural globe with no remote texture or geographic requests. Rendering runs briefly after the globe becomes ready or the container resizes, then pauses. The preview was checked in an OBS browser source at 1920 by 1080; see [Phase 1 verification results](#phase-1-verification-results).

## Persistence

`server/src/persistence/contracts.ts` defines repositories for streamers, sessions, translation windows, and atomic arrival/reputation recording. Session writes specify optimistic concurrency and one active roulette per channel. These are requirements for a future adapter, not implemented guarantees.

No SQLite dependency, driver, connection configuration, database file, schema, migration, JSON backup, or persistence I/O is included. Credentials need a separately designed server-only storage interface before OAuth implementation.

## Dependencies and verification status

Node 20-compatible tooling was targeted, with Vite constrained to major 6 rather than implicitly installing an unrestricted release. globe.gl is pinned to the factory API used by the preview. The original manifest ranges were revised during verification; the resolved graph is recorded in `package-lock.json` and summarized in [Phase 1 verification results](#phase-1-verification-results). Audit results describe the advisory database at the time of the check, not a permanent security guarantee.

## F1–F5 remediation

These corrections were authored before dependency installation. Their regression tests now pass as part of the Phase 1 verification run.

The owner authorized a targeted source-only remediation on `feature/project-foundation`. The corrections below do not introduce dependencies, persistence implementation, new application features, or changes to `RAIDSPHERE_CONTEXT.md`.

### F1: Snapshot invariants

- Voting and selecting require a nonempty candidate pool and a deadline after creation.
- The chosen candidate remains null until selection is complete.
- Vote-count keys must refer to languages present in the session pool, including keys with zero counts.
- Chosen, pending-raid, completed, and unknown outcomes require a selected candidate.
- Any selected candidate must match a pool entry by identity and language. Refreshed display metadata, such as title or viewer count, is allowed.
- Failed/cancelled snapshots may have an empty pool only with empty votes and no selected candidate.
- Existing uniqueness, timestamp, privacy, and channel-ownership constraints remain.

Regression cases exercise these rules through `serverEventSchema`. Existing valid event fixtures are retained. Previously accepted inconsistent states are intentionally rejected; wire fields are unchanged.

### F2: Authoritative public event validation

`serverEventSchema` and `clientMessageSchema` are the only runtime validator exports from `shared/events.ts`. Consumers use their `parse`/`safeParse` methods. Per-event structural schemas and the handshake implementation schema are private, while all existing named event types remain exported.

Developers importing individual event schemas must migrate those imports to the canonical validator. Public model schemas remain available for model validation, but cannot replace event-level parsing. Regression cases check the runtime export surface, canonical rejection behavior, and representative named-event type compatibility. No protocol version, event name, or payload field changes are introduced.

### F3: TypeScript coverage

`shared/tsconfig.test.json` and `server/tsconfig.test.json` cover their source and test files with `noEmit`. `overlay/tsconfig.node.json` checks Vite configuration using Node module resolution and types, separately from browser code. Production build configurations are unchanged and continue excluding tests.

The root `typecheck` script builds shared exports first and then invokes each workspace's type-check script. This preserves the documented shared-build output; test/tooling checks themselves do not emit artifacts. `skipLibCheck` remains unchanged, so this does not claim exhaustive checking of third-party declaration files.

### F4: Strict decimal ports

Raw `PORT` input must contain one to five ASCII decimal digits before conversion, then satisfy the existing 1–65535 integer range. Missing input still defaults to 3000; loopback binding is unchanged. Leading zeroes are allowed within the length bound. Signs, whitespace (including final line terminators), hexadecimal, exponent, fractional, and non-ASCII inputs are rejected without echoing configuration values in application errors.

Regression cases cover valid boundaries, leading zeroes, missing input, and invalid representations. Previously accepted alternate numeric representations are intentionally incompatible.

### F5: Credential filename protection

`.gitignore` additionally excludes `.netrc`, `_netrc`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `id_ecdsa_sk`, and `id_ed25519_sk`. Exact filename patterns avoid unnecessarily ignoring public-key files. Existing ignore rules and example-file exceptions remain.

The authorized read-only synthetic ignore check passed: all 12 expected ignored paths matched, and all five expected non-ignored paths remained unignored. Direct command arguments avoided the earlier stdin line-ending ambiguity. No synthetic credential files were created or opened. This result verifies the tested ignore patterns only. Ignore rules do not protect tracked or forcibly added secrets and do not replace publication review.

### Remaining scope

The proposed internal Twitch, translation, and coordinator interfaces remain a separate, unimplemented proposal. No files for those interfaces are included in this remediation.

## Phase 1 verification results

Verification ran on 2026-10-27 with Node.js 20.18.0 and npm 10.8.2 on Windows. No runtime or package-manager upgrade was performed, and no security control was disabled.

### Environment and connectivity

The npm registry was reachable over HTTPS from the verification environment. The earlier HTTPS failure was specific to another environment; its cause remains unknown and is not attributed to RaidSphere or its dependencies.

In Windows PowerShell, `npm` runs through `npm.cmd`, and the command interpreter removes `^` from arguments. Registry queries such as `npm view "vite@^6.1.0"` therefore silently query an exact version. Query a major version (`npm view vite@6 version`) or an exact version instead. Ranges inside `package.json` are unaffected.

When the repository is inside a synchronized OneDrive folder, pausing synchronization during installation and builds avoids uploading generated dependency trees and reduces the risk of locked files.

### Dependency corrections

| ID | Finding | Correction |
| --- | --- | --- |
| V1 | `fastify@5.12.7` resolved `light-my-request@6.8.0`, which requires the ESM-only `cookie@2` (`node >=22`) through CommonJS `require()`. `app.inject()` failed with `ERR_REQUIRE_ESM` on Node.js 20.18. | Root `overrides` pins `light-my-request` to `6.6.0`, which uses `cookie@1` and satisfies Fastify's `^6.0.0` range. The production server does not load this package; it is used by `inject()`. |
| V2 | `npm audit` reported critical and moderate advisories in `vitest@3`, `@vitest/mocker`, and `tinypool` (development tooling only). | `vitest` raised to `^4.1.12`. It declares Node.js 20 support, accepts Vite 6, and no longer depends on `tinypool`. No test changes were required. |
| V3 | `npm audit` reported a high-severity advisory for `zod <4.6.6` (memory exhaustion while validating oversized constrained collections). | `zod` raised to `^4.6.7` in `shared` and `server`. See [Zod 4 migration](#zod-4-migration). |

An override added after a lockfile exists is not applied by `npm install` alone; `npm update light-my-request --ignore-scripts --no-audit --no-fund` re-resolved it. After the Zod upgrade, `npm dedupe` was required to hoist a single Zod copy instead of one per workspace.

Resolved versions of the direct dependencies:

| Package | Version | Package | Version |
| --- | --- | --- | --- |
| typescript | 5.9.3 | fastify | 5.12.7 |
| vite | 6.4.5 | light-my-request (override) | 6.6.0 |
| vitest | 4.1.12 | ws | 8.22.0 |
| globe.gl | 2.32.0 | zod | 4.6.7 |
| three (transitive) | 0.186.1 | cookie (transitive) | 1.1.1 |

### Source corrections

| ID | File | Finding | Correction |
| --- | --- | --- | --- |
| V4 | `server/src/app.ts` | Fastify 5.12 types the `setErrorHandler` error as `unknown`; reading `error.statusCode` failed type checking and the server build. | A `clientErrorStatus(error: unknown)` helper narrows the value and trusts only an integer 4xx status; anything else returns 500. Response bodies remain generic. |
| V5 | `overlay/src/main.ts` | Rendering paused on the first animation frame while three-globe still kept the scene hidden until the globe layer was ready, leaving an empty canvas. | Rendering continues until `onGlobeReady`. |
| V6 | `overlay/src/main.ts` | globe.gl applies `width`/`height` changes asynchronously. Pausing on the next frame drew before the resize was applied, and the resize then cleared the canvas, so the globe disappeared after resizing. | `renderBriefly()` resumes rendering and pauses after a 250 ms settle period; it handles both readiness and resize. `pagehide` clears the pending timer. |
| V7 | `overlay/src/main.ts` | `pointOfView()` ran before controls were disabled, so it only updated the controls target; the camera was never re-aimed and the globe rendered off-center. | Controls are disabled before `pointOfView()`, which then orients the camera directly. |

V5–V7 are runtime rendering defects that static review could not detect.

### Zod 4 migration

- `voteCountsSchema` uses `z.partialRecord(languageCodeSchema, countSchema)`. In Zod 4, `z.record` with enum keys requires every key, which would reject partial vote counts.
- Custom issues use `code: 'custom'` instead of the deprecated `z.ZodIssueCode.custom`.
- The `notification()` helper constrains payloads with `z.ZodType` instead of the removed `z.ZodTypeAny`.

Wire event names, fields, and validation rules are unchanged; all contract tests pass without modification. Module owners must use Zod 4 for any new schema. Deprecated but supported Zod 4 APIs remain in use (`.strict()`, `z.string().url()`, `message` in refinements, `.safe()`); migrating them is optional cleanup.

### Results

| Check | Result |
| --- | --- |
| `npm install --ignore-scripts --no-audit --no-fund` | Succeeded; no lifecycle script was required. |
| `npm audit` | 0 vulnerabilities. |
| `npm run typecheck` | Passed for shared, server, overlay, and Vite configuration. |
| `npm test` | 63 of 63 tests passed (38 shared contract, 25 server). |
| `npm run build` | Passed. Vite warns that the overlay bundle (~2.04 MB, ~578 kB gzip) exceeds 500 kB, mostly because of three.js. |
| Backend smoke test | `GET /health` returned 200 with `Cache-Control: no-store` and the expected body; an unknown route returned 404; a `/ws` upgrade returned 503 without reflecting the query string; another upgrade path returned 404; the server listened only on `127.0.0.1:3000`. |
| Overlay browser check | At `/fixture/overlay`, the globe rendered centered at load and after resizing to 1280×720 and 1920×1080; `html` and `body` backgrounds were transparent; no console errors from the application; every request targeted `127.0.0.1:5173`. |
| OBS check | OBS Studio 32.2.2 browser source at 1920×1080 over a color source: the background was transparent, the globe was centered, and the status panel was visible. OBS reported about 1% CPU at 30 FPS. |
| Post-merge check on `main` | After PR #1 (`b89ed23`), a clean install from the lockfile left it unchanged; `npm audit` reported 0 vulnerabilities; type checking, 63 of 63 tests, and the build passed. |

### Remaining limitations

- The purple atmosphere has low contrast over bright backgrounds; visual tuning belongs to later Module A work.
- The overlay bundle size warning is not addressed; code splitting belongs to later Module A work.
- Contract follow-ups for team review: require `sessionId` on raid-related `error` events, validate `roulette:chosen.toCountry` against the candidate, and derive the `languages` maximum from the language enum instead of the literal `7`.
- Viewing authorization, real-time subscriptions, Twitch, translation, roulette, and persistence remain unimplemented.

## Deferred work and decisions

- Implement viewing authorization before any channel subscription or data publication.
- Revalidate Twitch documentation before Module B work. The historical `chat:read`/`chat:edit` examples do not match the previously reviewed EventSub/Helix `user:read:chat`/`user:write:chat` path.
- Confirm broadcaster/moderator control policy and the authorization model for each Twitch operation.
- Define tie, no-vote, candidate eligibility, overlapping window, retention, and reputation policies.
- Handle lost events and ambiguous external outcomes without assuming raid success or blindly retrying.
- Revalidate rate-limit buckets and actual subscription costs instead of hard-coding independent endpoint budgets.
- Choose the AI provider/model and validate hackathon requirements. A second-provider fallback is not approved.
- Keep untranslated fallback content explicitly untranslated; never silently widen broadcaster preferences.
- Implement moderation deletion, bounded translation queues/cache, expiry, and provider data-minimization controls.
- Add actual globe animation, countries, votes, cards, welcome messages, and translation rendering in their later module tasks.
- Select deployment and SQLite operational designs separately. No hosting, release, or public exposure is authorized.

## Next authorization gates

Phase 1 integration is complete: the verification changes and `package-lock.json` were reviewed and merged into `main` through PR #1.

1. Create module branches from the latest `main`.
2. Coordinate the contract follow-ups and internal B/C/D interfaces before parallel module work.

No gate authorizes commits, remote operations, publication, unrelated file access, or elevated filesystem permissions.

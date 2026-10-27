# Phase 1 foundation decisions

## Status and authority

This record describes the approved direction, the foundation source written for it, and remaining limitations. Source creation is not evidence of successful installation, compilation, execution, or security verification.

The project owner approved TypeScript, a modular monolith, Fastify, Vite, globe.gl, ws, top-level `overlay/`, `server/`, `shared/`, canonical commands `!roulette`, `!vote`, `!cancel`, and contracts in `shared/events.ts`. The owner subsequently approved npm workspaces and shared Zod contracts for file implementation.

The installed baseline previously inspected was Node.js 20.18.0 and npm 10.8.2. `.nvmrc` records that baseline; no runtime or package-manager upgrade is authorized. Engine declarations are not a claim about upstream support status.

All Phase 1 implementation belongs on `feature/project-foundation`. The branch was created from the previously verified matching local `main` and locally recorded `origin/main`. Remote freshness is not implied.

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

The Vite development server also defaults to loopback. The overlay uses a static, procedural globe with no remote texture or geographic requests. Rendering pauses after drawing and resumes for resize. Configure the OBS browser source to 1920 by 1080 when an actual OBS check is authorized. No OBS check has occurred.

## Persistence

`server/src/persistence/contracts.ts` defines repositories for streamers, sessions, translation windows, and atomic arrival/reputation recording. Session writes specify optimistic concurrency and one active roulette per channel. These are requirements for a future adapter, not implemented guarantees.

No SQLite dependency, driver, connection configuration, database file, schema, migration, JSON backup, or persistence I/O is included. Credentials need a separately designed server-only storage interface before OAuth implementation.

## Dependencies and verification status

Manifest versions are provisional declarations, not a verified dependency graph. Node 20-compatible tooling was targeted, with Vite constrained to major 6 rather than implicitly installing an unrestricted release. globe.gl is pinned to the factory API used by the preview. Registry availability, engine compatibility, transitive dependencies, type compatibility, and security advisories require separately authorized checks before installation. No current package support or vulnerability claim is made.

No dependencies were installed, no lockfile was generated, and no tests, type checks, builds, application servers, or external services were executed during file authoring. Shared and backend tests are written but unexecuted. Following the F1–F5 remediation, root type checking is configured to cover source, shared/backend tests, and Vite configuration. That expanded coverage has not been executed.

## F1–F5 remediation: authored, not verified

The owner authorized a targeted source-only remediation on `feature/project-foundation`. The corrections below do not introduce dependencies, persistence implementation, new application features, or changes to `RAIDSPHERE_CONTEXT.md`. Their effectiveness remains unverified until separately authorized checks succeed.

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

The authorized read-only synthetic ignore check passed: all 12 expected ignored paths matched, and all five expected non-ignored paths remained unignored. Direct command arguments avoided the earlier stdin line-ending ambiguity. No synthetic credential files were created or opened. This result verifies the tested ignore patterns only; dependency installation, lockfile generation, type checking, tests, builds, and runtime checks remain incomplete. Ignore rules do not protect tracked or forcibly added secrets and do not replace publication review.

### Remaining scope

The proposed internal Twitch, translation, and coordinator interfaces remain a separate, unimplemented proposal. No files for those interfaces are included in this remediation. Dependency compatibility, security advisories, tests, compilation, browser/OBS behavior, and final Git state require later authorized verification.

## Deferred work and decisions

- Select and verify dependency versions without upgrading the installed runtime automatically.
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

1. Review the authored files and dependency declarations.
2. Approve exact registry metadata queries and any resulting version adjustments.
3. Approve installation with lifecycle scripts disabled and lockfile creation.
4. Approve type checking, tests, builds, and relevant Git inspection commands.
5. Review results before authorizing runtime/OBS checks or further implementation.

No gate authorizes commits, remote operations, publication, unrelated file access, or elevated filesystem permissions.

# Phase 2 backend decisions (Module D)

## Status and authority

This record collects the decisions taken while building the Phase 2 backend (Module D) on `feature/backend-core`. It continues [Phase 1 decisions](phase-1-decisions.md), which stays authoritative for everything not changed here. Progress across all modules is tracked in the [phase plan](phase-plan.md).

`RAIDSPHERE_CONTEXT.md` is preserved historical context. Where this record differs from it, this record wins for Module D.

Each entry uses one of these statuses:

| Status | Meaning |
| --- | --- |
| PENDING | Needs a decision before implementation. |
| PROPOSED | Recommendation written down; not yet approved. |
| APPROVED | Approved by the project owner (and by affected module owners when a shared contract changes). |
| IMPLEMENTED | Source exists; not yet verified by tests or execution. |
| VERIFIED | Implemented and covered by checks that were actually run; the evidence is recorded. |
| SUPERSEDED | Replaced by a later entry, which is linked. |
| DEFERRED | Intentionally postponed: neither decided nor implemented in Phase 2. The entry says when to revisit it. |

## Scope

Phase 2 goal for Module D: a local roulette flow with authoritative state, synthetic channels, 30-second voting, and selection, feeding a synchronized globe (milestones M2 and M3 in the [phase plan](phase-plan.md)).

In scope for Module D:

- Roulette session lifecycle and state machine.
- Vote validation and aggregation, deadline enforcement, and winner/candidate selection.
- Command intake for `!roulette`, `!vote`, and `!cancel` through an internal interface. Twitch is simulated in this phase.
- Synthetic candidate pool and demo fixtures, clearly marked as synthetic.
- Building channel-scoped events and validating them with `serverEventSchema` before publication.
- Internal interfaces that Modules B and C will implement later.

Out of scope for Phase 2 unless a later entry approves it:

- Real Twitch OAuth, EventSub, Helix calls, or raids (Module B, Phase 3).
- AI translation providers (Module C, Phase 4).
- SQLite or any persistence I/O. Persistence stays at the interface level.
- Public deployment, or binding to anything other than loopback.

## Baseline inherited from Phase 1

- Branch `feature/backend-core` starts from `main` at `4086024` (merge of PR #2, which follows the Phase 1 merge `b89ed23`).
- Node.js 20.18.0 and npm 10.8.2; Fastify 5, ws 8, Zod 4. New schemas must use Zod 4.
- `server/src/app.ts`: `/health` only; it reports `channelSubscriptions: false` and `controlCommands: false`.
- `server/src/websocket.ts`: `/ws` upgrades return 503 until viewing authorization exists.
- `server/src/persistence/contracts.ts`: repository interfaces only. `StoredRouletteSession` keeps `votesByUser` server-side, uses optimistic versioning, and allows one active session per channel.
- `shared/schemas.ts`: the roulette statuses are `voting`, `selecting`, `chosen`, `raid_pending`, `done`, `cancelled`, `failed`, and `unknown`. The F1 snapshot invariants apply to every public state the backend produces.
- Baseline checks on `main`: 63/63 tests, typecheck, and build passed (see [Phase 1 verification results](phase-1-decisions.md#phase-1-verification-results)). They have not been re-run on this branch yet.

## Open decisions

These items are carried over from the [phase plan](phase-plan.md#decisions-before-parallel-development) and the [Phase 1 deferred work](phase-1-decisions.md#deferred-work-and-decisions). Each needs an entry in the decision log before the code that depends on it is written.

| ID | Topic | Question | Status |
| --- | --- | --- | --- |
| Q1 | Ties | How is a tie between the leading languages resolved (for example, random among the tied languages, as in the historical spec)? | APPROVED ([D2-02](#d2-02-resolve-ties-by-uniform-random-draw-among-tied-languages)) |
| Q2 | Zero votes | What happens when voting ends with no valid votes: random language, cancellation, or `failed`? | APPROVED ([D2-03](#d2-03-treat-zero-votes-as-a-tie-among-all-pool-languages)) |
| Q3 | Vote rules | Is the latest vote per user the one that counts? How are votes for a language outside the pool handled? Are late votes ignored? | APPROVED ([D2-04](#d2-04-vote-acceptance-rules)) |
| Q4 | Command authorization | Who can run `!roulette` and `!cancel` (broadcaster only, or moderators too)? How is this represented in the simulated command input? | APPROVED ([D2-05](#d2-05-command-authorization-for-roulette-and-cancel)) |
| Q5 | Candidate eligibility | Which filters apply in Phase 2 (language preferences, viewer range, exclusion of the source channel)? The pool must never silently widen beyond the configured preferences. | APPROVED ([D2-06](#d2-06-candidate-eligibility-and-selection)) |
| Q6 | State transitions | The allowed transitions between the eight statuses, which states are terminal, and when a new session may start on the same channel. | APPROVED ([D2-07](#d2-07-roulette-session-state-machine)) |
| Q7 | Vote broadcast cadence | How often `roulette:votes` is emitted (every 2 s, on change, or throttled). | APPROVED ([D2-08](#d2-08-throttled-vote-count-broadcasts)) |
| Q8 | Clock and timers | How the backend gets time and schedules deadlines so tests can run deterministically (an injected clock and scheduler). | APPROVED ([D2-09](#d2-09-injected-clock-scheduler-and-random-source)) |
| Q9 | Event publication | Who assigns `eventId` and the per-channel `sequence`, and how events reach the overlay while `/ws` is closed (an internal publisher interface; a local transport only after authorization). | APPROVED ([D2-10](#d2-10-single-event-publisher), [D2-11](#d2-11-read-only-viewing-authorization-for-ws)) |
| Q10 | In-memory state | Whether Phase 2 keeps sessions in an in-memory implementation of the repository interfaces. That would be in-process memory, not persistence I/O, so it stays within the Phase 1 restriction; confirm. | APPROVED ([D2-12](#d2-12-in-memory-state-and-synthetic-fixtures)) |
| Q11 | Internal B/C/D contracts | Normalized chat command input, raid request/outcome adapter, arrival event, and translation request/result interfaces. | APPROVED ([D2-13](#d2-13-internal-ports-between-the-roulette-logic-and-adapters)); translation, moderation, and vote aliases deferred |
| Q12 | Shared contract follow-ups | Require `sessionId` on raid-related `error` events; validate `roulette:chosen.toCountry` against the candidate; derive the `languages` maximum from the enum instead of `7`. Possibly add an error code for "no eligible candidates" (see D2-06). Coordinate with all module owners. | APPROVED ([D2-14](#d2-14-shared-contract-follow-ups)) |
| Q13 | Raid outcomes in a simulation | How a simulated raid shows queued, confirmed, failed, cancelled, and uncertain outcomes without claiming that a real Twitch raid happened. | APPROVED ([D2-15](#d2-15-simulated-raid-outcomes)) |
| Q14 | Reputation | How reputation is credited (amount, conditions, whether `unknown` outcomes count) and what it is used for. Raised during plan step 3; listed as undecided in [Phase 1 deferred work](phase-1-decisions.md#deferred-work-and-decisions). | DEFERRED ([D2-17](#d2-17-defer-reputation-raid-logs-and-translation-window-storage)) |

## Decision log

Add new entries at the end. Do not rewrite an entry after it is approved; supersede it with a new one. Use this format:

```md
### D2-NN: Short title

- **Status:** PENDING | PROPOSED | APPROVED | IMPLEMENTED | VERIFIED | SUPERSEDED (by D2-NN)
- **Date:** YYYY-MM-DD
- **Resolves:** Q-ID, if any
- **Decided by:** role (for example, project owner, or Module D owner with Module A review)
- **Context:** Why the decision is needed.
- **Decision:** What was decided, stated so it can be tested.
- **Alternatives considered:** Options rejected and why.
- **Consequences:** Effects on code, contracts, other modules, and security.
- **Affected files:** Repository-relative paths.
- **Verification:** Checks that were run and their results, or "not verified".
```

### D2-01: Record Phase 2 backend decisions in a dedicated document

- **Status:** APPROVED
- **Date:** 2026-10-28
- **Resolves:** none
- **Decided by:** project owner
- **Context:** Phase 2 backend work will produce decisions that do not belong in the closed Phase 1 record.
- **Decision:** Record Module D Phase 2 decisions, overrides, and limitations in `docs/phase-2-backend-decisions.md`. `docs/phase-1-decisions.md` stays the record of Phase 1.
- **Alternatives considered:** Appending to `docs/phase-1-decisions.md`, which would mix a closed phase with active work.
- **Consequences:** Other modules may keep their own Phase 2 records. Decisions that touch shared contracts must also be reflected wherever those modules record them.
- **Affected files:** `docs/phase-2-backend-decisions.md`
- **Verification:** Not applicable (documentation only).

### D2-02: Resolve ties by uniform random draw among tied languages

- **Status:** APPROVED
- **Date:** 2026-10-28
- **Resolves:** Q1
- **Decided by:** project owner
- **Context:** When voting ends, two or more languages can share the highest vote count. The backend needs one winning language to publish `roulette:chosen`.
- **Decision:** If several languages share the highest nonzero count, the backend picks one of them uniformly at random. Languages below the highest count are never chosen. The random source is injected into the roulette logic so tests can make the draw deterministic. Choosing a candidate inside the winning language is a separate step (see Q5).
- **Alternatives considered:**
  - First language to reach the count: deterministic, but needs per-vote timestamps and rewards early voting.
  - Extra tie-break voting round: changes the fixed 30-second duration and needs a new state or event in `shared/`.
  - Random draw over all candidates of the tied languages: gives an advantage to languages with more candidates despite equal votes.
- **Consequences:** No shared contract change; `roulette:chosen` already carries only `winningLanguage`. Public events do not say that a tie occurred. The zero-vote case is not covered here (see Q2).
- **Affected files:** `server/src/application/selection.ts`, `server/test/selection.test.ts`; future coordinator in `server/src/`.
- **Verification:** Partial (plan step 4, 2026-10-28): `winningLanguage` draws only among the tied highest languages, as a pure function tested in `server/test/selection.test.ts`. Use by the coordinator is verified in step 6.

### D2-03: Treat zero votes as a tie among all pool languages

- **Status:** APPROVED
- **Date:** 2026-10-28
- **Resolves:** Q2
- **Decided by:** project owner
- **Context:** Voting can end without any valid vote. The backend needs a defined outcome for that case.
- **Decision:** If no valid vote was counted when voting ends, every language in the session pool is treated as tied at zero, and D2-02 applies: one pool language is chosen uniformly at random with the injected random source. The session then continues to selection as usual.
- **Alternatives considered:**
  - Cancel the session with `raid:cancelled` (`session_cancelled_before_request`): avoids an unrequested destination, but the overlay could not distinguish "no votes" from a user cancellation.
  - Mark the session `failed` with an `error` event: no existing error code describes this case, so `shared/events.ts` would need a coordinated change.
  - Random draw over all candidates: favors languages with more candidates, which D2-02 already rejected.
- **Consequences:** No shared contract change. A destination can be selected without chat participation. The broadcaster's ability to cancel after selection is defined separately (see Q6 and Q13). In Phase 2 no real raid is executed.
- **Affected files:** `server/src/application/selection.ts`, `server/test/selection.test.ts`; future coordinator in `server/src/`.
- **Verification:** Partial (plan step 4, 2026-10-28): with zero votes every pool language ties at zero, so the same `winningLanguage` rule draws among all of them; tested in `server/test/selection.test.ts`. Use by the coordinator is verified in step 6.

### D2-04: Vote acceptance rules

- **Status:** APPROVED
- **Date:** 2026-10-28
- **Resolves:** Q3
- **Decided by:** project owner
- **Context:** The backend needs testable rules for which votes count during the voting window.
- **Decision:**
  1. **One fixed vote per user.** A user's first valid vote is final. Any later vote from the same user is ignored, even if it names another valid language.
  2. **Invalid votes do not count.** A vote for a language that is not in the session pool, or that is not a supported language code, is ignored silently: it is not counted, emits no event, and does not use up the user's vote. The user can still cast a valid vote before the deadline.
  3. **Late votes do not count.** A vote received by the backend at or after `votingEndsAtMs` is ignored. The deadline is exclusive and measured with the server's injected clock (see Q8), not with the chat message timestamp.
  4. **Anyone in chat can vote**, including the broadcaster and moderators, one vote each. Users are identified by their stable user ID, never by login or display name.
  5. **The backend receives normalized language codes** (for example `es`). Parsing chat text and accepting aliases such as "spanish" or "español" belongs to the command parser (Module B in Phase 3; alias list to be agreed in Q11). In Phase 2 the command simulator sends codes directly.
- **Alternatives considered:**
  - Latest vote replaces the previous one (the historical spec): lets users fix a mistake, but was rejected in favor of fixed votes.
  - Reporting invalid votes with an `error` event: `error` events reach the channel overlay, not the voter, so they would clutter the overlay.
- **Consequences:** No shared contract change. `votesByUser` in `server/src/persistence/contracts.ts` is written at most once per user per session. Public vote counts only ever increase during voting. This differs from `RAIDSPHERE_CONTEXT.md` ("latest vote replaces previous"), which stays unchanged as historical context.
- **Affected files:** `server/src/application/votes.ts`, `server/test/votes.test.ts`; future coordinator in `server/src/`.
- **Verification:** Partial (plan step 4, 2026-10-28): rules 1–3 are implemented by `castVote` and tested in `server/test/votes.test.ts`. Rules 4–5 (anyone votes by user ID; normalized codes) depend on the command path and are verified in steps 6 and 7.

### D2-05: Command authorization for `!roulette` and `!cancel`

- **Status:** APPROVED
- **Date:** 2026-10-28
- **Resolves:** Q4
- **Decided by:** project owner
- **Context:** Control commands start and stop roulette sessions and, from Phase 3, real raids. The backend needs a clear rule for who may issue them and where that role comes from.
- **Decision:**
  1. **`!roulette`** is accepted from the channel's broadcaster and its moderators.
  2. **`!cancel`** is accepted from the channel's broadcaster and its moderators.
  3. **Unauthorized commands are ignored silently**: no state change, no event, no reply (consistent with D2-04).
  4. **Roles come from the adapter, never from message text.** The normalized command the backend receives carries the issuer's stable user ID and a role (`broadcaster`, `moderator`, or `viewer`). The broadcaster is the user whose ID equals the channel ID. In Phase 3, Module B derives roles from Twitch data; in Phase 2, the command simulator assigns them.
  5. **The Phase 2 simulator is internal only.** It is in-process code used by tests and a local demo script that call the roulette logic directly. It is not an HTTP or WebSocket endpoint and grants no remote control capability, because control must not be exposed before server-side authorization exists (`AGENTS.md`). Details are settled in Q9 and Q11.
- **Alternatives considered:**
  - Broadcaster only for `!roulette`: more control, less flexibility while the streamer is busy.
  - Broadcaster only for `!cancel`: more cautious for an in-progress raid, but rejected so moderators can stop an unwanted raid.
- **Consequences:** No shared contract change. In Phase 3, cancelling a raid on Twitch uses the broadcaster's token even when a moderator issues `!cancel`; Module B must confirm that this is allowed and how it is authorized. `/health` keeps reporting `controlCommands: false` because no remote control path exists.
- **Affected files:** Future roulette logic and command interface in `server/src/` (not written yet).
- **Verification:** Not verified (no code yet).

### D2-06: Candidate eligibility and selection

- **Status:** APPROVED; rule 4 amended by [D2-14](#d2-14-shared-contract-follow-ups)
- **Date:** 2026-10-28
- **Resolves:** Q5
- **Decided by:** project owner
- **Context:** The backend builds the candidate pool when a roulette starts and later picks one candidate from the winning language. Eligibility must respect configured preferences and never widen silently.
- **Decision:**
  1. **Basic exclusions.** The source channel is never a candidate. Only registered RaidSphere streamers that are live are eligible. In Phase 2, "live" comes from synthetic fixture data.
  2. **Viewer range.** A candidate is eligible only if its current viewer count is within the source streamer's `minViewers`–`maxViewers` range, inclusive. The destination's own range is not applied in Phase 2.
  3. **Destination language preference.** A destination with `acceptsOtherLanguages: false` is eligible only when its language equals the source streamer's language. The source's own language may appear in the pool.
  4. **No eligible candidates.** The roulette does not start: no session is created and no event is published. Filters are never relaxed to fill the pool.
  5. **Frozen pool.** The pool is fixed when the session starts and does not change during voting (also required by the F1 snapshot invariants). If more than 100 candidates are eligible (the contract maximum), a uniform random sample of 100 is used, drawn with the injected random source.
  6. **Final pick.** After the winning language is decided (D2-02, D2-03), one candidate of that language is chosen uniformly at random with the injected random source.
- **Alternatives considered:**
  - Also applying the destination's viewer range: fairer to both sides but shrinks the pool, and the meaning of the destination range is not yet defined. Deferred.
  - Weighting the final pick by reputation: deferred until reputation rules exist.
- **Consequences:** No shared contract change. When no candidate is eligible, the overlay receives no feedback, because no existing `error` code describes that case; this is a candidate contract follow-up for Q12. Sampling down to 100 can drop a language from the pool entirely.
- **Affected files:** `server/src/application/eligibility.ts`, `server/src/application/selection.ts`, `server/test/eligibility.test.ts`, `server/test/selection.test.ts`; future coordinator in `server/src/`.
- **Verification:** Partial (plan step 4, 2026-10-28): rules 1–3, 5, and 6 are implemented as pure functions and tested, including the demo source pool (`rsdemo_en_01`, `rsdemo_es_02`, `rsdemo_pt_01`, `rsdemo_ja_01`, `rsdemo_ko_02`). Rule 4 (as amended by D2-14) and coordinator use are verified in step 6.

### D2-07: Roulette session state machine

- **Status:** APPROVED
- **Date:** 2026-10-28
- **Resolves:** Q6
- **Decided by:** project owner
- **Context:** `shared/schemas.ts` defines eight roulette statuses but not the allowed transitions, the events they produce, or when a new session may start.
- **Decision:**
  1. **Transitions.** Only these transitions are allowed; any other is a programming error.

     ```text
                  !roulette (authorized, eligible pool, no active session)
                       │
                       ▼
                   voting ──── !cancel ─────────────────────► cancelled
                       │ voting deadline reached               ▲
                       ▼                                       │
                  selecting (instantaneous)                    │
                       │                                       │
                       ▼                                       │
                    chosen ─── !cancel before raid request ────┤
                       │ │                                     │
                       │ └── raid request rejected ──► failed  │
                       │ raid request accepted                 │
                       ▼                                       │
                 raid_pending ── confirmed !cancel ────────────┘
                       │ │
                       │ └── uncertain outcome ──► unknown
                       │ arrival observed
                       ▼
                     done
     ```

  2. **Active and terminal states.** `voting`, `selecting`, `chosen`, and `raid_pending` are active; at most one active session exists per channel. `done`, `cancelled`, `failed`, and `unknown` are terminal.
  3. **Events per transition.** All events already exist in `shared/events.ts`.

     | Transition | Event |
     | --- | --- |
     | start → `voting` | `roulette:start` |
     | `voting` → `selecting` → `chosen` | `roulette:chosen` |
     | `voting` or `chosen` → `cancelled` | `raid:cancelled` with `reason: session_cancelled_before_request` |
     | `chosen` → `raid_pending` | `raid:started` |
     | `raid_pending` → `cancelled` | `raid:cancelled` with `reason: user_cancelled` |
     | `chosen` → `failed` | `error` with `RAID_REJECTED` |
     | `raid_pending` → `unknown` | `error` with `RAID_OUTCOME_UNKNOWN` |
     | `raid_pending` → `done` | `raid:arrived`, published to the destination channel |

     `selecting` is an instantaneous internal state with no event of its own; it may appear in a snapshot.
  4. **Automatic raid request.** The backend requests the raid as soon as a candidate is chosen, without waiting for a command or for overlay animation. Visual timing belongs to Module A and never drives state. How the request is simulated in Phase 2 is decided in Q13.
  5. **Out-of-place commands are ignored silently**: `!roulette` while a session is active, `!cancel` with no active session, and `!cancel` during the instantaneous `selecting` state.
  6. **New sessions.** A new session may start as soon as the previous one reaches a terminal state. No cooldown in Phase 2.
  7. **Last session in snapshots.** The most recent terminal session remains in `state:snapshot` until a new session starts, so a reconnecting overlay sees the final outcome.
- **Alternatives considered:** Waiting for a confirmation command or for the overlay animation before requesting the raid; rejected because visual timing must not decide state and an extra command slows the flow.
- **Consequences:** No shared contract change. Phase 3 must revisit a cooldown for Twitch's raid rate limit (historically 10 requests per 10 minutes; revalidate) and whether `unknown` should block a new session while a real raid may still be in progress.
- **Affected files:** Future roulette logic in `server/src/` (not written yet).
- **Verification:** Not verified (no code yet).

### D2-08: Throttled vote count broadcasts

- **Status:** APPROVED
- **Date:** 2026-10-28
- **Resolves:** Q7
- **Decided by:** project owner
- **Context:** Overlays need live vote bars. `roulette:votes` carries only aggregate counts and their total; the countdown is computed by the overlay from `votingEndsAtMs` in `roulette:start`.
- **Decision:**
  1. **Counting is separate from broadcasting.** Every valid vote is counted in the backend's session state when it is received (D2-04). The broadcast throttle only limits outgoing notifications; it never delays, drops, or batches votes.
  2. **Throttle on change.** At most one `roulette:votes` per second per session, sent only if the counts changed since the previous one.
  3. **Final counts.** When voting closes, a final `roulette:votes` with the definitive counts is sent immediately before `roulette:chosen`, unless the counts have not changed since the last one sent.
  4. **No initial event.** No `roulette:votes` is sent at session start; overlays treat all counts as zero after `roulette:start`.
  5. **Configurable interval.** The 1-second interval is a server constant that can change without a contract change.
- **Alternatives considered:**
  - Fixed 2-second broadcast (the historical spec): predictable, but sends unchanged events and makes small-channel bars lag up to 2 s.
  - One event per vote: immediate, but unbounded under heavy voting.
- **Consequences:** No shared contract change. Outgoing vote traffic is bounded at about 30 events per 30-second session, regardless of chat size. Each event carries absolute totals rather than increments, so an overlay that misses one recovers with the next event or a snapshot. Inbound load is not covered here: in Phase 3, chat messages that reach the backend late (for example, during an EventSub reconnection) may arrive after the deadline and be ignored under D2-04 rule 3, and messages Twitch never delivers cannot be counted. Module B must measure and report this; it may justify revisiting the deadline rule.
- **Affected files:** Future roulette logic and event publisher in `server/src/` (not written yet).
- **Verification:** Not verified (no code yet).

### D2-09: Injected clock, scheduler, and random source

- **Status:** APPROVED
- **Date:** 2026-10-28
- **Resolves:** Q8
- **Decided by:** project owner
- **Context:** Deadlines, vote throttling, and random draws must be testable without waiting in real time and without nondeterministic results.
- **Decision:**
  1. **Injected dependencies.** The roulette logic receives a clock (current time in Unix milliseconds), a scheduler (run a callback after a delay, and cancel it), and the random source from D2-02. Production wiring uses the real implementations; tests use controllable fakes that are advanced manually.
  2. **Absolute deadlines.** Deadlines are stored as absolute instants (`votingEndsAtMs`), never as remaining durations. A timer that fires late is still evaluated against the stored instant.
  3. **Stale timers do nothing.** When a timer fires, the backend first checks that the session still exists and is still in the expected state. If not, the callback has no effect.
  4. **Timer cleanup.** When a session is cancelled or reaches a terminal state, all of its pending timers are cancelled.
- **Alternatives considered:** Vitest fake timers (`vi.useFakeTimers`) without injection: less code, but couples the logic to the test tool and leaves randomness uncontrolled.
- **Consequences:** No shared contract change and no new dependency. Domain logic does not call `Date.now()`, `setTimeout`, or `Math.random()` directly.
- **Affected files:** `server/src/application/ports.ts`, `server/src/application/runtime.ts`, `server/test/support/fakes.ts`; future roulette logic and server composition in `server/src/`.
- **Verification:** Partial (plan step 2, 2026-10-28): clock, scheduler, and random ports, their production implementations, and deterministic test fakes exist and pass `server/test/runtime.test.ts`. Rules 2–4 are verified when the coordinator uses them (step 6).

### D2-10: Single event publisher

- **Status:** APPROVED
- **Date:** 2026-10-28
- **Resolves:** Q9 (event building and in-process delivery)
- **Decided by:** project owner
- **Context:** Events need unique IDs, ordered per-channel sequences, validation, and strict channel isolation, no matter which transport delivers them.
- **Decision:**
  1. **One publisher.** A single backend component is the only producer of server events.
  2. **Identity and order.** It assigns `eventId` (a random UUID) and a per-channel `sequence` that starts at 0 and increases by one for each event, within one server lifetime. Sequences are not durable replay cursors (unchanged from Phase 1).
  3. **Validation before delivery.** Every event is parsed with `serverEventSchema` before delivery. An event that fails validation is not delivered and is reported as an internal error; in tests this fails the test.
  4. **Channel isolation.** Subscribers subscribe to one channel and receive only that channel's events.
  5. **In-process subscribers.** Tests and the local demo script subscribe directly in process. The WebSocket transport (D2-11) is one more subscriber, not a separate path.
- **Alternatives considered:** Letting each component build its own events: duplicates sequencing and makes skipping validation possible.
- **Consequences:** No shared contract change. Module A can work with recorded, schema-valid event sequences until the WebSocket client is connected.
- **Affected files:** `server/src/application/publisher.ts`, `server/test/publisher.test.ts`.
- **Verification:** Implemented on 2026-10-28 (plan step 5); `npm run typecheck` passed and `npm test` passed 114/114 (6 publisher tests). Implementation details approved by the project owner: invalid events take no sequence number and are reported without content; a failing subscriber does not stop delivery to the others; `issue()` builds and validates a per-connection event (such as `state:snapshot`) without broadcasting it, taking the next sequence number so clients can order later events after it. Sequences therefore increase per channel but may have gaps for a given subscriber. Rule 5 (the WebSocket transport as a subscriber) is verified in step 8.

### D2-11: Read-only viewing authorization for `/ws`

- **Status:** APPROVED; rule 7 amended by [D2-16](#d2-16-print-only-demo-channel-overlay-urls)
- **Date:** 2026-10-28
- **Resolves:** Q9 (transport to the overlay)
- **Decided by:** project owner
- **Context:** Milestone M3 needs a connected overlay, but `/ws` must stay closed until server-side authorization exists (`AGENTS.md`). A simplified, read-only viewing authorization is approved for Phase 2.
- **Decision:**
  1. **Credential.** At startup the server generates one random viewing credential per channel, keeps it only in memory, and regenerates it on every restart. Nothing is written to disk. Credentials are compared in constant time.
  2. **Connection rules.** Upgrades are accepted only on `/ws` and only from the overlay origin (`http://127.0.0.1:5173`, a server constant). Requests without an `Origin` header are rejected.
  3. **Handshake.** The first client message must be a valid `auth` message (`clientMessageSchema`) received within 5 seconds. An invalid, late, or wrong message closes the connection without reflecting any input or detail.
  4. **Read-only.** After a successful `auth`, the server sends a `state:snapshot` for that channel, then live events from the publisher (D2-10). Any further client message closes the connection. No control command is ever accepted over this connection.
  5. **Limits.** At most 4 connections per channel and 16 in total. A ping every 30 seconds drops dead connections. A client whose outgoing buffer exceeds a server limit is disconnected; on reconnection it receives a fresh snapshot.
  6. **Health.** `/health` reports `channelSubscriptions: true`; `controlCommands` stays `false`.
  7. **Credential delivery (approved exception).** At startup the server prints, once, to the local terminal the OBS URL for each channel with the credential in the URL fragment, for example `http://127.0.0.1:5173/<channel>/overlay#cred=<credential>`. Browsers do not send the fragment to servers, so it does not appear in HTTP request logs. The overlay reads the fragment, sends it in `auth`, and removes it from the address bar.
  8. **Overlay client ownership.** The browser WebSocket client belongs to Module A and is coordinated with its owner. Module D implements only the server side.
- **Alternatives considered:**
  - In-process delivery only until a later decision: safe, but leaves M3 incomplete.
  - Opening `/ws` without authorization on loopback: forbidden by `AGENTS.md`.
  - Typing the credential into the overlay: follows the rule literally, but is awkward in OBS and must be repeated after each restart.
- **Consequences:**
  - **Exception to `AGENTS.md`.** Rule 7 places a credential in a URL fragment and in local terminal output, which `AGENTS.md` otherwise forbids. The exception is limited to Phase 2 viewing credentials: read-only, loopback-only, in memory, regenerated per restart, and never granting control. It does not apply to Twitch tokens or any other credential. Users must not share the printed URL or screen-share the terminal.
  - The server's real credential delivery and broadcaster setup flow are redesigned in Phase 3.
  - No shared contract change: `auth` and `state:snapshot` already exist.
- **Affected files:** Future changes to `server/src/websocket.ts` and `server/src/app.ts` (not written yet); overlay client in `overlay/` (Module A).
- **Verification:** Not verified (no code yet).

### D2-12: In-memory state and synthetic fixtures

- **Status:** APPROVED
- **Date:** 2026-10-28
- **Resolves:** Q10
- **Decided by:** project owner
- **Context:** The backend needs to store streamers, sessions, and votes while it runs. `AGENTS.md` forbids SQLite and any persistence I/O; the repository interfaces in `server/src/persistence/contracts.ts` already exist.
- **Decision:**
  1. **In-memory only.** Phase 2 implements the existing repository interfaces with in-process memory. No files, JSON backups, databases, or other persistence I/O. The project owner confirmed that process memory is not persistence under the `AGENTS.md` rule.
  2. **Contract guarantees.** The in-memory `compareAndSave` enforces the expected version and at most one active session per channel. Records are validated with the shared Zod schemas on write and on read, so a later persistent adapter can replace the implementation without changing the roulette logic.
  3. **Synthetic fixtures.** A small set of synthetic streamers (3 to 5 per supported language) is defined in code, not loaded from files. IDs and logins use an unmistakable prefix (for example `rsdemo_es_01`), `avatarUrl` is `null` so no external request is made, and viewer counts vary so the D2-06 filters can be exercised. Fixtures are clearly marked as synthetic and never presented as real channels.
  4. **Restart loses everything.** Sessions, votes, and viewing credentials (D2-11) are lost on restart. Reconnecting overlays receive `roulette: null` in the snapshot, and the OBS URL must be copied again because the credential changes.
- **Alternatives considered:** The historical in-memory store with JSON backup: rejected because file backup is persistence I/O.
- **Consequences:** No shared contract change and no new dependency. Persistence remains a later decision.
- **Affected files:** `server/src/persistence/memory.ts`, `server/src/persistence/contracts.ts`, `server/src/simulation/fixtures.ts`, `server/test/memory.test.ts`, `server/test/fixtures.test.ts`.
- **Verification:** Implemented on 2026-10-28 (plan step 3); `npm run typecheck` passed and `npm test` passed 90/90. Implementation details approved by the project owner: `RouletteRepository` gains `findLatestByChannel` so snapshots can show the last terminal session (D2-07 rule 7), and the in-memory repository keeps only the latest session per channel; a wrong next version throws instead of returning `false`; stored sessions also require public counts to match individual votes. Fixtures: 21 streamers (3 per language). Rule 4 (restart behavior) is verified with the server composition in step 8.

### D2-13: Internal ports between the roulette logic and adapters

- **Status:** APPROVED
- **Date:** 2026-10-28
- **Resolves:** Q11 (Phase 2 scope)
- **Decided by:** project owner (who also owns Modules B, C, and D)
- **Context:** The roulette logic must run against a simulator in Phase 2 and against Twitch in Phase 3, and `AGENTS.md` requires separating domain decisions from provider adapters. Modules B, C, and D share one owner, so no cross-owner review process is needed.
- **Decision:**
  1. **Ports, not shared contracts.** The interfaces are server-internal TypeScript types in `server/`, not in `shared/`, and are not versioned. They change by ordinary refactoring with the compiler as the safety net.
  2. **Validation at external edges only.** Zod validation happens where external data enters: in the Twitch adapter on raw payloads (Phase 3) and at the WebSocket handshake (D2-11). Calls between server modules rely on TypeScript types and are not validated twice.
  3. **Chat commands (adapter → roulette logic).** A normalized command carries `messageId`, `channelId`, `userId`, `role` (`broadcaster`, `moderator`, or `viewer`), and `command`: `{ type: 'roulette' }`, `{ type: 'cancel' }`, or `{ type: 'vote', language }` with a supported language code. It carries no timestamp; the logic uses its own clock (D2-04, D2-09). Duplicate `messageId`s are ignored.
  4. **Candidate source (adapter → roulette logic).** `listLiveChannels()` returns registered live channels with their current viewer counts. Eligibility filters (D2-06) are applied by the roulette logic, not by the adapter.
  5. **Raid gateway (roulette logic → adapter).**
     - `requestRaid({ sessionId, fromChannelId, toStreamerId })` returns `accepted` (with `requestedAtMs` and a nullable estimated countdown), `rejected`, or `unknown`.
     - `cancelRaid({ sessionId, fromChannelId })` returns `cancelled`, `not_cancelled`, or `unknown`.
     - `sessionId` is the idempotency key. Each call has a bounded timeout that yields `unknown`; calls are never retried blindly.
  6. **Raid arrivals (adapter → roulette logic).** An arrival carries `eventId`, `fromChannelId`, `toChannelId`, `viewers`, and `observedAtMs`. It is matched to the `raid_pending` session with the same source and destination; unmatched arrivals are ignored. Duplicate `eventId`s are ignored.
  7. **Phase 2 implementations.** The command simulator, synthetic candidate source (D2-12), and simulated raid gateway and arrivals (Q13) implement these ports in process.
  8. **Deferred.** The translation port (D ↔ C), moderation events (message deletion, user clear), and the vote alias list (D2-04 rule 5) are designed in the phase that first needs them, not in Phase 2.
- **Alternatives considered:**
  - Cross-owner review before adapter work: unnecessary with a single owner of B, C, and D.
  - Re-validating every internal call with Zod: duplicate work inside one trusted process.
  - Designing translation and moderation ports now: guesswork without Phase 3–4 data.
- **Consequences:** No shared contract change. `AGENTS.md` and `docs/phase-plan.md` still describe four separate module owners; they are left unchanged unless separately approved.
- **Affected files:** `server/src/application/ports.ts`; future simulators in `server/src/`; real adapters later in `server/src/twitch/` and `server/src/translation/`.
- **Verification:** Partial (plan step 2, 2026-10-28): port types for commands, candidates, raids, and arrivals are defined and type-check. The call timeout (rule 5), deduplication (rules 3 and 6), and simulators (rule 7) are verified in steps 6 and 7.

### D2-14: Shared contract follow-ups

- **Status:** VERIFIED
- **Date:** 2026-10-28
- **Resolves:** Q12
- **Decided by:** project owner (who also owns Module A, the other consumer of `shared/events.ts`)
- **Context:** Phase 1 left three contract follow-ups open, and D2-06 left the overlay without feedback when no candidate is eligible. These changes touch the canonical event contract.
- **Decision:**
  1. **`sessionId` on raid errors.** An `error` event with code `RAID_REJECTED` or `RAID_OUTCOME_UNKNOWN` must carry `sessionId`. This is a validation rule; no field is added.
  2. **Destination country matches the candidate.** In `roulette:chosen`, `toCountry` must equal `candidate.illustrativeCountry`. `fromCountry` cannot be checked inside the event and remains the backend's responsibility.
  3. **Language maximum from the enum.** The `roulette:start` `languages` maximum is derived from the supported language list instead of the literal `7`. No behavior change.
  4. **New error code `NO_ELIGIBLE_CANDIDATES`.** When `!roulette` finds no eligible candidate, the backend publishes an `error` event with this code, `recoverable: true`, and no `sessionId` (no session is created). This replaces D2-06 rule 4's "no event is published"; filters are still never relaxed.
  5. **Delivery.** The four changes are made together in `shared/`, each with contract tests, when implementation starts.
- **Alternatives considered:** Leaving the "no eligible candidates" case silent (D2-06 as first approved): simpler, but the broadcaster gets no visible response to `!roulette`.
- **Consequences:** Rules 1 and 2 reject events that were valid before; no producer emits them yet, so nothing breaks. Rule 4 adds an error code that the overlay must handle. Module A has the same owner, so no separate coordination is needed. Protocol version stays `1`.
- **Affected files:** `shared/events.ts`, `shared/test/events.test.ts`.
- **Verification:** Implemented on 2026-10-28 (plan step 1). As an implementation detail, an `error` with `NO_ELIGIBLE_CANDIDATES` is also rejected if it carries a `sessionId`, enforcing rule 4. `npm run typecheck` passed and `npm test` passed 67/67 (4 new contract tests).

### D2-15: Simulated raid outcomes

- **Status:** APPROVED
- **Date:** 2026-10-28
- **Resolves:** Q13
- **Decided by:** project owner
- **Context:** Phase 2 does not call Twitch, but the state machine (D2-07) must reach `done`, `failed`, `cancelled`, and `unknown`. The simulation must never be presented as a real raid.
- **Decision:**
  1. **Raid request.** The simulated raid gateway (D2-13) returns `accepted` by default and can be configured in tests and the demo to return `rejected` or `unknown`.
  2. **Countdown.** The simulated estimated countdown is 90 seconds by default and configurable to a shorter value (for example 10 seconds) for the demo. It is published in `estimatedCountdownSeconds` (contract maximum 120).
  3. **Arrival.** When the countdown ends, the simulator delivers an arrival through the arrival port (D2-13 rule 6). The session moves to `done` and the destination channel receives `raid:arrived`. The simulator can be configured to never deliver the arrival.
  4. **Arrival deadline (domain rule).** If no arrival is observed within the estimated countdown plus a 60-second grace period, the session moves to `unknown` and an `error` with `RAID_OUTCOME_UNKNOWN` is published. Success is never assumed. The same rule applies to real raids in Phase 3.
  5. **Cancellation during `raid_pending`.**

     | `cancelRaid` result | Outcome |
     | --- | --- |
     | `cancelled` (simulator default) | Session moves to `cancelled`; `raid:cancelled` with `user_cancelled`. |
     | `not_cancelled` | Session stays `raid_pending`; the raid continues. |
     | `unknown` | Session moves to `unknown`; `error` with `RAID_OUTCOME_UNKNOWN`. |

     An arrival received after the session reached a terminal state is ignored in Phase 2; Phase 3 revisits whether it should be recorded.
  6. **Visible simulation mode.** In Phase 2 the server runs only in simulation mode, and `/health` reports `mode: 'simulation'`. The overlay always shows a visible "Simulation" label during Phase 2; it is removed in Phase 3. Synthetic logins use the `rsdemo_` prefix (D2-12). No shared contract change is needed.
  7. **Two-overlay demo.** D2-11 issues a viewing credential for every channel, including synthetic ones, so the demo can show the source overlay (roulette) and the destination overlay (arrival) side by side in OBS.
- **Alternatives considered:** A per-event "simulated" flag in the shared contract: more precise, but adds a protocol change for a Phase 2-only concern.
- **Consequences:** The `/health` response gains a `mode` field, so the existing health test in `server/test/app.test.ts` must be updated. The overlay "Simulation" label is Module A work (same owner). If the countdown is configured above 120 seconds, the event would fail validation; the simulator configuration must stay within that bound.
- **Affected files:** Future simulator and roulette logic in `server/src/`, `server/src/app.ts`, `server/test/app.test.ts`, and the overlay in `overlay/` (not changed yet).
- **Verification:** Not verified (no code yet).

### D2-16: Print only demo channel overlay URLs

- **Status:** APPROVED
- **Date:** 2026-10-28
- **Resolves:** Implementation planning detail for D2-11 rule 7
- **Decided by:** project owner
- **Context:** D2-11 rule 7 prints an OBS URL with a viewing credential for each channel. With 3 to 5 synthetic streamers per language (D2-12), that would print 21 to 35 credentials to the terminal.
- **Decision:** At startup the server prints overlay URLs only for the channels used by the demo script: the demo source channel and its possible destinations. Credentials still exist in memory for every channel, but only the printed ones can be used in practice.
- **Alternatives considered:** Printing every channel's URL (D2-11 as first approved): more flexible, but exposes more credentials in terminal output for no demo benefit.
- **Consequences:** Fewer credentials appear in terminal output. Using a channel outside the demo set requires changing the demo configuration.
- **Affected files:** Future `server/src/index.ts` and `server/src/simulation/demo.ts` (not written yet).
- **Verification:** Not verified (no code yet).

### D2-17: Defer reputation, raid logs, and translation window storage

- **Status:** DEFERRED
- **Date:** 2026-10-28
- **Resolves:** Q14 (deferral only)
- **Decided by:** project owner
- **Context:** `RaidRepository.recordArrivalAndCreditOnce` in `server/src/persistence/contracts.ts` records an arrival and credits reputation, but no reputation rule was ever defined; the historical spec only says the source "receives reputation credit". `TranslationWindowRepository` serves the Phase 4 translation window.
- **Decision:**
  1. Phase 2 does not implement `RaidRepository` or `TranslationWindowRepository`.
  2. When a session reaches `done`, `raid:arrived` is published (D2-07), but no raid log is recorded and no reputation is credited. `Streamer.reputation` stays at its fixture value.
  3. Snapshots carry `translationWindow: null`.
  4. **Revisit:** reputation and raid logs when Phase 3 introduces real arrivals; translation window storage in Phase 4.
- **Alternatives considered:** A minimal rule (+1 to the source per confirmed arrival, once per session, informational only): rejected for now to avoid inventing a policy without its use case.
- **Consequences:** No shared contract change. Reputation has no effect on eligibility or selection (consistent with D2-06). The repository interfaces stay unchanged so a later implementation can follow them.
- **Affected files:** None in Phase 2.
- **Verification:** Not applicable (deferred).

## Implementation and verification status

Keep implemented source, verified behavior, pending work, and unverified assumptions separate.

| Area | Implemented | Verified | Evidence |
| --- | --- | --- | --- |
| Roulette state machine | No | No | — |
| Vote aggregation and deadlines | Partial | Partial | Vote rules in `server/test/votes.test.ts` (plan step 4); deadline timers pending step 6 |
| Candidate selection | Partial | Partial | Eligibility, pool, tie-break, and pick in `server/test/eligibility.test.ts` and `server/test/selection.test.ts` (plan step 4) |
| Command intake (simulated) | No | No | — |
| Event building and publication | Yes | Partial | `server/test/publisher.test.ts` (plan step 5); WebSocket delivery pending step 8 |
| Read-only viewing authorization (`/ws`) | No | No | — |
| Shared contract follow-ups (D2-14) | Yes | Yes | Contract tests, 67/67 passing (plan step 1) |
| In-memory repositories and synthetic fixtures (D2-12) | Yes | Partial | `server/test/memory.test.ts`, `server/test/fixtures.test.ts` (plan step 3); restart behavior pending step 8 |
| Internal ports and injectable runtime (D2-09, D2-13) | Partial | Partial | Port types, runtime, and fakes; `server/test/runtime.test.ts` (plan step 2) |

## Limitations and unverified assumptions

- D2-11 approves a limited exception to the `AGENTS.md` rule against credentials in URLs and logs, for Phase 2 read-only viewing credentials only.
- D2-17 defers reputation, raid logs, and translation window storage: confirmed arrivals are published but not recorded, and reputation never changes in Phase 2.

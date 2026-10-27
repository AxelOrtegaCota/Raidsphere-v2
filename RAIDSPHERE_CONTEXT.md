# 🌐 RaidSphere — Complete AI-Friendly Context Document

> **For AI Agents:** This document contains ALL context needed to work on RaidSphere. Read it completely before making any changes. Do not assume information not present here.

[![Hackathon](https://img.shields.io/badge/Codex_×_TwitchCon-2026-9146FF?style=for-the-badge&logo=twitch)](https://twitchcon.com)
[![Team Size](https://img.shields.io/badge/Team-4_devs-blue?style=for-the-badge)]()
[![Duration](https://img.shields.io/badge/Sprint-7_days-orange?style=for-the-badge)]()

---

## 🤖 AI AGENT OPERATING RULES

**CRITICAL: Read and follow these rules before any action.**

### Authorization Boundaries
- ✅ Work ONLY within the RaidSphere repository
- ✅ Use repository-relative paths in all explanations
- ✅ Respect the four-module architecture
- ❌ Do NOT modify another developer's module without explicit authorization
- ❌ Do NOT access unrelated directories or repositories
- ❌ Do NOT assume another developer's filesystem layout

### Before Any Action
1. Verify your workspace and Git repository boundaries
2. Explain every proposed terminal command: purpose, scope, expected effects
3. Obtain explicit authorization before:
   - Running terminal commands
   - Creating, modifying, deleting, or renaming files
   - Installing dependencies
   - Executing application code
   - Contacting external services

### Security Rules
- ❌ NEVER expose secrets in output, source code, logs, or Git history
- ❌ NEVER print environment files, credential stores, or secret values
- ❌ NEVER commit, push, merge, deploy, or publish without explicit approval
- ✅ Use English for all code, comments, documentation, and user-facing interfaces

### Implementation Status Categories
Use these consistently when reporting:
- **CONFIRMED:** Verified working functionality
- **SPECIFICATION:** From design docs, not yet implemented
- **PROPOSED:** Recommendations, not approved decisions
- **IMPLEMENTED:** Code exists and was verified
- **PENDING:** Requires decision before implementation

---

## 📋 PROJECT IDENTITY

| Field | Value |
|-------|-------|
| **Official Name** | RaidSphere |
| **Context** | Codex × TwitchCon Hackathon 2026 |
| **Team Size** | 4 developers |
| **Duration** | 7 days |
| **Language** | English (all code, docs, UI) |

### Vision Statement
> **"Raids without language barriers"**

RaidSphere is an interactive Twitch raid-discovery platform that helps small streamers discover communities of comparable size across languages through:
- An animated globe displayed in OBS
- Chat voting to select a destination language
- Random selection of an eligible live channel
- Twitch raid initiation and cancellation
- Temporary AI translation in the destination broadcaster's OBS overlay

### Problem Being Solved
When a streamer ends their broadcast, they can "raid" another channel — sending their viewers there. But:
1. Most streamers only raid within their language community
2. Small streamers struggle to discover similar-sized channels
3. Language barriers prevent cross-cultural community building

### Solution
RaidSphere creates a "raid network" where:
1. Streamers register with their language, games, and viewer range
2. When ending a stream, they spin a globe instead of manually picking
3. Their chat votes on which language/region to raid
4. The system finds an eligible live channel and initiates the raid
5. AI translation activates for 15 minutes so visitors can communicate

---

## 🎯 CORE USER WORKFLOWS

### Workflow 1: Broadcaster Setup (One-Time)

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Broadcaster visits RaidSphere setup page                 │
│    └─► Clicks "Connect with Twitch"                        │
│                                                             │
│ 2. OAuth flow redirects to Twitch                          │
│    └─► User authorizes required scopes                     │
│                                                             │
│ 3. Returns to setup page with token                        │
│    └─► Configures:                                         │
│        • Channel language (e.g., "Spanish")                │
│        • Viewer range preference (e.g., "5-50 viewers")    │
│        • Accept cross-language raids? (yes/no)             │
│                                                             │
│ 4. Receives unique OBS Browser Source URL                  │
│    └─► Format: https://raidsphere.app/{channel}/overlay    │
│    └─► URL contains channel-specific auth token            │
│                                                             │
│ 5. Adds URL to OBS as Browser Source                       │
│    └─► 1920x1080, transparent background                   │
└─────────────────────────────────────────────────────────────┘
```

### Workflow 2: Raid Selection (Each Stream End)

```
┌─────────────────────────────────────────────────────────────┐
│ PHASE 1: INITIATION                                         │
│ ─────────────────────                                       │
│ • Authorized user types !roulette in chat                  │
│ • Backend validates: user is broadcaster OR moderator      │
│ • Backend finds all eligible live channels in network      │
│ • Candidates grouped by language                           │
│ • Event sent to overlay: roulette:start                    │
│                                                             │
│ PHASE 2: VOTING (30 seconds)                               │
│ ─────────────────────                                       │
│ • Globe spins with language markers visible                │
│ • Chat votes with: !vote spanish, !vote japanese, etc.     │
│ • Vote counts update in real-time on overlay               │
│ • One vote per user; latest vote replaces previous         │
│ • Backend broadcasts: roulette:votes every 2 seconds       │
│                                                             │
│ PHASE 3: SELECTION                                          │
│ ─────────────────────                                       │
│ • Timer ends, votes tallied                                │
│ • Winning language determined (random tiebreaker)          │
│ • Random channel selected from that language group         │
│ • Globe animates arc from source to destination country    │
│ • Channel card displayed with streamer info                │
│ • Event sent: roulette:chosen                              │
│                                                             │
│ PHASE 4: RAID EXECUTION                                     │
│ ─────────────────────                                       │
│ • Backend calls POST /helix/raids                          │
│ • Twitch queues the raid (90-second countdown OR instant)  │
│ • Event sent: raid:started                                 │
│ • Broadcaster can cancel with !cancel during countdown     │
│ • If cancelled: raid:cancelled event, roulette resets      │
│                                                             │
│ PHASE 5: ARRIVAL (on destination channel)                  │
│ ─────────────────────                                       │
│ • EventSub receives channel.raid event                     │
│ • Backend correlates with pending RaidSphere raid          │
│ • Event sent to destination overlay: raid:arrived          │
│ • Translation window activates for 15 minutes              │
│ • Foreign-language messages shown with translation         │
│ • Source broadcaster receives reputation credit            │
└─────────────────────────────────────────────────────────────┘
```

### Workflow 3: Translation (15-Minute Window)

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Chat message received via EventSub                       │
│    └─► channel.chat.message event                          │
│                                                             │
│ 2. Backend checks:                                          │
│    └─► Is translation window active? (15 min from arrival) │
│    └─► Is message in foreign language?                     │
│                                                             │
│ 3. If eligible, send to Translation module:                │
│    └─► Detect source language                              │
│    └─► Check cache for existing translation                │
│    └─► If not cached: call LLM API                        │
│    └─► Preserve emotes (Kappa, PogChamp, LUL, etc.)       │
│    └─► Cache result (5-minute TTL)                        │
│                                                             │
│ 4. Send to destination overlay:                            │
│    └─► translate:bubble event                              │
│    └─► Original text + translated text                     │
│    └─► Source language flag                                │
│    └─► Username                                            │
│                                                             │
│ 5. Overlay displays:                                        │
│    └─► Purple bubble with translation                      │
│    └─► Original text smaller/grayed                        │
│    └─► Fades after 10 seconds                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 🏗️ ARCHITECTURE

### System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        BROADCASTER'S OBS                             │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Browser Source: /{channel}/overlay                           │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌───────────────────────┐  │  │
│  │  │   GLOBE     │  │  VOTE UI    │  │  TRANSLATION BUBBLES  │  │  │
│  │  │  globe.gl   │  │  30s timer  │  │  Purple overlays      │  │  │
│  │  │  Countries  │  │  Vote bars  │  │  Original + translated│  │  │
│  │  │  Arc anim   │  │  Winner     │  │  Language flags       │  │  │
│  │  └─────────────┘  └─────────────┘  └───────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ WebSocket (wss://)
                                    │ Events: roulette:*, raid:*, translate:*
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         RAIDSPHERE SERVER                            │
│                                                                       │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │
│  │  MODULE D       │  │  MODULE B       │  │  MODULE C           │  │
│  │  Backend Core   │  │  Twitch         │  │  Translation        │  │
│  │  ─────────────  │  │  ─────────────  │  │  ─────────────────  │  │
│  │  • HTTP server  │  │  • OAuth flow   │  │  • Language detect  │  │
│  │  • WS server    │  │  • EventSub WS  │  │  • LLM API calls    │  │
│  │  • Sessions     │  │  • Chat parsing │  │  • Emote preserve   │  │
│  │  • State machine│  │  • Helix API    │  │  • Cache (5min TTL) │  │
│  │  • Persistence  │  │  • Raid API     │  │  • Rate limiting    │  │
│  └────────┬────────┘  └────────┬────────┘  └──────────┬──────────┘  │
│           │                    │                       │             │
│           ▼                    ▼                       ▼             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │
│  │  In-Memory DB   │  │  Twitch API     │  │  LLM Provider       │  │
│  │  + JSON backup  │  │  EventSub WS    │  │  (GPT-4o-mini)      │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### Module Responsibilities

#### Module A: Overlay (Browser/OBS)
**Owner:** Dev 1 | **Backup:** Dev 2

| Responsibility | Details |
|----------------|---------|
| OBS Browser Source | Transparent 1920x1080 canvas |
| Globe rendering | globe.gl with country markers |
| Globe animation | Spin, deceleration, arc to destination |
| Vote UI | 30s timer, live vote bars per language |
| Channel card | Streamer avatar, name, game, viewers |
| Translation bubbles | Purple overlay, original + translated |
| WebSocket client | Connect to backend, parse events |
| Reconnection | Auto-reconnect with state restore |

**NOT responsible for:**
- Twitch credentials (never in browser)
- Session state decisions
- Raid execution logic

#### Module B: Twitch Integration
**Owner:** Dev 2 | **Backup:** Dev 3

| Responsibility | Details |
|----------------|---------|
| OAuth flow | Authorization code flow, token storage |
| Token lifecycle | Refresh tokens, validate hourly |
| EventSub | WebSocket connection, subscriptions |
| Chat reception | channel.chat.message events |
| Command parsing | !roulette, !vote {lang}, !cancel |
| Channel discovery | GET /helix/streams with filters |
| Raid API | POST /helix/raids, DELETE /helix/raids |
| Arrival detection | channel.raid EventSub events |

**NOT responsible for:**
- Roulette state machine (that's Module D)
- Translation (that's Module C)
- Overlay rendering (that's Module A)

#### Module C: AI Translation
**Owner:** Dev 3 | **Backup:** Dev 4

| Responsibility | Details |
|----------------|---------|
| Language detection | Identify source language |
| Translation | LLM API calls with context |
| Emote preservation | Keep Kappa, PogChamp, LUL, etc. unchanged |
| Fragment handling | Preserve @mentions, URLs, emotes order |
| Cache layer | 5-minute TTL, keyed by text+target |
| Rate limiting | Max concurrent calls, budget cap |
| Structured output | Validate LLM JSON responses |
| Fallback chain | GPT → Google Translate → prefix only |

**NOT responsible for:**
- Bubble rendering (that's Module A)
- Chat message reception (that's Module B)
- Window timing (that's Module D)

#### Module D: Backend Core
**Owner:** Dev 4 | **Backup:** Dev 1

| Responsibility | Details |
|----------------|---------|
| HTTP server | Express/Fastify on port 3000 |
| WebSocket server | ws library on port 3001 |
| Session management | One roulette per channel |
| State machine | Roulette lifecycle states |
| Vote aggregation | Count, validate, tiebreak |
| Deadline enforcement | 30s voting, 15min translation |
| Channel isolation | Events only to correct overlays |
| Persistence | In-memory + JSON file backup |
| Coordination | Orchestrate B and C modules |
| Demo fixtures | Clearly marked test data |

**Is the authoritative state owner.** Visual animation must not determine the selected destination or initiate a raid independently.

---

## 📁 REPOSITORY STRUCTURE

```
raidsphere/
├── .github/
│   └── workflows/
│       └── ci.yml                 # GitHub Actions
├── packages/
│   ├── overlay/                   # MODULE A
│   │   ├── src/
│   │   │   ├── main.ts           # Entry point
│   │   │   ├── globe/
│   │   │   │   ├── Globe.ts      # globe.gl wrapper
│   │   │   │   ├── markers.ts    # Country markers
│   │   │   │   └── animation.ts  # Spin, arc
│   │   │   ├── vote/
│   │   │   │   ├── VoteUI.ts     # Vote bars component
│   │   │   │   └── Timer.ts      # 30s countdown
│   │   │   ├── translation/
│   │   │   │   └── Bubble.ts     # Translation bubble
│   │   │   ├── card/
│   │   │   │   └── ChannelCard.ts # Streamer info
│   │   │   └── websocket/
│   │   │       └── client.ts     # WS connection
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   └── package.json
│   │
│   ├── server/                    # MODULES B, C, D
│   │   ├── src/
│   │   │   ├── index.ts          # Entry point
│   │   │   ├── http/
│   │   │   │   ├── server.ts     # Express/Fastify
│   │   │   │   ├── routes/
│   │   │   │   │   ├── auth.ts   # OAuth endpoints
│   │   │   │   │   └── overlay.ts # Overlay routes
│   │   │   │   └── middleware/
│   │   │   │       └── auth.ts   # Token validation
│   │   │   ├── websocket/
│   │   │   │   ├── server.ts     # ws server
│   │   │   │   └── handlers.ts   # Event handlers
│   │   │   ├── twitch/           # MODULE B
│   │   │   │   ├── oauth.ts      # OAuth flow
│   │   │   │   ├── tokens.ts     # Token management
│   │   │   │   ├── eventsub.ts   # EventSub WS
│   │   │   │   ├── helix.ts      # Helix API client
│   │   │   │   └── commands.ts   # Chat command parser
│   │   │   ├── translation/      # MODULE C
│   │   │   │   ├── detector.ts   # Language detection
│   │   │   │   ├── translator.ts # LLM integration
│   │   │   │   ├── cache.ts      # Translation cache
│   │   │   │   └── emotes.ts     # Emote preservation
│   │   │   ├── application/      # MODULE D
│   │   │   │   ├── roulette.ts   # State machine
│   │   │   │   ├── sessions.ts   # Session manager
│   │   │   │   ├── votes.ts      # Vote aggregation
│   │   │   │   └── reputation.ts # Reputation tracking
│   │   │   ├── domain/
│   │   │   │   └── types.ts      # Domain types
│   │   │   ├── persistence/
│   │   │   │   └── store.ts      # In-memory + JSON
│   │   │   └── security/
│   │   │       └── encryption.ts # Token encryption
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── shared/                    # SHARED CONTRACTS
│       ├── src/
│       │   ├── events.ts         # WebSocket events
│       │   ├── models.ts         # Entity types
│       │   └── constants.ts      # Shared constants
│       └── package.json
│
├── docs/
│   └── Raidsphere.pdf            # Original spec
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── .env.example
├── .gitignore
├── Dockerfile
└── README.md
```

---

## 📡 WEBSOCKET EVENTS SPECIFICATION

### Event Envelope (All Events)

```typescript
interface EventEnvelope<T> {
  type: string;           // Event type identifier
  version: 1;             // Protocol version
  eventId: string;        // UUID for deduplication
  channelId: string;      // Target channel
  sessionId?: string;     // Roulette session if applicable
  timestamp: number;      // Unix ms
  sequence: number;       // Ordering within session
  payload: T;             // Event-specific data
}
```

### Client → Server Events

```typescript
// Authenticate WebSocket connection
interface AuthEvent {
  type: 'auth';
  payload: {
    token: string;        // Overlay auth token
    channelId: string;    // Channel identifier
  };
}

// Broadcaster starts roulette
interface RouletteStartCommand {
  type: 'roulette:start';
  payload: {
    languages?: string[]; // Optional filter
  };
}

// Broadcaster cancels roulette or pending raid
interface RouletteCancelCommand {
  type: 'roulette:cancel';
  payload: {};
}
```

### Server → Client Events

```typescript
// Roulette session begins
interface RouletteStartEvent {
  type: 'roulette:start';
  payload: {
    sessionId: string;
    candidates: Candidate[];
    languages: string[];        // Available to vote
    voteDurationSeconds: 30;
    deadline: number;           // Unix ms when voting ends
  };
}

// Vote counts update (every 2 seconds)
interface RouletteVotesEvent {
  type: 'roulette:votes';
  payload: {
    votes: Record<string, number>;  // { "Spanish": 42, "Japanese": 38 }
    totalVotes: number;
    secondsRemaining: number;
  };
}

// Winner determined, channel selected
interface RouletteChosenEvent {
  type: 'roulette:chosen';
  payload: {
    winningLanguage: string;
    channel: {
      id: string;
      login: string;
      displayName: string;
      profileImageUrl: string;
      title: string;
      gameName: string;
      viewerCount: number;
      language: string;
    };
    fromCountry: string;        // Illustrative geography
    toCountry: string;          // Illustrative geography
  };
}

// Raid request sent to Twitch
interface RaidStartedEvent {
  type: 'raid:started';
  payload: {
    toLogin: string;
    toDisplayName: string;
    countdown: number;          // Seconds until raid executes
  };
}

// Raid was cancelled
interface RaidCancelledEvent {
  type: 'raid:cancelled';
  payload: {
    sessionId: string;
    reason: 'user_cancelled' | 'timeout' | 'target_offline' | 'api_error';
  };
}

// Raid arrived at destination (EventSub confirmed)
interface RaidArrivedEvent {
  type: 'raid:arrived';
  payload: {
    fromLogin: string;
    fromDisplayName: string;
    viewers: number;
    language: string;
  };
}

// Translation bubble to display
interface TranslateBubbleEvent {
  type: 'translate:bubble';
  payload: {
    messageId: string;          // For updates/removal
    username: string;
    userDisplayName: string;
    original: string;
    translated: string;
    fromLang: string;           // ISO 639-1
    toLang: string;             // ISO 639-1
    flag: string;               // Emoji flag
    timestamp: number;
  };
}

// Error event
interface ErrorEvent {
  type: 'error';
  payload: {
    code: string;
    message: string;
    recoverable: boolean;
  };
}

// State snapshot (after reconnection)
interface StateSnapshotEvent {
  type: 'state:snapshot';
  payload: {
    roulette?: RouletteState;
    translationWindow?: {
      active: boolean;
      expiresAt: number;
      targetLanguage: string;
    };
  };
}
```

### Core Entity Types

```typescript
interface Candidate {
  id: string;
  login: string;
  displayName: string;
  profileImageUrl: string;
  title: string;
  gameName: string;
  viewerCount: number;
  language: string;
  country: string;              // Illustrative
}

interface RouletteSession {
  id: string;
  sourceChannelId: string;
  candidates: Candidate[];
  votes: Map<string, string>;   // UserId → Language
  voteCounts: Record<string, number>;
  state: 'voting' | 'selecting' | 'pending_raid' | 'completed' | 'cancelled';
  chosenCandidate?: Candidate;
  createdAt: number;
  votingDeadline: number;
}

interface TranslationWindow {
  channelId: string;
  sourceLanguage: string;
  targetLanguage: string;
  activatedAt: number;
  expiresAt: number;            // 15 minutes after activation
}

interface Streamer {
  id: string;
  login: string;
  displayName: string;
  profileImageUrl: string;
  language: string;
  viewerRangeMin: number;
  viewerRangeMax: number;
  acceptsCrossLanguageRaids: boolean;
  reputation: number;
  createdAt: number;
}
```

---

## 🔌 TWITCH API REQUIREMENTS

### Required OAuth Scopes

| Scope | Purpose |
|-------|---------|
| `channel:manage:raids` | Start and cancel raids |
| `chat:read` | Read chat messages |
| `chat:edit` | Send chat messages (optional) |
| `user:read:email` | Get user email for account |
| `moderator:read:chatters` | List chatters (optional) |

### EventSub Subscriptions

| Subscription | Purpose | Cost |
|--------------|---------|------|
| `channel.chat.message` | Receive chat messages | 1 |
| `channel.raid` | Detect raid arrivals | 1 |

**Limits:**
- Max 3 WebSocket connections per client/user
- Max 300 subscriptions per connection
- Total subscription cost: 10

### Helix API Endpoints

| Endpoint | Method | Purpose | Rate Limit |
|----------|--------|---------|------------|
| `/helix/users` | GET | Get user info | 800/min |
| `/helix/streams` | GET | Find live streams | 800/min |
| `/helix/raids` | POST | Start a raid | 10/10min |
| `/helix/raids` | DELETE | Cancel a raid | 10/10min |

### Important Twitch Behaviors

1. **Raid is queued, not instant:** A successful POST /helix/raids queues the raid. Twitch shows a 90-second countdown OR "Raid Now" button.

2. **Arrival is separate:** The `channel.raid` EventSub event fires when the raid actually arrives, not when requested.

3. **No participant list:** Raid events provide viewer COUNT but not a list of who arrived.

4. **Rate limits are strict:** 10 raid requests per 10 minutes. Implement backoff.

5. **Token must match source:** The user token for POST /helix/raids must belong to the source broadcaster.

---

## 🔧 TECHNOLOGY STACK

### Recommended Stack (with rationale)

| Category | Choice | Rationale |
|----------|--------|-----------|
| **Runtime** | Node.js 20 | LTS, native ES modules |
| **Language** | TypeScript 5.x | Type safety, shared types |
| **Monorepo** | pnpm workspaces | Simple, fast, no extra config |
| **Overlay Build** | Vite | Fast HMR, native TS |
| **Globe** | globe.gl | WebGL globe, easy API |
| **WebSocket (app)** | ws | Lightweight, well-maintained |
| **HTTP Server** | Fastify | Fast, schema validation |
| **LLM** | GPT-4o-mini | Cheap, fast, good quality |
| **Database** | In-memory + JSON | Zero setup for hackathon |
| **Hosting** | Railway | Native WebSocket, easy deploy |
| **Container** | Docker | Reproducible builds |
| **Testing** | Vitest | Vite-native, fast |

### Alternative Options

#### LLM for Translation

| Option | Pros | Cons | Cost/1M tokens | Latency |
|--------|------|------|----------------|---------|
| **GPT-4o-mini** ✅ | Quality, speed, emote handling | API key required | $0.15 in | ~200ms |
| Claude 3.5 Haiku | Great context | Slightly pricier | $0.25 in | ~250ms |
| DeepL API | Best pure translation | No emote instructions | Free tier | ~100ms |
| Google Translate | Free tier | Lower slang quality | Free | ~150ms |

#### Hosting

| Option | Pros | Cons | Free Tier | WebSocket |
|--------|------|------|-----------|-----------|
| **Railway** ✅ | Simple, WS native | Credits burn | $5/mo | ✅ Native |
| Render | Great DX | Cold starts | 750 hrs | ✅ Config |
| Fly.io | Global edge | Complex setup | $5 credit | ✅ Native |
| Vercel | Best frontend | Serverless only | Generous | ❌ No |

#### Database

| Option | Pros | Cons | Best For |
|--------|------|------|----------|
| **In-Memory + JSON** ✅ | Zero setup | Lost on crash | Hackathon |
| SQLite | Persistent, SQL | Disk required | Production |
| Turso | Edge SQLite | Overkill | Scale later |
| Redis | Fast, pub/sub | External service | Heavy RT |

---

## 📅 7-DAY DEVELOPMENT PLAN

### Day 1: Foundation 🏗️

| Module | AM Tasks | PM Tasks | End-of-Day Goal |
|--------|----------|----------|-----------------|
| **A: Overlay** | Setup Vite + globe.gl | Static globe in HTML | Globe renders in OBS |
| **B: Twitch** | Register Twitch app | OAuth flow skeleton | /auth/twitch redirects |
| **C: Translation** | Evaluate LLM options | Basic /translate endpoint | Returns mock translation |
| **D: Backend** | Monorepo setup | HTTP + WS server | WebSocket accepts connections |

**Day 1 Checkpoint:**
- [ ] `pnpm install` works
- [ ] Globe visible in browser
- [ ] OAuth redirects to Twitch
- [ ] WebSocket connects overlay ↔ server

---

### Day 2: Core Mechanics ⚙️

| Module | AM Tasks | PM Tasks | End-of-Day Goal |
|--------|----------|----------|-----------------|
| **A: Overlay** | Vote UI component | 30s timer animation | Shows vote bars |
| **B: Twitch** | EventSub WebSocket | Chat message parsing | Receives chat events |
| **C: Translation** | Language detection | Emote preservation regex | Detects ES/EN/PT |
| **D: Backend** | Roulette state machine | Vote aggregation | State: voting → chosen |

**Day 2 Checkpoint:**
- [ ] Vote UI updates with mock data
- [ ] EventSub receives real chat
- [ ] Language detected 90%+ accuracy
- [ ] Roulette cycles through states

---

### Day 3: Discovery & Cache 🔍

| Module | AM Tasks | PM Tasks | End-of-Day Goal |
|--------|----------|----------|-----------------|
| **A: Overlay** | Channel card component | Arc animation | Card shows streamer |
| **B: Twitch** | GET /helix/streams | Filter by language/viewers | Finds 10+ channels |
| **C: Translation** | Cache layer (5min TTL) | Batch translation | Cache hit rate >50% |
| **D: Backend** | Eligible channel pool | Candidate ranking | Pool refreshes every 5min |

**Day 3 Checkpoint:**
- [ ] Channel card displays real data
- [ ] Arc draws from A to B
- [ ] Translations cached
- [ ] Live channels discovered

---

### Day 4: INTEGRATION DAY 🔗

**ALL MODULES INTEGRATE**

| Time | Task |
|------|------|
| 9 AM | Team standup, review interfaces |
| 10 AM | Connect WebSocket events E2E |
| 12 PM | Test roulette flow with mock raid |
| 2 PM | First real raid test (internal channels) |
| 4 PM | Debug, fix integration issues |
| 6 PM | Demo complete flow internally |

**Day 4 Checkpoint (CRITICAL):**
- [ ] 🎯 Complete E2E flow works:
  1. !roulette starts session
  2. Globe spins, votes appear
  3. !vote spanish accepted
  4. Winner selected, card shown
  5. Raid API called successfully
  6. (If destination has overlay) Translation works

---

### Day 5: Edge Cases & Polish 🧪

| Module | AM Tasks | PM Tasks |
|--------|----------|----------|
| **A: Overlay** | Error state UI | Mobile-friendly sizing |
| **B: Twitch** | Rate limit handling | Cancelled raid flow |
| **C: Translation** | 5+ languages | Context-aware translation |
| **D: Backend** | Reconnection logic | Graceful degradation |

**Day 5 Checkpoint:**
- [ ] Handles: no votes, raid fails, WS disconnect
- [ ] Works: EN, ES, PT, FR, DE
- [ ] Rate limits respected
- [ ] Auto-reconnects

---

### Day 6: Performance & Rehearsal 🎭

| Time | Task |
|------|------|
| 9 AM | Performance profiling |
| 11 AM | Bundle size optimization |
| 1 PM | Full demo rehearsal #1 |
| 3 PM | Fix issues from rehearsal |
| 5 PM | Full demo rehearsal #2 |
| 7 PM | Record backup video |

**Day 6 Checkpoint:**
- [ ] Translation latency &lt;500ms p95
- [ ] Overlay loads &lt;2s
- [ ] Demo script finalized
- [ ] Backup video recorded

---

### Day 7: Final Day 🏁

| Time | Task |
|------|------|
| 9 AM | Fix critical bugs |
| 12 PM | Code freeze |
| 2 PM | Final demo rehearsal |
| 4 PM | Record final demo video |
| 6 PM | Write submission |
| 8 PM | Submit |

**Day 7 Checkpoint:**
- [ ] All critical bugs fixed
- [ ] Demo video recorded (90s)
- [ ] README complete
- [ ] Submission uploaded

---

## ✅ DELIVERABLES CHECKLIST

### MVP (Must Have)

#### Overlay (Module A)
- [ ] Globe with country markers
- [ ] Spin animation
- [ ] Vote UI (30s timer, live counts)
- [ ] Winner announcement animation
- [ ] Channel card with streamer info
- [ ] Translation bubbles (purple)
- [ ] Arc from source to destination
- [ ] Reconnection handling

#### Twitch Integration (Module B)
- [ ] OAuth login flow complete
- [ ] Token refresh working
- [ ] EventSub connection stable
- [ ] Chat commands: !roulette, !vote, !cancel
- [ ] Channel discovery by language
- [ ] POST /helix/raids working
- [ ] DELETE /helix/raids working
- [ ] channel.raid arrival detection

#### Translation (Module C)
- [ ] Language detection (EN, ES, PT minimum)
- [ ] LLM translation working
- [ ] Emote preservation (Kappa, PogChamp, LUL)
- [ ] Translation cache (5min TTL)
- [ ] Rate limiting
- [ ] Fallback chain

#### Backend (Module D)
- [ ] WebSocket server stable
- [ ] Session management
- [ ] Roulette state machine
- [ ] Vote aggregation
- [ ] 30s deadline enforcement
- [ ] 15min translation window
- [ ] Channel isolation
- [ ] In-memory persistence + JSON backup

### Nice to Have

- [ ] Streamer dashboard
- [ ] Translation quality voting
- [ ] Raid history
- [ ] Custom globe themes
- [ ] Sound effects
- [ ] Reputation leaderboard

### Documentation

- [ ] README.md with setup
- [ ] .env.example
- [ ] Architecture diagram
- [ ] Demo video (90s max)
- [ ] Submission form complete

---

## ⚠️ RISK MITIGATION

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Twitch app not approved | Low | High | Use development mode |
| OAuth flow fails | Medium | High | Test early, manual token fallback |
| Raid rate limit (10/10min) | Medium | High | Implement backoff, show cooldown |
| LLM latency &gt;2s | Medium | Medium | Cache, pre-warm, fallback |
| WebSocket disconnects | Medium | Medium | Auto-reconnect, state snapshot |
| No eligible channels | Low | High | Expand viewer range, fallback pool |
| Demo fails live | Medium | Critical | Pre-recorded backup video |

### Emergency Fallback Code

```typescript
// Translation fallback chain
async function translate(text: string, target: string): Promise<string> {
  try {
    return await gpt4oMini(text, target);       // Primary
  } catch (e) {
    console.error('GPT failed:', e);
    try {
      return await googleTranslate(text, target); // Fallback 1
    } catch (e2) {
      console.error('Google failed:', e2);
      return `[${target}] ${text}`;               // Fallback 2
    }
  }
}

// WebSocket reconnection
function connectWithRetry(url: string, maxRetries = 5): WebSocket {
  let retries = 0;
  
  function connect() {
    const ws = new WebSocket(url);
    
    ws.onclose = () => {
      if (retries < maxRetries) {
        retries++;
        const delay = Math.min(1000 * Math.pow(2, retries), 30000);
        setTimeout(connect, delay);
      }
    };
    
    ws.onopen = () => {
      retries = 0;
      ws.send(JSON.stringify({ type: 'state:request' }));
    };
    
    return ws;
  }
  
  return connect();
}
```

---

## 🚀 QUICK START

```bash
# Clone
git clone https://github.com/Articnn/raidsphere.git
cd raidsphere

# Install dependencies
pnpm install

# Setup environment
cp .env.example .env
# Edit .env with your credentials

# Development
pnpm dev          # Starts all packages

# Production
pnpm build
pnpm start
```

### Environment Variables

```env
# Twitch OAuth (REQUIRED)
TWITCH_CLIENT_ID=your_client_id
TWITCH_CLIENT_SECRET=your_client_secret
TWITCH_REDIRECT_URI=http://localhost:3000/auth/callback

# OpenAI (REQUIRED for translation)
OPENAI_API_KEY=sk-...

# Server
PORT=3000
WS_PORT=3001
NODE_ENV=development

# Optional
LOG_LEVEL=debug
TRANSLATION_CACHE_TTL_MS=300000
ROULETTE_VOTE_DURATION_S=30
TRANSLATION_WINDOW_DURATION_MS=900000
```

---

## 📞 TEAM COORDINATION

| Event | Schedule | Duration |
|-------|----------|----------|
| Daily Standup | 10:00 AM | 15 min max |
| Integration Sync | Day 4, 2:00 PM | 2 hours |
| Demo Rehearsal | Day 6, 3:00 PM | 3 hours |
| Communication | Discord #raidsphere | Async |

### Git Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Production-ready code |
| `develop` | Integration branch |
| `module-a/overlay` | Module A work |
| `module-b/twitch` | Module B work |
| `module-c/translation` | Module C work |
| `module-d/backend` | Module D work |

**Rules:**
- Daily merge to `develop`
- PR required for `main`
- Shared contracts require team review

---

## 📚 REFERENCE LINKS

- [Twitch API Reference](https://dev.twitch.tv/docs/api/reference/)
- [Twitch EventSub](https://dev.twitch.tv/docs/eventsub/)
- [Twitch Raids](https://dev.twitch.tv/docs/api/raids/)
- [OAuth Guide](https://dev.twitch.tv/docs/authentication/)
- [globe.gl Documentation](https://globe.gl/)
- [OpenAI API](https://platform.openai.com/docs/)
- [Railway Docs](https://docs.railway.app/)
- [Vite Guide](https://vitejs.dev/guide/)
- [ws Library](https://github.com/websockets/ws)

---

## 🔄 DOCUMENT VERSION

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | Oct 2026 | Initial AI-friendly context document |

---

*This document is designed to give any AI agent complete context for RaidSphere development. If something is unclear or missing, ask before assuming.*

**Team RaidSphere — Codex × TwitchCon Hackathon 2026**

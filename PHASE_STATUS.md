# RaidSphere — Phase Status Report

> **Branch:** `feature/phase4-translation`\
> **Last updated:** 2026-10-30\
> **Deployed at:** https://raidsphere.up.railway.app

---

## ✅ What We Built (Working)

### Phase 1 — Foundation
| Component | Status | Details |
|-----------|--------|---------|
| HTTP Server (Fastify) | ✅ Working | Port 3000, Railway deployed |
| WebSocket Server | ✅ Working | Same-origin, secure credentials |
| State Machine | ✅ Working | `server/src/application/roulette.ts` (~450 lines) |
| Vote Aggregation | ✅ Working | `server/src/application/votes.ts` |
| Channel Selection | ✅ Working | `server/src/application/selection.ts` |
| Event Publisher | ✅ Working | `server/src/application/publisher.ts` |

### Phase 2 — Modules B & C (Code Complete, Not Integrated)

#### Module B — Twitch (2,551 lines)
| File | Lines | Status | Description |
|------|-------|--------|-------------|
| `oauth.ts` | 590 | ✅ Working E2E | Login, tokens, refresh, revoke |
| `helix.ts` | — | ✅ Tested reads | Streams, users/avatars, channels, categories, language/game filters |
| `eventsub.ts` | 406 | ⚠️ Code exists | WebSocket EventSub — NOT CONNECTED |
| `raids.ts` | 394 | ⚠️ Code exists | Raid gateway — SIMULATED |
| `commands.ts` | 220 | ⚠️ Code exists | Parser `!roulette`, `!vote`, `!cancel` |
| `candidates.ts` | 154 | ⚠️ Code exists | Channel discovery — SYNTHETIC DATA |
| `sessions.ts` | 157 | ✅ Working | Session store (in-memory only) |

#### Module C — Translation (1,164 lines)
| File | Lines | Status | Description |
|------|-------|--------|-------------|
| `service.ts` | 605 | ✅ Working | Main service with cache/fallback |
| `emotes.ts` | 214 | ✅ Working | Preserve Kappa, PogChamp, etc. |
| `mock-provider.ts` | 168 | ✅ Working | Fake provider for demo |
| `provider.ts` | 118 | ✅ Interface | Ready for real providers |

### Phase 3 — OAuth & Overlay
| Component | Status | Details |
|-----------|--------|---------|
| Twitch OAuth | ✅ Working E2E | Login, callback, session cookie |
| Dashboard | ✅ Working | Shows username, avatar, overlay URL |
| Private Overlay URL | ✅ Working | Channel-specific with credentials |
| Globe (night Earth) | ✅ Working | `globe.gl` with textures |
| Stars Background | ✅ Working | CSS + texture |
| Auto-rotation | ✅ Working | `?mode=interactive` only; pauses on location detect |
| Geolocation | ✅ Working | `?mode=interactive` only; requested on click, not on load |
| Interactive Controls | ✅ Working | `?mode=interactive` only: zoom, rotate, drag |
| Simulation Badge | ✅ Working | Visible unless `/health` reports live mode |
| OBS Mode | ✅ Verified in OBS | Default: transparent, no discovery tools, globe paused when idle |
| Raid Candidate Discovery | ✅ Implemented | Live Helix candidates, category autocomplete, language and viewer filters |
| Candidate Identity | ✅ Implemented | Twitch avatars with stream-preview and initial fallbacks |
| Stream Language Markers | ✅ Implemented | All Twitch broadcast language codes plus `other`; flags are not location |

---

## ❌ What's Missing (Not Built)

### Module A — Overlay UI
| Component | Status | Priority |
|-----------|--------|----------|
| Vote bars (30s timer, language percentages) | ✅ Built on `feature/phase4-translation` | — |
| Channel card (name, game, viewers) | ✅ Built (winner card; no avatars yet) | — |
| Translation bubbles (purple overlays) | ✅ Built; fed by the simulated chat translation pipeline (real chat pending EventSub) | — |
| Arc animation (origin → destination) | ✅ Built | — |

### Module B — Real Twitch Connection
| Component | Status | Priority |
|-----------|--------|----------|
| EventSub WebSocket activation | ❌ Not connected | HIGH |
| Real chat message reception | ❌ Not connected | HIGH |
| Real raid execution | ❌ Disabled | HIGH |
| Integration with roulette coordinator | ⚠️ Simulated parser and raid gateway wired through adapters; real Twitch not wired | HIGH |

### Module C — Real Translation
| Component | Status | Priority |
|-----------|--------|----------|
| GPT/DeepL provider | ❌ Only mock | MEDIUM |
| Real API calls | ❌ Not implemented | MEDIUM |

### Module D — Persistence
| Component | Status | Priority |
|-----------|--------|----------|
| Redis/Database sessions | ❌ Memory only | LOW for hackathon |
| Token encryption at rest | ❌ Not implemented | LOW for hackathon |

---

## 🧪 How to Test Each Component

### 1. OAuth (Working)
```
1. Go to https://raidsphere.up.railway.app/auth/twitch
2. Authorize with Twitch
3. Should redirect to /dashboard with your info
```

### 2. Overlay (Working)
```
1. After login, copy your private overlay URL from dashboard
2. Open in browser or add to OBS as Browser Source
3. Globe should render with stars, auto-rotate, ask for location
```

### 3. Helix Candidate Discovery
```text
1. Log in at https://raidsphere.up.railway.app/auth/twitch
2. Open the private overlay URL from the dashboard
3. Filter by language, category, channel name, or viewer range
4. Confirm candidate avatars, stream-language markers, and live viewer counts
```

Implementation and API details: `docs/raid-candidate-discovery.md`.

### 4. EventSub (Code exists, not connected)
```
EventSub requires:
1. Active WebSocket connection to wss://eventsub.wss.twitch.tv/ws
2. Subscription creation via Helix API
3. The server must handle incoming events

Currently: Code exists in server/src/twitch/eventsub.ts but is not activated
```

### 5. Raids (Code exists, disabled)
```
Raid execution requires:
1. Broadcaster must be LIVE
2. Target channel must be LIVE
3. POST /helix/raids with broadcaster_id and to_broadcaster_id

Currently: Code exists in server/src/twitch/raids.ts but is simulated
```

---

## 📁 Key Files

### Server
- `server/src/index.ts` — Entry point
- `server/src/app.ts` — Fastify app, routes, static files
- `server/src/routes/auth.ts` — OAuth flow, dashboard
- `server/src/twitch/oauth.ts` — Token management
- `server/src/twitch/helix.ts` — Twitch API client
- `server/src/twitch/eventsub.ts` — EventSub WebSocket
- `server/src/application/roulette.ts` — State machine

### Overlay
- `overlay/src/main.ts` — Globe, WebSocket, UI
- `overlay/src/connection.ts` — WebSocket client
- `overlay/src/view-state.ts` — Event handling
- `overlay/src/styles.css` — Dark theme, stars
- `overlay/src/search-panel.ts` — Raid candidate discovery UI
- `overlay/src/languages.ts` — Twitch language catalog and representative markers

### Tests
- `server/test/auth-ui.test.ts` — OAuth/overlay routes
- `server/test/credentials.test.ts` — Viewing credentials
- `overlay/test/connection.test.ts` — WebSocket URL
- `overlay/test/location.test.ts` — Geolocation
- `server/test/helix-users.test.ts` — Twitch profile-image retrieval
- `overlay/test/languages.test.ts` — Complete language catalog

---

## 🚀 Deployment

```bash
# Build and test
npm run build
npm test

# Deploy to Railway
railway up --service RaidSphere --detach

# Verify
curl https://raidsphere.up.railway.app/health
```

---

## 📝 Notes

1. **Client Secret was exposed** — Must rotate in Twitch Developer Console before production
2. **Sessions are in-memory** — Lost on every Railway deploy/restart
3. **`main` has Phase 1 and Module D** — The rest of Phase 2 and this work are on `feature/phase4-translation`, pending review
4. **Mode is `simulation`** — Real raids are disabled for safety
5. **No credential URLs in hosted logs** — A server bound to `0.0.0.0` does not print overlay URLs; take the overlay URL from the dashboard

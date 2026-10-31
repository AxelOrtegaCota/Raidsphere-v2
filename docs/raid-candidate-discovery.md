# Raid Candidate Discovery

## Scope

RaidSphere exposes a Twitch Helix-powered candidate discovery panel in the overlay. The panel can filter live streams by stream language, category/game ID, channel text, and viewer range.

## Streamer images

Twitch returns two different image types:

- `GET /helix/streams` returns `thumbnail_url`, which is a live stream preview.
- `GET /helix/users?id=...` returns `profile_image_url`, which is the streamer's avatar.
- `GET /helix/search/channels` returns `thumbnail_url`, which is used as the profile image for channel-search results.

`server/src/routes/auth.ts` now enriches discovered streams with a batched `getUsers()` request. The browser receives both `profileImageUrl` and `thumbnailUrl`.

The overlay renders images in this order:

1. Twitch profile image.
2. Stream preview thumbnail.
3. A local initial-based fallback if neither URL exists or the image fails to load.

No access token or credential is embedded in an image URL.

## Language filter

`overlay/src/languages.ts` contains all Twitch-supported broadcast language codes plus `other`:

`ar`, `bg`, `ca`, `cs`, `da`, `de`, `el`, `en`, `es`, `fi`, `fr`, `hu`, `it`, `ja`, `ko`, `nl`, `no`, `pl`, `pt`, `ro`, `ru`, `sk`, `sv`, `th`, `tr`, `vi`, `zh`, `other`.

Each option includes a representative flag marker. A flag describes the selected **stream language only**; it is not a verified country, nationality, or streamer location. Twitch Helix does not expose streamer geolocation.

Unexpected language codes are preserved in the UI and receive a globe fallback (`🌐`) instead of being discarded.

## Category filter

The category autocomplete calls:

```text
GET /api/categories?q=<partial category name>
```

A selected suggestion stores and sends its stable Twitch `game_id`. Free text remains supported as a fallback and is resolved server-side through Helix category search.

## Candidate API

```text
GET /api/test-helix?language=<code>&gameId=<id>&q=<channel>&viewers=<min>-<max>
```

The endpoint requires the authenticated RaidSphere session cookie. It does not return OAuth tokens or viewing credentials.

## Verification

Focused regression coverage:

- `server/test/helix-users.test.ts`: deduplicates streamer IDs and retrieves profile images from Helix Get Users.
- `server/test/auth-ui.test.ts`: verifies the candidate endpoint includes `profileImageUrl`.
- `overlay/test/languages.test.ts`: verifies the full language catalog, markers, and unknown-code fallback.

Production limitations remain unchanged:

- OAuth sessions are stored in process memory and are lost on redeploy.
- Real raid execution is still disabled/simulated.
- Language metadata is not geolocation.

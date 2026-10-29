/**
 * Authentication and onboarding routes for RaidSphere.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  buildAuthorizationUrl,
  exchangeCode,
  getAuthenticatedUser,
  loadOAuthConfig,
  revokeToken,
} from '../twitch/oauth.js';
import {
  searchChannels,
  getStreams,
  type HelixRequestConfig,
} from '../twitch/helix.js';
import {
  createSession,
  destroySession,
  getSession,
  type UserSession,
} from '../twitch/sessions.js';

const SESSION_COOKIE_NAME = 'raidsphere_session';
const OAUTH_STATE_COOKIE_NAME = 'raidsphere_oauth_state';
const STATE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const pendingStates = new Map<string, number>();

export interface AuthRouteDependencies {
  issueViewingCredential: (channelId: string) => string;
  onAuthenticated?: (session: UserSession) => Promise<void>;
  onLogout?: (session: UserSession) => Promise<void>;
}

export function registerAuthRoutes(app: FastifyInstance, dependencies: AuthRouteDependencies): void {
  app.get('/', async (_request, reply) => {
    return sendHtml(reply, publicLandingPage());
  });

  app.get('/auth/twitch', async (_request, reply) => {
    const config = loadOAuthConfig(process.env);
    const state = randomUUID();
    pendingStates.set(state, Date.now());
    cleanupPendingStates();

    return reply
      .header('Set-Cookie', cookie(OAUTH_STATE_COOKIE_NAME, state, {
        maxAge: Math.floor(STATE_TTL_MS / 1000),
        secure: isSecureRedirect(config.redirectUri),
      }))
      .redirect(buildAuthorizationUrl(config, state));
  });

  app.get('/auth/callback', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    if (query.error) {
      return reply.status(400).send({
        error: 'OAuth failed',
        message: String(query.error_description || query.error),
      });
    }

    const code = typeof query.code === 'string' ? query.code : null;
    const state = typeof query.state === 'string' ? query.state : null;
    const cookieState = readCookie(request, OAUTH_STATE_COOKIE_NAME);
    const issuedAt = state ? pendingStates.get(state) : undefined;
    const stateIsFresh = issuedAt !== undefined && Date.now() - issuedAt <= STATE_TTL_MS;
    if (!code || !state || !cookieState || cookieState !== state || !stateIsFresh) {
      return reply.status(400).send({
        error: 'Invalid state',
        message: 'The login request expired or could not be verified. Start the Twitch login again.',
      });
    }
    pendingStates.delete(state);

    try {
      const config = loadOAuthConfig(process.env);
      const tokens = await exchangeCode(code);
      const user = await getAuthenticatedUser(tokens.access_token);
      const viewingCredential = dependencies.issueViewingCredential(user.id);
      const session = createSession(randomUUID(), user, tokens, {
        channelId: user.id,
        viewingCredential,
      });
      await dependencies.onAuthenticated?.(session);

      return reply
        .header('Set-Cookie', [
          cookie(OAUTH_STATE_COOKIE_NAME, '', { maxAge: 0, secure: isSecureRedirect(config.redirectUri) }),
          cookie(SESSION_COOKIE_NAME, session.sessionId, {
            maxAge: SESSION_TTL_SECONDS,
            secure: isSecureRedirect(config.redirectUri),
          }),
        ])
        .redirect('/dashboard');
    } catch (error) {
      request.log.warn({ err: error }, 'Twitch authentication failed');
      return reply.status(502).send({
        error: 'Authentication failed',
        message: 'Twitch could not complete the login. Try again from the RaidSphere home page.',
      });
    }
  });

  app.get('/dashboard', async (request, reply) => {
    const session = currentSession(request);
    if (!session) return reply.redirect('/auth/twitch');
    reply.header('Cache-Control', 'no-store');
    return sendHtml(reply, dashboardPage(session));
  });

  app.get('/auth/me', async (request, reply) => {
    const session = currentSession(request);
    if (!session) return reply.status(401).send({ error: 'Not authenticated' });
    reply.header('Cache-Control', 'no-store');
    return {
      user: {
        id: session.user.id,
        login: session.user.login,
        displayName: session.user.display_name,
        profileImageUrl: session.user.profile_image_url,
      },
      scopes: [...session.tokens.scope],
      capabilities: {
        overlay: true,
        eventSub: false,
        realRaids: false,
      },
    };
  });

  app.post('/auth/logout', async (request, reply) => {
    const session = currentSession(request);
    if (session) {
      try {
        await dependencies.onLogout?.(session);
        await revokeToken(loadOAuthConfig(process.env), session.tokens.access_token);
      } catch {
        // Local logout still succeeds if Twitch is unavailable or the token was already revoked.
      }
      destroySession(session.sessionId);
    }
    const secure = isSecureRedirect(loadOAuthConfig(process.env).redirectUri);
    return reply
      .header('Set-Cookie', cookie(SESSION_COOKIE_NAME, '', { maxAge: 0, secure }))
      .send({ message: 'Logged out' });
  });

  app.get('/auth/status', async (request, reply) => {
    const session = currentSession(request);
    reply.header('Cache-Control', 'no-store');
    return session
      ? { authenticated: true, user: session.user.login }
      : { authenticated: false };
  });

  // ==========================================================================
  // Test endpoint: Helix API
  // ==========================================================================

  app.get('/api/test-helix', async (request, reply) => {
    const session = currentSession(request);
    if (!session) {
      return reply.status(401).send({ error: 'Not authenticated. Login first at /auth/twitch' });
    }

    const config = loadOAuthConfig(process.env);
    const helixConfig: HelixRequestConfig = {
      accessToken: session.tokens.access_token,
      clientId: config.clientId,
    };

    const query = (request.query as Record<string, string>);
    const language = query.language || 'es';
    const searchQuery = query.q || 'just chatting';

    try {
      // Search for live channels
      const channels = await searchChannels(searchQuery, helixConfig, language, 10);
      
      // Get top streams (general)
      const streams = await getStreams(helixConfig, undefined, 10);

      return {
        success: true,
        authenticated_as: session.user.login,
        search: {
          query: searchQuery,
          language,
          results: channels.map(ch => ({
            id: ch.id,
            login: ch.login,
            displayName: ch.displayName,
            game: ch.gameName,
            title: ch.title,
            isLive: ch.isLive,
            language: ch.broadcasterLanguage,
          })),
        },
        top_streams: streams.slice(0, 5).map(s => ({
          id: s.userId,
          login: s.userLogin,
          name: s.userName,
          game: s.gameName,
          title: s.title,
          viewers: s.viewerCount,
          language: s.language,
        })),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({ error: 'Helix API call failed', details: message });
    }
  });
}

function currentSession(request: FastifyRequest): UserSession | null {
  const sessionId = readCookie(request, SESSION_COOKIE_NAME);
  return sessionId ? getSession(sessionId) : null;
}

function readCookie(request: FastifyRequest, name: string): string | null {
  const raw = request.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function cookie(
  name: string,
  value: string,
  options: { maxAge: number; secure: boolean },
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    options.secure ? 'Secure' : '',
    `Max-Age=${options.maxAge}`,
  ].filter(Boolean).join('; ');
}

function isSecureRedirect(redirectUri: string): boolean {
  try {
    return new URL(redirectUri).protocol === 'https:';
  } catch {
    return false;
  }
}

function cleanupPendingStates(): void {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [state, issuedAt] of pendingStates) {
    if (issuedAt < cutoff) pendingStates.delete(state);
  }
}

function sendHtml(reply: FastifyReply, html: string) {
  return reply
    .header('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'self'")
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Content-Type-Options', 'nosniff')
    .type('text/html; charset=utf-8')
    .send(html);
}

function publicLandingPage(): string {
  return page('RaidSphere — Twitch login', `
    <main class="shell">
      <section class="hero">
        <p class="brand">RaidSphere</p>
        <h1>Raids without language barriers.</h1>
        <p class="lede">Connect a Twitch channel, prepare its private OBS overlay, and review every integration before enabling live controls.</p>
        <a class="primary" href="/auth/twitch">Continue with Twitch</a>
      </section>
      <ol class="steps" aria-label="Setup steps">
        <li><strong>Authorize Twitch</strong><span>Grant chat read and raid management permissions.</span></li>
        <li><strong>Open your control room</strong><span>Copy the private overlay URL created for your channel.</span></li>
        <li><strong>Add it to OBS</strong><span>Create a Browser Source at 1920 × 1080 and paste the URL.</span></li>
        <li><strong>Run the readiness check</strong><span>Confirm overlay, EventSub, and raid controls separately.</span></li>
      </ol>
    </main>
  `);
}

function dashboardPage(session: UserSession): string {
  const displayName = escapeHtml(session.user.display_name);
  const login = escapeHtml(session.user.login);
  const channel = encodeURIComponent(session.overlay.channelId);
  const credential = encodeURIComponent(session.overlay.viewingCredential);
  const overlayPath = `/${encodeURIComponent(session.user.login)}/overlay#channel=${channel}&cred=${credential}`;
  const safeOverlayPath = escapeHtml(overlayPath);
  return page(`RaidSphere — ${displayName}`, `
    <main class="shell dashboard">
      <header class="account">
        <img src="${escapeHtml(session.user.profile_image_url)}" alt="" width="56" height="56" />
        <div><p class="brand">RaidSphere control room</p><h1>${displayName}</h1><p class="muted">twitch.tv/${login}</p></div>
      </header>

      <section class="overlay-access">
        <div><h2>Your private OBS overlay</h2><p>Anyone with this complete URL can view this channel's read-only overlay. Do not post it publicly.</p></div>
        <code id="overlay-url">${safeOverlayPath}</code>
        <div class="actions">
          <a class="primary" href="${safeOverlayPath}">Open overlay</a>
          <button id="copy-overlay" type="button">Copy URL</button>
        </div>
      </section>

      <section class="readiness">
        <h2>Integration readiness</h2>
        <ul>
          <li data-state="ready"><strong>Twitch OAuth</strong><span>Authenticated with the required scopes.</span></li>
          <li data-state="ready"><strong>OBS overlay</strong><span>Private URL and secure WebSocket are ready.</span></li>
          <li data-state="pending"><strong>EventSub chat</strong><span>Authorization is granted; runtime subscription is not enabled yet.</span></li>
          <li data-state="pending"><strong>Real raids</strong><span>Permission is granted; live control remains disabled until an explicit activation step.</span></li>
        </ul>
      </section>

      <section class="guide">
        <h2>How to reach every function</h2>
        <ol class="steps">
          <li><strong>OBS</strong><span>Add a Browser Source, paste the complete private URL, and use 1920 × 1080.</span></li>
          <li><strong>Country marker</strong><span>Inside the overlay, choose “Locate my country.” The browser asks before sharing location.</span></li>
          <li><strong>Roulette</strong><span>After EventSub is marked ready, the broadcaster or moderator sends <code>!roulette</code>.</span></li>
          <li><strong>Voting</strong><span>Viewers send <code>!vote es</code>, <code>!vote en</code>, or another supported language.</span></li>
          <li><strong>Cancel</strong><span>The broadcaster or moderator sends <code>!cancel</code> before the raid completes.</span></li>
        </ol>
      </section>
    </main>
    <script>
      const copyButton = document.getElementById('copy-overlay');
      const overlayPath = document.getElementById('overlay-url').textContent;
      copyButton.addEventListener('click', async () => {
        const absolute = new URL(overlayPath, window.location.origin).href;
        await navigator.clipboard.writeText(absolute);
        copyButton.textContent = 'Copied';
      });
    </script>
  `);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#070711;color:#f7f4ff}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 78% 8%,#281d46 0,transparent 32rem),#070711}a{color:inherit}.shell{width:min(1080px,calc(100% - 40px));margin:0 auto;padding:72px 0 96px}.hero{max-width:760px;padding:64px 0}.brand{margin:0 0 16px;color:#b9a8ff;font-weight:750;letter-spacing:.04em}.hero h1,.account h1{margin:0;font-size:clamp(2.7rem,7vw,6rem);line-height:.94;letter-spacing:-.045em}.lede{max-width:650px;margin:28px 0 36px;color:#d7d0eb;font-size:1.2rem;line-height:1.65}.primary,button{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 20px;border:1px solid #9f87ff;border-radius:10px;background:#9f87ff;color:#100b1f;font:inherit;font-weight:800;text-decoration:none;cursor:pointer}.steps{display:grid;gap:0;margin:0;padding:0;list-style:none;border-top:1px solid #312a45}.steps li{display:grid;grid-template-columns:minmax(140px,.65fr) 1.35fr;gap:28px;padding:22px 0;border-bottom:1px solid #312a45}.steps span,.muted,.overlay-access p,.readiness span{color:#bdb5ce;line-height:1.55}.account{display:flex;align-items:center;gap:18px;margin-bottom:48px}.account img{border-radius:50%;object-fit:cover}.account h1{font-size:clamp(2.2rem,5vw,4.4rem)}h2{margin:0 0 16px;font-size:1.5rem;letter-spacing:-.02em}.overlay-access,.readiness,.guide{padding:32px 0;border-top:1px solid #3a3150}.overlay-access code{display:block;margin:22px 0;padding:16px;overflow-wrap:anywhere;border:1px solid #3a3150;border-radius:8px;background:#0d0a16;color:#d8ceff}.actions{display:flex;gap:12px;flex-wrap:wrap}.actions button{background:transparent;color:#e9e3ff}.readiness ul{margin:0;padding:0;list-style:none}.readiness li{display:grid;grid-template-columns:minmax(160px,.55fr) 1.45fr;gap:24px;padding:17px 0;border-bottom:1px solid #2d273b}.readiness li::before{content:'';width:8px;height:8px;margin-top:7px;border-radius:50%;background:#f1ad48;position:absolute;transform:translateX(-20px)}.readiness li[data-state=ready]::before{background:#6ce0a1}.readiness li{position:relative;margin-left:20px}.dashboard{max-width:920px}button:focus-visible,a:focus-visible{outline:3px solid #fff;outline-offset:4px}::selection{background:#9f87ff;color:#100b1f}@media(max-width:640px){.shell{width:min(100% - 28px,1080px);padding-top:36px}.steps li,.readiness li{grid-template-columns:1fr;gap:6px}.hero{padding-top:36px}}
  </style></head><body>${body}</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character] ?? character));
}

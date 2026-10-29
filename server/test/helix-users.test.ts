import { afterEach, describe, expect, it, vi } from 'vitest';
import { getUsers } from '../src/twitch/helix.js';

describe('Helix user profiles', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads profile image URLs for all requested streamer IDs', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/helix/users');
      expect(url.searchParams.getAll('id')).toEqual(['100', '200']);

      return new Response(JSON.stringify({
        data: [
          {
            id: '100',
            login: 'alpha',
            display_name: 'Alpha',
            type: '',
            broadcaster_type: 'affiliate',
            description: '',
            profile_image_url: 'https://static-cdn.jtvnw.net/alpha.png',
            offline_image_url: '',
            view_count: 0,
            created_at: '2026-01-01T00:00:00Z',
          },
          {
            id: '200',
            login: 'beta',
            display_name: 'Beta',
            type: '',
            broadcaster_type: '',
            description: '',
            profile_image_url: 'https://static-cdn.jtvnw.net/beta.png',
            offline_image_url: '',
            view_count: 0,
            created_at: '2026-01-02T00:00:00Z',
          },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const users = await getUsers(
      { accessToken: 'test-token', clientId: 'test-client' },
      ['100', '200', '100'],
    );

    expect(users.map(user => ({ id: user.id, profileImageUrl: user.profileImageUrl }))).toEqual([
      { id: '100', profileImageUrl: 'https://static-cdn.jtvnw.net/alpha.png' },
      { id: '200', profileImageUrl: 'https://static-cdn.jtvnw.net/beta.png' },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

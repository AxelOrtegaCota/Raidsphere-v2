/** Discovery and candidate selection belong only to the broadcaster's interactive tab. */
import { discoveryResponseSchema } from '@raidsphere/shared';
import type { DiscoveryCandidate } from '@raidsphere/shared';
import { TWITCH_LANGUAGES, getLanguageMeta } from './languages.js';

export type Candidate = DiscoveryCandidate;
export interface SearchPanelConfig {
  apiBaseUrl: string;
  isOverlay: boolean;
  onRaid?: (candidate: Candidate) => void | Promise<void>;
  onAdd?: (candidate: Candidate) => void;
}
export interface UserStatus { authenticated: boolean; isLive: boolean; login?: string; simulated?: boolean }

const node = <T extends keyof HTMLElementTagNameMap>(tag: T, className: string, text?: string): HTMLElementTagNameMap[T] => {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const button = (text: string, className: string, action: () => void): HTMLButtonElement => {
  const element = node('button', className, text);
  element.type = 'button'; element.addEventListener('click', action); return element;
};
const safeImage = (url: string, className: string): HTMLImageElement | null => {
  if (!url.startsWith('https://')) return null;
  const image = node('img', className);
  image.src = url; image.alt = ''; image.loading = 'lazy';
  image.addEventListener('error', () => image.remove());
  return image;
};

export function createSearchPanel(container: HTMLElement, config: SearchPanelConfig): {
  toggle: () => void; refresh: () => Promise<void>; updateUserStatus: (status: UserStatus) => void;
} {
  const panel = node('div', 'search-panel');
  // Fixed local markup only; network text is assigned through DOM properties.
  panel.innerHTML = `
    <div class="search-panel-header"><h2>Raid Candidates</h2></div>
    <div class="user-status"><span class="status-indicator offline"></span><span class="status-text">Checking status…</span></div>
    <div class="candidates-list"></div>
    <div class="candidate-detail" hidden><button class="detail-back" type="button">Back</button><div class="detail-content"></div></div>
    <div class="search-filters"><h3>Filters</h3>
      <div class="filter-row"><select id="filter-language" aria-label="Language"><option value="">All languages</option></select>
        <input id="filter-category" type="text" placeholder="Category" aria-label="Category" autocomplete="off"><div class="suggestions-dropdown"></div></div>
      <div class="filter-row"><input id="filter-search" type="text" placeholder="Search channel…" aria-label="Search channel"></div>
      <div class="filter-row"><label for="filter-viewers">Viewers</label><select id="filter-viewers" aria-label="Viewer range"></select></div>
      <button id="apply-filters" type="button">Apply Filters</button>
    </div>`;
  container.append(panel);
  const get = <T extends HTMLElement>(selector: string): T => panel.querySelector<T>(selector)!;
  const candidatesList = get<HTMLElement>('.candidates-list');
  const detail = get<HTMLElement>('.candidate-detail');
  const content = get<HTMLElement>('.detail-content');
  const language = get<HTMLSelectElement>('#filter-language');
  const category = get<HTMLInputElement>('#filter-category');
  const suggestions = get<HTMLElement>('.suggestions-dropdown');
  const search = get<HTMLInputElement>('#filter-search');
  const viewers = get<HTMLSelectElement>('#filter-viewers');
  let user: UserStatus = { authenticated: false, isLive: false };
  let selected: Candidate | null = null;
  let countdown: ReturnType<typeof setInterval> | undefined;
  let autocomplete: ReturnType<typeof setTimeout> | undefined;
  let categoryId: string | null = null;
  let searchGeneration = 0;
  let categoryGeneration = 0;
  let posting = false;
  let open = config.isOverlay;
  panel.classList.toggle('open', open);
  const toggle = (): void => { open = !open; panel.classList.toggle('open', open); };
  if (!config.isOverlay) get<HTMLElement>('.search-panel-header').append(button('Close', 'search-panel-close', toggle));

  for (const entry of TWITCH_LANGUAGES) {
    const option = node('option', '', `${entry.flag} ${entry.name}`); option.value = entry.code; language.append(option);
  }
  for (const range of ['0-10000000', '0-10', '10-50', '50-100', '100-500', '500-1000', '1000-5000', '5000-10000', '10000-50000', '50000-100000', '100000-1000000', '1000000-10000000']) {
    const option = node('option', '', range === '0-10000000' ? 'All' : range.replace('-', ' – ')); option.value = range; viewers.append(option);
  }
  const cancelCountdown = (): void => { clearInterval(countdown); countdown = undefined; content.querySelector('.detail-countdown')?.remove(); };
  const openStream = (candidate: Candidate): void => { window.open(`https://twitch.tv/${candidate.login}`, '_blank', 'noopener,noreferrer'); };
  const canRaid = (candidate: Candidate): boolean => user.authenticated && user.isLive && candidate.isLive && candidate.login !== user.login && !posting;
  const refreshDetailStatus = (): void => {
    const raid = content.querySelector<HTMLButtonElement>('.btn-raid');
    if (raid && selected) { raid.disabled = !canRaid(selected); raid.textContent = user.simulated === false ? 'Start Raid' : 'Simulate Raid'; }
    const add = content.querySelector<HTMLButtonElement>('.btn-add');
    if (add && selected) add.disabled = !user.authenticated || !selected.isLive || selected.login === user.login;
  };
  const updateUserStatus = (status: UserStatus): void => {
    user = status;
    get<HTMLElement>('.status-indicator').className = `status-indicator ${status.isLive ? 'live' : 'offline'}`;
    get<HTMLElement>('.status-text').textContent = !status.authenticated ? 'Not logged in' :
      `${status.login ?? 'Your channel'} is ${status.isLive ? 'LIVE' : 'OFFLINE'}${status.simulated !== false ? ' · raids are simulated' : ''}`;
    refreshDetailStatus();
  };

  const showDetail = (candidate: Candidate): void => {
    cancelCountdown(); selected = candidate; candidatesList.hidden = true; detail.hidden = false; content.replaceChildren();
    const avatar = node('div', 'detail-avatar');
    avatar.append(node('span', 'detail-avatar-fallback', candidate.displayName.charAt(0).toUpperCase()));
    const image = safeImage(candidate.profileImageUrl || candidate.thumbnailUrl, ''); if (image) avatar.append(image);
    content.append(avatar, node('h3', '', candidate.displayName), node('p', 'detail-status', candidate.isLive ? 'LIVE' : 'OFFLINE'),
      node('p', 'detail-language', getLanguageMeta(candidate.language).name), node('p', 'detail-game', `${candidate.game} · ${candidate.viewers} viewers`), node('p', 'detail-title', candidate.title));
    const timer = node('div', 'detail-countdown');
    const timerText = node('span', 'countdown-text'); let seconds = 10;
    timerText.textContent = `Opening stream in ${seconds}s…`;
    timer.append(timerText, button('Cancel opening', '', cancelCountdown)); content.append(timer);
    // This existing countdown opens a stream tab only. It never starts a raid.
    countdown = setInterval(() => {
      seconds -= 1; timerText.textContent = `Opening stream in ${seconds}s…`;
      if (seconds <= 0) { cancelCountdown(); openStream(candidate); }
    }, 1_000);
    const actions = node('div', 'detail-actions');
    actions.append(button('Open Stream', 'btn-primary', () => { cancelCountdown(); openStream(candidate); }));
    actions.append(button('Simulate Raid', 'btn-raid', () => {
      if (!canRaid(candidate) || !config.onRaid) return;
      cancelCountdown(); posting = true; refreshDetailStatus();
      void Promise.resolve().then(() => config.onRaid?.(candidate)).catch(() => {
        content.append(node('p', 'raid-warning', 'The action could not be completed. Check the control status before trying again.'));
      }).finally(() => { posting = false; refreshDetailStatus(); });
    }));
    if (config.onAdd) actions.append(button('Add to Roulette', 'btn-add', () => { cancelCountdown(); config.onAdd?.(candidate); }));
    content.append(actions, node('p', 'raid-warning', 'Raids require a live source and destination. Only a confirmed arrival completes a raid.'));
    refreshDetailStatus();
  };

  const renderCandidates = (candidates: Candidate[]): void => {
    candidatesList.replaceChildren();
    if (!candidates.length) { candidatesList.append(node('p', 'no-results', 'No candidates found. Try different filters.')); return; }
    for (const candidate of candidates) {
      const item = node('div', 'candidate-item'); item.tabIndex = 0; item.setAttribute('role', 'button');
      item.setAttribute('aria-label', `View ${candidate.displayName}`);
      const avatar = node('div', 'candidate-avatar-wrap');
      avatar.append(node('span', 'candidate-avatar-fallback', candidate.displayName.charAt(0).toUpperCase()));
      const image = safeImage(candidate.profileImageUrl || candidate.thumbnailUrl, 'candidate-avatar'); if (image) avatar.append(image);
      const info = node('div', 'candidate-info'); info.append(node('span', 'candidate-name', candidate.displayName), node('span', 'candidate-game', candidate.game));
      const meta = node('div', 'candidate-meta', `${candidate.isLive ? 'LIVE' : 'OFFLINE'} · ${candidate.viewers} · ${candidate.language || 'unknown'}`);
      item.append(avatar, info, meta);
      item.addEventListener('click', () => showDetail(candidate));
      item.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showDetail(candidate); } });
      item.addEventListener('contextmenu', (event) => {
        event.preventDefault(); document.querySelector('.context-menu')?.remove();
        const menu = node('div', 'context-menu');
        menu.style.left = `${event.clientX}px`; menu.style.top = `${event.clientY}px`;
        menu.append(button('Open stream', '', () => { openStream(candidate); menu.remove(); }), button('Copy channel URL', '', () => {
          void navigator.clipboard.writeText(`https://twitch.tv/${candidate.login}`); menu.remove();
        }));
        document.body.append(menu);
        setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
      });
      candidatesList.append(item);
    }
  };

  const refresh = async (): Promise<void> => {
    const generation = ++searchGeneration;
    cancelCountdown(); selected = null; detail.hidden = true; candidatesList.hidden = false;
    candidatesList.replaceChildren(node('p', 'loading', 'Loading candidates…'));
    const params = new URLSearchParams({ viewers: viewers.value });
    if (language.value) params.set('language', language.value);
    if (categoryId) params.set('gameId', categoryId); else if (category.value) params.set('category', category.value);
    if (search.value) params.set('q', search.value);
    try {
      const response = await fetch(`${config.apiBaseUrl}/api/test-helix?${params}`, { credentials: 'include', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error('Discovery unavailable');
      const data = discoveryResponseSchema.parse(await response.json());
      const unique = new Map<string, Candidate>();
      for (const candidate of [...data.streams, ...data.search_results]) if (!unique.has(candidate.id)) unique.set(candidate.id, candidate);
      if (generation === searchGeneration) renderCandidates([...unique.values()]);
    } catch { if (generation === searchGeneration) candidatesList.replaceChildren(node('p', 'no-results', 'Discovery is unavailable or returned invalid data.')); }
  };
  get<HTMLButtonElement>('.detail-back').addEventListener('click', () => { cancelCountdown(); selected = null; detail.hidden = true; candidatesList.hidden = false; });
  get<HTMLButtonElement>('#apply-filters').addEventListener('click', () => { void refresh(); });
  search.addEventListener('keydown', (event) => { if (event.key === 'Enter') void refresh(); });
  category.addEventListener('input', () => {
    categoryId = null; clearTimeout(autocomplete); const generation = ++categoryGeneration;
    suggestions.replaceChildren(); suggestions.classList.remove('visible');
    if (category.value.length < 2) return;
    autocomplete = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`${config.apiBaseUrl}/api/categories?q=${encodeURIComponent(category.value)}`, { credentials: 'include', signal: AbortSignal.timeout(10_000) });
          if (!response.ok) return;
          const raw: unknown = await response.json();
          if (generation !== categoryGeneration || typeof raw !== 'object' || raw === null || !('categories' in raw) || !Array.isArray(raw.categories)) return;
          suggestions.replaceChildren();
          for (const value of raw.categories.slice(0, 10)) {
            if (typeof value !== 'object' || value === null || !('id' in value) || !('name' in value) || typeof value.id !== 'string' || !/^[0-9]+$/.test(value.id) || typeof value.name !== 'string') continue;
            const id = value.id; const name = value.name.slice(0, 200);
            suggestions.append(button(name, 'suggestion-item', () => { category.value = name; categoryId = id; suggestions.replaceChildren(); suggestions.classList.remove('visible'); }));
          }
          suggestions.classList.toggle('visible', suggestions.childElementCount > 0);
        } catch { suggestions.classList.remove('visible'); }
      })();
    }, 300);
  });
  window.addEventListener('pagehide', () => { cancelCountdown(); clearTimeout(autocomplete); searchGeneration += 1; categoryGeneration += 1; }, { once: true });
  void refresh();
  return { toggle, refresh, updateUserStatus };
}

/**
 * Search Panel for discovering raid candidates via Helix API
 */
import { TWITCH_LANGUAGES, getLanguageMeta } from './languages.js';

export interface Candidate {
  id: string;
  login: string;
  displayName: string;
  game: string;
  title: string;
  viewers: number;
  language: string;
  thumbnailUrl: string;
  profileImageUrl: string;
  isLive: boolean;
}

export interface SearchPanelConfig {
  apiBaseUrl: string;
  isOverlay: boolean; // true = always open, false = toggle with button
  onRaid?: (candidate: Candidate) => void;
}

export interface UserStatus {
  authenticated: boolean;
  isLive: boolean;
  login?: string;
}

let selectedCandidate: Candidate | null = null;
let countdownTimer: number | null = null;
let countdownSeconds = 10;
let userStatus: UserStatus = { authenticated: false, isLive: false };

export function createSearchPanel(container: HTMLElement, config: SearchPanelConfig): {
  toggle: () => void;
  refresh: () => Promise<void>;
  updateUserStatus: (status: UserStatus) => void;
} {
  const panel = document.createElement('div');
  panel.className = 'search-panel';
  panel.innerHTML = `
    <div class="search-panel-header">
      <h2>🔍 Raid Candidates</h2>
      ${config.isOverlay ? '' : '<button class="search-panel-close" type="button" aria-label="Close">×</button>'}
    </div>
    <div class="user-status">
      <span class="status-indicator offline"></span>
      <span class="status-text">Checking status...</span>
    </div>
    <div class="candidates-list"></div>
    <div class="candidate-detail" hidden>
      <button class="detail-back" type="button">← Back</button>
      <div class="detail-content"></div>
    </div>
    <div class="search-filters">
      <h3>Filters</h3>
      <div class="filter-row">
        <select id="filter-language" aria-label="Language">
          <option value="">All languages</option>
          ${TWITCH_LANGUAGES.map(language => (
            `<option value="${language.code}">${language.flag} ${language.name}</option>`
          )).join('')}
        </select>
        <input type="text" id="filter-category" placeholder="Category (e.g. Minecraft)" aria-label="Category" autocomplete="off">
        <div id="category-suggestions" class="suggestions-dropdown"></div>
      </div>
      <div class="filter-row">
        <input type="text" id="filter-search" placeholder="🔍 Search channel..." aria-label="Search channel">
      </div>
      <div class="filter-row">
        <label>Viewers:</label>
        <select id="filter-viewers" aria-label="Viewer range">
          <option value="0-10000000">All</option>
          <option value="0-10">0 - 10</option>
          <option value="10-50">10 - 50</option>
          <option value="50-100">50 - 100</option>
          <option value="100-500">100 - 500</option>
          <option value="500-1000">500 - 1K</option>
          <option value="1000-5000">1K - 5K</option>
          <option value="5000-10000">5K - 10K</option>
          <option value="10000-50000">10K - 50K</option>
          <option value="50000-100000">50K - 100K</option>
          <option value="100000-1000000">100K - 1M</option>
          <option value="1000000-10000000">1M - 10M</option>
        </select>
      </div>
      <button id="apply-filters" type="button">Apply Filters</button>
    </div>
  `;

  container.appendChild(panel);

  // Elements
  const candidatesList = panel.querySelector<HTMLElement>('.candidates-list')!;
  const candidateDetail = panel.querySelector<HTMLElement>('.candidate-detail')!;
  const detailContent = panel.querySelector<HTMLElement>('.detail-content')!;
  const detailBack = panel.querySelector<HTMLButtonElement>('.detail-back')!;
  const closeBtn = panel.querySelector<HTMLButtonElement>('.search-panel-close');
  const applyFilters = panel.querySelector<HTMLButtonElement>('#apply-filters')!;
  const statusIndicator = panel.querySelector<HTMLElement>('.status-indicator')!;
  const statusText = panel.querySelector<HTMLElement>('.status-text')!;

  // Filters
  const languageFilter = panel.querySelector<HTMLSelectElement>('#filter-language')!;
  const categoryFilter = panel.querySelector<HTMLInputElement>('#filter-category')!;
  const categorySuggestions = panel.querySelector<HTMLElement>('#category-suggestions')!;
  const searchFilter = panel.querySelector<HTMLInputElement>('#filter-search')!;
  const viewersFilter = panel.querySelector<HTMLSelectElement>('#filter-viewers')!;

  // Category autocomplete state
  let selectedCategoryId: string | null = null;
  let autocompleteTimeout: number | null = null;

  // State
  let isOpen = config.isOverlay;
  if (config.isOverlay) {
    panel.classList.add('open');
  }

  // Toggle panel
  const toggle = () => {
    isOpen = !isOpen;
    panel.classList.toggle('open', isOpen);
  };

  if (closeBtn) {
    closeBtn.addEventListener('click', toggle);
  }

  // Update user status display
  const updateUserStatus = (status: UserStatus) => {
    userStatus = status;
    if (status.authenticated) {
      if (status.isLive) {
        statusIndicator.className = 'status-indicator live';
        statusText.textContent = `🔴 ${status.login} is LIVE — You can raid`;
      } else {
        statusIndicator.className = 'status-indicator offline';
        statusText.textContent = `⚫ ${status.login} is OFFLINE — Cannot raid`;
      }
    } else {
      statusIndicator.className = 'status-indicator offline';
      statusText.textContent = '⚫ Not logged in';
    }
  };

  // Fetch candidates from API
  const fetchCandidates = async (): Promise<Candidate[]> => {
    const params = new URLSearchParams();
    if (languageFilter.value) params.set('language', languageFilter.value);
    // Use gameId if we have it from autocomplete, otherwise use category name
    if (selectedCategoryId) {
      params.set('gameId', selectedCategoryId);
    } else if (categoryFilter.value) {
      params.set('category', categoryFilter.value);
    }
    if (searchFilter.value) params.set('q', searchFilter.value);
    if (viewersFilter.value) params.set('viewers', viewersFilter.value);

    try {
      const response = await fetch(`${config.apiBaseUrl}/api/test-helix?${params}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('API request failed');
      }
      const data = await response.json();

      const candidates: Candidate[] = [];

      // Add streams (main results with viewers)
      if (data.streams) {
        for (const s of data.streams) {
          candidates.push({
            id: s.id,
            login: s.login,
            displayName: s.displayName,
            game: s.game || 'Unknown',
            title: s.title || '',
            viewers: s.viewers || 0,
            language: s.language || '',
            thumbnailUrl: s.thumbnailUrl || '',
            profileImageUrl: s.profileImageUrl || '',
            isLive: true,
          });
        }
      }

      // Add search results if any (these might not have viewers)
      if (data.search_results) {
        for (const ch of data.search_results) {
          // Avoid duplicates
          if (!candidates.find(c => c.id === ch.id)) {
            candidates.push({
              id: ch.id,
              login: ch.login,
              displayName: ch.displayName,
              game: ch.game || 'Unknown',
              title: ch.title || '',
              viewers: ch.viewers || 0,
              language: ch.language || '',
              thumbnailUrl: '',
              profileImageUrl: ch.profileImageUrl || '',
              isLive: ch.isLive,
            });
          }
        }
      }

      return candidates;
    } catch (err) {
      console.error('Failed to fetch candidates:', err);
      return [];
    }
  };

  // Render candidates list
  const renderCandidates = (candidates: Candidate[]) => {
    if (candidates.length === 0) {
      candidatesList.innerHTML = '<p class="no-results">No candidates found. Try different filters.</p>';
      return;
    }

    candidatesList.innerHTML = candidates.map(candidate => {
      const language = getLanguageMeta(candidate.language);
      const imageUrl = candidate.profileImageUrl || candidate.thumbnailUrl;
      const initial = escapeHtml(candidate.displayName.charAt(0).toUpperCase());

      return `
        <div class="candidate-item" data-id="${escapeHtml(candidate.id)}" data-login="${escapeHtml(candidate.login)}">
          <div class="candidate-avatar-wrap">
            <span class="candidate-avatar-fallback" aria-hidden="true">${initial}</span>
            ${imageUrl ? `<img class="candidate-avatar" src="${escapeHtml(imageUrl)}" alt="" loading="lazy">` : ''}
          </div>
          <div class="candidate-info">
            <span class="candidate-name">${escapeHtml(candidate.displayName)}</span>
            <span class="candidate-game">${escapeHtml(candidate.game)}</span>
          </div>
          <div class="candidate-meta">
            <span class="candidate-status ${candidate.isLive ? 'live' : 'offline'}">${candidate.isLive ? '🔴' : '⚫'}</span>
            <span class="candidate-viewers">${candidate.viewers > 0 ? candidate.viewers.toLocaleString() : ''}</span>
            <span class="candidate-lang" title="${escapeHtml(language.name)} stream language; flag is representative, not location">${language.flag} ${escapeHtml(language.code.toUpperCase())}</span>
          </div>
        </div>`;
    }).join('');

    candidatesList.querySelectorAll<HTMLImageElement>('.candidate-avatar').forEach(image => {
      image.addEventListener('error', () => image.remove());
    });

    // Add click listeners
    candidatesList.querySelectorAll('.candidate-item').forEach(item => {
      const id = item.getAttribute('data-id')!;
      const candidate = candidates.find(c => c.id === id)!;

      item.addEventListener('click', () => showCandidateDetail(candidate));
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e as MouseEvent, candidate);
      });
    });
  };

  // Show candidate detail with countdown
  const showCandidateDetail = (candidate: Candidate) => {
    selectedCandidate = candidate;
    candidatesList.hidden = true;
    candidateDetail.hidden = false;
    countdownSeconds = 10;

    const canRaid = userStatus.authenticated && userStatus.isLive && candidate.isLive;
    const language = getLanguageMeta(candidate.language);
    const imageUrl = candidate.profileImageUrl || candidate.thumbnailUrl;
    const initial = escapeHtml(candidate.displayName.charAt(0).toUpperCase());

    detailContent.innerHTML = `
      <div class="detail-avatar">
        <span class="detail-avatar-fallback" aria-hidden="true">${initial}</span>
        ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="" loading="lazy">` : ''}
      </div>
      <h3>${escapeHtml(candidate.displayName)}</h3>
      <p class="detail-status ${candidate.isLive ? 'live' : 'offline'}">
        ${candidate.isLive ? '🔴 LIVE' : '⚫ OFFLINE'}
      </p>
      <p class="detail-language" title="Flag is representative of the stream language, not streamer location">${language.flag} ${escapeHtml(language.name)}</p>
      <p class="detail-game">${escapeHtml(candidate.game)} • ${candidate.viewers.toLocaleString()} viewers</p>
      <p class="detail-title">${escapeHtml(candidate.title)}</p>

      <div class="detail-countdown">
        <span class="countdown-text">Opening in <strong id="countdown-number">${countdownSeconds}</strong>s...</span>
        <button id="cancel-countdown" type="button">Cancel</button>
      </div>

      <div class="detail-actions">
        <button id="btn-open" type="button" class="btn-primary">🔗 Open Stream</button>
        <button id="btn-raid" type="button" class="btn-raid" ${canRaid ? '' : 'disabled'}>
          🚀 Start Raid
        </button>
      </div>
      ${!canRaid ? `<p class="raid-warning">${getRaidWarning(candidate)}</p>` : ''}
    `;

    detailContent.querySelector<HTMLImageElement>('.detail-avatar img')
      ?.addEventListener('error', event => (event.currentTarget as HTMLImageElement).remove());

    // Start countdown
    startCountdown(candidate);

    // Button listeners
    detailContent.querySelector('#cancel-countdown')?.addEventListener('click', cancelCountdown);
    detailContent.querySelector('#btn-open')?.addEventListener('click', () => {
      cancelCountdown();
      openStream(candidate);
    });
    detailContent.querySelector('#btn-raid')?.addEventListener('click', () => {
      if (canRaid && config.onRaid) {
        cancelCountdown();
        config.onRaid(candidate);
      }
    });
  };

  const getRaidWarning = (candidate: Candidate): string => {
    if (!userStatus.authenticated) return 'Login to enable raids';
    if (!userStatus.isLive) return 'You must be live to raid';
    if (!candidate.isLive) return 'Target must be live to raid';
    return '';
  };

  const startCountdown = (candidate: Candidate) => {
    cancelCountdown();
    const countdownEl = detailContent.querySelector<HTMLElement>('#countdown-number');

    countdownTimer = window.setInterval(() => {
      countdownSeconds--;
      if (countdownEl) countdownEl.textContent = String(countdownSeconds);

      if (countdownSeconds <= 0) {
        cancelCountdown();
        openStream(candidate);
      }
    }, 1000);
  };

  const cancelCountdown = () => {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    const countdownDiv = detailContent.querySelector('.detail-countdown');
    if (countdownDiv) countdownDiv.remove();
  };

  const openStream = (candidate: Candidate) => {
    window.open(`https://twitch.tv/${candidate.login}`, '_blank');
  };

  // Context menu for right-click
  const showContextMenu = (e: MouseEvent, candidate: Candidate) => {
    // Remove existing menu
    document.querySelector('.context-menu')?.remove();

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.innerHTML = `
      <button type="button" data-action="open">🔗 Open in new window</button>
      <button type="button" data-action="copy">📋 Copy channel URL</button>
    `;
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    document.body.appendChild(menu);

    menu.addEventListener('click', (ev) => {
      const action = (ev.target as HTMLElement).getAttribute('data-action');
      if (action === 'open') {
        window.open(`https://twitch.tv/${candidate.login}`, '_blank');
      } else if (action === 'copy') {
        navigator.clipboard.writeText(`https://twitch.tv/${candidate.login}`);
      }
      menu.remove();
    });

    // Close on click outside
    setTimeout(() => {
      document.addEventListener('click', () => menu.remove(), { once: true });
    }, 10);
  };

  // Back button
  detailBack.addEventListener('click', () => {
    cancelCountdown();
    selectedCandidate = null;
    candidateDetail.hidden = true;
    candidatesList.hidden = false;
  });

  // Apply filters
  const refresh = async () => {
    candidatesList.innerHTML = '<p class="loading">Loading candidates...</p>';
    const candidates = await fetchCandidates();
    renderCandidates(candidates);
  };

  applyFilters.addEventListener('click', refresh);
  searchFilter.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') refresh();
  });

  // Category autocomplete
  const fetchCategorySuggestions = async (query: string) => {
    if (query.length < 2) {
      categorySuggestions.innerHTML = '';
      categorySuggestions.classList.remove('visible');
      return;
    }

    try {
      const response = await fetch(`${config.apiBaseUrl}/api/categories?q=${encodeURIComponent(query)}`, {
        credentials: 'include',
      });
      if (!response.ok) return;

      const data = await response.json();
      if (data.categories && data.categories.length > 0) {
        categorySuggestions.innerHTML = data.categories.map((c: { id: string; name: string; boxArtUrl: string }) => `
          <div class="suggestion-item" data-id="${c.id}" data-name="${escapeHtml(c.name)}">
            <img src="${c.boxArtUrl}" alt="" onerror="this.style.display='none'">
            <span>${escapeHtml(c.name)}</span>
          </div>
        `).join('');
        categorySuggestions.classList.add('visible');

        // Add click listeners to suggestions
        categorySuggestions.querySelectorAll('.suggestion-item').forEach(item => {
          item.addEventListener('click', () => {
            const id = item.getAttribute('data-id')!;
            const name = item.getAttribute('data-name')!;
            categoryFilter.value = name;
            selectedCategoryId = id;
            categorySuggestions.innerHTML = '';
            categorySuggestions.classList.remove('visible');
          });
        });
      } else {
        categorySuggestions.innerHTML = '<div class="suggestion-empty">No categories found</div>';
        categorySuggestions.classList.add('visible');
      }
    } catch {
      categorySuggestions.innerHTML = '';
      categorySuggestions.classList.remove('visible');
    }
  };

  categoryFilter.addEventListener('input', () => {
    selectedCategoryId = null; // Reset selected ID when typing
    if (autocompleteTimeout) clearTimeout(autocompleteTimeout);
    autocompleteTimeout = window.setTimeout(() => {
      fetchCategorySuggestions(categoryFilter.value);
    }, 300);
  });

  categoryFilter.addEventListener('blur', () => {
    // Delay hiding to allow click on suggestion
    setTimeout(() => {
      categorySuggestions.classList.remove('visible');
    }, 200);
  });

  categoryFilter.addEventListener('focus', () => {
    if (categoryFilter.value.length >= 2) {
      fetchCategorySuggestions(categoryFilter.value);
    }
  });

  // Initial load
  refresh();

  return { toggle, refresh, updateUserStatus };
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

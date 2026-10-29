/**
 * Search Panel for discovering raid candidates via Helix API
 */

export interface Candidate {
  id: string;
  login: string;
  displayName: string;
  game: string;
  title: string;
  viewers: number;
  language: string;
  thumbnailUrl: string;
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
          <option value="es">Spanish</option>
          <option value="en">English</option>
          <option value="ja">Japanese</option>
          <option value="ko">Korean</option>
          <option value="pt">Portuguese</option>
          <option value="fr">French</option>
          <option value="de">German</option>
          <option value="ru">Russian</option>
          <option value="zh">Chinese</option>
        </select>
        <select id="filter-category" aria-label="Category">
          <option value="">All categories</option>
          <option value="just chatting">Just Chatting</option>
          <option value="minecraft">Minecraft</option>
          <option value="valorant">Valorant</option>
          <option value="fortnite">Fortnite</option>
          <option value="league of legends">League of Legends</option>
        </select>
      </div>
      <div class="filter-row">
        <input type="text" id="filter-search" placeholder="🔍 Search channel..." aria-label="Search channel">
      </div>
      <div class="filter-row viewers-range">
        <label>Viewers:</label>
        <input type="number" id="filter-min-viewers" value="5" min="0" aria-label="Min viewers">
        <span>-</span>
        <input type="number" id="filter-max-viewers" value="500" min="0" aria-label="Max viewers">
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
  const categoryFilter = panel.querySelector<HTMLSelectElement>('#filter-category')!;
  const searchFilter = panel.querySelector<HTMLInputElement>('#filter-search')!;
  const minViewers = panel.querySelector<HTMLInputElement>('#filter-min-viewers')!;
  const maxViewers = panel.querySelector<HTMLInputElement>('#filter-max-viewers')!;

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
    if (categoryFilter.value) params.set('q', categoryFilter.value);
    if (searchFilter.value) params.set('q', searchFilter.value);

    try {
      const response = await fetch(`${config.apiBaseUrl}/api/test-helix?${params}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error('API request failed');
      }
      const data = await response.json();
      
      // Combine search results and top streams
      const candidates: Candidate[] = [];
      
      if (data.search?.results) {
        for (const ch of data.search.results) {
          candidates.push({
            id: ch.id,
            login: ch.login,
            displayName: ch.displayName,
            game: ch.game || 'Unknown',
            title: ch.title || '',
            viewers: 0, // Search doesn't return viewers
            language: ch.language || '',
            thumbnailUrl: '',
            isLive: ch.isLive,
          });
        }
      }
      
      if (data.top_streams) {
        for (const s of data.top_streams) {
          // Avoid duplicates
          if (!candidates.find(c => c.id === s.id)) {
            candidates.push({
              id: s.id,
              login: s.login,
              displayName: s.name,
              game: s.game || 'Unknown',
              title: s.title || '',
              viewers: s.viewers || 0,
              language: s.language || '',
              thumbnailUrl: '',
              isLive: true,
            });
          }
        }
      }

      // Filter by viewer range
      const minV = parseInt(minViewers.value) || 0;
      const maxV = parseInt(maxViewers.value) || Infinity;
      return candidates.filter(c => c.viewers >= minV && c.viewers <= maxV);
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

    candidatesList.innerHTML = candidates.map(c => `
      <div class="candidate-item" data-id="${c.id}" data-login="${c.login}">
        <div class="candidate-info">
          <span class="candidate-name">${escapeHtml(c.displayName)}</span>
          <span class="candidate-game">${escapeHtml(c.game)}</span>
        </div>
        <div class="candidate-meta">
          <span class="candidate-status ${c.isLive ? 'live' : 'offline'}">${c.isLive ? '🔴' : '⚫'}</span>
          <span class="candidate-viewers">${c.viewers > 0 ? c.viewers + ' viewers' : ''}</span>
          <span class="candidate-lang">${c.language}</span>
        </div>
      </div>
    `).join('');

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

    detailContent.innerHTML = `
      <div class="detail-avatar">
        <img src="https://static-cdn.jtvnw.net/jtv_user_pictures/${candidate.login}-profile_image-70x70.png" 
             alt="${escapeHtml(candidate.displayName)}" 
             onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect fill=%22%23333%22 width=%22100%22 height=%22100%22/><text x=%2250%22 y=%2255%22 font-size=%2240%22 text-anchor=%22middle%22 fill=%22%23fff%22>${candidate.displayName.charAt(0)}</text></svg>'">
      </div>
      <h3>${escapeHtml(candidate.displayName)}</h3>
      <p class="detail-status ${candidate.isLive ? 'live' : 'offline'}">
        ${candidate.isLive ? '🔴 LIVE' : '⚫ OFFLINE'}
      </p>
      <p class="detail-game">${escapeHtml(candidate.game)} • ${candidate.viewers} viewers</p>
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

  // Initial load
  refresh();

  return { toggle, refresh, updateUserStatus };
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

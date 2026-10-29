import type { LanguageCode } from '@raidsphere/shared';
import { getLanguageMeta } from './languages';
import type { ViewState } from './view-state';

// Vote bars grouped by language, with that language's channels, and the winner card
// (Phase 2, Module A). Chat votes for a language, so the language row is the unit shown.

const CHANNELS_PER_ROW = 3;

export interface ChannelLine {
  name: string;
  detail: string;
}

export interface LanguageRow {
  language: LanguageCode;
  label: string;
  votes: number;
  // Share of all votes, from 0 to 1.
  share: number;
  chosen: boolean;
  channels: ChannelLine[];
  more: number;
}

export interface RoulettePanel {
  rows: LanguageRow[];
  totalVotes: number;
  winner: (ChannelLine & { title: string; language: string }) | null;
}

const SHOWN_STATUSES = new Set(['voting', 'selecting', 'chosen', 'raid_pending', 'done']);

export function describeRoulettePanel(state: ViewState): RoulettePanel | null {
  const roulette = state.roulette;
  if (!roulette || !SHOWN_STATUSES.has(roulette.status)) return null;
  const totalVotes = Object.values(roulette.votes).reduce((sum, count) => sum + (count ?? 0), 0);
  const winnerLanguage = roulette.chosenCandidate?.language ?? null;
  const languages = [...new Set(roulette.candidates.map((candidate) => candidate.language))];
  const rows = languages.map((language): LanguageRow => {
    const channels = roulette.candidates.filter((candidate) => candidate.language === language);
    const votes = roulette.votes[language] ?? 0;
    return {
      language, label: getLanguageMeta(language).name, votes, share: totalVotes === 0 ? 0 : votes / totalVotes,
      chosen: language === winnerLanguage,
      channels: channels.slice(0, CHANNELS_PER_ROW).map(channelLine),
      more: Math.max(0, channels.length - CHANNELS_PER_ROW),
    };
  });
  const chosen = roulette.chosenCandidate;
  return {
    rows, totalVotes,
    winner: chosen ? { ...channelLine(chosen), title: chosen.title, language: getLanguageMeta(chosen.language).name } : null,
  };
}

function channelLine(candidate: { displayName: string; viewers: number; gameName: string }): ChannelLine {
  const viewers = `${candidate.viewers} ${candidate.viewers === 1 ? 'viewer' : 'viewers'}`;
  return { name: candidate.displayName, detail: candidate.gameName ? `${viewers} · ${candidate.gameName}` : viewers };
}

// Network text is assigned through textContent only.
export function renderRoulettePanel(root: HTMLElement, panel: RoulettePanel | null): void {
  root.hidden = panel === null;
  if (!panel) {
    root.replaceChildren();
    return;
  }
  const rows = panel.rows.map((row) => {
    const item = element('li', 'vote-row');
    item.classList.toggle('chosen', row.chosen);
    const header = element('p', 'vote-header');
    header.append(text('span', 'vote-language', row.label), text('span', 'vote-count', `${row.votes}`));
    const bar = element('div', 'vote-bar');
    const fill = element('div', 'vote-fill');
    fill.style.width = `${Math.round(row.share * 100)}%`;
    bar.append(fill);
    const channels = element('ul', 'vote-channels');
    for (const channel of row.channels) {
      const line = element('li', 'vote-channel');
      line.append(text('span', 'channel-name', channel.name), text('span', 'channel-detail', channel.detail));
      channels.append(line);
    }
    if (row.more > 0) channels.append(text('li', 'vote-more', `+${row.more} more`));
    item.append(header, bar, channels);
    return item;
  });
  const list = element('ol', 'vote-rows');
  list.append(...rows);
  const children: HTMLElement[] = [list];
  if (panel.winner) {
    const card = element('article', 'winner-card');
    card.append(
      text('p', 'winner-label', `Chosen · ${panel.winner.language}`),
      text('p', 'winner-name', panel.winner.name),
      text('p', 'winner-detail', panel.winner.detail),
    );
    if (panel.winner.title) card.append(text('p', 'winner-title', panel.winner.title));
    children.unshift(card);
  }
  root.replaceChildren(...children);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function text<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, value: string): HTMLElementTagNameMap[K] {
  const node = element(tag, className);
  node.textContent = value;
  return node;
}

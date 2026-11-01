/**
 * Module C: Protect ordered source fragments during provider translation.
 * Heuristic token recognition never invents Twitch emote or user identities.
 */
import { z } from 'zod';
import { chatFragmentSchema } from '@raidsphere/shared';
import type { ChatFragment } from '@raidsphere/shared';

const COMMON_EMOTES = new Set([
  'Kappa', 'PogChamp', 'LUL', 'OMEGALUL', 'monkaS', 'PepeHands', 'FeelsBadMan', 'FeelsGoodMan',
  'KEKW', 'LULW', 'PepeLaugh', 'Sadge', 'EZ', 'Clap', 'Pog', 'POGGERS', 'PepoG',
  '4Head', 'BibleThump', 'DansGame', 'ResidentSleeper', 'NotLikeThis', 'WutFace',
  'Jebaited', 'CoolStoryBob', 'HeyGuys', 'VoHiYo', 'BlessRNG', 'TriHard',
  'haHAA', 'cmonBruh', 'HYPERS', 'widepeepoHappy', 'peepoHappy', 'peepoSad',
  'GG', 'WP', 'EZ Clap', 'F', 'W', 'L', 'copium', 'Copium', 'COPIUM',
  'JAJAJA', 'xd', 'XD', 'xD', 'lol', 'LOL', 'jaja', 'JAJA',
]);
const COMMON_WORDS = new Set([
  'The', 'This', 'That', 'What', 'When', 'Where', 'How', 'Why',
  'Hello', 'Thanks', 'Please', 'Welcome', 'Good', 'Great',
]);
// Slang, laughter, and keyboard smashes with nothing to translate, matched as whole words in any case.
// Laughter accepts any mix of its letters ("jajajjjaja"); a 5+ letter word without vowels is a smash.
// shortcut: hand-picked from common Twitch chat, not measured on real chat; extend from observed misses.
const CHAT_SLANG = [
  'g+g+', 'e+z+', 'wp', 'l+o+l+', 'lmf?a+o+', 'omg', 'wtf', 'x+d+', 'kekw?', 'pog(?:gers)?',
  '[ja]{4,}', '[je]{4,}', '[js]{4,}', '[jas]{5,}', '[ha]{4,}', '[he]{4,}', '[rs]{4,}', 'k{3,}', 'w{3,}',
  '[ㅋㅎㅠㅜ]{2,}', 'p?tdr', 'mdr',
  '[b-df-hj-np-tv-xz]{5,}', 'asdf\\p{L}*', 'qwer\\p{L}*', 'zxcv\\p{L}*',
];
const CHAT_SLANG_PATTERN = new RegExp('(?<![\\p{L}\\p{N}_])(?:' + CHAT_SLANG.join('|') + ')(?![\\p{L}\\p{N}_])', 'giu');
const EMOTE_LIKE_PATTERN =/\b[A-Z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+\b/g;
const PLACEHOLDER_PREFIX = '__RAIDSPHERE_';
const PLACEHOLDER_PATTERN = /__RAIDSPHERE_[0-9]+_[A-Z]+_[0-9]+__/g;
const sourceFragmentsSchema = z.array(chatFragmentSchema).min(1).max(100);
const emoteNamesSchema = z.array(z.string().min(1).max(2000));

export interface Fragment {
  type: 'text' | 'emote' | 'mention' | 'url' | 'emoji';
  value: string;
  placeholder?: string;
  start?: number;
  end?: number;
  sourceFragment?: ChatFragment;
}

export interface FragmentedMessage {
  original: string;
  fragments: Fragment[];
  protectedText: string;
  // Recognition may span text fragments; retain their exact canonical partition separately.
  sourceFragments?: ChatFragment[];
}

interface ProtectedSpan {
  start: number;
  end: number;
  type: Fragment['type'];
}

export function fragmentMessage(
  text: string,
  channelEmotes: string[] = [],
  sourceFragments?: ChatFragment[]
): FragmentedMessage {
  if (!z.string().max(2000).safeParse(text).success || !emoteNamesSchema.safeParse(channelEmotes).success) {
    throw new TypeError('Invalid fragment input.');
  }
  const parsedFragments = sourceFragments === undefined ? undefined : sourceFragmentsSchema.safeParse(sourceFragments);
  if (parsedFragments && (!parsedFragments.success ||
      parsedFragments.data.map(fragment => fragment.text).join('') !== text)) {
    throw new TypeError('Invalid source fragments.');
  }
  const segments: ChatFragment[] = parsedFragments?.success
    ? parsedFragments.data : [{ type: 'text', text }];
  let namespace = 0;
  while (text.includes('__RAIDSPHERE_' + namespace + '_')) namespace++;
  const prefix = '__RAIDSPHERE_' + namespace + '_';
  const fragments: Fragment[] = [];
  let offset = 0;
  let placeholderIndex = 0;

  const append = (type: Fragment['type'], value: string, protect: boolean, source?: ChatFragment): void => {
    fragments.push({
      type, value, start: offset, end: offset + value.length,
      ...(source === undefined ? {} : { sourceFragment: source }),
      ...(protect ? { placeholder: prefix + type.toUpperCase() + '_' + placeholderIndex++ + '__' } : {}),
    });
    offset += value.length;
  };

  let segmentIndex = 0;
  while (segmentIndex < segments.length) {
    const source = segments[segmentIndex];
    if (source === undefined) throw new TypeError('Invalid source fragments.');
    if (source.type !== 'text') {
      append(source.type === 'link' ? 'url' : source.type, source.text, true, source);
      segmentIndex++;
      continue;
    }
    // Only contiguous text participates in recognition across canonical boundaries.
    // Authoritative emotes, mentions, and links always remain independent.
    let runText = '';
    const runSources: { fragment: ChatFragment; start: number; end: number }[] = [];
    while (segmentIndex < segments.length) {
      const next = segments[segmentIndex];
      if (next === undefined || next.type !== 'text') break;
      runSources.push({ fragment: next, start: runText.length, end: runText.length + next.text.length });
      runText += next.text;
      segmentIndex++;
    }
    const appendRun = (type: Fragment['type'], start: number, end: number, protect: boolean): void => {
      const owner = runSources.find(candidate => start >= candidate.start && end <= candidate.end);
      append(type, runText.slice(start, end), protect, owner?.fragment);
    };
    const spans = findProtectedSpans(runText, channelEmotes);
    let cursor = 0;
    for (const span of spans) {
      if (span.start > cursor) appendRun('text', cursor, span.start, false);
      appendRun(span.type, span.start, span.end, true);
      cursor = span.end;
    }
    if (cursor < runText.length || runText.length === 0) {
      appendRun('text', cursor, runText.length, false);
    }
  }
  return {
    original: text,
    fragments,
    protectedText: fragments.map(fragment => fragment.placeholder ?? fragment.value).join(''),
    sourceFragments: segments,
  };
}

function findProtectedSpans(text: string, channelEmotes: string[]): ProtectedSpan[] {
  const spans: ProtectedSpan[] = [];
  const add = (start: number, end: number, type: Fragment['type']): void => {
    if (!spans.some(span => start < span.end && end > span.start)) spans.push({ start, end, type });
  };
  const match = (pattern: RegExp, type: Fragment['type']): void => {
    for (const value of text.matchAll(pattern)) {
      if (value.index !== undefined) add(value.index, value.index + value[0].length, type);
    }
  };
  match(/https?:\/\/[^\s]+/g, 'url');
  // Protect literal marker text before generating any tokens, including incomplete
  // prefixes. This scan cannot consume generated tokens or adjacent Unicode content.
  // Keep existing URL protection intact when a literal overlaps a URL boundary.
  for (const literal of text.matchAll(/__RAIDSPHERE_[A-Za-z0-9_]*/g)) {
    if (literal.index === undefined) continue;
    let cursor = literal.index;
    const end = cursor + literal[0].length;
    for (const covered of [...spans].sort((first, second) => first.start - second.start)) {
      if (covered.end <= cursor) continue;
      if (covered.start >= end) break;
      if (covered.start > cursor) add(cursor, covered.start, 'text');
      cursor = Math.max(cursor, covered.end);
      if (cursor >= end) break;
    }
    if (cursor < end) add(cursor, end, 'text');
  }
  match(/@\w+/g, 'mention');
  const words = [...new Set([...COMMON_EMOTES, ...channelEmotes])]
    .sort((first, second) => second.length - first.length).map(escapeRegex);
  if (words.length > 0) {
    match(new RegExp('(?<![\\p{L}\\p{N}_])(?:' + words.join('|') + ')(?![\\p{L}\\p{N}_])', 'gu'), 'emote');
  }
  match(CHAT_SLANG_PATTERN, 'emote');
  for (const value of text.matchAll(EMOTE_LIKE_PATTERN)) {
    if (value.index !== undefined && !COMMON_WORDS.has(value[0])) {
      add(value.index, value.index + value[0].length, 'emote');
    }
  }
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  for (const { segment, index } of segmenter.segment(text)) {
    if (/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(segment)) {
      add(index, index + segment.length, 'emoji');
    }
  }
  return spans.sort((first, second) => first.start - second.start);
}

export function restoreFragments(translatedText: string, fragmented: FragmentedMessage): string {
  const fail = (): never => { throw new Error('Protected fragment integrity check failed.'); };
  if (typeof translatedText !== 'string' || !fragmented || !Array.isArray(fragmented.fragments)) return fail();
  if (fragmented.fragments.map(fragment => fragment.value).join('') !== fragmented.original ||
      fragmented.fragments.map(fragment => fragment.placeholder ?? fragment.value).join('') !== fragmented.protectedText) {
    return fail();
  }
  if (fragmented.sourceFragments !== undefined) {
    const source = sourceFragmentsSchema.safeParse(fragmented.sourceFragments);
    if (!source.success || source.data.map(fragment => fragment.text).join('') !== fragmented.original) return fail();
  }
  const expected = fragmented.fragments.flatMap(fragment => fragment.placeholder === undefined ? [] : [fragment.placeholder]);
  const replacements = new Map(fragmented.fragments.flatMap(fragment =>
    fragment.placeholder === undefined ? [] : [[fragment.placeholder, fragment.value] satisfies [string, string]]
  ));
  const actual: string[] = [];
  let cursor = 0;
  for (const match of translatedText.matchAll(PLACEHOLDER_PATTERN)) {
    if (match.index === undefined || translatedText.slice(cursor, match.index).includes(PLACEHOLDER_PREFIX)) return fail();
    actual.push(match[0]);
    cursor = match.index + match[0].length;
  }
  // Reject malformed reserved markers as well as unexpected well-formed tokens.
  // Inspect each gap separately to avoid joining unrelated translated text.
  if (translatedText.slice(cursor).includes(PLACEHOLDER_PREFIX)) return fail();
  if (replacements.size !== expected.length || actual.length !== expected.length ||
      actual.some((token, index) => token !== expected[index])) {
    return fail();
  }
  return translatedText.replace(PLACEHOLDER_PATTERN, token => {
    const value = replacements.get(token);
    return value === undefined ? fail() : value;
  });
}

export function extractEmotes(text: string, channelEmotes: string[] = []): string[] {
  return fragmentMessage(text, channelEmotes).fragments
    .filter(fragment => fragment.type === 'emote').map(fragment => fragment.value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^{}$()|[\]\\]/g, '\\$&');
}

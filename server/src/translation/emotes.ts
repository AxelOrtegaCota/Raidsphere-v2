/**
 * Module C: Emote preservation
 * 
 * Extracts, protects, and restores Twitch emotes and fragments during translation.
 * Prevents the LLM from mangling KEKW, PogChamp, etc.
 */

// Common Twitch/BTTV/FFZ emotes to preserve
const COMMON_EMOTES = new Set([
  // Twitch global
  'Kappa', 'PogChamp', 'LUL', 'OMEGALUL', 'monkaS', 'PepeHands', 'FeelsBadMan', 'FeelsGoodMan',
  'KEKW', 'LULW', 'PepeLaugh', 'Sadge', 'EZ', 'Clap', 'Pog', 'POGGERS', 'PepoG',
  '4Head', 'BibleThump', 'DansGame', 'ResidentSleeper', 'NotLikeThis', 'WutFace',
  'Jebaited', 'CoolStoryBob', 'HeyGuys', 'VoHiYo', 'BlessRNG', 'TriHard',
  'haHAA', 'cmonBruh', 'HYPERS', 'widepeepoHappy', 'peepoHappy', 'peepoSad',
  // Gaming
  'GG', 'WP', 'EZ Clap', 'F', 'W', 'L', 'Sadge', 'copium', 'Copium', 'COPIUM',
  // Spanish common
  'JAJAJA', 'xd', 'XD', 'xD', 'lol', 'LOL', 'jaja', 'JAJA',
]);

// Pattern for custom channel emotes (usually camelCase or with channel prefix)
const CUSTOM_EMOTE_PATTERN = /\b[a-z]+[A-Z][a-zA-Z0-9]*\b/g;

// Pattern for emote-like strings (PascalCase with numbers)
const EMOTE_LIKE_PATTERN = /\b[A-Z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+\b/g;

export interface Fragment {
  type: 'text' | 'emote' | 'mention' | 'url' | 'emoji';
  value: string;
  placeholder?: string;
}

export interface FragmentedMessage {
  original: string;
  fragments: Fragment[];
  protectedText: string; // Text with placeholders instead of emotes
}

/**
 * Fragment a message, identifying and protecting emotes and special content.
 */
export function fragmentMessage(text: string, channelEmotes: string[] = []): FragmentedMessage {
  const fragments: Fragment[] = [];
  const allEmotes = new Set([...COMMON_EMOTES, ...channelEmotes]);
  
  // Build regex for all known emotes
  const emoteWords = Array.from(allEmotes).map(e => escapeRegex(e));
  const emotePattern = emoteWords.length > 0 
    ? new RegExp(`\\b(${emoteWords.join('|')})\\b`, 'g')
    : null;
  
  // Track replacements
  let protectedText = text;
  let placeholderIndex = 0;
  
  // Protect URLs first
  const urlPattern = /https?:\/\/[^\s]+/g;
  protectedText = protectedText.replace(urlPattern, (match) => {
    const placeholder = `__URL_${placeholderIndex++}__`;
    fragments.push({ type: 'url', value: match, placeholder });
    return placeholder;
  });
  
  // Protect mentions (@username)
  const mentionPattern = /@\w+/g;
  protectedText = protectedText.replace(mentionPattern, (match) => {
    const placeholder = `__MENTION_${placeholderIndex++}__`;
    fragments.push({ type: 'mention', value: match, placeholder });
    return placeholder;
  });
  
  // Protect known emotes
  if (emotePattern) {
    protectedText = protectedText.replace(emotePattern, (match) => {
      const placeholder = `__EMOTE_${placeholderIndex++}__`;
      fragments.push({ type: 'emote', value: match, placeholder });
      return placeholder;
    });
  }
  
  // Protect emote-like patterns (PascalCase)
  protectedText = protectedText.replace(EMOTE_LIKE_PATTERN, (match) => {
    // Skip if already a placeholder
    if (match.startsWith('__') && match.endsWith('__')) return match;
    // Skip common words
    if (isCommonWord(match)) return match;
    
    const placeholder = `__EMOTE_${placeholderIndex++}__`;
    fragments.push({ type: 'emote', value: match, placeholder });
    return placeholder;
  });
  
  // Protect standard emoji (Unicode)
  const emojiPattern = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu;
  protectedText = protectedText.replace(emojiPattern, (match) => {
    const placeholder = `__EMOJI_${placeholderIndex++}__`;
    fragments.push({ type: 'emoji', value: match, placeholder });
    return placeholder;
  });
  
  return {
    original: text,
    fragments,
    protectedText,
  };
}

/**
 * Restore protected fragments after translation.
 */
export function restoreFragments(translatedText: string, fragmented: FragmentedMessage): string {
  let result = translatedText;
  
  for (const fragment of fragmented.fragments) {
    if (fragment.placeholder) {
      // Replace placeholder with original value
      result = result.replace(fragment.placeholder, fragment.value);
      
      // Also handle case where LLM might have added spaces around placeholder
      result = result.replace(
        new RegExp(`\\s*${escapeRegex(fragment.placeholder)}\\s*`, 'g'),
        ` ${fragment.value} `
      );
    }
  }
  
  // Clean up extra spaces
  result = result.replace(/\s+/g, ' ').trim();
  
  return result;
}

/**
 * Get emotes from a message (for display purposes).
 */
export function extractEmotes(text: string, channelEmotes: string[] = []): string[] {
  const fragmented = fragmentMessage(text, channelEmotes);
  return fragmented.fragments
    .filter(f => f.type === 'emote')
    .map(f => f.value);
}

// Helper functions
function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isCommonWord(word: string): boolean {
  const common = new Set([
    'The', 'This', 'That', 'What', 'When', 'Where', 'How', 'Why',
    'Hello', 'Thanks', 'Please', 'Welcome', 'Good', 'Great',
  ]);
  return common.has(word);
}

import { BUBBLE_LIFETIME_MS, describeBubble, describeWindow } from './translation-view';
import type { BubbleView, TranslationView } from './translation-view';

// Renders translation bubbles. Chat and model text come from the network, so every value is
// assigned through textContent and never interpreted as HTML.

const FADE_MS = 600;
const SLIDE_MS = 280;

interface BubbleNodes {
  root: HTMLLIElement;
  name: HTMLElement;
  languages: HTMLElement;
  primary: HTMLElement;
  secondary: HTMLElement;
}

export function createTranslationLayer(windowLabel: HTMLElement, list: HTMLOListElement) {
  // Keyed by message, so an update keeps its node and its place.
  const nodes = new Map<string, BubbleNodes>();

  const render = (view: TranslationView, nowMs: number): void => {
    const label = describeWindow(view, nowMs);
    windowLabel.hidden = label === null;
    windowLabel.textContent = label ?? '';

    const topsBefore = new Map([...nodes].map(([messageId, { root }]) => [messageId, root.getBoundingClientRect().top]));
    const visible = new Set(view.bubbles.map((bubble) => bubble.messageId));
    for (const [messageId, bubbleNodes] of nodes) {
      if (!visible.has(messageId)) {
        bubbleNodes.root.remove();
        nodes.delete(messageId);
      }
    }
    const roots = view.bubbles.map((bubble) => {
      const bubbleNodes = nodes.get(bubble.messageId) ?? createBubble(bubble.messageId);
      if (!nodes.has(bubble.messageId)) nodes.set(bubble.messageId, bubbleNodes);
      fill(bubbleNodes, bubble, nowMs);
      return bubbleNodes.root;
    });
    placeInOrder(list, roots);
    // On a very short screen a bubble that does not fit is hidden whole, never cut in half.
    for (const { root } of nodes.values()) root.classList.toggle('clipped', root.offsetTop < list.offsetTop);
    slide(nodes, topsBefore);
  };

  return { render };
}

// Inserts only the nodes that are new or out of place: re-inserting a node that is already
// shown restarts its entry animation, which made every bubble flicker on each 250 ms render.
export function placeInOrder(
  list: Pick<Element, 'firstElementChild' | 'insertBefore'>, roots: readonly Element[],
): void {
  let next = list.firstElementChild;
  for (const root of roots) {
    if (root === next) next = root.nextElementSibling;
    else list.insertBefore(root, next);
  }
}

// Bubbles that changed position glide there, so the queue reads as moving up one place.
function slide(nodes: ReadonlyMap<string, BubbleNodes>, topsBefore: ReadonlyMap<string, number>): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const [messageId, { root }] of nodes) {
    const before = topsBefore.get(messageId);
    const offset = before === undefined ? 0 : before - root.getBoundingClientRect().top;
    if (Math.abs(offset) < 1) continue;
    root.animate(
      [{ transform: `translateY(${offset}px)` }, { transform: 'none' }],
      { duration: SLIDE_MS, easing: 'ease-out' },
    );
  }
}

function createBubble(messageId: string): BubbleNodes {
  const root = document.createElement('li');
  root.className = 'bubble';
  root.dataset.messageId = messageId;
  const header = document.createElement('p');
  header.className = 'bubble-header';
  const name = document.createElement('span');
  name.className = 'bubble-name';
  const languages = document.createElement('span');
  languages.className = 'bubble-languages';
  header.append(name, languages);
  const primary = document.createElement('p');
  primary.className = 'bubble-primary';
  const secondary = document.createElement('p');
  secondary.className = 'bubble-secondary';
  root.append(header, primary, secondary);
  return { root, name, languages, primary, secondary };
}

function fill(nodes: BubbleNodes, bubble: BubbleView, nowMs: number): void {
  const text = describeBubble(bubble);
  nodes.root.dataset.status = bubble.status;
  nodes.root.classList.toggle('leaving', nowMs - bubble.shownAtMs >= BUBBLE_LIFETIME_MS - FADE_MS);
  nodes.name.textContent = bubble.displayName;
  nodes.languages.textContent = text.languages;
  nodes.primary.textContent = text.primary;
  nodes.secondary.textContent = text.secondary;
}

import { BUBBLE_LIFETIME_MS, describeBubble, describeWindow } from './translation-view';
import type { BubbleView, TranslationView } from './translation-view';

// Renders translation bubbles. Chat and model text come from the network, so every value is
// assigned through textContent and never interpreted as HTML.

const FADE_MS = 600;

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

    const visible = new Set(view.bubbles.map((bubble) => bubble.messageId));
    for (const [messageId, bubbleNodes] of nodes) {
      if (!visible.has(messageId)) {
        bubbleNodes.root.remove();
        nodes.delete(messageId);
      }
    }
    for (const bubble of view.bubbles) {
      const bubbleNodes = nodes.get(bubble.messageId) ?? createBubble(bubble.messageId);
      if (!nodes.has(bubble.messageId)) nodes.set(bubble.messageId, bubbleNodes);
      fill(bubbleNodes, bubble, nowMs);
      list.append(bubbleNodes.root);
    }
  };

  return { render };
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

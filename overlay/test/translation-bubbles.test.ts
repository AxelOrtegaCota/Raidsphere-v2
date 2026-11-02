import { describe, expect, it } from 'vitest';
import { placeInOrder } from '../src/translation-bubbles';

// A minimal stand-in for the bubble list: it records every insertion, since an insertion
// restarts a shown bubble's entry animation.
class FakeList {
  readonly children: FakeNode[] = [];
  inserted: string[] = [];

  get firstElementChild(): FakeNode | null { return this.children[0] ?? null; }

  insertBefore(node: FakeNode, reference: FakeNode | null): FakeNode {
    this.inserted.push(node.id);
    const current = this.children.indexOf(node);
    if (current >= 0) this.children.splice(current, 1);
    const index = reference ? this.children.indexOf(reference) : this.children.length;
    this.children.splice(index, 0, node);
    return node;
  }
}

class FakeNode {
  constructor(readonly list: FakeList, readonly id: string) {}

  get nextElementSibling(): FakeNode | null {
    return this.list.children[this.list.children.indexOf(this) + 1] ?? null;
  }
}

const place = (list: FakeList, roots: FakeNode[]): string[] => {
  list.inserted = [];
  placeInOrder(list as unknown as Element, roots as unknown as Element[]);
  return list.inserted;
};

describe('translation bubble placement', () => {
  it('never re-inserts bubbles that are already shown in order', () => {
    const list = new FakeList();
    const [a, b, c] = ['a', 'b', 'c'].map((id) => new FakeNode(list, id)) as [FakeNode, FakeNode, FakeNode];

    expect(place(list, [a, b])).toEqual(['a', 'b']);
    expect(place(list, [a, b])).toEqual([]);

    // The oldest bubble left and a new one arrived: only the new one is inserted.
    list.children.splice(0, 1);
    expect(place(list, [b, c])).toEqual(['c']);
    expect(list.children.map((node) => node.id)).toEqual(['b', 'c']);
  });

  it('moves a bubble only when the order changed', () => {
    const list = new FakeList();
    const [a, b] = ['a', 'b'].map((id) => new FakeNode(list, id)) as [FakeNode, FakeNode];
    place(list, [a, b]);

    expect(place(list, [b, a])).toHaveLength(1);
    expect(list.children.map((node) => node.id)).toEqual(['b', 'a']);
  });
});

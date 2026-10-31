import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ViewingCredentials } from '../src/viewing/credentials.js';

// All identifiers in this file are synthetic fixtures.
describe('viewing credentials', () => {
  const { credentials, issued } = ViewingCredentials.issue(['rsdemo_es_01', 'rsdemo_ja_01']);
  const source = issued.get('rsdemo_es_01') ?? '';
  const destination = issued.get('rsdemo_ja_01') ?? '';

  it('issues one unique 43-character base64url credential per channel', () => {
    expect([...issued.keys()]).toEqual(['rsdemo_es_01', 'rsdemo_ja_01']);
    for (const credential of [source, destination]) expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(source).not.toBe(destination);
  });

  it('accepts only the credential issued for that channel', () => {
    expect(credentials.verify('rsdemo_es_01', source)).toBe(true);
    expect(credentials.verify('rsdemo_es_01', destination)).toBe(false);
    expect(credentials.verify('rsdemo_es_01', '')).toBe(false);
    expect(credentials.verify('rsdemo_unknown', source)).toBe(false);
    expect(credentials.verify('rsdemo_unknown', '')).toBe(false);
  });

  it('accepts a credential issued dynamically after startup', () => {
    const { credentials } = ViewingCredentials.issue([]);
    const credential = credentials.issueForChannel('themask957');

    expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(credentials.verify('themask957', credential)).toBe(true);
    expect(credentials.verify('another_channel', credential)).toBe(false);
  });

  it('does not retain plaintext credentials in the verifier', () => {
    const description = inspect(credentials, { showHidden: true, depth: 5 });
    expect(description).not.toContain(source);
    expect(description).not.toContain(destination);
  });
});

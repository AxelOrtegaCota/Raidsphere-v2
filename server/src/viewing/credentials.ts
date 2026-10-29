import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Read-only viewing credentials (D2-11 rule 1). Generated per server start, kept only as
// SHA-256 digests in memory, and compared in constant time. They grant no control capability.

const CREDENTIAL_BYTES = 32;

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
// Compared against for unknown channels so timing does not reveal which channels exist.
const UNKNOWN_CHANNEL_DIGEST = digest('');

export class ViewingCredentials {
  readonly #digests: ReadonlyMap<string, Buffer>;

  private constructor(digests: ReadonlyMap<string, Buffer>) {
    this.#digests = digests;
  }

  // Returns each plaintext credential exactly once; the verifier keeps only digests.
  static issue(channelIds: readonly string[]): { credentials: ViewingCredentials; issued: ReadonlyMap<string, string> } {
    const issued = new Map<string, string>();
    const digests = new Map<string, Buffer>();
    for (const channelId of channelIds) {
      const credential = randomBytes(CREDENTIAL_BYTES).toString('base64url');
      issued.set(channelId, credential);
      digests.set(channelId, digest(credential));
    }
    return { credentials: new ViewingCredentials(digests), issued };
  }

  verify(channelId: string, credential: string): boolean {
    const expected = this.#digests.get(channelId);
    const matches = timingSafeEqual(digest(credential), expected ?? UNKNOWN_CHANNEL_DIGEST);
    return matches && expected !== undefined;
  }
}

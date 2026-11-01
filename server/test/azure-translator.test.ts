import { describe, expect, it } from 'vitest';
import type { ChatTextMessage } from '../src/application/ports.js';
import { AzureTranslator, loadAzureTranslatorConfig, toLanguageCode } from '../src/translation/azure.js';
import { ServiceChatTranslator } from '../src/translation/chat-translator.js';
import { extractEmotes } from '../src/translation/emotes.js';

// A fictitious key: no request leaves the process, every call goes to the fake fetch below.
const FAKE_KEY = 'fixture-azure-key';

interface Call { url: URL; headers: Record<string, string>; text: string }

function fakeAzure(respond: (call: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { Text: string }[];
    const call = { url: new URL(String(input)), headers: init?.headers as Record<string, string>, text: body[0]?.Text ?? '' };
    calls.push(call);
    const { status = 200, body: payload } = respond(call);
    return new Response(JSON.stringify(payload ?? {}), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetch: fetchFake };
}

// Azure "translates" by swapping one word and keeps the HTML around protected content.
const swapHello = (call: Call) => call.url.pathname === '/detect'
  ? { body: [{ language: 'en', score: 1 }] }
  : { body: [{ translations: [{ text: call.text.replace('hello', 'hola'), to: 'es' }] }] };

const request = (text: string) => ({ text, sourceLanguage: 'en' as const, targetLanguage: 'es' as const });

describe('Azure translator provider', () => {
  it('sends the key, the language pair, and protected HTML, and restores emotes', async () => {
    const azure = fakeAzure(swapHello);
    const translator = new AzureTranslator({ key: FAKE_KEY, region: 'westus', fetch: azure.fetch });
    const response = await translator.translate(request('hello <b> Kappa'));
    expect(response).toMatchObject({ success: true, result: { translatedText: 'hola <b> Kappa', provenance: 'provider' } });
    const [call] = azure.calls;
    expect(call?.url.searchParams.get('from')).toBe('en');
    expect(call?.url.searchParams.get('to')).toBe('es');
    expect(call?.url.searchParams.get('textType')).toBe('html');
    expect(call?.headers).toMatchObject({ 'Ocp-Apim-Subscription-Key': FAKE_KEY, 'Ocp-Apim-Subscription-Region': 'westus' });
    // Chat text cannot become markup, and the emote travels as an untranslatable placeholder.
    expect(call?.text).toMatch(/^hello &lt;b&gt; <span class="notranslate">__RAIDSPHERE_0_EMOTE_0__<\/span>$/);
  });

  it('omits the region header for a global resource', async () => {
    const azure = fakeAzure(swapHello);
    await new AzureTranslator({ key: FAKE_KEY, fetch: azure.fetch }).translate(request('hello'));
    expect(azure.calls[0]?.headers).not.toHaveProperty('Ocp-Apim-Subscription-Region');
  });

  it('rejects a translation that loses protected content', async () => {
    const azure = fakeAzure(() => ({ body: [{ translations: [{ text: 'hola', to: 'es' }] }] }));
    const response = await new AzureTranslator({ key: FAKE_KEY, fetch: azure.fetch }).translate(request('hello Kappa'));
    expect(response).toMatchObject({ success: false, error: { code: 'PROVIDER_ERROR' } });
  });

  it('maps HTTP failures to fixed errors that never contain the key', async () => {
    for (const [status, code] of [[429, 'RATE_LIMIT'], [403, 'PROVIDER_ERROR'], [500, 'PROVIDER_ERROR']] as const) {
      const azure = fakeAzure(() => ({ status, body: { error: { code: status * 1000, message: 'fixture' } } }));
      const response = await new AzureTranslator({ key: FAKE_KEY, fetch: azure.fetch }).translate(request('hello'));
      expect(response).toMatchObject({ success: false, error: { code } });
      expect(JSON.stringify(response)).not.toContain(FAKE_KEY);
    }
  });

  it('rejects an unexpected response shape', async () => {
    const azure = fakeAzure(() => ({ body: [{ unexpected: true }] }));
    const response = await new AzureTranslator({ key: FAKE_KEY, fetch: azure.fetch }).translate(request('hello'));
    expect(response).toMatchObject({ success: false, error: { code: 'PROVIDER_ERROR' } });
  });
});

describe('Azure language detection', () => {
  const detectWith = (language: string, score: number) =>
    new AzureTranslator({ key: FAKE_KEY, fetch: fakeAzure(() => ({ body: [{ language, score }] })).fetch });

  it('returns a supported language only when the score is high enough', async () => {
    await expect(detectWith('es', 0.95).detect('hola a todos')).resolves.toBe('es');
    await expect(detectWith('pt-PT', 1).detect('olá')).resolves.toBe('pt');
    await expect(detectWith('es', 0.4).detect('ok')).resolves.toBeNull();
    await expect(detectWith('zh-Hans', 1).detect('你好')).resolves.toBeNull();
  });

  it('rejects when detection fails, instead of guessing', async () => {
    const azure = fakeAzure(() => ({ status: 401 }));
    await expect(new AzureTranslator({ key: FAKE_KEY, fetch: azure.fetch }).detect('hello')).rejects.toThrow();
  });

  it('maps only the base language code', () => {
    expect(toLanguageCode('KO')).toBe('ko');
    expect(toLanguageCode('ja')).toBe('ja');
    expect(toLanguageCode('it')).toBeNull();
  });
});

describe('chat slang protection', () => {
  it('protects laughter and smashes but not real words that look similar', () => {
    for (const slang of ['jajajjjajaajaaj', 'jsjs', 'hahahhaah', 'wwkhjwww', 'ㅋㅋㅎㅋ', 'KKKKK', 'ptdr', 'Gg', 'loool']) {
      expect(extractEmotes(slang)).toEqual([slang]);
    }
    for (const word of ['je suis là', 'java', 'thx', 'lollipop', 'hola', 'rhythm']) {
      expect(extractEmotes(word)).toEqual([]);
    }
  });
});

describe('Azure configuration', () => {
  it('stays off without a key and rejects an invalid region', () => {
    expect(loadAzureTranslatorConfig({})).toBeNull();
    expect(loadAzureTranslatorConfig({ AZURE_TRANSLATOR_KEY: FAKE_KEY })).toEqual({ key: FAKE_KEY });
    expect(() => loadAzureTranslatorConfig({ AZURE_TRANSLATOR_KEY: FAKE_KEY, AZURE_TRANSLATOR_REGION: 'west us' })).toThrow(TypeError);
  });
});

describe('chat translator with language detection', () => {
  const CHANNEL = 'fixture_channel';
  let messageNumber = 0;
  const message = (text: string, overrides: Partial<ChatTextMessage> = {}): ChatTextMessage => {
    messageNumber += 1;
    return {
      messageId: `fixture-message-${messageNumber}`, channelId: CHANNEL, userId: 'fixture_user',
      displayName: 'Fixture User', text, receivedAtMs: 1_000_000, sourceLanguage: null, ...overrides,
    };
  };
  const setup = (respond: (call: Call) => { status?: number; body?: unknown } = swapHello) => {
    const azure = fakeAzure(respond);
    const provider = new AzureTranslator({ key: FAKE_KEY, fetch: azure.fetch });
    const translator = new ServiceChatTranslator({ provider, detector: provider, simulationMode: false });
    translator.openChannel(CHANNEL);
    return { azure, translator };
  };

  it('detects the language of a message that arrives without one, then translates it', async () => {
    const { azure, translator } = setup();
    const bubble = await translator.translate(message('hello friends'), 'es');
    expect(bubble).toMatchObject({ status: 'completed', fromLanguage: 'en', translated: 'hola friends' });
    expect(azure.calls.map((call) => call.url.pathname)).toEqual(['/detect', '/translate']);
    translator.close();
  });

  it('sends only plain text to detection', async () => {
    const { azure, translator } = setup();
    await translator.translate(message('hello Kappa @someone https://example.com'), 'es');
    expect(azure.calls[0]?.text).toBe('hello');
    translator.close();
  });

  it('skips messages with nothing to translate', async () => {
    const { azure, translator } = setup();
    await expect(translator.translate(message('Kappa PogChamp 123'), 'es')).resolves.toBeNull();
    expect(azure.calls).toEqual([]);
    translator.close();
  });

  it('skips messages already in the target language', async () => {
    const { azure, translator } = setup();
    await expect(translator.translate(message('hello friends'), 'en')).resolves.toBeNull();
    expect(azure.calls.map((call) => call.url.pathname)).toEqual(['/detect']);
    translator.close();
  });

  it('marks an unsure detection as unavailable and never translates it', async () => {
    const { azure, translator } = setup(() => ({ body: [{ language: 'en', score: 0.3 }] }));
    const bubble = await translator.translate(message('gg ok'), 'es');
    expect(bubble).toMatchObject({ status: 'unavailable', reason: 'unsupported_language', fromLanguage: null });
    expect(azure.calls.map((call) => call.url.pathname)).toEqual(['/detect']);
    translator.close();
  });

  it('never sends slang, laughter, or keyboard smashes to Azure', async () => {
    const { azure, translator } = setup();
    for (const text of ['jajajjjajaajaaj', 'wwkhjwww', 'ㅋㅋㅎㅋ', 'asdfghjkl', 'KKKKK', 'GG ez', 'rsrsrs kkkk', 'XDDD lmaooo']) {
      await expect(translator.translate(message(text), 'es')).resolves.toBeNull();
    }
    expect(azure.calls).toEqual([]);
    await translator.translate(message('jajaja hello stream'), 'es');
    expect(azure.calls[0]?.text).toBe('hello stream');
    translator.close();
  });

  it('keeps a language the adapter already knows', async () => {
    const { azure, translator } = setup();
    await translator.translate(message('hello again', { sourceLanguage: 'en' }), 'es');
    expect(azure.calls.map((call) => call.url.pathname)).toEqual(['/translate']);
    translator.close();
  });
});

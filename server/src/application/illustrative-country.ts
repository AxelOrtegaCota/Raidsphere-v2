import type { IllustrativeCountry, LanguageCode } from '@raidsphere/shared';

// An illustrative place on the globe for each language; it never states where a person is.
export const COUNTRY_BY_LANGUAGE: Record<LanguageCode, IllustrativeCountry> = {
  en: 'US', es: 'MX', pt: 'BR', fr: 'FR', de: 'DE', ja: 'JP', ko: 'KR',
};

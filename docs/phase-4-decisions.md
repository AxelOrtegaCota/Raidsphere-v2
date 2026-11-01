# Phase 4 decisions — AI translation

## D4-01 — Azure AI Translator as the translation provider and language detector

- **Context:** Phase 4 modules 1 and 2 need a real provider and language detection, within a free tier.
- **Decision:** Azure AI Translator (Text API v3, free F0 tier) is the single provider for both translation and detection. `AZURE_TRANSLATOR_KEY` enables it (`AZURE_TRANSLATOR_REGION` for a regional resource); without a key the runtime keeps the simulated provider, labeled as simulated.
- **Rules:**
  - Detection sends plain text only (no emotes, mentions, links, or emoji).
  - Common chat slang, laughter, and keyboard smashes are protected like emotes: never translated, never sent to detection. A message with nothing else is not sent to Azure.
  - A result below the 0.8 score, or outside `en, es, pt, fr, de, ja, ko`, is unknown: the bubble is unavailable and the original shows alone.
  - A message already in the target language is not translated.
  - Emotes and other protected fragments travel inside `notranslate` spans and are verified on return.
  - Twitch terms (`chat`, `raid`, `raider`, `stream`, `streamer`, `sub`, and plurals) are kept untranslated in Azure requests, so French "chat" is not translated as "cat". The simulated provider and detection are unaffected.
- **Limitations:** The 0.8 threshold and the slang list are not calibrated on real chat; extend the list from observed misses, never from logged chat. Short or slang-heavy messages can end as unknown: in the Azure check below, "boa live, galera PogChamp" did. Whether detection calls count toward the free characters is unverified. The key is server-only and never logged.
- **Status:** Verified against a real F0 resource (`eastus`) on 2026-10-31 with seven synthetic phrases: detection of `en`, `es`, `fr`, `ja`, and `ko`; translation; `Kappa` preserved through `notranslate`; "gg" left unknown. That check ran before the Twitch-term glossary was added, so the glossary is covered by automated tests only. Not yet verified with real Twitch chat.

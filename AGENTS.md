# RaidSphere engineering instructions

## Scope and authorization

- Work exclusively inside the currently opened RaidSphere repository.
- Use repository-relative paths in communication. Do not reveal personal paths or account information.
- Explain the exact command, purpose, network access, and write effects before requesting authorization.
- Obtain explicit approval before terminal commands, file changes, dependency installation, application execution, or external access.
- Execute only the approved command batch and stop if a command fails; report the failure before proposing an alternative.
- Never request or use elevated filesystem permissions without separate explicit approval.
- Never commit, push, pull, fetch, merge, rebase, change branches, deploy, or publish without explicit authorization.
- Phase 1 implementation belongs exclusively on `feature/project-foundation`. Do not modify `main`.
- Do not overwrite another developer's work. Identify the exact overlap and obtain approval first.

## Architecture and ownership

- Use TypeScript and a modular monolith with `overlay/`, `server/`, and `shared/`.
- Module A owns browser rendering and the OBS interface in `overlay/`.
- Module B owns future Twitch OAuth, EventSub, chat, discovery, and raid adapters in `server/src/twitch/`.
- Module C owns future translation processing in `server/src/translation/`.
- Module D owns backend composition, application state, voting, deadlines, and persistence boundaries.
- `shared/events.ts` is the canonical application event contract. Coordinate changes with all consumers.
- Infer public models from the shared Zod schemas. Do not duplicate incompatible models or bypass boundary validation.
- Separate domain decisions from transport and provider adapters. The backend is the authoritative state owner.
- Preserve `RAIDSPHERE_CONTEXT.md` unless specific edits receive separate approval.
- Record approved Phase 1 overrides and limitations in `docs/phase-1-decisions.md`.

## Security and engineering

- Use English for code, comments, documentation, communication, and interfaces.
- Never read or display environment files, credentials, private configuration, or real secrets without explicit task-specific authorization.
- Never place credentials in public models, browser code, fixtures, URLs, logs, or Git history.
- Viewing credentials must never grant raid or roulette control permissions.
- Reject channel access until server-side authorization is implemented; loopback binding alone is not authorization.
- Treat chat, model output, and network messages as untrusted data. Render text safely and validate inputs.
- Keep individual votes and other private session records out of public snapshots.
- Distinguish a queued raid, confirmed arrival, failure, cancellation, and uncertain outcome.
- Build bounded, idempotent integration behavior when those modules are authorized.
- Do not silently widen configured candidate preferences or claim untranslated content is translated.
- No SQLite installation, driver, configuration, database files, migrations, or persistence I/O in Phase 1. Interfaces only.
- Preserve the installed Node.js 20.18.0 and npm 10.8.2; do not upgrade them automatically.
- Do not claim dependency compatibility, security, successful tests, or OBS performance without verification.
- Add meaningful tests for contract and security boundaries. Tests and builds require separate execution approval.
- Report implemented source, verified behavior, pending functionality, and unverified assumptions separately.

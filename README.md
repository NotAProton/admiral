# Admiral PoC (BBB link resolve + join)

This is a minimal TypeScript PoC for two actions only:

1. Resolve the real BBB join URL from Moodle flow
2. Join BBB with Playwright and attempt listen-only mode

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

Fill `.env` locally. Do not put secrets in Git.

## Run

Resolve BBB URL from LMS click flow:

```bash
npm run poc:resolve
```

This writes:

- `.runtime/bbb-link.txt` (best candidate URL)
- `.runtime/resolve-log.json` (network + navigation trace)

Join BBB using resolved URL:

```bash
npm run poc:join
```

This writes:

- `.runtime/join-proof.png`
- `.runtime/join-log.json`

## Notes

- If `HEADLESS=true` is too brittle during selector tuning, set `HEADLESS=false` in `.env`.
- If Moodle/BBB UI differs, we will tune selectors based on your real page HTML/trace.
- No audio recording, transcription, or keyword spotting is included in this PoC.

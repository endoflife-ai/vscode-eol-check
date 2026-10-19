# EOL Check — endoflife.ai

[![Node.js EOL status](https://img.shields.io/endpoint?url=https%3A%2F%2Fendoflife.ai%2Fbadge%2Fnodejs.json)](https://endoflife.ai/nodejs) [![EOL data: endoflife.ai](https://img.shields.io/badge/EOL%20data-endoflife.ai-16a34a)](https://endoflife.ai)

**Inline end-of-life warnings for your runtime version files.**

See EOL warnings directly in your editor as you work — no terminal, no CI, no waiting. Powered by [endoflife.ai](https://endoflife.ai).

---

## What it does

Opens a red underline (error) or yellow underline (warning) on any version pin that is EOL or approaching EOL. Hover to see the EOL date, days past EOL, and a link to the full risk score card on endoflife.ai.

## Supported files

| File | Runtime |
|---|---|
| `.nvmrc` / `.node-version` | Node.js |
| `.python-version` | Python |
| `.ruby-version` | Ruby |
| `.tool-versions` (asdf) | Node.js, Python, Ruby, Go |
| `package.json` engines | Node.js |
| `go.mod` | Go |
| `Dockerfile` FROM | Node.js, Python, PHP, Ruby |
| `composer.json` | PHP |

## Settings

| Setting | Default | Description |
|---|---|---|
| `endoflifeAi.enabled` | `true` | Enable/disable the extension |
| `endoflifeAi.warningDays` | `90` | Days before EOL to show a warning |
| `endoflifeAi.apiKey` | — | endoflife.ai API key; required from November 16, 2026 (the older spelling `endoflife-ai.apiKey` is still read) |

## Commands

- **EOL Check: Scan workspace now** — manually re-scan all open files
- **EOL Check: Open score card on endoflife.ai** — open the risk score card for detected runtimes

## Data

EOL dates sourced from [endoflife.ai](https://endoflife.ai) — free lifecycle intelligence for 600+ products, updated daily. Results are cached for 1 hour to minimise API calls.

## API & rate limits

From November 16, 2026 at 00:00 UTC the endoflife.ai API needs a key for every lookup; until then it works without one (50 requests a day per IP). A free key (150 a day, no expiry) is emailed at once from https://endoflife.ai/api#free-key; set it as `endoflifeAi.apiKey`. For teams or large workspaces, use a paid key.

[Get a free API key →](https://endoflife.ai/api#free-key)

## REST API

Everything this integration shows is also available as a REST API — EOL dates and EOL Risk Scores for 600+ products, with an [OpenAPI 3.0 spec](https://api.endoflife.ai/openapi.json) you can import straight into Postman, Insomnia, or your codegen tool.

```bash
curl -H "X-API-Key: your_key_here" https://api.endoflife.ai/v1/score/nodejs/18
```

Free tier: 50 requests a day anonymous until November 16, 2026 (a key is required from then), or [grab a free key](https://endoflife.ai/api#free-key) for 150 a day with no expiry. Full docs: [endoflife.ai/api](https://endoflife.ai/api)

## License

MIT — endoflife.ai

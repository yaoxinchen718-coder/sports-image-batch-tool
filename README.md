# No-Key Sports Image Batch Finder

Online demo for finding high-resolution sports people images without needing a Getty Images API key.

## Current source

- Wikimedia Commons
- No API key required
- 1080px+ minimum long edge by default
- Batch downloads selected original files into a ZIP
- Includes a CSV manifest with source pages, authors, and license notes

## Features

- Search by player, team, and sport
- Common Chinese player/team names are converted into English search phrases
- Sport filters for football, basketball, and baseball
- Single / multiple people filters
- Headshot / half-body / action shot filters
- Browser visual analysis fallback when supported

## Local run

```bash
node server.js
```

Open:

```text
http://localhost:3000
```

## Render deploy

1. Push the code to GitHub.
2. Create or redeploy the Render Web Service from this repo.
3. Use this start command:

```bash
node server.js
```

No environment variable is required for this version.

## Note

Wikimedia Commons images can have different licenses. Always check the source page and the included CSV manifest before commercial use.

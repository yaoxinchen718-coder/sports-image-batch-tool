# Getty Sports Image Finder

This is a Getty Images only demo for sports image search. It tries to turn Chinese player and team names into better English search phrases, and returns Getty results with a minimum long edge of 1080px.

## Features

- Getty Images only search
- 1080px+ minimum size by default
- Sport filters for football, basketball, and baseball
- Single / multiple people filters
- Headshot / half-body / action shot filters
- Visual analysis fallback when supported by the browser
- Export selected results as CSV

## Required setup

You need a Getty Images API key for online use.

Render environment variable:

```text
GETTY_API_KEY=your Getty Images API key
```

Without it, the app will load but search will show a missing-key message.

## Local run

```bash
set GETTY_API_KEY=your Getty Images API key
node server.js
```

PowerShell:

```powershell
$env:GETTY_API_KEY="your Getty Images API key"
node server.js
```

Open:

```text
http://localhost:3000
```

## Render deploy

1. Push the code to GitHub.
2. Create a Render Web Service from that repo.
3. Add this environment variable:

```text
GETTY_API_KEY
```

4. Use this start command:

```bash
node server.js
```

5. Deploy the latest commit.

## Note

Getty Images usage, downloads, and licensing are subject to Getty's terms. This demo shows previews and result links, and exports selected result metadata as CSV.

# Chart Watcher

**On-demand LLM read of a stock chart. Mobile-first, one tap, three sections.**

Type a ticker, pick a timeframe, tap ANALYZE. Claude Sonnet 4.6 looks at the candlestick chart (as an image) plus the last 20 bars and a compact fundamentals snapshot, and returns:

1. **What just happened** — plain English narration of the recent move
2. **Technical read** — levels, trend, momentum, continuation-vs-reversal
3. **Fundamental why** — earnings, analyst actions, or "no obvious catalyst"

On-demand only. No monitoring, no alerts, no watchlists. Hit the button when you want a read.

---

## Architecture

- **Frontend**: single-file `index.html`, hosted on GitHub Pages. `lightweight-charts` for the candlestick, `marked` + `DOMPurify` for markdown.
- **Worker**: Cloudflare Worker (`worker/worker.js`) with three endpoints:
  - `GET /chart` — proxies Yahoo chart JSON (solves CORS)
  - `GET /fundamentals` — proxies Yahoo `quoteSummary`, extracts compact subset
  - `POST /analyze` — calls Anthropic API with chart image + OHLCV tail + fundamentals
- **Data**: Yahoo Finance chart endpoint for OHLCV (unauthenticated); Finnhub free tier for fundamentals/earnings/analyst data (60 req/min).
- **LLM**: `claude-sonnet-4-6` via `@anthropic-ai/sdk`.
- **Rate limit**: 10 analyses/hour/IP via Workers KV.

~$0.02 per analysis. Cloudflare Worker stays on free tier.

---

## Deploy

### 1. Worker

```bash
cd worker
npm install
wrangler kv:namespace create RATE_LIMIT
# paste the returned id into wrangler.toml
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put FINNHUB_API_KEY   # free key from https://finnhub.io
wrangler deploy
```

The deployed URL will be `https://chart-watcher.<your-subdomain>.workers.dev`.

### 2. Frontend

Edit the `WORKER_URL` constant at the top of the `<script>` block in `index.html` to your deployed Worker URL.

Push the repo to GitHub and enable GitHub Pages on `main` branch, root folder.

### 3. Local dev

```bash
cd worker && npm run dev     # wrangler dev on localhost:8787
# then edit index.html's WORKER_URL to "http://localhost:8787" and open index.html directly
```

---

## License

MIT

import Anthropic from "@anthropic-ai/sdk";

const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;
const RATE_LIMIT_PER_HOUR = 10;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const SYSTEM_PROMPT = `You are a market analyst helping a professional trader interpret a stock chart. The trader has 11 years experience and runs concentrated semiconductor positions. Be direct, technical, no hedging. Use the chart image as primary evidence; use the OHLCV tail and fundamentals to ground specific numbers. Never invent data you cannot see.

Output exactly three markdown sections, in this order, no preamble:

## What just happened
Plain English narration of the most recent visible move on the chart. Reference specific candles (dates, price levels) the trader can locate. 3-5 sentences max.

## Technical read
Support/resistance levels visible on the chart. Trend structure (higher highs/lower lows, ranges, patterns). Momentum signals from candle structure and volume. What a continuation vs reversal would look like from here. Bullet points, specific prices.

## Fundamental why
Explain the likely driver of the recent move using the fundamentals context provided (earnings dates, analyst actions, P/E shifts, guidance). If fundamentals don't obviously explain the move, say so and name what's more likely (sector rotation, macro, news flow) — do not fabricate a catalyst.`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const YAHOO_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
  Accept: "application/json",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
  });
}

function errorResponse(message, status = 400) {
  return json({ error: message }, status);
}

async function handleChart(url) {
  const ticker = (url.searchParams.get("ticker") || "").toUpperCase();
  const range = url.searchParams.get("range") || "1mo";
  const interval = url.searchParams.get("interval") || "1d";

  if (!TICKER_RE.test(ticker)) return errorResponse("invalid ticker", 400);
  if (!/^[a-z0-9]{1,5}$/.test(range)) return errorResponse("invalid range", 400);
  if (!/^[0-9a-z]{1,5}$/.test(interval)) return errorResponse("invalid interval", 400);

  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker
  )}?range=${range}&interval=${interval}`;

  const res = await fetch(yahooUrl, { headers: YAHOO_HEADERS });
  if (res.status === 404) return errorResponse(`ticker ${ticker} not found`, 404);
  if (!res.ok) {
    // Yahoo occasionally returns error shapes with non-200 bodies; try to parse
    const body = await res.json().catch(() => null);
    const desc = body?.chart?.error?.description;
    if (desc) return errorResponse(desc, 404);
    return errorResponse(`yahoo returned ${res.status}`, 502);
  }
  const data = await res.json();

  if (data?.chart?.error) {
    return errorResponse(data.chart.error.description || "yahoo error", 404);
  }
  if (!data?.chart?.result?.[0]) {
    return errorResponse("no data for ticker", 404);
  }

  return json(data);
}

function num(v) {
  if (v == null || v === "" || Number.isNaN(Number(v))) return null;
  return Number(v);
}

function compactFundamentals({ profile, metrics, recs, earningsCal }) {
  const m = metrics?.metric || {};
  const latestRec = Array.isArray(recs) && recs.length ? recs[0] : {};

  let nextEarnings = null;
  const upcoming = earningsCal?.earningsCalendar || [];
  if (upcoming.length) {
    const now = Date.now();
    const future = upcoming
      .map((e) => ({ d: e.date, ms: Date.parse(e.date) }))
      .filter((e) => !Number.isNaN(e.ms) && e.ms >= now - 86400_000)
      .sort((a, b) => a.ms - b.ms);
    if (future.length) nextEarnings = future[0].d;
  }

  const recentEPS = upcoming
    .filter((e) => e.epsActual != null)
    .slice(0, 4)
    .map((e) => ({
      date: e.date,
      actual: num(e.epsActual),
      estimate: num(e.epsEstimate),
    }));

  return {
    symbol: profile?.ticker || null,
    shortName: profile?.name || null,
    industry: profile?.finnhubIndustry || null,
    marketCap: num(profile?.marketCapitalization) != null
      ? Number(profile.marketCapitalization) * 1_000_000
      : null,
    trailingPE: num(m.peTTM) ?? num(m.peInclExtraTTM) ?? null,
    forwardPE: num(m.peBasicExclExtraTTM) ?? null,
    priceToSales: num(m.psTTM) ?? null,
    enterpriseToEbitda: num(m["enterpriseValue/ebitdaTTM"]) ?? null,
    fiftyTwoWeekHigh: num(m["52WeekHigh"]) ?? null,
    fiftyTwoWeekLow: num(m["52WeekLow"]) ?? null,
    avgVolume10Day: num(m["10DayAverageTradingVolume"]) != null
      ? Number(m["10DayAverageTradingVolume"]) * 1_000_000
      : null,
    revenueGrowthYoY: num(m.revenueGrowthTTMYoy) ?? null,
    epsGrowthYoY: num(m.epsGrowthTTMYoy) ?? null,
    nextEarningsDate: nextEarnings,
    recentQuarterlyEPS: recentEPS,
    analystTrend: {
      strongBuy: latestRec?.strongBuy ?? null,
      buy: latestRec?.buy ?? null,
      hold: latestRec?.hold ?? null,
      sell: latestRec?.sell ?? null,
      strongSell: latestRec?.strongSell ?? null,
      period: latestRec?.period ?? null,
    },
  };
}

async function finnhubGet(path, token) {
  const url = `https://finnhub.io/api/v1${path}${path.includes("?") ? "&" : "?"}token=${token}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

async function handleFundamentals(url, env) {
  const ticker = (url.searchParams.get("ticker") || "").toUpperCase();
  if (!TICKER_RE.test(ticker)) return errorResponse("invalid ticker", 400);
  if (!env.FINNHUB_API_KEY) return errorResponse("server missing finnhub key", 500);

  const t = env.FINNHUB_API_KEY;
  const today = new Date().toISOString().slice(0, 10);
  const oneYearAhead = new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10);
  const oneYearBack = new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);

  const [profile, metrics, recs, earningsCal] = await Promise.all([
    finnhubGet(`/stock/profile2?symbol=${encodeURIComponent(ticker)}`, t),
    finnhubGet(`/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all`, t),
    finnhubGet(`/stock/recommendation?symbol=${encodeURIComponent(ticker)}`, t),
    finnhubGet(
      `/calendar/earnings?from=${oneYearBack}&to=${oneYearAhead}&symbol=${encodeURIComponent(ticker)}`,
      t
    ),
  ]);

  if (!profile || !profile.ticker) {
    return errorResponse("no fundamentals for ticker", 404);
  }

  return json(compactFundamentals({ profile, metrics, recs, earningsCal }));
}

async function checkRateLimit(env, ip) {
  if (!env.RATE_LIMIT) return { ok: true };
  const bucket = Math.floor(Date.now() / 3600_000);
  const key = `ratelimit:${ip}:${bucket}`;
  const current = parseInt((await env.RATE_LIMIT.get(key)) || "0", 10);
  if (current >= RATE_LIMIT_PER_HOUR) {
    return { ok: false, current };
  }
  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: 3600 });
  return { ok: true, current: current + 1 };
}

function formatOhlcvTable(bars) {
  if (!Array.isArray(bars) || !bars.length) return "(no bars provided)";
  const header = "date        open     high     low      close    volume";
  const rows = bars.map((b) => {
    const d = (b.date || "").padEnd(10, " ").slice(0, 10);
    const fmt = (n) =>
      n == null ? "—".padStart(8, " ") : Number(n).toFixed(2).padStart(8, " ");
    const vol = b.volume == null ? "—".padStart(12, " ") : String(b.volume).padStart(12, " ");
    return `${d}  ${fmt(b.open)} ${fmt(b.high)} ${fmt(b.low)} ${fmt(b.close)} ${vol}`;
  });
  return [header, ...rows].join("\n");
}

async function handleAnalyze(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid json body", 400);
  }

  const { ticker, timeframe, image, ohlcv_tail, fundamentals } = body || {};

  if (!ticker || !TICKER_RE.test(String(ticker).toUpperCase())) {
    return errorResponse("invalid ticker", 400);
  }
  if (typeof timeframe !== "string" || timeframe.length > 10) {
    return errorResponse("invalid timeframe", 400);
  }
  if (typeof image !== "string" || !image.startsWith("data:image/")) {
    return errorResponse("invalid image (expected data URL)", 400);
  }
  const base64 = image.split(",", 2)[1] || "";
  const approxBytes = Math.floor((base64.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) return errorResponse("image too large", 413);

  if (!Array.isArray(ohlcv_tail) || ohlcv_tail.length > 20) {
    return errorResponse("invalid ohlcv_tail", 400);
  }

  if (!env.ANTHROPIC_API_KEY) return errorResponse("server missing api key", 500);

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const rl = await checkRateLimit(env, ip);
  if (!rl.ok) return errorResponse("rate limit exceeded (10/hour)", 429);

  const userText = [
    `Ticker: ${ticker.toUpperCase()}`,
    `Timeframe: ${timeframe}`,
    "",
    "Last 20 bars (OHLCV):",
    formatOhlcvTable(ohlcv_tail),
    "",
    "Fundamentals snapshot:",
    JSON.stringify(fundamentals ?? {}, null, 2),
  ].join("\n");

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  let response;
  try {
    response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: base64,
              },
            },
            { type: "text", text: userText },
          ],
        },
      ],
    });
  } catch (err) {
    return errorResponse(`llm call failed: ${err?.message || String(err)}`, 502);
  }

  const markdown = (response.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return json({ markdown, usage: response.usage || null });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    try {
      if (url.pathname === "/chart" && request.method === "GET") {
        return await handleChart(url);
      }
      if (url.pathname === "/fundamentals" && request.method === "GET") {
        return await handleFundamentals(url, env);
      }
      if (url.pathname === "/analyze" && request.method === "POST") {
        return await handleAnalyze(request, env);
      }
      if (url.pathname === "/" || url.pathname === "/health") {
        return json({ ok: true, name: "chart-watcher" });
      }
      return errorResponse("not found", 404);
    } catch (err) {
      return errorResponse(`server error: ${err?.message || String(err)}`, 500);
    }
  },
};

/**
 * Supabase Edge Function: fetch-quotes
 *
 * Fetches Yahoo Finance quotes for all active portfolio stocks.
 * - On first run per stock: backfills daily history from open_date
 * - On subsequent runs: fetches today's quote only
 * Upserts into stock_quotes and stock_history.
 *
 * Called by pg_cron every 2 minutes during BIST market hours.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface HistoryCandle {
  date: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
}

interface QuoteData {
  symbol: string
  name: string
  price: number | null
  dayHigh: number | null
  dayLow: number | null
  open: number | null
  prevClose: number | null
  change: number | null
  changePct: number | null
  volume: number | null
  history: HistoryCandle[]
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Fetch quote + history from Yahoo Finance v8 chart API.
 * If openDate is provided and there's no history yet, fetches from openDate.
 * Otherwise fetches just today's data.
 */
async function fetchQuoteWithHistory(
  symbol: string,
  openDate: string | null,
  needsBackfill: boolean
): Promise<QuoteData> {
  const yahooSym = `${symbol}.IS`

  // If we need history from openDate (first run or new earlier position), fetch full range
  // Otherwise just get today's data
  let url: string
  if (openDate && needsBackfill) {
    const period1 = Math.floor(new Date(openDate).getTime() / 1000)
    const period2 = Math.floor(Date.now() / 1000)
    url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=1d&period1=${period1}&period2=${period2}`
  } else {
    url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=1d&range=1d`
  }

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })

  if (!res.ok) {
    throw new Error(`Yahoo v8 error ${res.status} for ${symbol}`)
  }

  const json = await res.json()
  const result = json?.chart?.result?.[0]
  const meta = result?.meta
  if (!meta) throw new Error(`No data for ${symbol}`)

  const price = meta.regularMarketPrice ?? null
  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null
  const change = price != null && prevClose != null ? price - prevClose : null
  const changePct = change != null && prevClose ? (change / prevClose) * 100 : null

  // Parse all candles from the response
  const timestamps: number[] = result.timestamp || []
  const indicators = result.indicators?.quote?.[0] || {}
  const opens: (number | null)[] = indicators.open || []
  const highs: (number | null)[] = indicators.high || []
  const lows: (number | null)[] = indicators.low || []
  const closes: (number | null)[] = indicators.close || []
  const volumes: (number | null)[] = indicators.volume || []

  const history: HistoryCandle[] = []
  for (let i = 0; i < timestamps.length; i++) {
    const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10)
    history.push({
      date,
      open: opens[i] ?? null,
      high: highs[i] ?? null,
      low: lows[i] ?? null,
      close: closes[i] ?? null,
      volume: volumes[i] ?? null,
    })
  }

  // Use the last candle for today's OHLCV
  const lastIdx = timestamps.length - 1
  const dayHigh = lastIdx >= 0 ? (highs[lastIdx] ?? null) : null
  const dayLow = lastIdx >= 0 ? (lows[lastIdx] ?? null) : null
  const dayOpen = lastIdx >= 0 ? (opens[lastIdx] ?? null) : null
  const volume = lastIdx >= 0 ? (volumes[lastIdx] ?? null) : null

  return {
    symbol,
    name: meta.shortName || meta.longName || symbol,
    price,
    dayHigh,
    dayLow,
    open: dayOpen,
    prevClose,
    change,
    changePct,
    volume,
    history,
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    // 1. Get all active portfolio stocks
    const { data: portfolioStocks, error: psErr } = await supabase
      .from('portfolio_stocks')
      .select('id, symbol')
      .eq('is_active', true)

    if (psErr) throw new Error(`Portfolio query failed: ${psErr.message}`)

    if (!portfolioStocks || portfolioStocks.length === 0) {
      console.log('No active stocks in portfolio — nothing to fetch.')
      return new Response(
        JSON.stringify({ ok: true, message: 'No active stocks in portfolio', updated: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const psIds = portfolioStocks.map((ps: any) => ps.id)

    // Get earliest open_date per symbol from positions table
    const { data: positionData, error: posErr } = await supabase
      .from('positions')
      .select('portfolio_stock_id, open_date')
      .in('portfolio_stock_id', psIds)
      .eq('is_active', true)

    if (posErr) console.warn('Positions query warning:', posErr.message)

    // Build symbol → earliest open_date map
    const psIdToSymbol = new Map<string, string>()
    for (const ps of portfolioStocks) {
      psIdToSymbol.set(ps.id, ps.symbol as string)
    }

    const symbolMap = new Map<string, string | null>()
    // Initialize all portfolio symbols (even those without positions)
    for (const ps of portfolioStocks) {
      const sym = ps.symbol as string
      if (!symbolMap.has(sym)) symbolMap.set(sym, null)
    }
    // Find earliest open_date per symbol from positions
    for (const pos of (positionData || [])) {
      const sym = psIdToSymbol.get(pos.portfolio_stock_id)
      if (!sym) continue
      const date = pos.open_date as string | null
      const existing = symbolMap.get(sym)
      if (date && (!existing || date < existing)) {
        symbolMap.set(sym, date)
      }
    }

    const today = todayStr()
    let updated = 0
    let backfilled = 0
    const errors: string[] = []

    for (const [symbol, openDate] of symbolMap) {
      try {
        // Check if we need to backfill: compare earliest history date with open_date
        let needsBackfill = false
        if (openDate) {
          const { data: earliest } = await supabase
            .from('stock_history')
            .select('date')
            .eq('symbol', symbol)
            .order('date', { ascending: true })
            .limit(1)
            .single()

          // Backfill if no history at all, or if earliest history is after open_date
          needsBackfill = !earliest || earliest.date > openDate
        }

        // 2. Fetch quote (with backfill if needed)
        const q = await fetchQuoteWithHistory(symbol, openDate, needsBackfill)

        if (q.price == null) {
          console.warn(`No price data for ${symbol}, skipping`)
          continue
        }

        // 3. Upsert stock_quotes with peak tracking
        const { data: existing } = await supabase
          .from('stock_quotes')
          .select('peak')
          .eq('symbol', q.symbol)
          .single()

        const currentPeak = existing?.peak ? Number(existing.peak) : 0

        // Find the all-time high from history + current
        let allTimeHigh = currentPeak
        for (const candle of q.history) {
          if (candle.high != null && candle.high > allTimeHigh) {
            allTimeHigh = candle.high
          }
        }

        const newPeak = allTimeHigh
        const isPeakUpdate = newPeak > currentPeak

        // Find peak date
        let peakDate = today
        if (isPeakUpdate) {
          for (const candle of q.history) {
            if (candle.high != null && candle.high === allTimeHigh) {
              peakDate = candle.date
            }
          }
        }

        const { error: upsertErr } = await supabase
          .from('stock_quotes')
          .upsert({
            symbol: q.symbol,
            name: q.name,
            price: q.price,
            day_high: q.dayHigh,
            day_low: q.dayLow,
            open: q.open,
            prev_close: q.prevClose,
            change: q.change,
            change_pct: q.changePct,
            volume: q.volume,
            peak: newPeak,
            ...(isPeakUpdate ? { peak_date: peakDate } : {}),
            fetched_at: new Date().toISOString(),
          }, { onConflict: 'symbol' })

        if (upsertErr) {
          console.error(`Upsert failed for ${q.symbol}: ${upsertErr.message}`)
          errors.push(`${q.symbol}: upsert failed`)
          continue
        }

        // 4. Upsert history candles (bulk)
        if (q.history.length > 0) {
          const rows = q.history
            .filter(c => c.close != null)
            .map(c => ({
              symbol: q.symbol,
              date: c.date,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
            }))

          if (rows.length > 0) {
            const { error: histErr } = await supabase
              .from('stock_history')
              .upsert(rows, { onConflict: 'symbol,date' })

            if (histErr) {
              console.error(`History upsert failed for ${q.symbol}: ${histErr.message}`)
              errors.push(`${q.symbol}: history upsert failed`)
            } else if (needsBackfill && rows.length > 1) {
              backfilled += rows.length
              console.log(`Backfilled ${rows.length} candles for ${q.symbol} from ${openDate}`)
            }
          }
        }

        updated++
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`Failed to process ${symbol}: ${msg}`)
        errors.push(`${symbol}: ${msg}`)
      }
    }

    const symbols = [...symbolMap.keys()]
    console.log(`Updated ${updated}/${symbols.length} stocks: ${symbols.join(', ')}${backfilled ? ` (backfilled ${backfilled} candles)` : ''}`)

    return new Response(
      JSON.stringify({
        ok: true,
        updated,
        backfilled,
        symbols,
        errors: errors.length > 0 ? errors : undefined,
        timestamp: new Date().toISOString(),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error)
    console.error('fetch-quotes error:', errMsg)
    return new Response(
      JSON.stringify({ ok: false, error: errMsg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

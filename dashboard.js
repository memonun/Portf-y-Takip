#!/usr/bin/env node
/**
 * BIST Peak Tracker Dashboard
 *
 * Tracks all-time peak prices for configured positions, calculates
 * support/confidence tiers (-5%, -8%, -12%), and exports styled Excel reports.
 *
 * Usage:
 *   npm start
 *   npm run dev
 */

import express from 'express'
import ExcelJS from 'exceljs'
import { Resend } from 'resend'
import { supabase, getDefaultUserId, todayStr, formatDate, EDGE_FUNCTION_URL } from './lib/supabase.js'

const PORT = process.env.PORT || process.env.BIST_PORT || 3737

// Build dashboard data entirely from the database
async function getDashboardData() {
  const userId = await getDefaultUserId()

  // Get all active portfolio stocks for this user
  const { data: portfolioRows, error: psErr } = await supabase
    .from('portfolio_stocks')
    .select('id, symbol, stock_id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('symbol')

  if (psErr) throw new Error(`Portfolio query failed: ${psErr.message}`)
  if (!portfolioRows || portfolioRows.length === 0) return []

  const psIds = portfolioRows.map(r => r.id)
  const symbols = portfolioRows.map(r => r.symbol)

  // Fetch positions, quotes, and history in parallel
  const [posResult, quotesResult, historyResult] = await Promise.all([
    supabase
      .from('positions')
      .select('id, portfolio_stock_id, open_date, cost, target1, target2, created_at')
      .in('portfolio_stock_id', psIds)
      .eq('is_active', true)
      .order('created_at', { ascending: true }),
    supabase
      .from('stock_quotes')
      .select('*')
      .in('symbol', symbols),
    supabase
      .from('stock_history')
      .select('symbol, date, high')
      .in('symbol', symbols)
      .order('date', { ascending: true }),
  ])

  if (posResult.error) console.warn('Positions query warning:', posResult.error.message)
  if (quotesResult.error) console.warn('Quotes query warning:', quotesResult.error.message)
  if (historyResult.error) console.warn('History query warning:', historyResult.error.message)

  // Group positions by portfolio_stock_id
  const positionsByPsId = {}
  for (const p of (posResult.data || [])) {
    if (!positionsByPsId[p.portfolio_stock_id]) positionsByPsId[p.portfolio_stock_id] = []
    positionsByPsId[p.portfolio_stock_id].push({
      id: p.id,
      openDate: formatDate(p.open_date),
      cost: Number(p.cost),
      target1: p.target1 ? Number(p.target1) : null,
      target2: p.target2 ? Number(p.target2) : null,
      createdAt: p.created_at,
    })
  }

  // Group history candles by symbol
  const historyBySymbol = {}
  for (const h of (historyResult.data || [])) {
    if (!historyBySymbol[h.symbol]) historyBySymbol[h.symbol] = []
    historyBySymbol[h.symbol].push(h)
  }

  const quoteMap = Object.fromEntries((quotesResult.data || []).map(q => [q.symbol, q]))

  // Build one row per portfolio stock
  return portfolioRows.map(ps => {
    const q = quoteMap[ps.symbol] || {}
    const positions = positionsByPsId[ps.id] || []
    const history = historyBySymbol[ps.symbol] || []
    const price = q.price ? Number(q.price) : null

    // Peak since earliest position open_date (from stock_history)
    const earliestOpenDate = positions.reduce((earliest, p) => {
      if (!earliest || (p.openDate && p.openDate < earliest)) return p.openDate
      return earliest
    }, null)

    let peakFromOpen = null
    let peakFromOpenDate = null
    if (earliestOpenDate && history.length > 0) {
      for (const h of history) {
        const hDate = formatDate(h.date)
        if (hDate >= earliestOpenDate && h.high != null) {
          const high = Number(h.high)
          if (peakFromOpen === null || high > peakFromOpen) {
            peakFromOpen = high
            peakFromOpenDate = hDate
          }
        }
      }
    }
    const pctFromOpenPeak = peakFromOpen && price ? ((price - peakFromOpen) / peakFromOpen) * 100 : null

    // Use the latest position for the main row columns
    const latest = positions.length > 0 ? positions[positions.length - 1] : null

    return {
      symbol: ps.symbol,
      portfolioStockId: ps.id,
      name: q.name || ps.symbol,
      price,
      dayHigh: q.day_high ? Number(q.day_high) : null,
      dayLow: q.day_low ? Number(q.day_low) : null,
      open: q.open ? Number(q.open) : null,
      prevClose: q.prev_close ? Number(q.prev_close) : null,
      tracked: true,
      // Peak since position open (used for tiers and display)
      peak: peakFromOpen,
      peakDate: peakFromOpenDate,
      pctFromPeak: pctFromOpenPeak,
      tier1: peakFromOpen ? peakFromOpen * 0.95 : null,
      tier2: peakFromOpen ? peakFromOpen * 0.92 : null,
      tier3: peakFromOpen ? peakFromOpen * 0.88 : null,
      // Latest position for column display
      cost: latest ? latest.cost : null,
      target1: latest ? latest.target1 : null,
      target2: latest ? latest.target2 : null,
      // All positions for the config panel
      positions,
      fetchedAt: q.fetched_at || null,
    }
  })
}

// ============ Excel Export ============

async function buildPeakWorkbook(liveData) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'StableX Insights - BIST Peak Tracker'
  wb.created = new Date()

  const headerStyle = {
    font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A237E' } },
    alignment: { horizontal: 'center', vertical: 'middle' },
  }

  // --- Sheet 1: Pik Özeti ---
  const s1 = wb.addWorksheet('Pik Özeti', { properties: { defaultColWidth: 16 } })
  s1.columns = [
    { header: 'Sembol', key: 'symbol', width: 12 },
    { header: 'Fiyat (₺)', key: 'price', width: 14 },
    { header: 'Maliyet (₺)', key: 'cost', width: 14 },
    { header: 'Hedef 1 (₺)', key: 'target1', width: 14 },
    { header: 'Hedef 2 (₺)', key: 'target2', width: 14 },
    { header: 'Pik (₺)', key: 'peak', width: 14 },
    { header: '% Pikten', key: 'pctFromPeak', width: 12 },
    { header: 'T1 -5% (₺)', key: 'tier1', width: 14 },
    { header: 'T2 -8% (₺)', key: 'tier2', width: 14 },
    { header: 'T3 -12% (₺)', key: 'tier3', width: 14 },
  ]

  const hr1 = s1.getRow(1)
  hr1.font = headerStyle.font
  hr1.fill = headerStyle.fill
  hr1.alignment = headerStyle.alignment
  hr1.height = 25

  for (const d of liveData) {
    const row = s1.addRow({
      symbol: d.symbol,
      price: d.price,
      cost: d.cost,
      target1: d.target1,
      target2: d.target2,
      peak: d.peak,
      pctFromPeak: d.pctFromPeak != null ? d.pctFromPeak / 100 : null,
      tier1: d.tier1,
      tier2: d.tier2,
      tier3: d.tier3,
    })

    for (const col of ['price', 'peak', 'tier1', 'tier2', 'tier3', 'cost', 'target1', 'target2']) {
      row.getCell(col).numFmt = '#,##0.00 ₺'
    }
    row.getCell('pctFromPeak').numFmt = '0.00%'

    // Color tiers
    if (d.pctFromPeak != null) {
      const tierColor = (pct) => {
        if (pct >= 0) return 'FF2E7D32' // green
        if (pct > -5) return 'FFF9A825' // yellow
        if (pct > -8) return 'FFEF6C00' // orange
        return 'FFC62828' // red
      }
      row.getCell('pctFromPeak').font = { color: { argb: tierColor(d.pctFromPeak) }, bold: true }
    }
  }

  s1.autoFilter = { from: { row: 1, column: 1 }, to: { row: liveData.length + 1, column: 10 } }
  s1.views = [{ state: 'frozen', ySplit: 1 }]

  return wb
}

// ============ Express App ============

const app = express()
app.use(express.json())

// GET /api/stocks — read-only from DB
app.get('/api/stocks', async (_req, res) => {
  try {
    const data = await getDashboardData()
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/update-peaks — trigger edge function then return fresh data
app.post('/api/update-peaks', async (_req, res) => {
  try {
    // Trigger the edge function to fetch fresh quotes
    try {
      await fetch(EDGE_FUNCTION_URL, { method: 'POST' })
    } catch (e) {
      console.warn('Edge function trigger failed (will return cached data):', e.message)
    }
    const data = await getDashboardData()
    res.json({ updated: true, data })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/add-stock — add a symbol to the portfolio (no positions yet)
app.post('/api/add-stock', async (req, res) => {
  try {
    const { symbol } = req.body
    if (!symbol) return res.status(400).json({ error: 'sembol gereklidir' })

    const sym = symbol.toUpperCase().replace('.IS', '')
    const userId = await getDefaultUserId()

    // Check if already in portfolio
    const { data: existing } = await supabase
      .from('portfolio_stocks')
      .select('id')
      .eq('user_id', userId)
      .eq('symbol', sym)
      .eq('is_active', true)
      .limit(1)

    if (existing && existing.length > 0) {
      return res.json({ ok: true, message: 'Hisse zaten portföyde' })
    }

    // Ensure stock_quotes row exists
    await supabase.from('stock_quotes').upsert({ symbol: sym }, { onConflict: 'symbol', ignoreDuplicates: true })
    const { data: sqData } = await supabase.from('stock_quotes').select('id').eq('symbol', sym).single()

    // Create portfolio entry
    const { error: insertErr } = await supabase.from('portfolio_stocks').insert({
      user_id: userId,
      symbol: sym,
      stock_id: sqData?.id ?? null,
    })
    if (insertErr) throw new Error(insertErr.message)

    // Trigger edge function to fetch current quote
    try { await fetch(EDGE_FUNCTION_URL, { method: 'POST' }) } catch {}

    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/position — create a new position under a portfolio stock
app.post('/api/position', async (req, res) => {
  try {
    const { portfolio_stock_id, open_date, cost, target1, target2 } = req.body
    if (!portfolio_stock_id) return res.status(400).json({ error: 'portfolio_stock_id gereklidir' })
    if (!open_date || cost == null) return res.status(400).json({ error: 'open_date ve cost gereklidir' })

    const { error } = await supabase.from('positions').insert({
      portfolio_stock_id, open_date, cost,
      target1: target1 ?? null,
      target2: target2 ?? null,
    })
    if (error) throw new Error(error.message)

    // Trigger edge function to backfill from open_date
    try { await fetch(EDGE_FUNCTION_URL, { method: 'POST' }) } catch {}

    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/position/:id — update an existing position
app.put('/api/position/:id', async (req, res) => {
  try {
    const { open_date, cost, target1, target2 } = req.body
    const { error } = await supabase.from('positions').update({
      open_date, cost, target1: target1 ?? null, target2: target2 ?? null,
    }).eq('id', req.params.id)
    if (error) throw new Error(error.message)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/position/:id — close a single position
app.delete('/api/position/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('positions').update({
      is_active: false, close_date: todayStr(),
    }).eq('id', req.params.id)
    if (error) throw new Error(error.message)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/stock/:symbol — remove stock from portfolio (deactivates stock + all its positions)
app.delete('/api/stock/:symbol', async (req, res) => {
  try {
    const sym = req.params.symbol.toUpperCase()
    const userId = await getDefaultUserId()

    // Get portfolio_stock ids for this symbol
    const { data: psRows } = await supabase
      .from('portfolio_stocks')
      .select('id')
      .eq('user_id', userId)
      .eq('symbol', sym)
      .eq('is_active', true)

    const psIds = (psRows || []).map(r => r.id)

    if (psIds.length > 0) {
      // Deactivate all positions under these portfolio stocks
      await supabase.from('positions').update({
        is_active: false, close_date: todayStr(),
      }).in('portfolio_stock_id', psIds).eq('is_active', true)

      // Deactivate the portfolio stocks themselves
      await supabase.from('portfolio_stocks').update({
        is_active: false,
      }).in('id', psIds)
    }

    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/refresh — trigger edge function to refresh quotes
app.post('/api/refresh', async (_req, res) => {
  try {
    const response = await fetch(EDGE_FUNCTION_URL, { method: 'POST' })
    const result = await response.json()
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/export-excel
app.get('/api/export-excel', async (_req, res) => {
  try {
    const liveData = await getDashboardData()
    const wb = await buildPeakWorkbook(liveData)
    const dateStr = todayStr()
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="bist-peaks-${dateStr}.xlsx"`)
    await wb.xlsx.write(res)
    res.end()
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============ Email Snapshot ============

const RESEND_API_KEY = process.env.RESEND_API_KEY
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'StableX Insights <onboarding@resend.dev>'

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null

function fmtNum(v) {
  if (v == null) return '-'
  return Number(v).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function buildSnapshotEmail(data) {
  const date = new Date().toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })
  const time = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })

  const rows = data.map((d, i) => {
    const pctPeak = d.pctFromPeak != null
      ? (d.pctFromPeak >= 0 ? '+' : '') + d.pctFromPeak.toFixed(2) + '%'
      : '-'
    const pctPeakWeight = d.pctFromPeak != null && d.pctFromPeak >= 0 ? '700' : '400'

    const costPnl = d.cost && d.price ? ((d.price - d.cost) / d.cost * 100) : null
    const costPnlStr = costPnl != null ? (costPnl >= 0 ? '+' : '') + costPnl.toFixed(2) + '%' : ''

    const rowBg = i % 2 === 0 ? '#ffffff' : '#f7f7f7'

    return `<tr style="background:${rowBg};border-bottom:1px solid #e8e8e8;">
      <td style="padding:10px 14px;font-weight:700;font-size:13px;letter-spacing:0.04em;">${d.symbol}</td>
      <td style="padding:10px 14px;text-align:right;font-family:monospace;font-size:13px;">₺${fmtNum(d.price)}</td>
      <td style="padding:10px 14px;text-align:right;font-family:monospace;font-size:13px;">${d.peak != null ? '₺' + fmtNum(d.peak) : '-'}</td>
      <td style="padding:10px 14px;text-align:right;font-family:monospace;font-size:13px;font-weight:${pctPeakWeight};">${pctPeak}</td>
      <td style="padding:10px 14px;text-align:right;font-family:monospace;font-size:13px;color:#555;">${d.tier1 != null ? '₺' + fmtNum(d.tier1) : '-'}</td>
      <td style="padding:10px 14px;text-align:right;font-family:monospace;font-size:13px;color:#555;">${d.tier2 != null ? '₺' + fmtNum(d.tier2) : '-'}</td>
      <td style="padding:10px 14px;text-align:right;font-family:monospace;font-size:13px;color:#555;">${d.tier3 != null ? '₺' + fmtNum(d.tier3) : '-'}</td>
      <td style="padding:10px 14px;text-align:right;font-family:monospace;font-size:13px;">${d.cost ? '₺' + fmtNum(d.cost) : '-'}${costPnlStr ? '<br><span style="font-size:11px;color:#555;">' + costPnlStr + '</span>' : ''}</td>
      <td style="padding:10px 14px;text-align:right;font-family:monospace;font-size:13px;color:#555;">${d.target1 != null ? '₺' + fmtNum(d.target1) : '-'}</td>
      <td style="padding:10px 14px;text-align:right;font-family:monospace;font-size:13px;color:#555;">${d.target2 != null ? '₺' + fmtNum(d.target2) : '-'}</td>
    </tr>`
  }).join('')

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:720px;margin:0 auto;padding:32px 16px;">
    <div style="background:#ffffff;border:1px solid #d0d0d0;">
      <div style="padding:24px 28px;border-bottom:2px solid #000;">
        <div style="font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px;">StableX Insights</div>
        <h1 style="margin:0;color:#000;font-size:22px;font-weight:700;letter-spacing:-0.02em;">Portföy Özeti</h1>
        <p style="margin:6px 0 0;color:#555;font-size:12px;">${date} — ${time}</p>
      </div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;color:#000;font-size:13px;">
          <thead>
            <tr style="background:#000;">
              <th style="padding:9px 14px;text-align:left;color:#fff;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.07em;">Sembol</th>
              <th style="padding:9px 14px;text-align:right;color:#fff;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.07em;">Fiyat</th>
              <th style="padding:9px 14px;text-align:right;color:#fff;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.07em;">Pik</th>
              <th style="padding:9px 14px;text-align:right;color:#fff;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.07em;">% Pik</th>
              <th style="padding:9px 14px;text-align:right;color:#fff;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.07em;">T1 −%5</th>
              <th style="padding:9px 14px;text-align:right;color:#fff;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.07em;">T2 −%8</th>
              <th style="padding:9px 14px;text-align:right;color:#fff;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.07em;">T3 −%12</th>
              <th style="padding:9px 14px;text-align:right;color:#fff;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.07em;">Maliyet</th>
              <th style="padding:9px 14px;text-align:right;color:#fff;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.07em;">Hedef 1</th>
              <th style="padding:9px 14px;text-align:right;color:#fff;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.07em;">Hedef 2</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="padding:14px 28px;border-top:1px solid #e0e0e0;">
        <p style="margin:0;color:#aaa;font-size:10px;letter-spacing:0.06em;text-transform:uppercase;">BIST Peak Tracker</p>
      </div>
    </div>
  </div>
</body>
</html>`
}

app.post('/api/send-snapshot', async (_req, res) => {
  if (!resend) return res.status(500).json({ error: 'RESEND_API_KEY not configured' })
  try {
    const data = await getDashboardData()
    if (!data.length) return res.status(400).json({ error: 'Portföyde hisse yok' })

    const html = buildSnapshotEmail(data)
    const { data: users } = await supabase.from('users').select('email')
    const toEmails = users?.map(u => u.email).filter(Boolean) ?? []
    if (toEmails.length === 0) return res.status(400).json({ error: 'Hiçbir kullanıcı için e-posta bulunamadı' })

    const { data: emailData, error } = await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: toEmails,
      subject: `BIST Portföy Özeti — ${todayStr()}`,
      html,
    })
    if (error) throw new Error(error.message)

    res.json({ ok: true, messageId: emailData.id, to: toEmails })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============ Price Alert Notifications ============

// Cooldown tracking: prevents duplicate alerts within a time window
// Key: "SYMBOL_ALERTTYPE" → Value: timestamp of last sent alert
const alertCooldowns = new Map()
const ALERT_COOLDOWN_MS = 60 * 60 * 1000 // 1 hour cooldown per alert type per stock

function isOnCooldown(key) {
  const last = alertCooldowns.get(key)
  if (!last) return false
  return (Date.now() - last) < ALERT_COOLDOWN_MS
}

function markSent(key) {
  alertCooldowns.set(key, Date.now())
}

// Previous prices for delta/crossing detection
// Key: symbol → Value: last known price
const previousPrices = new Map()

function checkAlerts(data) {
  const alerts = []

  for (const d of data) {
    if (!d.price || !d.peak) continue

    const { symbol, price, peak, tier1, tier2, tier3, target1, target2 } = d
    const prevPrice = previousPrices.get(symbol)

    // --- Peak tier alerts: price crossed below or is at -5%, -8%, -12% from peak ---
    const tierChecks = [
      { level: tier1, pct: 5, key: `${symbol}_TIER_5` },
      { level: tier2, pct: 8, key: `${symbol}_TIER_8` },
      { level: tier3, pct: 12, key: `${symbol}_TIER_12` },
    ]

    for (const tc of tierChecks) {
      if (tc.level == null) continue
      // Trigger if price crossed below the tier (was above, now at or below)
      const crossedBelow = prevPrice != null
        ? prevPrice > tc.level && price <= tc.level
        : false
      // First run after deploy: catch if already at or below the tier
      const firstRunBelow = prevPrice == null && price <= tc.level
      const isAtLevel = Math.abs(price - tc.level) / tc.level <= 0.005

      if ((crossedBelow || firstRunBelow || isAtLevel) && !isOnCooldown(tc.key)) {
        const verb = crossedBelow ? 'düştü' : 'şu anda'
        alerts.push({
          symbol,
          type: 'peak_tier',
          message: `${symbol} pik fiyatının %${tc.pct} altına ${verb} — fiyat ₺${fmtNum(price)} (pik ₺${fmtNum(peak)})`,
          color: tc.pct === 5 ? '#d29922' : tc.pct === 8 ? '#e3872d' : '#f85149',
          icon: '🔻',
          key: tc.key,
        })
      }
    }

    // --- Target proximity and reached alerts ---
    const targetChecks = [
      { target: target1, label: 'Hedef 1' },
      { target: target2, label: 'Hedef 2' },
    ]

    for (const tc of targetChecks) {
      if (!tc.target) continue
      const pctToTarget = ((tc.target - price) / price) * 100
      const prevPctToTarget = prevPrice ? ((tc.target - prevPrice) / prevPrice) * 100 : null

      // Price reached or crossed above target
      const reachedKey = `${symbol}_${tc.label}_REACHED`
      const crossedAbove = prevPrice != null
        ? prevPrice < tc.target && price >= tc.target
        : false
      if ((crossedAbove || pctToTarget <= 0) && !isOnCooldown(reachedKey)) {
        alerts.push({
          symbol,
          type: 'target_reached',
          message: `${symbol} ${tc.label} hedefine ulaştı ₺${fmtNum(tc.target)} — fiyat ₺${fmtNum(price)}`,
          color: '#2ea043',
          icon: '🎯',
          key: reachedKey,
        })
        continue // skip proximity checks if already reached
      }

      // Crossed into 2% zone (was >2% away, now <=2%)
      const close2Key = `${symbol}_${tc.label}_2PCT`
      const enteredZone2 = prevPctToTarget != null
        ? prevPctToTarget > 2 && pctToTarget > 0 && pctToTarget <= 2
        : false
      const isInZone2 = pctToTarget > 0 && pctToTarget <= 2
      if ((enteredZone2 || isInZone2) && !isOnCooldown(close2Key)) {
        alerts.push({
          symbol,
          type: 'target_close',
          message: `${symbol} ${tc.label} ₺${fmtNum(tc.target)} hedefine %2 uzakta — fiyat ₺${fmtNum(price)}`,
          color: '#d29922',
          icon: '🔔',
          key: close2Key,
        })
      }
      // Crossed into 5% zone (was >5% away, now <=5% but >2%)
      else {
        const close5Key = `${symbol}_${tc.label}_5PCT`
        const enteredZone5 = prevPctToTarget != null
          ? prevPctToTarget > 5 && pctToTarget > 2 && pctToTarget <= 5
          : false
        const isInZone5 = pctToTarget > 2 && pctToTarget <= 5
        if ((enteredZone5 || isInZone5) && !isOnCooldown(close5Key)) {
          alerts.push({
            symbol,
            type: 'target_near',
            message: `${symbol} ${tc.label} ₺${fmtNum(tc.target)} hedefine %5 uzakta — fiyat ₺${fmtNum(price)}`,
            color: '#58a6ff',
            icon: '📡',
            key: close5Key,
          })
        }
      }
    }

    // Store current price for next cycle's delta comparison
    previousPrices.set(symbol, price)
  }

  return alerts
}

function buildAlertEmail(alerts) {
  const date = new Date().toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' })
  const time = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })

  const rows = alerts.map(a => `
    <tr style="border-bottom:1px solid #e8e8e8;">
      <td style="padding:16px 14px;font-size:20px;width:36px;vertical-align:top;text-align:center;">${a.icon}</td>
      <td style="padding:16px 14px 16px 4px;vertical-align:top;">
        <div style="font-weight:700;font-size:13px;letter-spacing:0.06em;margin-bottom:4px;">${a.symbol}</div>
        <div style="color:#333;font-size:13px;line-height:1.5;">${a.message}</div>
      </td>
    </tr>`).join('')

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:32px 16px;">
    <div style="background:#ffffff;border:1px solid #d0d0d0;">
      <div style="padding:20px 24px;border-bottom:2px solid #000;">
        <div style="font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px;">StableX Insights</div>
        <h1 style="margin:0;color:#000;font-size:20px;font-weight:700;letter-spacing:-0.02em;">Fiyat Uyarısı</h1>
        <p style="margin:4px 0 0;color:#555;font-size:12px;">${date} — ${time}</p>
      </div>
      <table style="width:100%;border-collapse:collapse;">${rows}</table>
      <div style="padding:12px 24px;border-top:1px solid #e0e0e0;">
        <p style="margin:0;color:#aaa;font-size:10px;letter-spacing:0.06em;text-transform:uppercase;">BIST Peak Tracker</p>
      </div>
    </div>
  </div>
</body>
</html>`
}

async function sendAlertEmail(alerts) {
  if (!resend || alerts.length === 0) return

  const { data: users } = await supabase.from('users').select('email')
  const toEmails = users?.map(u => u.email).filter(Boolean) ?? []
  if (toEmails.length === 0) return

  const html = buildAlertEmail(alerts)
  const symbols = [...new Set(alerts.map(a => a.symbol))].join(', ')

  try {
    const { error } = await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: toEmails,
      subject: `Fiyat Uyarısı — ${symbols}`,
      html,
    })
    if (error) throw new Error(error.message)

    // Mark all alerts as sent
    for (const a of alerts) markSent(a.key)
    console.log(`  Uyarı e-postası gönderildi (${toEmails.join(', ')}): ${symbols} için ${alerts.length} uyarı`)
  } catch (err) {
    console.error('  Uyarı e-postası başarısız:', err.message)
  }
}

// Periodic alert check — runs every 2 minutes alongside the pg_cron refresh
async function runAlertCheck() {
  try {
    const data = await getDashboardData()
    const alerts = checkAlerts(data)
    if (alerts.length > 0) {
      console.log(`  ${alerts.length} uyarı bulundu:`, alerts.map(a => a.message).join(' | '))
      await sendAlertEmail(alerts)
    }
  } catch (err) {
    console.error('  Uyarı kontrol hatası:', err.message)
  }
}

// Start alert loop after server is ready (2-min interval to match pg_cron)
const ALERT_INTERVAL_MS = 2 * 60 * 1000
let alertTimer = null

function startAlertLoop() {
  if (!resend) {
    console.log('  Uyarılar devre dışı — RESEND_API_KEY ayarlanmamış')
    return
  }
  console.log('  Fiyat uyarıları etkin (her 2 dakikada bir kontrol)')
  // Run first check after a short delay (let pg_cron populate fresh data first)
  setTimeout(() => {
    runAlertCheck()
    alertTimer = setInterval(runAlertCheck, ALERT_INTERVAL_MS)
  }, 10_000)
}

// ============ HTML Dashboard ============

app.get('/', (_req, res) => {
  res.type('html').send(HTML)
})

const HTML = /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BIST Peak Tracker</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0f1117;
    color: #e1e4e8;
    padding: 20px;
  }
  h1 { text-align: center; margin-bottom: 6px; font-size: 1.5rem; color: #58a6ff; }
  .subtitle { text-align: center; color: #666; font-size: 0.85rem; margin-bottom: 20px; }
  .controls { text-align: center; margin-bottom: 16px; display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; }
  .btn {
    background: #21262d; color: #58a6ff; border: 1px solid #30363d;
    padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 0.9rem;
    text-decoration: none; display: inline-block;
  }
  .btn:hover { background: #30363d; }
  .btn:disabled { opacity: 0.5; cursor: wait; }
  .btn-primary { background: #1f6feb; color: #fff; border-color: #1f6feb; }
  .btn-primary:hover { background: #388bfd; }
  .btn-danger { color: #f85149; }
  .btn-danger:hover { background: #f8514922; }
  .btn-sm { padding: 4px 10px; font-size: 0.78rem; }
  #status { text-align: center; color: #888; font-size: 0.8rem; margin-bottom: 14px; }

  table { width: 100%; max-width: 1300px; margin: 0 auto; border-collapse: collapse; font-size: 0.85rem; }
  th {
    background: #161b22; color: #8b949e; text-transform: uppercase; font-size: 0.72rem;
    letter-spacing: 0.5px; padding: 8px 10px; text-align: right; border-bottom: 1px solid #30363d;
    position: sticky; top: 0; white-space: nowrap; z-index: 2;
  }
  th:first-child, td:first-child { text-align: left; }
  td {
    padding: 8px 10px; border-bottom: 1px solid #1c2028; text-align: right;
    font-variant-numeric: tabular-nums; white-space: nowrap; vertical-align: top;
  }
  .stock-row { cursor: pointer; }
  .stock-row:hover { background: #161b22; }
  .symbol { font-weight: 700; color: #f0f6fc; }

  .row-at-peak { background: #3fb95012; }
  .row-near-t1 { background: #f9a82512; }
  .row-near-t2 { background: #ef6c0012; }
  .row-below-t3 { background: #c6282812; }
  .row-untracked td.peak-col { color: #333; }
  .up { color: #3fb950; }
  .down { color: #f85149; }

  .tag { padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 0.78rem; }
  .tag-green { background: #3fb95022; color: #3fb950; }
  .tag-yellow { background: #f9a82522; color: #f9a825; }
  .tag-orange { background: #ef6c0022; color: #ef6c00; }
  .tag-red { background: #c6282822; color: #f85149; }

  .empty-msg { text-align: center; padding: 40px; color: #555; }

  /* Expandable config panel row */
  .config-row td { padding: 0; border-bottom: 1px solid #1c2028; }
  .config-panel {
    background: #161b22; padding: 12px 16px;
    display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap;
  }
  .config-panel .field { display: flex; flex-direction: column; gap: 3px; }
  .config-panel label { font-size: 0.72rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.3px; }
  .config-panel input {
    padding: 6px 10px; background: #0d1117; border: 1px solid #30363d;
    border-radius: 5px; color: #e1e4e8; font-size: 0.85rem; width: 130px;
    font-variant-numeric: tabular-nums;
  }
  .config-panel input:focus { border-color: #58a6ff; outline: none; }
  .config-panel .panel-actions { display: flex; gap: 6px; align-items: flex-end; }
  .config-panel .panel-actions .btn-sm { padding: 6px 14px; }
  .config-has-values { color: #58a6ff; font-size: 0.7rem; margin-left: 4px; }
  .sub-pct { display: block; font-size: 0.72rem; margin-top: 2px; opacity: 0.75; }
</style>
</head>
<body>
  <h1>BIST Pik Takibi</h1>
  <p class="subtitle">Pik fiyatları, destek seviyeleri ve pozisyon yönetimi — yapılandırmak için hisseye tıklayın</p>

  <div class="controls">
    <button class="btn btn-primary" id="refreshBtn">Yenile & Pikleri Güncelle</button>
    <button class="btn" id="refreshQuotesBtn">Fiyatları Yenile</button>
    <a class="btn" href="/api/export-excel" id="exportBtn">Excel'e Aktar</a>
    <button class="btn" id="sendMailBtn">Özet Gönder</button>
    <span style="display:inline-flex;gap:4px;align-items:center;">
      <input id="addSymbolInput" type="text" placeholder="THYAO" style="padding:7px 10px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#e1e4e8;font-size:0.9rem;width:100px;text-transform:uppercase;" />
      <button class="btn btn-sm btn-primary" id="addStockBtn">+ Ekle</button>
    </span>
  </div>
  <div id="status">Yükleniyor...</div>

  <table id="peakTable">
    <thead>
      <tr>
        <th>Sembol</th>
        <th>Fiyat (&#8378;)</th>
        <th>Maliyet (&#8378;)</th>
        <th>Hedef 1 (&#8378;)</th>
        <th>Hedef 2 (&#8378;)</th>
        <th>Pik (&#8378;)</th>
        <th>% Pikten</th>
        <th>T1 -%5 (&#8378;)</th>
        <th>T2 -%8 (&#8378;)</th>
        <th>T3 -%12 (&#8378;)</th>
      </tr>
    </thead>
    <tbody id="peakBody">
      <tr><td colspan="12" class="empty-msg">Portföyde hisse yok — yukarıdan ekleyin</td></tr>
    </tbody>
  </table>

<script>
const COLS = 10;
const peakBody = document.getElementById('peakBody');
const status = document.getElementById('status');
const refreshBtn = document.getElementById('refreshBtn');

let currentData = [];
let expandedSymbol = null;

function fmt(v) {
  if (v == null) return '-';
  return v.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(v) {
  if (v == null) return '-';
  return v.toFixed(2) + '%';
}

function rowClass(pct) {
  if (pct == null) return '';
  if (pct >= 0) return 'row-at-peak';
  if (pct > -5) return 'row-near-t1';
  if (pct > -8) return 'row-near-t2';
  return 'row-below-t3';
}

function pctTag(pct) {
  if (pct == null) return '-';
  var cls = 'tag-green';
  if (pct < 0) cls = 'tag-yellow';
  if (pct < -5) cls = 'tag-orange';
  if (pct < -8) cls = 'tag-red';
  return '<span class="tag ' + cls + '">' + fmtPct(pct) + '</span>';
}

function hasConfig(d) {
  return d.positions && d.positions.some(function(p) { return p.cost; });
}

function pctFromCostTag(price, ref) {
  if (!price || !ref) return '';
  var pct = ((price - ref) / ref) * 100;
  var cls = 'tag-green';
  if (pct < 0) cls = 'tag-yellow';
  if (pct < -5) cls = 'tag-orange';
  if (pct < -8) cls = 'tag-red';
  var sign = pct >= 0 ? '+' : '';
  return '<span class="sub-pct"><span class="tag ' + cls + '">' + sign + pct.toFixed(2) + '%</span></span>';
}

function pctToTargetTag(price, target) {
  if (!price || !target) return '';
  var pct = ((target - price) / price) * 100;
  var cls;
  if (pct <= 0) cls = 'tag-green';
  else if (pct < 5) cls = 'tag-yellow';
  else if (pct < 15) cls = 'tag-orange';
  else cls = 'tag-red';
  var sign = pct >= 0 ? '+' : '';
  return '<span class="sub-pct"><span class="tag ' + cls + '">' + sign + pct.toFixed(2) + '%</span></span>';
}

function togglePanel(symbol) {
  if (expandedSymbol === symbol) {
    expandedSymbol = null;
  } else {
    expandedSymbol = symbol;
  }
  renderPeakTable(currentData);
}

function renderPeakTable(data) {
  if (!data || data.length === 0) {
    peakBody.innerHTML = '<tr><td colspan="' + COLS + '" class="empty-msg">Loading...</td></tr>';
    return;
  }
  currentData = data;
  peakBody.innerHTML = '';

  for (var i = 0; i < data.length; i++) {
    var d = data[i];
    if (d.error) {
      peakBody.innerHTML += '<tr><td class="symbol">' + d.symbol + '</td><td colspan="' + (COLS - 1) + '" style="color:#f85149">Failed to load</td></tr>';
      continue;
    }

    var cls = d.tracked ? rowClass(d.pctFromPeak) : 'row-untracked';
    var pc = 'peak-col';
    var configDot = hasConfig(d) ? '<span class="config-has-values">&#9679;</span>' : '';

    peakBody.innerHTML += '<tr class="stock-row ' + cls + '" data-symbol="' + d.symbol + '">'
      + '<td><span class="symbol">' + d.symbol + '</span>' + configDot + '</td>'
      + '<td>' + fmt(d.price) + '</td>'
      + '<td class="' + pc + '">' + (d.peak != null ? fmt(d.peak) : '<span style="color:#333">-</span>') + '</td>'
      + '<td class="' + pc + '">' + (d.pctFromPeak != null ? pctTag(d.pctFromPeak) : '<span style="color:#333">-</span>') + '</td>'
      + '<td class="' + pc + '">' + (d.tier1 != null ? fmt(d.tier1) : '<span style="color:#333">-</span>') + '</td>'
      + '<td class="' + pc + '">' + (d.tier2 != null ? fmt(d.tier2) : '<span style="color:#333">-</span>') + '</td>'
      + '<td class="' + pc + '">' + (d.tier3 != null ? fmt(d.tier3) : '<span style="color:#333">-</span>') + '</td>'
      + '<td>' + (d.cost ? fmt(d.cost) + pctFromCostTag(d.price, d.cost) : '<span style="color:#333">-</span>') + '</td>'
      + '<td>' + (d.target1 ? fmt(d.target1) + pctToTargetTag(d.price, d.target1) : '<span style="color:#333">-</span>') + '</td>'
      + '<td>' + (d.target2 ? fmt(d.target2) + pctToTargetTag(d.price, d.target2) : '<span style="color:#333">-</span>') + '</td>'
      + '</tr>';

    // Expandable config panel — shows all positions + add new form
    if (expandedSymbol === d.symbol) {
      var allPositions = d.positions || [];
      var positions = allPositions.filter(function(p) { return p.cost != null; });
      var html = '<tr class="config-row"><td colspan="' + COLS + '">'
        + '<div class="config-panel">';

      // Existing positions list
      if (positions.length > 0) {
        html += '<div style="margin-bottom:12px;font-size:0.85rem;color:#8b949e;">Positions (' + positions.length + ')</div>';
        for (var pi = 0; pi < positions.length; pi++) {
          var pos = positions[pi];
          var posDate = pos.openDate || '-';
          var posCost = pos.cost != null ? fmt(pos.cost) : '-';
          var posT1 = pos.target1 != null ? fmt(pos.target1) : '-';
          var posT2 = pos.target2 != null ? fmt(pos.target2) : '-';
          var pnl = (pos.cost && d.price) ? (((d.price - pos.cost) / pos.cost) * 100) : null;
          var pnlStr = pnl != null ? (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%' : '';
          var pnlCls = pnl != null ? (pnl >= 0 ? 'tag-green' : 'tag-red') : '';

          html += '<div class="pos-row" style="display:flex;gap:12px;align-items:center;padding:6px 0;border-bottom:1px solid #21262d;">'
            + '<span style="min-width:90px;">' + posDate + '</span>'
            + '<span style="min-width:80px;">&#8378;' + posCost + '</span>'
            + '<span style="min-width:80px;">T1: ' + posT1 + '</span>'
            + '<span style="min-width:80px;">T2: ' + posT2 + '</span>'
            + (pnlStr ? '<span class="tag ' + pnlCls + '">' + pnlStr + '</span>' : '')
            + '<button class="btn btn-sm btn-danger" data-action="delete-pos" data-pos-id="' + pos.id + '" style="margin-left:auto;padding:2px 8px;">&#10005;</button>'
            + '</div>';
        }
      } else {
        html += '<div style="margin-bottom:8px;font-size:0.85rem;color:#8b949e;">Henüz pozisyon yok — aşağıya ekleyin</div>';
      }

      // Add new position form
      html += '<div style="margin-top:12px;padding-top:10px;border-top:1px solid #30363d;">'
        + '<div style="font-size:0.82rem;color:#58a6ff;margin-bottom:8px;">Yeni Pozisyon</div>'
        + '<div class="config-panel" style="padding:0;">'
        + '<div class="field"><label>Açılış Tarihi</label>'
        + '<input type="date" id="cfg-date-' + d.symbol + '" /></div>'
        + '<div class="field"><label>Maliyet (&#8378;)</label>'
        + '<input type="number" step="0.01" id="cfg-cost-' + d.symbol + '" placeholder="Giriş fiyatı" /></div>'
        + '<div class="field"><label>Hedef 1 (&#8378;)</label>'
        + '<input type="number" step="0.01" id="cfg-t1-' + d.symbol + '" placeholder="İlk hedef" /></div>'
        + '<div class="field"><label>Hedef 2 (&#8378;)</label>'
        + '<input type="number" step="0.01" id="cfg-t2-' + d.symbol + '" placeholder="Yüksek hedef" /></div>'
        + '</div>'
        + '<div class="panel-actions" style="margin-top:8px;">'
        + '<button class="btn btn-sm btn-primary" data-action="save-pos" data-sym="' + d.symbol + '">Pozisyon Ekle</button>'
        + '<button class="btn btn-sm" data-action="refresh" data-sym="' + d.symbol + '">Fiyatları Yenile</button>'
        + '<button class="btn btn-sm btn-danger" data-action="remove-stock" data-sym="' + d.symbol + '">Hisseyi Kaldır</button>'
        + '</div></div>'
        + '</div></td></tr>';

      peakBody.innerHTML += html;
    }
  }
}

// ---- API calls ----

async function updatePeaks() {
  refreshBtn.disabled = true;
  status.textContent = 'Fiyatlar alınıyor & pikler güncelleniyor...';
  try {
    var res = await fetch('/api/update-peaks', { method: 'POST' });
    var json = await res.json();
    renderPeakTable(json.data);
    status.textContent = (json.updated ? 'Pikler güncellendi! ' : 'Yeni pik yok. ')
      + 'Son yenileme: ' + new Date().toLocaleTimeString('tr-TR');
  } catch (e) {
    status.textContent = 'Hata: ' + e.message;
  }
  refreshBtn.disabled = false;
}

async function savePosition(symbol) {
  var dateVal = document.getElementById('cfg-date-' + symbol).value.trim();
  var cost = document.getElementById('cfg-cost-' + symbol).value.trim();
  var t1 = document.getElementById('cfg-t1-' + symbol).value.trim();
  var t2 = document.getElementById('cfg-t2-' + symbol).value.trim();

  if (!dateVal || cost === '') {
    status.textContent = 'Açılış tarihi ve maliyet zorunludur.';
    return;
  }

  // Find portfolio_stock_id from currentData
  var stock = currentData.find(function(d) { return d.symbol === symbol; });
  if (!stock || !stock.portfolioStockId) {
    status.textContent = 'Hata: hisse portföyde bulunamadı.';
    return;
  }

  var payload = { portfolio_stock_id: stock.portfolioStockId, open_date: dateVal, cost: parseFloat(cost) };
  if (t1 !== '') payload.target1 = parseFloat(t1);
  if (t2 !== '') payload.target2 = parseFloat(t2);

  status.textContent = symbol + ' için pozisyon ekleniyor...';
  try {
    var res = await fetch('/api/position', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var json = await res.json();
    if (json.error) {
      status.textContent = 'Kaydetme hatası: ' + json.error;
    } else {
      status.textContent = symbol + ' pozisyonu eklendi.';
      await refreshView();
    }
  } catch (e) {
    status.textContent = 'Kaydetme hatası: ' + e.message;
  }
}

async function refreshQuotes() {
  status.textContent = 'Fiyatlar yenileniyor...';
  try {
    var res = await fetch('/api/refresh', { method: 'POST' });
    var json = await res.json();
    status.textContent = 'Fiyatlar yenilendi: ' + (json.updated || 0) + ' hisse güncellendi.';
    await refreshView();
  } catch (e) {
    status.textContent = 'Yenileme hatası: ' + e.message;
  }
}

async function deletePosition(posId) {
  if (!confirm('Bu pozisyonu silmek istediğinizden emin misiniz?')) return;
  status.textContent = 'Pozisyon siliniyor...';
  try {
    await fetch('/api/position/' + posId, { method: 'DELETE' });
    status.textContent = 'Pozisyon silindi.';
    await refreshView();
  } catch (e) {
    status.textContent = 'Silme hatası: ' + e.message;
  }
}

async function removeStock(sym) {
  if (!confirm(sym + ' ve tüm pozisyonlarını portföyden kaldırmak istediğinizden emin misiniz?')) return;
  status.textContent = sym + ' kaldırılıyor...';
  try {
    await fetch('/api/stock/' + sym, { method: 'DELETE' });
    expandedSymbol = null;
    status.textContent = sym + ' kaldırıldı.';
    await refreshView();
  } catch (e) {
    status.textContent = 'Kaldırma hatası: ' + e.message;
  }
}

async function refreshView() {
  try {
    var res = await fetch('/api/stocks');
    var data = await res.json();
    renderPeakTable(data);
  } catch {}
}

async function addStock() {
  var input = document.getElementById('addSymbolInput');
  var sym = input.value.trim().toUpperCase();
  if (!sym) return;
  status.textContent = sym + ' ekleniyor...';
  try {
    var res = await fetch('/api/add-stock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: sym }),
    });
    var json = await res.json();
    if (json.error) {
      status.textContent = 'Hata: ' + json.error;
      return;
    }
    input.value = '';
    expandedSymbol = sym;
    await refreshView();
    status.textContent = sym + ' eklendi — aşağıda pozisyon tanımlayın.';
  } catch (e) {
    status.textContent = 'Hisse ekleme hatası: ' + e.message;
  }
}

// ---- Event delegation ----
document.addEventListener('click', function(e) {
  var target = e.target;

  // Ignore clicks inside the config panel (inputs, labels, etc.) unless it's an action button
  if (target.closest('.config-panel') && !target.closest('[data-action]')) {
    return;
  }

  // Panel action buttons
  var actionBtn = target.closest('[data-action]');
  if (actionBtn) {
    var action = actionBtn.dataset.action;
    var sym = actionBtn.dataset.sym;
    if (action === 'save-pos') savePosition(sym);
    else if (action === 'refresh') refreshQuotes();
    else if (action === 'delete-pos') deletePosition(actionBtn.dataset.posId);
    else if (action === 'remove-stock') removeStock(sym);
    return;
  }

  // Stock row click -> toggle panel
  var row = target.closest('.stock-row');
  if (row) {
    togglePanel(row.dataset.symbol);
    return;
  }
});

// ---- Init ----
document.getElementById('refreshBtn').addEventListener('click', function() { updatePeaks(); });
document.getElementById('refreshQuotesBtn').addEventListener('click', function() { refreshQuotes(); });
document.getElementById('addStockBtn').addEventListener('click', function() { addStock(); });
document.getElementById('sendMailBtn').addEventListener('click', async function() {
  var btn = this;
  btn.disabled = true;
  btn.textContent = 'Gönderiliyor...';
  try {
    var res = await fetch('/api/send-snapshot', { method: 'POST' });
    var json = await res.json();
    if (json.error) {
      status.textContent = 'Mail hatası: ' + json.error;
    } else {
      status.textContent = 'Özet gönderildi: ' + json.to;
    }
  } catch (e) {
    status.textContent = 'Mail hatası: ' + e.message;
  }
  btn.disabled = false;
  btn.textContent = 'Özet Gönder';
});
document.getElementById('addSymbolInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') addStock();
});
updatePeaks();
</script>
</body>
</html>`

// Pre-warm the Supabase client before accepting requests
async function startServer() {
  const t0 = Date.now()
  console.log('  Warming up Supabase connection...')
  await getDefaultUserId()
  console.log(`  Ready in ${Date.now() - t0}ms`)

  app.listen(PORT, () => {
    console.log('')
    console.log('  ╔═══════════════════════════════════════╗')
    console.log('  ║   BIST Peak Tracker running           ║')
    console.log(`  ║   http://localhost:${PORT}              ║`)
    console.log('  ╚═══════════════════════════════════════╝')
    console.log('')
    startAlertLoop()
  })
}

startServer().catch(err => {
  console.error('Failed to start:', err.message)
  process.exit(1)
})

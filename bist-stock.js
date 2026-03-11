#!/usr/bin/env node
/**
 * BIST (Borsa İstanbul) Stock Data Fetcher
 *
 * Fetches current price and key data for any BIST stock
 * and writes it to an Excel file.
 *
 * Usage:
 *   node scripts/fetch/bist-stock.js THYAO          # Single stock
 *   node scripts/fetch/bist-stock.js THYAO ASELS SISE  # Multiple stocks
 *   npm run fetch:bist -- THYAO ASELS               # Via npm script
 */

import dns from 'dns'
dns.setDefaultResultOrder('ipv4first')

import YahooFinance from 'yahoo-finance2'
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] })
import ExcelJS from 'exceljs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const OUTPUT_DIR = path.resolve(__dirname, '../../output')

// ============ Configuration ============

// Popular BIST stocks for reference
const POPULAR_BIST_STOCKS = [
  'THYAO', 'ASELS', 'SISE', 'TUPRS', 'GARAN',
  'AKBNK', 'EREGL', 'BIMAS', 'KCHOL', 'SAHOL',
  'TCELL', 'TOASO', 'YKBNK', 'HEKTS', 'PGSUS',
  'FROTO', 'SASA', 'KOZAL', 'ENKAI', 'ARCLK'
]

// ============ Helpers ============

function toBistTicker(symbol) {
  // Add .IS suffix if not already present (Yahoo Finance format for BIST)
  return symbol.toUpperCase().endsWith('.IS')
    ? symbol.toUpperCase()
    : `${symbol.toUpperCase()}.IS`
}

function formatCurrency(value) {
  if (value == null) return 'N/A'
  return new Intl.NumberFormat('tr-TR', {
    style: 'currency',
    currency: 'TRY',
    minimumFractionDigits: 2
  }).format(value)
}

function formatNumber(value) {
  if (value == null) return 'N/A'
  return new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 }).format(value)
}

function formatPercent(value) {
  if (value == null) return 'N/A'
  return `${(value * 100).toFixed(2)}%`
}

function formatMarketCap(value) {
  if (value == null) return 'N/A'
  if (value >= 1e12) return `₺${(value / 1e12).toFixed(2)}T`
  if (value >= 1e9) return `₺${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `₺${(value / 1e6).toFixed(2)}M`
  return formatCurrency(value)
}

// ============ Data Fetching ============

async function fetchStockData(symbol) {
  const ticker = toBistTicker(symbol)
  const cleanSymbol = symbol.toUpperCase().replace('.IS', '')

  console.log(`  Fetching data for ${cleanSymbol} (${ticker})...`)

  try {
    const quote = await yahooFinance.quote(ticker)

    return {
      symbol: cleanSymbol,
      name: quote.shortName || quote.longName || cleanSymbol,
      currentPrice: quote.regularMarketPrice,
      previousClose: quote.regularMarketPreviousClose,
      open: quote.regularMarketOpen,
      dayHigh: quote.regularMarketDayHigh,
      dayLow: quote.regularMarketDayLow,
      change: quote.regularMarketChange,
      changePercent: quote.regularMarketChangePercent,
      volume: quote.regularMarketVolume,
      marketCap: quote.marketCap,
      fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: quote.fiftyTwoWeekLow,
      fiftyDayAverage: quote.fiftyDayAverage,
      twoHundredDayAverage: quote.twoHundredDayAverage,
      currency: quote.currency || 'TRY',
      exchange: quote.exchange || 'IST',
      fetchedAt: new Date().toISOString()
    }
  } catch (error) {
    console.error(`  ERROR fetching ${cleanSymbol}: ${error.message}`)
    return {
      symbol: cleanSymbol,
      name: 'ERROR',
      currentPrice: null,
      error: error.message,
      fetchedAt: new Date().toISOString()
    }
  }
}

// ============ Excel Export ============

async function writeToExcel(stockDataList, outputPath) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'StableX Insights - BIST Fetcher'
  workbook.created = new Date()

  const sheet = workbook.addWorksheet('BIST Stocks', {
    properties: { defaultColWidth: 18 }
  })

  // Define columns
  sheet.columns = [
    { header: 'Sembol', key: 'symbol', width: 12 },
    { header: 'Şirket Adı', key: 'name', width: 30 },
    { header: 'Güncel Fiyat (₺)', key: 'currentPrice', width: 18 },
    { header: 'Değişim (₺)', key: 'change', width: 15 },
    { header: 'Değişim (%)', key: 'changePercent', width: 15 },
    { header: 'Açılış (₺)', key: 'open', width: 15 },
    { header: 'Gün Yüksek (₺)', key: 'dayHigh', width: 16 },
    { header: 'Gün Düşük (₺)', key: 'dayLow', width: 16 },
    { header: 'Önceki Kapanış (₺)', key: 'previousClose', width: 18 },
    { header: 'Hacim', key: 'volume', width: 18 },
    { header: 'Piyasa Değeri', key: 'marketCap', width: 18 },
    { header: '52H Yüksek (₺)', key: 'fiftyTwoWeekHigh', width: 16 },
    { header: '52H Düşük (₺)', key: 'fiftyTwoWeekLow', width: 16 },
    { header: '50 Gün Ort. (₺)', key: 'fiftyDayAverage', width: 16 },
    { header: '200 Gün Ort. (₺)', key: 'twoHundredDayAverage', width: 16 },
    { header: 'Tarih', key: 'fetchedAt', width: 22 }
  ]

  // Style header row
  const headerRow = sheet.getRow(1)
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 }
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1A237E' } // Dark blue
  }
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' }
  headerRow.height = 25

  // Add data rows
  for (const data of stockDataList) {
    if (data.error) {
      const row = sheet.addRow({
        symbol: data.symbol,
        name: `HATA: ${data.error}`,
        fetchedAt: data.fetchedAt
      })
      row.font = { color: { argb: 'FFFF0000' } }
      continue
    }

    const row = sheet.addRow({
      symbol: data.symbol,
      name: data.name,
      currentPrice: data.currentPrice,
      change: data.change,
      changePercent: data.changePercent != null ? data.changePercent / 100 : null,
      open: data.open,
      dayHigh: data.dayHigh,
      dayLow: data.dayLow,
      previousClose: data.previousClose,
      volume: data.volume,
      marketCap: data.marketCap,
      fiftyTwoWeekHigh: data.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: data.fiftyTwoWeekLow,
      fiftyDayAverage: data.fiftyDayAverage,
      twoHundredDayAverage: data.twoHundredDayAverage,
      fetchedAt: data.fetchedAt
    })

    // Color the change column: green for positive, red for negative
    const changeCell = row.getCell('change')
    const changePctCell = row.getCell('changePercent')
    if (data.change != null) {
      const color = data.change >= 0 ? 'FF2E7D32' : 'FFC62828' // Green / Red
      changeCell.font = { color: { argb: color }, bold: true }
      changePctCell.font = { color: { argb: color }, bold: true }
    }

    // Format percentage
    changePctCell.numFmt = '0.00%'

    // Format currency columns
    for (const col of ['currentPrice', 'change', 'open', 'dayHigh', 'dayLow', 'previousClose', 'fiftyTwoWeekHigh', 'fiftyTwoWeekLow', 'fiftyDayAverage', 'twoHundredDayAverage']) {
      row.getCell(col).numFmt = '#,##0.00 ₺'
    }

    // Format volume
    row.getCell('volume').numFmt = '#,##0'

    // Format market cap
    row.getCell('marketCap').numFmt = '#,##0'
  }

  // Auto-filter
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: stockDataList.length + 1, column: 16 }
  }

  // Freeze top row
  sheet.views = [{ state: 'frozen', ySplit: 1 }]

  await workbook.xlsx.writeFile(outputPath)
  console.log(`\n  Excel dosyası yazıldı: ${outputPath}`)
}

// ============ Main ============

async function main() {
  const args = process.argv.slice(2)

  let symbols
  if (args.length === 0) {
    console.log('\n  Sembol belirtilmedi. Popüler BIST hisseleri kullanılıyor...\n')
    symbols = POPULAR_BIST_STOCKS
  } else {
    symbols = args.map(s => s.toUpperCase().replace('.IS', ''))
  }

  console.log('╔══════════════════════════════════════════════╗')
  console.log('║   BIST Hisse Senedi Veri Çekici (StableX)   ║')
  console.log('╚══════════════════════════════════════════════╝')
  console.log(`\n  Hisse sayısı: ${symbols.length}`)
  console.log(`  Semboller: ${symbols.join(', ')}\n`)

  // Fetch all stock data
  const results = []
  for (const symbol of symbols) {
    const data = await fetchStockData(symbol)
    results.push(data)
  }

  // Print summary to console
  console.log('\n  ─── Özet ───')
  for (const data of results) {
    if (data.error) {
      console.log(`  ${data.symbol}: HATA - ${data.error}`)
    } else {
      const arrow = data.change >= 0 ? '▲' : '▼'
      console.log(
        `  ${data.symbol.padEnd(8)} ${formatCurrency(data.currentPrice).padEnd(16)} ${arrow} ${formatPercent(data.changePercent / 100)}  |  Hacim: ${formatNumber(data.volume)}`
      )
    }
  }

  // Write to Excel
  const { mkdirSync } = await import('fs')
  mkdirSync(OUTPUT_DIR, { recursive: true })

  const timestamp = new Date().toISOString().slice(0, 10)
  const outputPath = path.join(OUTPUT_DIR, `bist-stocks-${timestamp}.xlsx`)
  await writeToExcel(results, outputPath)

  console.log('\n  Tamamlandı!\n')
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})

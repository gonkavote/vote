// Formatting helpers. Numbers/dates respect the active i18next language so
// that switching EN ↔ RU rerenders 157,014 → 157 014 / "5 hours ago" → "5 ч.
// назад" without any extra wiring per call-site.

import i18n from '../i18n'

export const NGONKA_PER_GNK = 1_000_000_000n

/** i18n.language can be 'ru-RU' / 'en-US' / undefined; normalise to 'ru'/'en'. */
function locale(): string {
  const l = i18n.resolvedLanguage || i18n.language || 'en'
  return l.slice(0, 2)
}

/**
 * Render an ngonka string/bigint as a GNK string. Tries to be compact:
 *  - >= 1M GNK → "1.23M GNK"
 *  - >= 1k     → "12.3k GNK"
 *  - else      → "1,234.56 GNK" with up to `precision` fractional digits
 */
export function formatGNK(
  ngonka: string | bigint,
  opts: { precision?: number; compact?: boolean; integer?: boolean; noUnit?: boolean; compactPrecision?: number } = {},
): string {
  const lng = locale()
  const precision = opts.precision ?? 2
  const amount = typeof ngonka === 'bigint' ? ngonka : BigInt(ngonka || '0')
  const unit = opts.noUnit ? '' : ' GNK'
  if (amount === 0n) return `0${unit}`

  const wholeBig = amount / NGONKA_PER_GNK
  const frac = amount % NGONKA_PER_GNK

  // integer mode: shows whole GNK with k/M/B suffix. Default 2 decimals
  // (1.26M GNK), but pass `compactPrecision: 0` for whole multipliers
  // only (1M GNK). Sub-1k stays as integer.
  if (opts.integer) {
    if (wholeBig >= 1_000n) return `${compactBig(wholeBig, opts.compactPrecision ?? 2)}${unit}`
    return `${wholeBig.toLocaleString(lng)}${unit}`
  }

  const compact = opts.compact !== false
  if (compact && wholeBig >= 1_000_000n) {
    const m = Number(wholeBig) / 1_000_000
    return `${trimZeros(m.toFixed(2))}M${unit}`
  }
  if (compact && wholeBig >= 1_000n) {
    const k = Number(wholeBig) / 1_000
    return `${trimZeros(k.toFixed(2))}k${unit}`
  }

  if (frac === 0n) return `${wholeBig.toLocaleString(lng)}${unit}`
  const fracStr = frac.toString().padStart(9, '0').slice(0, precision).replace(/0+$/, '')
  return fracStr
    ? `${wholeBig.toLocaleString(lng)}.${fracStr}${unit}`
    : `${wholeBig.toLocaleString(lng)}${unit}`
}

function trimZeros(s: string): string {
  if (!s.includes('.')) return s
  return s.replace(/\.?0+$/, '')
}

/**
 * Compact integer renderer: 1.26M / 157.01k / 2.5B / 123.
 * Two-decimal rounding for k/M/B/T (trailing zeros trimmed).
 * `compact: false` returns the full number with locale separators.
 */
export function formatCount(
  n: string | bigint | number,
  opts: { compact?: boolean } = {},
): string {
  const lng = locale()
  const x = typeof n === 'bigint' ? n : BigInt(n.toString() || '0')
  if (x === 0n) return '0'
  if (opts.compact === false) return x.toLocaleString(lng)
  return compactBig(x)
}

/**
 * Shared compact formatter for BigInt counts. Default 2 decimals on
 * k/M/B/T with trailing zeros trimmed (1.20M → 1.2M, 1.00M → 1M).
 * Pass `precision: 0` for whole multipliers only (1M, 157k). Sub-1k =
 * full integer.
 */
export function compactBig(x: bigint, precision = 2): string {
  const lng = locale()
  if (x === 0n) return '0'
  if (precision <= 0) {
    if (x >= 1_000_000_000_000n) return `${(x / 1_000_000_000_000n).toLocaleString(lng)}T`
    if (x >= 1_000_000_000n)     return `${(x / 1_000_000_000n).toLocaleString(lng)}B`
    if (x >= 1_000_000n)         return `${(x / 1_000_000n).toLocaleString(lng)}M`
    if (x >= 1_000n)             return `${(x / 1_000n).toLocaleString(lng)}k`
    return x.toLocaleString(lng)
  }
  if (x >= 1_000_000_000_000n) return `${trimZeros((Number(x / 10_000_000_000n) / 100).toFixed(2))}T`
  if (x >= 1_000_000_000n)     return `${trimZeros((Number(x / 10_000_000n) / 100).toFixed(2))}B`
  if (x >= 1_000_000n)         return `${trimZeros((Number(x / 10_000n) / 100).toFixed(2))}M`
  if (x >= 1_000n)             return `${trimZeros((Number(x / 10n) / 100).toFixed(2))}k`
  return x.toLocaleString(lng)
}

export function truncateAddr(addr: string, head = 8, tail = 6): string {
  if (!addr) return ''
  if (addr.length <= head + tail + 1) return addr
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`
}

export function formatRelative(iso: string): string {
  const date = new Date(iso)
  const diffMs = date.getTime() - Date.now()
  const diffSec = Math.round(diffMs / 1000)
  const abs = Math.abs(diffSec)
  const fmt = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' })
  if (abs < 60) return fmt.format(diffSec, 'second')
  if (abs < 3600) return fmt.format(Math.round(diffSec / 60), 'minute')
  if (abs < 86400) return fmt.format(Math.round(diffSec / 3600), 'hour')
  return fmt.format(Math.round(diffSec / 86400), 'day')
}

/** Browser locale-aware absolute datetime ("Apr 24, 22:33" / "24 апр., 22:33"). */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(locale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

/**
 * Compact "5d 3h 12m" or "Closed" rendering for a future ISO timestamp.
 * Returns null if `iso` is null/empty (no deadline).
 *
 * Units stay English short-form (d/h/m/s) on purpose — they're intuitive
 * across languages and keep pills compact.
 */
/** Single-letter unit suffixes (`d`, `h`, `m`, `s`) localized to current lang. */
function unit(key: 'd' | 'h' | 'm' | 's'): string {
  return i18n.t(`countdown.unit.${key}`, { defaultValue: key })
}

export function formatCountdown(iso: string | null | undefined): string | null {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  if (Number.isNaN(ms)) return null
  if (ms <= 0) return 'Closed'

  const totalMin = Math.floor(ms / 60_000)
  const days = Math.floor(totalMin / (60 * 24))
  const hours = Math.floor((totalMin % (60 * 24)) / 60)
  const mins = totalMin % 60

  if (days >= 7) return `${days}${unit('d')}`
  if (days > 0) return `${days}${unit('d')} ${hours}${unit('h')}`
  if (hours > 0) return `${hours}${unit('h')} ${mins}${unit('m')}`
  if (mins > 0) return `${mins}${unit('m')}`
  return `<1${unit('m')}`
}

/**
 * Full-precision countdown: "5d 03h 12m 47s" / "Closed".
 * Suitable for a single hero counter that ticks every second.
 */
export function formatCountdownPrecise(iso: string | null | undefined): string | null {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  if (Number.isNaN(ms)) return null
  if (ms <= 0) return 'Closed'

  const totalSec = Math.floor(ms / 1000)
  const days = Math.floor(totalSec / 86400)
  const hours = Math.floor((totalSec % 86400) / 3600)
  const mins = Math.floor((totalSec % 3600) / 60)
  const secs = totalSec % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  const d = unit('d'), h = unit('h'), m = unit('m'), s = unit('s')

  if (days > 0) return `${days}${d} ${pad(hours)}${h} ${pad(mins)}${m} ${pad(secs)}${s}`
  if (hours > 0) return `${hours}${h} ${pad(mins)}${m} ${pad(secs)}${s}`
  if (mins > 0) return `${mins}${m} ${pad(secs)}${s}`
  return `${secs}${s}`
}

/** Convert a human GNK input ("1", "1500") to ngonka string. Whole GNK only. */
export function gnkToNgonka(gnk: string | number): string {
  const s = typeof gnk === 'number' ? String(gnk) : gnk.trim()
  if (!/^\d+$/.test(s)) return '0'
  return (BigInt(s) * NGONKA_PER_GNK).toString()
}

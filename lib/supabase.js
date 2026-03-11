/**
 * Centralized Supabase client for BIST dashboard and related scripts.
 *
 * - Singleton: one client instance per process, reused across all imports
 * - Uses the REST/PostgREST API (no direct PG connection — avoids IPv6/DNS issues)
 * - Configured via .env (SUPABASE_URL, SUPABASE_ANON_KEY)
 *
 * Usage:
 *   import { supabase, getDefaultUserId } from '../lib/supabase.js'
 */

import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'

// Load env once — safe to call multiple times (no-ops after first)
dotenv.config({ path: '.env' })

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    'Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env\n'
    + 'Create .env with:\n'
    + '  SUPABASE_URL=https://<ref>.supabase.co\n'
    + '  SUPABASE_ANON_KEY=<your-anon-key>'
  )
}

/**
 * Singleton Supabase client.
 *
 * Options:
 *  - persistSession: false — server-side, no cookie/localStorage
 *  - autoRefreshToken: false — anon key doesn't expire within a session
 *  - Global fetch headers kept minimal for speed
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  global: {
    headers: { 'x-client-info': 'bist-dashboard' },
  },
})

// Cached default user id — resolved once per process lifetime
let _defaultUserId = null

/**
 * Returns the default user id (first user in the users table).
 * Cached after first call — no repeated DB hits.
 */
export async function getDefaultUserId() {
  if (_defaultUserId) return _defaultUserId
  const { data, error } = await supabase
    .from('users')
    .select('id')
    .limit(1)
    .single()
  if (error || !data) {
    throw new Error('No user found — run the seed migration first')
  }
  _defaultUserId = data.id
  return _defaultUserId
}

/** Today's date as YYYY-MM-DD string */
export function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

/** Format a date value (Date object or string) to YYYY-MM-DD */
export function formatDate(v) {
  if (!v) return null
  if (typeof v === 'string') return v.slice(0, 10)
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return null
}

/** The edge function URL for triggering quote refreshes */
export const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/fetch-quotes`

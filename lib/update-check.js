/**
 * update-check.js — non-blocking update notifier for ccteams.
 *
 * Design: two-phase to avoid racing process.exit().
 *   1. maybeNotifyFromCache()  — synchronous, reads the on-disk cache, prints one
 *      stderr line if a newer version was found on the *previous* run. Fast, no I/O
 *      contention with main command output.
 *   2. refreshCacheInBackground() — fire-and-forget async, fetches the registry and
 *      rewrites the cache. The result is shown the *next* time the user runs a command.
 *
 * Nothing in here throws to the caller; every failure is silently swallowed so that
 * update-check bugs can never break the main CLI.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const REGISTRY_URL = 'https://registry.npmjs.org/ccteams/latest';
const CACHE_FILE = path.join(os.tmpdir(), 'ccteams-update-check.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 1500;

// ── version comparison ────────────────────────────────────────────────────────

/**
 * Parse "MAJOR.MINOR.PATCH[-prerelease]" into [major, minor, patch].
 * Any prerelease suffix is stripped. Missing numeric segments default to 0.
 * We intentionally ignore prerelease versions on the safe side: a release tagged
 * "1.0.0-beta.1" compares as "1.0.0", so if current === "1.0.0" no update is
 * shown — avoiding spurious "upgrade to beta" noise. This is the safe-side choice
 * and is noted here so future maintainers understand the trade-off.
 */
function parseSemver(v) {
  // Strip prerelease / build metadata before numeric split.
  const numeric = String(v ?? '').split('-')[0].split('+')[0];
  const parts = numeric.split('.').map((n) => parseInt(n, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/**
 * Return true if `latest` is strictly greater than `current`.
 * Compares left-to-right numerically (MAJOR, then MINOR, then PATCH).
 */
export function isNewer(latest, current) {
  const [lMaj, lMin, lPat] = parseSemver(latest);
  const [cMaj, cMin, cPat] = parseSemver(current);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}

// ── cache helpers ─────────────────────────────────────────────────────────────

/** Read the cache file. Returns null on any error. */
function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** Write the cache file. Silently ignores write errors (e.g. read-only /tmp). */
function writeCache(latest) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ lastCheck: Date.now(), latest }), 'utf8');
  } catch {
    // Write failure is non-fatal — next run will just miss the cache and re-fetch.
  }
}

// ── registry fetch ────────────────────────────────────────────────────────────

/**
 * Fetch the latest version from npm registry with a hard timeout.
 * Returns the version string, or null on any failure.
 */
async function fetchLatestVersion() {
  const controller = new AbortController();
  // Clear the timeout once fetch resolves so we don't keep the event loop alive.
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, { signal: controller.signal });
    const json = await res.json();
    return typeof json.version === 'string' ? json.version : null;
  } catch {
    // Network error, timeout, JSON parse failure — all treated as "no data".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Core check: compare currentVersion against the registry (or cache).
 * Returns `{ latest, newer }` where `newer` is true if an upgrade is available,
 * or null if the check could not complete.
 *
 * Used by tests and by refreshCacheInBackground.
 */
export async function checkForUpdate(currentVersion) {
  try {
    const cache = readCache();
    const now = Date.now();
    let latest;

    if (cache && typeof cache.latest === 'string' && now - cache.lastCheck < CACHE_TTL_MS) {
      // Cache is fresh enough — skip the HTTP round-trip.
      latest = cache.latest;
    } else {
      latest = await fetchLatestVersion();
      if (latest) writeCache(latest);
    }

    if (!latest) return null;
    return { latest, newer: isNewer(latest, currentVersion) };
  } catch {
    return null;
  }
}

// ── two-phase wrappers called from bin/ccteams.js ─────────────────────────────

/**
 * Synchronous. Read the existing cache and print a one-liner to stderr if a
 * newer version was found on the *previous* run. Does not touch the network.
 * Returns immediately — safe to call right before process.exit().
 *
 * Suppression conditions (checked by the caller before invoking this):
 *   NO_UPDATE_NOTIFIER, CI, !process.stdout.isTTY
 */
export function maybeNotifyFromCache(currentVersion) {
  try {
    const cache = readCache();
    if (!cache || typeof cache.latest !== 'string') return;
    if (!isNewer(cache.latest, currentVersion)) return;

    // Color mirrors the NO_COLOR / FORCE_COLOR / isTTY pattern used in ccteams.js.
    const color =
      !process.env.NO_COLOR && (process.env.FORCE_COLOR ? true : !!process.stderr.isTTY);
    const yellow = (s) => (color ? `\x1b[33m${s}\x1b[0m` : s);
    const bold = (s) => (color ? `\x1b[1m${s}\x1b[0m` : s);
    const dim = (s) => (color ? `\x1b[2m${s}\x1b[0m` : s);

    process.stderr.write(
      yellow(
        `Update available: ${bold(currentVersion)} → ${bold(cache.latest)}` +
          `   Run: ${bold('ccteams upgrade')}  ${dim('(or npm i -g ccteams)')}\n`,
      ),
    );
  } catch {
    // Display failure must never propagate.
  }
}

/**
 * Fire-and-forget. Fetches the registry in the background and updates the cache.
 * Intentionally not awaited by the caller — the result is shown on the *next* run
 * via maybeNotifyFromCache(). This avoids any race with process.exit().
 */
export function refreshCacheInBackground(currentVersion) {
  // We use .catch(() => {}) to prevent UnhandledPromiseRejection if the async
  // function somehow throws despite its own internal try/catch.
  checkForUpdate(currentVersion).catch(() => {});
}

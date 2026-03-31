/**
 * UsageProbe — live rate-limit / quota fetching from AI service APIs.
 *
 * Each service probe makes one lightweight request (e.g. GET /v1/models) and
 * reads the rate-limit headers from the response. This reflects the server's
 * authoritative view of how many requests remain, regardless of whether the
 * queries came from this terminal, another terminal, or the web UI.
 *
 * Polling cost:
 *   Anthropic  — GET /v1/models, ~200 ms round-trip, returns headers on every call.
 *   OpenAI     — GET /v1/models, ~150 ms round-trip, same.
 *   Gemini     — GET /v1beta/models?key=…, ~200 ms. Headers present on some tiers.
 *
 * Call at most once per minute per service to stay well within rate limits.
 */

import { requestUrl } from "obsidian";
import type { AiServiceConfig } from "./types";

export interface UsageProbeResult {
  /** How many requests remain in the current window. */
  remaining: number;
  /** Total request allowance for the window. */
  limit: number;
  /** Epoch ms when the window resets, null if not provided. */
  resetAt: number | null;
  /** Epoch ms this snapshot was taken. */
  probedAt: number;
  /** True = live from API headers; false = estimated from local count. */
  liveFromApi: boolean;
}

/**
 * Probe one configured service and return its current usage snapshot.
 * Returns null if no API key is configured or the call fails.
 */
export async function probeServiceUsage(
  service: AiServiceConfig
): Promise<UsageProbeResult | null> {
  const key = service.apiKey?.trim();
  if (!key) return null;

  try {
    switch (service.kind) {
      case "claude":   return await probeAnthropic(key);
      case "openai":   return await probeOpenAi(key);
      case "gemini":   return await probeGemini(key);
      default:         return null;
    }
  } catch {
    return null;
  }
}

// ─── Anthropic / Claude ───────────────────────────────────────────────────────
//
// Rate-limit headers (per-minute window for API key usage):
//   anthropic-ratelimit-requests-limit
//   anthropic-ratelimit-requests-remaining
//   anthropic-ratelimit-requests-reset     (ISO 8601 timestamp)
//
// Note: these reflect the API key's per-minute limit, NOT the claude.ai Pro
// 5-hour message quota. If the user is running Claude Code with an API key,
// the headers give the real remaining API calls. If they're using the claude.ai
// browser auth (no API key), we fall back to local turn counting.

async function probeAnthropic(apiKey: string): Promise<UsageProbeResult | null> {
  const resp = await requestUrl({
    url: "https://api.anthropic.com/v1/models",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });

  const h = normHeaders(resp.headers);
  const limit     = intHeader(h, "anthropic-ratelimit-requests-limit");
  const remaining = intHeader(h, "anthropic-ratelimit-requests-remaining");
  const resetStr  = h["anthropic-ratelimit-requests-reset"];

  if (limit === null || remaining === null) return null;
  return {
    limit, remaining,
    resetAt: resetStr ? new Date(resetStr).getTime() : null,
    probedAt: Date.now(),
    liveFromApi: true,
  };
}

// ─── OpenAI / Codex ───────────────────────────────────────────────────────────
//
// Rate-limit headers (per-minute RPM window):
//   x-ratelimit-limit-requests
//   x-ratelimit-remaining-requests
//   x-ratelimit-reset-requests    (duration string e.g. "1m30s", "45s")

async function probeOpenAi(apiKey: string): Promise<UsageProbeResult | null> {
  const resp = await requestUrl({
    url: "https://api.openai.com/v1/models",
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  const h = normHeaders(resp.headers);
  const limit     = intHeader(h, "x-ratelimit-limit-requests");
  const remaining = intHeader(h, "x-ratelimit-remaining-requests");
  const resetStr  = h["x-ratelimit-reset-requests"];

  if (limit === null || remaining === null) return null;
  return {
    limit, remaining,
    resetAt: resetStr ? parseOpenAiDuration(resetStr) : null,
    probedAt: Date.now(),
    liveFromApi: true,
  };
}

// ─── Google Gemini ────────────────────────────────────────────────────────────
//
// Free tier and paid plans expose x-ratelimit-* headers on some responses.
// Falls back gracefully when headers are absent.

async function probeGemini(apiKey: string): Promise<UsageProbeResult | null> {
  const resp = await requestUrl({
    url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
  });

  const h = normHeaders(resp.headers);
  const limit     = intHeader(h, "x-ratelimit-limit")     ?? intHeader(h, "x-ratelimit-limit-requests");
  const remaining = intHeader(h, "x-ratelimit-remaining") ?? intHeader(h, "x-ratelimit-remaining-requests");

  if (limit === null || remaining === null) return null;
  return { limit, remaining, resetAt: null, probedAt: Date.now(), liveFromApi: true };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalise header names to lower-case (Obsidian may return mixed case). */
function normHeaders(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) out[k.toLowerCase()] = v;
  return out;
}

function intHeader(h: Record<string, string>, key: string): number | null {
  const v = parseInt(h[key] ?? "");
  return isNaN(v) ? null : v;
}

/**
 * OpenAI expresses reset durations as "1h2m3s", "45s", "2m", etc.
 * Converts to an epoch ms timestamp relative to now.
 */
function parseOpenAiDuration(s: string): number {
  let ms = 0;
  const h   = s.match(/(\d+)h/);
  const m   = s.match(/(\d+)m(?!s)/);
  const sec = s.match(/(\d+(?:\.\d+)?)s/);
  if (h)   ms += parseInt(h[1])     * 3_600_000;
  if (m)   ms += parseInt(m[1])     *    60_000;
  if (sec) ms += parseFloat(sec[1]) *     1_000;
  return Date.now() + ms;
}

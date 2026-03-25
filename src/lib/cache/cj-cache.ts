import { Redis } from '@upstash/redis';

let redis: Redis | null = null;
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
} catch {}

// Simple in-memory TTL cache (per-instance)
type MemEntry = { v: any; e: number };
const mem = new Map<string, MemEntry>();

export async function getCache<T>(key: string): Promise<T | null> {
  const now = Date.now();
  const m = mem.get(key);
  if (m && m.e > now) return m.v as T;
  if (m) mem.delete(key);
  if (redis) {
    try {
      const raw = await redis.get<string>(key);
      if (raw) {
        const val = JSON.parse(raw) as T;
        // Keep a short-lived memory copy to reduce Redis hits
        mem.set(key, { v: val, e: now + 60_000 });
        return val;
      }
    } catch {}
  }
  return null;
}

export async function setCache<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  const now = Date.now();
  mem.set(key, { v: value, e: now + ttlSeconds * 1000 });
  if (redis) {
    try {
      await redis.set(key, JSON.stringify(value), { ex: ttlSeconds });
    } catch {}
  }
}

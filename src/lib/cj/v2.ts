import { createClient } from '@supabase/supabase-js';
import { loadToken, saveToken } from '@/lib/integration/token-store';
import { fetchJson } from '@/lib/http';
import { getSetting } from '@/lib/settings';
import { extractCjProductGalleryImages } from '@/lib/cj/image-gallery';
import { extractCjProductVideoUrl } from '@/lib/cj/video';
import { normalizeSingleSize } from '@/lib/cj/size-normalization';
import { build4kVideoDelivery } from '@/lib/video/delivery';
import {
  buildOptionSignature,
  deriveAvailableOptionsFromVariants,
  deriveLegacyOptionArrays,
  extractVariantOptionsFromRawVariant,
  type DynamicAvailableOption,
} from '@/lib/variants/dynamic-options';

// CJ v2 client with token auth per official docs:
// - POST /authentication/getAccessToken { apiKey }
// The apiKey format is: CJUserNum@api@xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// Token lives 15 days; refresh token 180 days; getAccessToken limited to once/5 minutes.

// ============================================================================
// GLOBAL RATE LIMITER FOR CJ API (1 request/second limit)
// Uses Redis for cross-process coordination + in-memory fallback
// ============================================================================
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { getCache, setCache } from '@/lib/cache/cj-cache';

// In-memory fallback for single-process rate limiting
let lastCjRequestTime = 0;
const CJ_REQUEST_INTERVAL_MS = 1100; // 1.1 seconds to be safe
const CJ_MAX_WAIT_MS = 55000; // 55 second timeout (CJ API timeout)

// Initialize Redis-backed rate limiter (if Redis is available)
let redisRateLimiter: Ratelimit | null = null;
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    redisRateLimiter = new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(1, '1 s'), // 1 request per second
      prefix: 'cj-api-ratelimit',
    });
  }
} catch (e) {
  console.warn('[CJ RateLimiter] Failed to initialize Redis rate limiter, using in-memory fallback');
}

/**
 * Wait if needed to respect CJ's 1 request/second rate limit.
 * Uses Redis for cross-process coordination, with in-memory fallback.
 * @returns true if rate limit was acquired, false if timed out
 */
export async function waitForCjRateLimit(): Promise<boolean> {
  const startTime = Date.now();
  
  // Try Redis-backed rate limiting first (for cross-process coordination)
  if (redisRateLimiter) {
    while (Date.now() - startTime < CJ_MAX_WAIT_MS) {
      try {
        const { success, remaining, reset } = await redisRateLimiter.limit('cj-inventory');
        if (success) {
          // Also update local timestamp for extra safety
          lastCjRequestTime = Date.now();
          return true;
        }
        // Calculate wait time until reset
        const waitMs = Math.min(reset - Date.now(), CJ_REQUEST_INTERVAL_MS);
        if (waitMs > 0) {
          await new Promise(r => setTimeout(r, waitMs));
        }
      } catch (e) {
        console.warn('[CJ RateLimiter] Redis error, falling back to in-memory:', e);
        break; // Fall through to in-memory limiter
      }
    }
  }
  
  // In-memory fallback (single-process coordination)
  const now = Date.now();
  const elapsed = now - lastCjRequestTime;
  if (elapsed < CJ_REQUEST_INTERVAL_MS) {
    const waitTime = CJ_REQUEST_INTERVAL_MS - elapsed;
    if (Date.now() - startTime + waitTime >= CJ_MAX_WAIT_MS) {
      console.warn('[CJ RateLimiter] Timeout waiting for rate limit slot');
      return false;
    }
    await new Promise(r => setTimeout(r, waitTime));
  }
  lastCjRequestTime = Date.now();
  return true;
}

// ============================================================================

type CjConfig = { email?: string | null; apiKey?: string | null; base?: string | null };

async function getCjApiKey(): Promise<string | null> {
  // Prefer env; if missing, attempt kv_settings (key: 'cj_config')
  const envKey = process.env.CJ_API_KEY || null;
  if (envKey) return envKey;
  try {
    const cfg = await getSetting<CjConfig>('cj_config', undefined);
    const apiKey = (cfg?.apiKey || null) as string | null;
    if (apiKey) return apiKey;
  } catch {}
  return envKey;
}

// Keep legacy function for backward compatibility
async function getCjCreds(): Promise<{ email: string | null; apiKey: string | null }> {
  const apiKey = await getCjApiKey();
  const envEmail = process.env.CJ_EMAIL || null;
  return { email: envEmail, apiKey };
}

export async function listCjProductsPage(params: { pageNum: number; pageSize?: number; keyword?: string }): Promise<any> {
  const pageNum = Math.max(1, Math.floor(params.pageNum || 1));
  const pageSize = Math.min(50, Math.max(1, Math.floor(params.pageSize ?? 20)));
  const kw = params.keyword ? String(params.keyword) : '';
  const qsList = `keyWords=${encodeURIComponent(kw)}&pageSize=${pageSize}&pageNum=${pageNum}`;
  const qsQuery = `keyword=${encodeURIComponent(kw)}&pageSize=${pageSize}&pageNumber=${pageNum}`;

  const endpoints = [
    `/product/list?${qsList}`,
    `/product/query?${qsQuery}`,
    `/product/myProduct/query?${qsQuery}`,
  ];

  const out: any[] = [];
  const seen = new Set<string>();
  let lastErr: any = null;
  for (const ep of endpoints) {
    try {
      const r = await cjFetch<any>(ep);
      const arr = Array.isArray(r?.data?.list)
        ? r.data.list
        : Array.isArray(r?.data?.content)
          ? r.data.content
          : Array.isArray(r?.list)
            ? r.list
            : Array.isArray(r?.data)
              ? r.data
              : Array.isArray(r)
                ? r
                : [];
      for (const it of arr) {
        const pid = String(it?.pid || it?.productId || it?.id || '');
        const key = pid || JSON.stringify(it).slice(0, 120);
        if (!seen.has(key)) { seen.add(key); out.push(it); }
        if (out.length >= pageSize) break;
      }
      if (out.length >= pageSize) break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (out.length === 0 && lastErr) throw lastErr;
  return { code: 200, data: { list: out } };
}

// --- Freight / Shipping ---
// Uses CJ's "According to Shipping Method" feature - exact pre-calculated shipping options
// Calls POST /logistic/freightCalculate with variant ID (vid) to get exact CJ pricing
export type CjFreightCalcParams = {
  countryCode: string; // e.g., 'US' - destination country
  startCountryCode?: string; // e.g., 'CN' - origin country (defaults to China)
  quantity?: number;
  vid: string; // variant ID (UUID format required for freightCalculate)
};

export type CjShippingOption = {
  code: string;
  name: string;
  price: number;
  currency?: string;
  logisticAgingDays?: { min?: number; max?: number };
};

export const CJ_CONFIGURED_SHIPPING_METHODS = [
  'LuWei Ordinary US',
  'CJPacket Ordinary',
  'YunExpress Ordinary',
  'YunExpress Sensitive',
  'CJPacket Sensitive',
  'GOFO+',
  'UniUni+',
  'GOFO GC parcel+',
] as const;

export type ConfiguredShippingMethodName = (typeof CJ_CONFIGURED_SHIPPING_METHODS)[number];

function normalizeShippingMethodToken(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\+/g, 'plus')
    .replace(/[^a-z0-9]/g, '');
}

const CONFIGURED_SHIPPING_METHOD_ALIASES: Record<ConfiguredShippingMethodName, string[]> = {
  'LuWei Ordinary US': ['luweiordinaryus'],
  'CJPacket Ordinary': ['cjpacketordinary'],
  'YunExpress Ordinary': ['yunexpressordinary'],
  'YunExpress Sensitive': ['yunexpresssensitive'],
  'CJPacket Sensitive': ['cjpacketsensitive'],
  'GOFO+': ['gofoplus', 'gofo'],
  'UniUni+': ['uniuniplus', 'uniuni'],
  'GOFO GC parcel+': ['gofogcparcelplus', 'gofogcparcel'],
};

const CONFIGURED_SHIPPING_METHOD_MATCHERS: Array<{
  method: ConfiguredShippingMethodName;
  aliases: string[];
}> = CJ_CONFIGURED_SHIPPING_METHODS.map((method) => {
  const aliases = CONFIGURED_SHIPPING_METHOD_ALIASES[method] || [method];
  return {
    method,
    aliases: aliases.map(normalizeShippingMethodToken).filter(Boolean),
  };
});

export function resolveConfiguredShippingMethod(option: CjShippingOption): ConfiguredShippingMethodName | undefined {
  const normalizedName = normalizeShippingMethodToken(option.name);
  const normalizedCode = normalizeShippingMethodToken(option.code);
  if (!normalizedName && !normalizedCode) return undefined;

  let matchedMethod: ConfiguredShippingMethodName | undefined;
  let matchedAliasLength = 0;

  for (const matcher of CONFIGURED_SHIPPING_METHOD_MATCHERS) {
    for (const alias of matcher.aliases) {
      if (!alias) continue;
      if (normalizedName.includes(alias) || normalizedCode.includes(alias)) {
        if (alias.length > matchedAliasLength) {
          matchedAliasLength = alias.length;
          matchedMethod = matcher.method;
        }
      }
    }
  }

  return matchedMethod;
}

export function filterConfiguredShippingOptions(options: CjShippingOption[]): CjShippingOption[] {
  return options.filter((option) => Boolean(resolveConfiguredShippingMethod(option)));
}

export function findCheapestConfiguredShippingOption(options: CjShippingOption[]): CjShippingOption | undefined {
  const candidates = options
    .map((option) => ({ option, method: resolveConfiguredShippingMethod(option) }))
    .filter((entry): entry is { option: CjShippingOption; method: ConfiguredShippingMethodName } => Boolean(entry.method));

  if (candidates.length === 0) {
    console.log('[CJ Freight] No configured shipping methods matched. Available options:');
    for (const o of options) {
      console.log(`[CJ Freight]   - ${o.name} (code: ${o.code}): $${o.price.toFixed(2)}`);
    }
    return undefined;
  }

  candidates.sort((a, b) => a.option.price - b.option.price);
  const selected = candidates[0];
  console.log(
    `[CJ Freight] Selected cheapest configured shipping: $${selected.option.price.toFixed(2)} USD (${selected.option.name} -> ${selected.method})`
  );
  return selected.option;
}

export type FreightResult = {
  ok: true;
  options: CjShippingOption[];
} | {
  ok: false;
  reason: 'invalid_vid' | 'no_options' | 'api_error';
  message: string;
};

export async function freightCalculate(params: CjFreightCalcParams): Promise<FreightResult> {
  const startCountry = params.startCountryCode || 'CN';
  const endCountry = params.countryCode || 'US';
  const vid = params.vid;
  const qty = params.quantity ?? 1;
  
  if (!vid) {
    return {
      ok: false,
      reason: 'invalid_vid',
      message: 'Variant ID (vid) is required for shipping calculation',
    };
  }
  
  console.log(`[CJ Freight] Getting "According to Shipping Method" for vid=${vid}, qty=${qty}, ${startCountry} → ${endCountry}`);
  
  const cacheKeyFreight = `cj:freight:vid:${vid}:dst:${endCountry}:qty:${qty}:start:${startCountry}`;
  try {
    const cached = await getCache<FreightResult>(cacheKeyFreight);
    if (cached) {
      return cached;
    }
  } catch {}
  
  try {
    // Use CJ's freightCalculate API - this returns the exact "According to Shipping Method" data
    const body = {
      startCountryCode: startCountry,
      endCountryCode: endCountry,
      products: [{ vid, quantity: qty }],
    };
    
    const r = await cjFetch<any>('/logistic/freightCalculate', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    
    console.log(`[CJ Freight] Response: ${JSON.stringify(r).slice(0, 2000)}`);
    
    const result = parseFreightResponse(r);
    if (result.ok && result.options.length > 0) {
      console.log(`[CJ Freight] Got ${result.options.length} shipping options from CJ "According to Shipping Method"`);
      try { await setCache(cacheKeyFreight, result, 21600); } catch {}
      return result;
    }
    
    // No options returned
    const miss: FreightResult = {
      ok: false,
      reason: 'no_options',
      message: 'CJ returned no shipping options for this variant/destination',
    };
    try { await setCache(cacheKeyFreight, miss, 900); } catch {}
    return miss;
  } catch (e: any) {
    console.error(`[CJ Freight] API error: ${e?.message}`);
    const err: FreightResult = {
      ok: false,
      reason: 'api_error',
      message: `CJ shipping API error: ${e?.message || 'Unknown error'}`,
    };
    try { await setCache(cacheKeyFreight, err, 300); } catch {}
    return err;
  }
}

// Helper to parse freightCalculate response
function parseFreightResponse(r: any): FreightResult {
  // Check for CJ API error response first (code !== 200 means error)
  if (r?.code && r.code !== 200 && r.code !== '200') {
    const errorMsg = r.message || r.msg || 'Unknown CJ error';
    console.log(`[CJ Freight] API error response: code=${r.code}, message=${errorMsg}`);
    return {
      ok: false,
      reason: 'api_error',
      message: `CJ error (${r.code}): ${errorMsg}`,
    };
  }
  
  const src: any = (r?.data ?? r?.content ?? r ?? []);
  const out: CjShippingOption[] = [];
  const arr: any[] = Array.isArray(src) ? src : Array.isArray(src?.list) ? src.list : [];
  
  console.log(`[CJ Freight] Raw shipping options from CJ API (${arr.length} items):`);
  
  for (const it of arr) {
    // CJ API returns logisticPrice in USD - this is the exact shipping cost
    const price = Number(it.logisticPrice || it.price || it.amount || it.totalFee || it.totalPrice || 0);
    
    const currency = it.currency || it.ccy || 'USD';
    const name = String(it.logisticName || it.logisticsName || it.name || it.channelName || it.express || 'Shipping');
    const code = String(it.logisticCode || it.logisticsType || it.code || it.channel || name);
    const age = it.logisticAging || it.aging || it.days || null;
    const aging = typeof age === 'string'
      ? (() => { const m = age.match(/(\d+)[^\d]+(\d+)/); if (m) return { min: Number(m[1]), max: Number(m[2]) }; const n = age.match(/(\d+)/); return n ? { min: Number(n[1]) } : undefined; })()
      : (typeof age === 'number' ? { min: age, max: age } : undefined);
    
    // Log each shipping option with exact price from CJ
    console.log(`[CJ Freight]   - ${name}: $${price.toFixed(2)} USD, delivery: ${age || 'N/A'}`);
    
    // Include all options even with price 0 for debugging, but mark them
    if (price <= 0) {
      console.log(`[CJ Freight]     ^ Skipping (price <= 0)`);
      continue;
    }
    
    out.push({ code, name, price, currency, logisticAgingDays: aging });
  }
  
  console.log(`[CJ Freight] Parsed ${out.length} valid shipping options`);
  
  if (out.length > 0) {
    return { ok: true, options: out };
  }
  
  return {
    ok: false,
    reason: 'no_options',
    message: 'No shipping options returned',
  };
}

// Helper to find CJPacket Ordinary from shipping options
export function findCJPacketOrdinary(options: CjShippingOption[]): CjShippingOption | undefined {
  // We're looking for anything that contains "cjpacketordinary" when normalized
  // This handles: "CJPacket Ordinary", "CJ Packet Ordinary", "CJ Packet Ordinary USPS", 
  // "CJPacket Ordinary+", "CJ-Packet-Ordinary", etc.
  const TARGET = normalizeShippingMethodToken('CJPacket Ordinary');
  
  for (const option of options) {
    const normalizedName = normalizeShippingMethodToken(option.name);
    const normalizedCode = normalizeShippingMethodToken(option.code);
    
    if (normalizedName.includes(TARGET) || normalizedCode.includes(TARGET)) {
      console.log(`[CJ Freight] Selected CJPacket Ordinary: $${option.price.toFixed(2)} USD (${option.name})`);
      return option;
    }
  }
  
  // Log available options if CJPacket Ordinary not found
  console.log(`[CJ Freight] CJPacket Ordinary NOT FOUND. Available options:`);
  for (const o of options) {
    console.log(`[CJ Freight]   - ${o.name} (code: ${o.code}): $${o.price.toFixed(2)}`);
  }
  
  return undefined;
}

// --- Product Variants by PID ---
// Uses CJ's variant query API: GET /product/variant/query
// Returns list of purchasable variants with pricing and attributes
export async function getProductVariants(pid: string): Promise<any[]> {
  const token = await getAccessToken();
  const base = await resolveBase();
  const cacheKeyVariants = `cj:variants:pid:${pid}`;
  try {
    const cached = await getCache<any[]>(cacheKeyVariants);
    if (cached && Array.isArray(cached)) {
      return cached;
    }
  } catch {}
  
  try {
    const res = await fetchJson<any>(`${base}/product/variant/query?pid=${encodeURIComponent(pid)}`, {
      headers: {
        'CJ-Access-Token': token,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      timeoutMs: 15000,
    });
    const data = res?.data;
    const variants = Array.isArray(data) ? data : (data?.list || data?.variants || []);
    
    if (variants.length > 0) {
      console.log(`[CJ Variants] Product ${pid}: ${variants.length} variants found`);
    }
    
    try { await setCache(cacheKeyVariants, variants, 43200); } catch {}
    return variants;
  } catch (e: any) {
    console.log(`[CJ Variants] Error for ${pid}:`, e?.message);
    return [];
  }
}

// --- Product Inventory by PID ---
// Uses CJ's dedicated inventory API: GET /product/stock/getInventoryByPid
// Returns warehouse-level stock breakdown (CJ warehouse vs Factory)
export type CjWarehouseInventory = {
  areaId: number;
  areaName: string;
  countryCode: string;
  totalInventory: number;
  cjInventory: number;
  factoryInventory: number;
};

export type CjProductInventory = {
  pid: string;
  totalCJ: number;
  totalFactory: number;
  totalAvailable: number;
  warehouses: CjWarehouseInventory[];
};

export async function getInventoryByPid(pid: string): Promise<CjProductInventory | null> {
  const token = await getAccessToken();
  const base = await resolveBase();
  
  const cacheKeyInventory = `cj:inventory:pid:${pid}`;
  try {
    const cached = await getCache<CjProductInventory>(cacheKeyInventory);
    if (cached) {
      return cached;
    }
  } catch {}
  
  console.log(`[CJ Inventory] Fetching inventory for pid=${pid}`);
  
  try {
    const url = `${base}/product/stock/getInventoryByPid?pid=${encodeURIComponent(pid)}`;
    const res = await fetchJson<any>(url, {
      method: 'GET',
      headers: {
        'CJ-Access-Token': token,
      },
      cache: 'no-store',
      timeoutMs: 10000,
    });
    
    console.log(`[CJ Inventory] Response for ${pid}:`, JSON.stringify(res).slice(0, 1000));
    
    // CJ API returns code as either number 200 or string "200" - handle both
    const isSuccess = res && (res.code === 200 || res.code === '200' || String(res.code) === '200');
    if (!isSuccess || !res.data) {
      console.log(`[CJ Inventory] No inventory data returned for ${pid} (code: ${res?.code})`);
      return null;
    }
    
    const data = res.data;
    const inventories = data.inventories || [];
    
    let totalCJ = 0;
    let totalFactory = 0;
    const warehouses: CjWarehouseInventory[] = [];
    
    for (const inv of inventories) {
      const cjInv = Number(inv.cjInventoryNum || inv.cjInventory || 0);
      const factoryInv = Number(inv.factoryInventoryNum || inv.factoryInventory || 0);
      const totalInv = Number(inv.totalInventoryNum || inv.totalInventory || cjInv + factoryInv);
      
      totalCJ += cjInv;
      totalFactory += factoryInv;
      
      warehouses.push({
        areaId: Number(inv.areaId || 0),
        areaName: inv.areaEn || inv.countryNameEn || inv.area || 'Unknown',
        countryCode: inv.countryCode || '',
        totalInventory: totalInv,
        cjInventory: cjInv,
        factoryInventory: factoryInv,
      });
    }
    
    const result: CjProductInventory = {
      pid,
      totalCJ,
      totalFactory,
      totalAvailable: totalCJ + totalFactory,
      warehouses,
    };
    
    console.log(`[CJ Inventory] Parsed for ${pid}: total=${result.totalAvailable} (CJ=${totalCJ}, Factory=${totalFactory}), warehouses=${warehouses.length}`);
    
    try { await setCache(cacheKeyInventory, result, 43200); } catch {}
    return result;
  } catch (e: any) {
    console.error(`[CJ Inventory] Error fetching inventory for ${pid}:`, e?.message);
    return null;
  }
}

// - POST /authentication/refreshAccessToken { refreshToken }
// Token lives 15 days; refresh token 180 days; getAccessToken limited to once/5 minutes.
// Env vars supported:
// - CJ_API_BASE (optional; default: https://developers.cjdropshipping.com/api2.0/v1)
// - CJ_ACCESS_TOKEN (optional manual override)
// - CJ_EMAIL (required if no CJ_ACCESS_TOKEN)
// - CJ_API_KEY (required if no CJ_ACCESS_TOKEN)

// --- Variant Inventory Query ---
export type CjVariantInventory = {
  variantSku: string;
  variantName?: string;
  vid?: string;           // CJ's variant ID (vid)
  variantId?: string;     // Alternative variant ID field
  variantKey?: string;    // Variant key (e.g., "White-L")
  price: number;
  cjStock: number; // CJ warehouse stock
  factoryStock: number; // Factory/supplier stock
  totalStock: number;
};

export async function queryVariantInventory(pid: string, warehouse?: string): Promise<CjVariantInventory[]> {
  const token = await getAccessToken();
  const base = await resolveBase();
  
  const cacheKeyVarInv = `cj:variantInventory:pid:${pid}:wh:${warehouse || '-'}`;
  try {
    const cached = await getCache<CjVariantInventory[]>(cacheKeyVarInv);
    if (cached && Array.isArray(cached)) {
      return cached;
    }
  } catch {}
  
  const toSafeNumber = (val: any, fallback = 0): number => {
    if (val === undefined || val === null || val === '') return fallback;
    const num = typeof val === 'number' ? val : Number(val);
    return isNaN(num) ? fallback : num;
  };
  
  let allVariants: CjVariantInventory[] = [];
  const stockBySku: Map<string, { cjStock: number; factoryStock: number }> = new Map();
  // Store original stockList items for fallback variant building
  let stockListItems: any[] = [];
  
  try {
    // Try the newer /product/stock/queryByPid endpoint first (better per-variant data)
    // This is a GET request with pid as query parameter
    let stockRes: any = null;
    
    try {
      stockRes = await fetchJson<any>(`${base}/product/stock/queryByPid?pid=${encodeURIComponent(pid)}`, {
        method: 'GET',
        headers: {
          'CJ-Access-Token': token,
        },
        cache: 'no-store',
        timeoutMs: 15000,
      });
      console.log(`[CJ Inventory] Used /product/stock/queryByPid for ${pid}`);
    } catch (e: any) {
      console.log(`[CJ Inventory] /product/stock/queryByPid failed, trying /inventory/queryVariantStock: ${e?.message}`);
      
      // Fallback to old endpoint
      const inventoryBody: any = { pid };
      if (warehouse) inventoryBody.warehouseId = warehouse;
      
      stockRes = await fetchJson<any>(`${base}/inventory/queryVariantStock`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CJ-Access-Token': token,
        },
        body: JSON.stringify(inventoryBody),
        cache: 'no-store',
        timeoutMs: 15000,
      });
    }
    
    console.log(`[CJ Inventory] Response for ${pid}:`, JSON.stringify(stockRes).slice(0, 3000));
    console.log(`[CJ Inventory] Full data structure for ${pid}:`, JSON.stringify(stockRes?.data, null, 2)?.slice(0, 5000));
    
    // Log first 3 raw variants to see exact field names CJ provides
    const rawVariants = stockRes?.data?.variantInventories || stockRes?.data?.variantStocks || [];
    if (Array.isArray(rawVariants) && rawVariants.length > 0) {
      console.log(`[CJ Inventory DEBUG] Raw variant fields for ${pid}:`);
      for (let i = 0; i < Math.min(3, rawVariants.length); i++) {
        const v = rawVariants[i];
        console.log(`  Variant ${i + 1}: ${JSON.stringify(v)}`);
        console.log(`  Fields: variantKey="${v.variantKey}", variantName="${v.variantName}", variantNameEn="${v.variantNameEn}", variantSku="${v.variantSku}", vid="${v.vid}"`);
        console.log(`  Stock fields: cjInventory=${v.cjInventory}, factoryInventory=${v.factoryInventory}, inventory=${JSON.stringify(v.inventory)}`);
      }
    } else {
      console.log(`[CJ Inventory DEBUG] No variantInventories or variantStocks in response for ${pid}`);
    }
    
    const stockData = stockRes?.data;
    
    // CJ API getInventoryByPid returns:
    // {
    //   data: {
    //     inventories: [...],  // Product-level by warehouse
    //     variantInventories: [  // Per-variant inventory
    //       { vid: "variant-id", inventory: [{ cjInventory, factoryInventory, totalInventory }] }
    //     ]
    //   }
    // }
    let stockList: any[] = [];
    
    // Normalize key helper
    const normalizeKey = (s: any): string => {
      if (s === undefined || s === null) return '';
      const str = String(s).trim();
      if (!str) return '';
      return str.toLowerCase().replace(/[\s\-_\.]/g, '');
    };
    
    // Check for CJ's standard variantInventories format first
    if (stockData?.variantInventories && Array.isArray(stockData.variantInventories)) {
      console.log(`[CJ Inventory] Found variantInventories array with ${stockData.variantInventories.length} variants`);
      
      for (const vi of stockData.variantInventories) {
        const vid = vi.vid || vi.variantId || '';
        const variantSku = vi.variantSku || vi.sku || '';
        const variantName = vi.variantName || vi.variantNameEn || vi.variantKey || '';
        const price = toSafeNumber(vi.variantSellPrice || vi.sellPrice || vi.price, 0);
        
        // Sum up inventory across all warehouses for this variant
        let cjTotal = 0;
        let factoryTotal = 0;
        let rawTotal = 0; // Total from totalInventory field (when CJ/Factory breakdown not available)
        
        const inventoryArr = vi.inventory || [];
        if (Array.isArray(inventoryArr)) {
          for (const inv of inventoryArr) {
            // Try to get CJ and Factory breakdown
            const cjInv = toSafeNumber(inv.cjInventory || inv.cjStock || 0);
            const factoryInv = toSafeNumber(inv.factoryInventory || inv.factoryStock || 0);
            cjTotal += cjInv;
            factoryTotal += factoryInv;
            
            // Also track totalInventory as fallback
            const total = toSafeNumber(inv.totalInventory || inv.total || 0);
            if (cjInv === 0 && factoryInv === 0 && total > 0) {
              // Check warehouse type to classify
              const countryCode = String(inv.countryCode || '').toUpperCase();
              const warehouseType = String(inv.warehouseType || inv.type || '').toLowerCase();
              const verifiedWarehouse = toSafeNumber(inv.verifiedWarehouse, 0);
              
              // CJ warehouses are typically verifiedWarehouse=1, outside China
              if (verifiedWarehouse === 1 || warehouseType.includes('cj') || warehouseType.includes('overseas')) {
                cjTotal += total;
              } else if (countryCode === 'CN' || warehouseType.includes('factory') || verifiedWarehouse === 2) {
                // China warehouse or factory = supplier stock
                factoryTotal += total;
              } else {
                // Unknown - treat as factory stock (safer assumption)
                factoryTotal += total;
              }
            }
          }
        }
        
        // Also check direct fields as fallback
        if (cjTotal === 0 && factoryTotal === 0) {
          cjTotal = toSafeNumber(vi.cjInventory || vi.cjStock || 0);
          factoryTotal = toSafeNumber(vi.factoryInventory || vi.factoryStock || 0);
        }
        
        // Final fallback: if still no stock but totalStock exists, treat as factory
        if (cjTotal === 0 && factoryTotal === 0) {
          const totalFromVariant = toSafeNumber(vi.totalStock || vi.stock || vi.totalInventory || 0);
          if (totalFromVariant > 0) {
            factoryTotal = totalFromVariant;
          }
        }
        
        const totalStock = cjTotal + factoryTotal;
        
        // Create a normalized stock list item for later use
        stockList.push({
          vid,
          variantSku,
          variantName,
          variantKey: vi.variantKey || variantName,
          price,
          cjStock: cjTotal,
          factoryStock: factoryTotal,
          totalStock,
        });
        
        // Store in stockBySku map
        const possibleKeys = [vid, variantSku, variantName].filter(k => k && String(k).trim());
        for (const rawKey of possibleKeys) {
          const rawKeyStr = String(rawKey).trim();
          if (!stockBySku.has(rawKeyStr)) {
            stockBySku.set(rawKeyStr, { cjStock: cjTotal, factoryStock: factoryTotal });
          }
          const normalized = normalizeKey(rawKeyStr);
          if (normalized && normalized !== rawKeyStr && !stockBySku.has(normalized)) {
            stockBySku.set(normalized, { cjStock: cjTotal, factoryStock: factoryTotal });
          }
        }
        
        if (stockList.length <= 3) {
          console.log(`[CJ Inventory] Variant ${vid}: CJ=${cjTotal}, Factory=${factoryTotal}, Name=${variantName}`);
        }
      }
    }
    // Fallback: check for variantStocks array
    else if (stockData?.variantStocks && Array.isArray(stockData.variantStocks)) {
      console.log(`[CJ Inventory] Found variantStocks array with ${stockData.variantStocks.length} variants`);
      
      for (const vs of stockData.variantStocks) {
        const vid = vs.vid || vs.variantId || '';
        const variantSku = vs.variantSku || vs.sku || '';
        const variantName = vs.variantName || vs.variantNameEn || vs.variantKey || '';
        const price = toSafeNumber(vs.variantSellPrice || vs.sellPrice || vs.price, 0);
        
        // Parse warehouse stocks
        let cjTotal = 0;
        let factoryTotal = 0;
        
        const warehouseStocks = vs.warehouseStocks || [];
        if (Array.isArray(warehouseStocks)) {
          for (const ws of warehouseStocks) {
            const warehouseType = String(ws.warehouseType || ws.type || '').toLowerCase();
            const availNum = toSafeNumber(ws.availableNum || ws.availableStock || ws.quantity || 0);
            if (warehouseType.includes('cj') || warehouseType.includes('overseas')) {
              cjTotal += availNum;
            } else {
              factoryTotal += availNum;
            }
          }
        }
        
        // Direct fields fallback
        if (cjTotal === 0 && factoryTotal === 0) {
          cjTotal = toSafeNumber(vs.cjInventory || vs.cjStock || 0);
          factoryTotal = toSafeNumber(vs.factoryInventory || vs.factoryStock || 0);
        }
        
        const totalStock = cjTotal + factoryTotal;
        
        stockList.push({
          vid,
          variantSku,
          variantName,
          variantKey: vs.variantKey || variantName,
          price,
          cjStock: cjTotal,
          factoryStock: factoryTotal,
          totalStock,
        });
        
        const possibleKeys = [vid, variantSku, variantName].filter(k => k && String(k).trim());
        for (const rawKey of possibleKeys) {
          const rawKeyStr = String(rawKey).trim();
          if (!stockBySku.has(rawKeyStr)) {
            stockBySku.set(rawKeyStr, { cjStock: cjTotal, factoryStock: factoryTotal });
          }
        }
      }
    }
    // Fallback: direct array or other structures
    else if (Array.isArray(stockData)) {
      console.log(`[CJ Inventory] Found direct array with ${stockData.length} items`);
      stockList = stockData;
    } else if (stockData?.list || stockData?.variants) {
      stockList = stockData?.list || stockData?.variants || [];
      console.log(`[CJ Inventory] Found nested list/variants with ${stockList.length} items`);
    }
    
    stockListItems = stockList; // Save for fallback variant building
    console.log(`[CJ Inventory] Parsed ${stockBySku.size} stock entries from inventory API (from ${stockList.length} items)`);
  } catch (e: any) {
    console.error(`[CJ Inventory] Error fetching stock for ${pid}:`, e?.message);
  }
  
  try {
    const variantRes = await fetchJson<any>(`${base}/product/variant/query?pid=${encodeURIComponent(pid)}`, {
      headers: {
        'Content-Type': 'application/json',
        'CJ-Access-Token': token,
      },
      cache: 'no-store',
      timeoutMs: 15000,
    });
    
    console.log(`[CJ Variants] Response for ${pid}:`, JSON.stringify(variantRes).slice(0, 1500));
    
    const variantData = variantRes?.data;
    const variantList = Array.isArray(variantData) ? variantData : (variantData?.list || variantData?.variants || []);
    
    if (Array.isArray(variantList) && variantList.length > 0) {
      console.log(`[CJ Variants] First variant sample:`, JSON.stringify(variantList[0]));
    }
    
    // Normalize key helper (same as storage)
    const normalizeKeyForLookup = (s: any): string => {
      if (s === undefined || s === null) return '';
      const str = String(s).trim();
      if (!str) return '';
      return str.toLowerCase().replace(/[\s\-_\.]/g, '');
    };
    
    // Log first few variants to debug field values
    if (Array.isArray(variantList) && variantList.length > 0) {
      console.log(`[CJ Variants DEBUG] First 3 variants for ${pid}:`);
      for (let i = 0; i < Math.min(3, variantList.length); i++) {
        const v = variantList[i];
        console.log(`  #${i + 1}: variantKey="${v.variantKey || '(empty)'}", variantSku="${v.variantSku || '(empty)'}", variantName="${v.variantName || '(empty)'}", variantNameEn="${v.variantNameEn || '(empty)'}", variantSellPrice=${v.variantSellPrice}`);
      }
    }
    
    for (const v of variantList) {
      // Capture ALL identifier fields from the response
      const variantSku = v.variantSku || v.sku || v.skuId || '';
      const vid = v.vid || '';
      const variantId = v.variantId || '';
      // variantKey is the SHORT name like "Black And Silver-2XL" - prioritize this!
      const variantKey = v.variantKey || '';
      // variantNameEn is typically the full product name with variant - use as fallback
      const variantNameLong = v.variantName || v.skuName || v.variantNameEn || '';
      const price = toSafeNumber(v.variantSellPrice || v.sellPrice || v.variantPrice || v.price, 0);
      
      // Try matching stock by ANY of the possible keys (both raw and normalized)
      const rawKeys = [variantSku, vid, variantId, variantKey, variantNameLong].filter(Boolean);
      const allKeysToTry = [...rawKeys];
      // Add normalized versions of each key
      for (const raw of rawKeys) {
        const normalized = normalizeKeyForLookup(raw);
        if (normalized && !allKeysToTry.includes(normalized)) {
          allKeysToTry.push(normalized);
        }
      }
      
      let stockInfo: { cjStock: number; factoryStock: number } | undefined;
      
      for (const key of allKeysToTry) {
        stockInfo = stockBySku.get(key);
        if (stockInfo) {
          console.log(`[CJ Variants] Matched stock for ${variantKey || variantSku} via key: ${key}`);
          break;
        }
      }
      
      let cjStock = 0;
      let factoryStock = 0;
      
      if (stockInfo) {
        cjStock = stockInfo.cjStock;
        factoryStock = stockInfo.factoryStock;
      } else {
        console.log(`[CJ Variants] No stock match for variant, trying direct fields. Keys tried: ${allKeysToTry.join(', ')}`);
        cjStock = Math.floor(toSafeNumber(v.cjAvailableNum || v.cjStock || v.warehouseStock || v.cjQuantity || 0));
        factoryStock = Math.floor(toSafeNumber(
          v.supplierAvailableNum || v.factoryStock || v.factoryAvailableNum || 
          v.inventory || v.supplierStock || v.availableStock || 0
        ));
        
        const totalFromVariant = Math.floor(toSafeNumber(v.stock || v.totalStock || v.quantity || v.availableNum || 0));
        if (cjStock === 0 && factoryStock === 0 && totalFromVariant > 0) {
          factoryStock = totalFromVariant;
        }
      }
      
      // Use the first non-empty identifier as the primary SKU
      const primarySku = variantSku || vid || variantId || variantKey || '';
      
      if (primarySku) {
        allVariants.push({
          variantSku: primarySku,
          // IMPORTANT: Prioritize variantKey (short name like "Black And Silver-2XL")
          // over variantNameLong (full descriptive name)
          variantName: variantKey || variantNameLong || undefined,
          vid: vid || undefined,
          variantId: variantId || undefined,
          variantKey: variantKey || undefined,
          price,
          cjStock,
          factoryStock,
          totalStock: cjStock + factoryStock,
        });
      }
    }
  } catch (e: any) {
    console.error(`[CJ Variants] Error fetching variants for ${pid}:`, e?.message);
  }
  
  // If variants have no per-variant stock data, query each variant individually
  // using /product/stock/queryByVid endpoint
  const variantsNeedStock = allVariants.filter(v => v.cjStock === 0 && v.factoryStock === 0 && v.vid);
  if (variantsNeedStock.length > 0 && variantsNeedStock.length <= 20) {
    console.log(`[CJ Variants] Querying per-variant stock for ${variantsNeedStock.length} variants with vid...`);
    
    // Query each variant's stock individually (respecting rate limits)
    for (const variant of variantsNeedStock) {
      if (!variant.vid) continue;
      
      try {
        // Rate limit: wait between requests
        await new Promise(r => setTimeout(r, 150)); // 150ms between variant stock queries
        
        const vidStockRes = await fetchJson<any>(
          `${base}/product/stock/queryByVid?vid=${encodeURIComponent(variant.vid)}`,
          {
            method: 'GET',
            headers: { 'CJ-Access-Token': token },
            cache: 'no-store',
            timeoutMs: 10000,
          }
        );
        
        const vidData = vidStockRes?.data;
        if (vidData) {
          // Parse the inventory array for this variant
          const inventoryArr = vidData.variantInventories?.[0]?.inventory || vidData.inventory || [];
          let cjTotal = 0;
          let factoryTotal = 0;
          
          if (Array.isArray(inventoryArr)) {
            for (const inv of inventoryArr) {
              const cjInv = toSafeNumber(inv.cjInventory || inv.cjStock || 0);
              const factoryInv = toSafeNumber(inv.factoryInventory || inv.factoryStock || 0);
              cjTotal += cjInv;
              factoryTotal += factoryInv;
              
              // Handle totalInventory when breakdown not available
              const total = toSafeNumber(inv.totalInventory || inv.total || 0);
              if (cjInv === 0 && factoryInv === 0 && total > 0) {
                const countryCode = String(inv.countryCode || '').toUpperCase();
                const verifiedWarehouse = toSafeNumber(inv.verifiedWarehouse, 0);
                if (verifiedWarehouse === 1 || countryCode !== 'CN') {
                  cjTotal += total;
                } else {
                  factoryTotal += total;
                }
              }
            }
          }
          
          // Also check direct fields on vidData
          if (cjTotal === 0 && factoryTotal === 0) {
            cjTotal = toSafeNumber(vidData.cjInventory || vidData.cjStock || 0);
            factoryTotal = toSafeNumber(vidData.factoryInventory || vidData.factoryStock || 0);
          }
          
          if (cjTotal > 0 || factoryTotal > 0) {
            variant.cjStock = cjTotal;
            variant.factoryStock = factoryTotal;
            variant.totalStock = cjTotal + factoryTotal;
            console.log(`[CJ Variants] Got stock for vid ${variant.vid}: CJ=${cjTotal}, Factory=${factoryTotal}`);
          }
        }
      } catch (e: any) {
        console.log(`[CJ Variants] Failed to get stock for vid ${variant.vid}: ${e?.message}`);
      }
    }
  }
  
  // If variant query returned nothing but we have stock data from inventory API,
  // build variants directly from stockListItems (already pre-parsed with cjStock/factoryStock)
  if (allVariants.length === 0 && stockListItems.length > 0) {
    console.log(`[CJ Variants] No variants from query but ${stockListItems.length} stock items available - building from stock data`);
    
    for (const v of stockListItems) {
      // stockListItems is pre-parsed with cjStock/factoryStock from inventory API
      const cjStock = v.cjStock ?? 0;
      const factoryStock = v.factoryStock ?? 0;
      const totalStock = v.totalStock ?? (cjStock + factoryStock);
      
      // Skip variants with no stock
      if (totalStock <= 0) continue;
      
      const sku = v.variantSku || v.sku || v.skuId || '';
      const vid = v.vid || '';
      const variantId = v.variantId || '';
      const variantKey = v.variantKey || '';
      const variantName = v.variantName || v.variantNameEn || '';
      const price = v.price ?? 0;
      
      const primarySku = sku || vid || variantId || variantKey || '';
      
      if (primarySku) {
        allVariants.push({
          variantSku: primarySku,
          variantName: variantName || variantKey || undefined,
          vid: vid || undefined,
          variantId: variantId || undefined,
          variantKey: variantKey || undefined,
          price,
          cjStock,
          factoryStock,
          totalStock,
        });
      }
    }
    console.log(`[CJ Variants] Built ${allVariants.length} variants from stock data fallback`);
  }
  
  console.log(`[CJ Variants] Final result: ${allVariants.length} variants for ${pid}`);
  try { await setCache(cacheKeyVarInv, allVariants, 43200); } catch {}
  return allVariants;
}

export type CjVariantLike = {
  cjSku?: string;
  variantKey?: string; // Short variant name from CJ (e.g., "Black And Silver-2XL")
  variantName?: string; // Full variant name (e.g., "Swinging VibratingAnd Glowing Twist-and-swivel Stimulator Remote control Boxed")
  vid?: string; // CJ variant ID
  size?: string;
  color?: string;
  price?: number;
  stock?: number;
  cjStock?: number; // CJ warehouse stock
  factoryStock?: number; // Factory/supplier stock
  // Optional shipping metadata when provided by CJ
  weightGrams?: number; // unit grams if available; undefined if unknown
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  imageUrl?: string; // optional variant image if provided by CJ
  variantOptions?: Record<string, string>;
  optionSignature?: string;
};

export type CjProductLike = {
  productId: string;
  name: string;
  images: string[];
  videoUrl?: string | null;
  videoSourceUrl?: string | null;
  video4kUrl?: string | null;
  videoDeliveryMode?: 'native' | 'enhanced' | 'passthrough' | null;
  videoQualityGatePassed?: boolean | null;
  videoSourceQualityHint?: '4k' | 'hd' | 'sd' | 'unknown' | null;
  variants: CjVariantLike[];
  deliveryTimeHours?: number | null; // estimated delivery time in hours (if provided by CJ)
  processingTimeHours?: number | null; // estimated processing time in hours (if provided by CJ)
  originArea?: string | null;
  originCountryCode?: string | null;
  // Added fields for better product display
  rating?: number | null; // Product/supplier rating (0-5 scale)
  reviewCount?: number | null; // Number of reviews
  supplierName?: string | null; // Supplier name from CJ
  price?: number | null; // Product-level price (min variant price)
  categoryName?: string | null; // Full category path
  sku?: string | null; // Main product SKU
  weight?: string | null; // Product weight (may be range like "98.00-120.00")
  materialEn?: string[] | null; // Material names in English
  packingEn?: string[] | null; // Packing names in English
  availableOptions?: DynamicAvailableOption[] | null; // Dynamic options from supplier variants
  availableColors?: string[] | null; // Unique colors across variants
  availableSizes?: string[] | null; // Unique sizes across variants
  availableModels?: string[] | null; // Legacy compatibility field
};

let baseOverride: string | null = null;
async function resolveBase(): Promise<string> {
  if (baseOverride) return baseOverride;
  const envBase = process.env.CJ_API_BASE || '';
  if (envBase) return envBase.replace(/\/$/, '');
  try {
    const cfg = await getSetting<CjConfig>('cj_config', undefined);
    const b = (cfg?.base || '').trim();
    if (b) {
      baseOverride = b.replace(/\/$/, '');
      return baseOverride;
    }
  } catch {}
  return 'https://developers.cjdropshipping.com/api2.0/v1';
}

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

type TokenState = {
  accessToken: string;
  accessTokenExpiry?: string | null;
  refreshToken?: string | null;
  refreshTokenExpiry?: string | null;
  lastAuthCallMs: number; // throttle get/refresh to avoid 5-min rule
};

let tokenState: TokenState | null = null;

function ms() { return Date.now(); }

function isNotExpired(iso?: string | null): boolean {
  if (!iso) return true; // if server doesn't give, assume valid
  const t = Date.parse(iso);
  if (isNaN(t)) return true;
  // treat token as expiring 60s earlier for safety
  return t - 60_000 > Date.now();
}

function throttleOk(last: number): boolean {
  // 5 minutes = 300000ms
  return (Date.now() - last) >= 300_000;
}

async function authPost<T>(path: string, body: any): Promise<T> {
  const base = await resolveBase();
  const url = `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  return await fetchJson<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    cache: 'no-store',
    timeoutMs: 12000,
    retries: 2,
  });
}

async function fetchNewAccessToken(): Promise<TokenState> {
  // Per official CJ API docs: only apiKey is required (format: CJUserNum@api@xxx)
  const apiKey = await getCjApiKey();
  if (!apiKey) throw new Error('Missing CJ_API_KEY (env or admin settings)');

  // Official endpoint per CJ docs
  const r = await authPost<any>('/authentication/getAccessToken', { apiKey });
  
  // Check for success response
  if (r?.code !== 200 || !r?.result) {
    throw new Error(`CJ getAccessToken failed: ${r?.message || 'Unknown error'} (code: ${r?.code})`);
  }
  
  const d = r?.data || {};
  const accessToken = String(d?.accessToken || '');
  
  if (!accessToken) {
    throw new Error('CJ getAccessToken returned empty token');
  }
  
  const out: TokenState = {
    accessToken,
    accessTokenExpiry: d?.accessTokenExpiryDate || null,
    refreshToken: d?.refreshToken || null,
    refreshTokenExpiry: d?.refreshTokenExpiryDate || null,
    lastAuthCallMs: ms(),
  };
  
  // Persist token to database for reuse across requests
  try {
    await saveToken('cj', {
      access_token: out.accessToken,
      access_expiry: out.accessTokenExpiry || null,
      refresh_token: out.refreshToken || null,
      refresh_expiry: out.refreshTokenExpiry || null,
      last_auth_call_at: new Date(out.lastAuthCallMs).toISOString(),
    });
  } catch {}
  
  return out;
}

async function refreshAccessTokenState(state: TokenState): Promise<TokenState> {
  if (!state.refreshToken) return state;
  const r = await authPost<any>('/authentication/refreshAccessToken', { refreshToken: state.refreshToken });
  if (r?.code !== 200 || !r?.result) {
    throw new Error(`refreshAccessToken failed: ${r?.message || 'Unknown error'}`);
  }
  const d = r.data || {};
  const out: TokenState = {
    accessToken: String(d.accessToken || state.accessToken),
    accessTokenExpiry: d.accessTokenExpiryDate || state.accessTokenExpiry || null,
    refreshToken: d.refreshToken || state.refreshToken || null,
    refreshTokenExpiry: d.refreshTokenExpiryDate || state.refreshTokenExpiry || null,
    lastAuthCallMs: ms(),
  };
  try {
    await saveToken('cj', {
      access_token: out.accessToken,
      access_expiry: out.accessTokenExpiry || null,
      refresh_token: out.refreshToken || null,
      refresh_expiry: out.refreshTokenExpiry || null,
      last_auth_call_at: new Date(out.lastAuthCallMs).toISOString(),
    });
  } catch {}
  return out;
}

export async function getAccessToken(): Promise<string> {
  // Manual override for emergencies
  const manual = process.env.CJ_ACCESS_TOKEN;
  if (manual) return manual;

  // Use cached if valid
  if (tokenState && isNotExpired(tokenState.accessTokenExpiry)) {
    return tokenState.accessToken;
  }

  // Try to load from DB token store
  try {
    const row = await loadToken('cj');
    if (row?.access_token) {
      const dbState: TokenState = {
        accessToken: row.access_token,
        accessTokenExpiry: row.access_expiry,
        refreshToken: row.refresh_token,
        refreshTokenExpiry: row.refresh_expiry,
        lastAuthCallMs: row.last_auth_call_at ? Date.parse(row.last_auth_call_at) : 0,
      };
      tokenState = dbState;
      if (isNotExpired(dbState.accessTokenExpiry)) {
        return dbState.accessToken;
      }
    }
  } catch {}

  // Try to refresh if we have a refreshToken and respect 5-min throttle
  if (tokenState && tokenState.refreshToken) {
    if (!throttleOk(tokenState.lastAuthCallMs)) {
      // If throttled but token expired, we still have to try using the old token (may fail downstream)
      return tokenState.accessToken;
    }
    try {
      tokenState = await refreshAccessTokenState(tokenState);
      if (tokenState && isNotExpired(tokenState.accessTokenExpiry)) return tokenState.accessToken;
    } catch {/* will fallback to new token */}
  }

  // Fetch a new token with email/apiKey
  if (!tokenState || throttleOk(tokenState.lastAuthCallMs)) {
    tokenState = await fetchNewAccessToken();
    return tokenState.accessToken;
  }

  throw new Error('Unable to obtain CJ access token (throttled). Please try again shortly.');
}

async function cjFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const base = await resolveBase();
  const url = `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  const attempt = async (tok: string) => {
    const headers = {
      'Content-Type': 'application/json',
      'CJ-Access-Token': tok,
      ...(init?.headers || {}),
    } as Record<string, string>;
    return await fetchJson<T>(url, {
      ...init,
      headers,
      cache: 'no-store',
      timeoutMs: 12000,
      retries: 2,
    });
  };

  let token = await getAccessToken();
  try {
    return await attempt(token);
  } catch (e: any) {
    const msg = String(e?.message || e || '');
    const looksAuth = /HTTP\s*(401|403)/i.test(msg) || /token|auth/i.test(msg);
    const freshCreds = await getCjCreds();
    const canFetchFresh = !!(process.env.CJ_EMAIL || freshCreds.email) && !!(process.env.CJ_API_KEY || freshCreds.apiKey);
    if (looksAuth && canFetchFresh) {
      try {
        // Force-fetch a fresh token bypassing any bad manual override
        const fresh = await fetchNewAccessToken();
        tokenState = fresh;
        return await attempt(fresh.accessToken);
      } catch {
        // fall through to rethrow original error
      }
    }
    throw e;
  }
}

// --- Product Rating from Comments ---
// CJDropshipping productComments API - fetches real customer reviews and calculates average rating
// Endpoint: GET /product/productComments?pid=xxx&pageNum=1&pageSize=200
// Response: { success: true, code: 0, data: { total: "285", list: [{ score: "5", ... }] } }
// Implements pagination to fetch ALL reviews for 100% accurate average rating calculation
export async function getProductRating(pid: string): Promise<{ rating: number | null; reviewCount: number }> {
  const PAGE_SIZE = 200; // Maximum reviews per page
  const MAX_PAGES = 10; // Safety limit to prevent excessive API calls
  
  try {
    console.log(`[CJ Rating] Fetching comments for pid: ${pid}`);
    
    // Helper function to extract score from a comment
    const extractScore = (comment: any): number | null => {
      const scoreVal = comment?.score ?? comment?.rating ?? comment?.starScore ?? comment?.commentScore;
      if (scoreVal !== undefined && scoreVal !== null && scoreVal !== '') {
        const score = parseFloat(String(scoreVal));
        if (Number.isFinite(score) && score > 0 && score <= 5) {
          return score;
        }
      }
      return null;
    };
    
    const toFiniteInt = (value: unknown, fallback: number): number => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.floor(value));
      }
      if (typeof value === 'string') {
        const cleaned = value.replace(/[^\d-]/g, '').trim();
        if (cleaned) {
          const parsed = Number(cleaned);
          if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
        }
      }
      return fallback;
    };

    // Helper function to parse API response
    const parseResponse = (res: any): { list: any[]; total: number; success: boolean } => {
      const codeRaw = res?.code;
      const codeNum = typeof codeRaw === 'string' ? Number(codeRaw) : codeRaw;
      const statusCodeRaw = res?.statusCode ?? res?.status;
      const statusCodeNum = typeof statusCodeRaw === 'string' ? Number(statusCodeRaw) : statusCodeRaw;
      const successRaw = res?.success;
      const successNum = typeof successRaw === 'string' ? Number(successRaw) : successRaw;
      const resultRaw = res?.result;
      const resultNum = typeof resultRaw === 'string' ? Number(resultRaw) : resultRaw;

      const data = res?.data ?? res?.resultData ?? null;
      const payload =
        (data && typeof data === 'object'
          ? (data?.data ?? data?.result ?? data?.page ?? data)
          : data) ?? null;
      const list =
        (Array.isArray(payload?.list) ? payload.list : null) ??
        (Array.isArray(payload?.content) ? payload.content : null) ??
        (Array.isArray(payload?.records) ? payload.records : null) ??
        (Array.isArray(payload?.rows) ? payload.rows : null) ??
        (Array.isArray(payload?.items) ? payload.items : null) ??
        (Array.isArray(payload?.commentList) ? payload.commentList : null) ??
        (Array.isArray(data?.list) ? data.list : null) ??
        (Array.isArray(data?.content) ? data.content : null) ??
        (Array.isArray(data?.records) ? data.records : null) ??
        (Array.isArray(data?.rows) ? data.rows : null) ??
        (Array.isArray(data?.items) ? data.items : null) ??
        (Array.isArray(data?.commentList) ? data.commentList : null) ??
        (Array.isArray(data) ? data : null) ??
        (Array.isArray(res?.list) ? res.list : null) ??
        (Array.isArray(res?.content) ? res.content : null) ??
        (Array.isArray(res?.records) ? res.records : null) ??
        (Array.isArray(res?.rows) ? res.rows : null) ??
        (Array.isArray(res?.items) ? res.items : null) ??
        (Array.isArray(res) ? res : []);

      const total = toFiniteInt(
        payload?.total ??
          payload?.totalCount ??
          payload?.count ??
          payload?.totalNum ??
          payload?.recordTotal ??
          payload?.itemTotal ??
          payload?.totalElements ??
          data?.total ??
          data?.totalCount ??
          data?.count ??
          data?.totalNum ??
          res?.total ??
          res?.totalCount ??
          res?.count,
        list.length
      );

      const isSuccess =
        successRaw === true ||
        successRaw === 'true' ||
        successRaw === 1 ||
        successRaw === '1' ||
        successNum === 1 ||
        resultRaw === true ||
        resultRaw === 'true' ||
        resultRaw === 1 ||
        resultRaw === '1' ||
        resultNum === 1 ||
        codeRaw === 200 ||
        codeRaw === 0 ||
        codeRaw === '200' ||
        codeRaw === '0' ||
        codeNum === 200 ||
        codeNum === 0 ||
        statusCodeRaw === 200 ||
        statusCodeRaw === '200' ||
        statusCodeNum === 200 ||
        res?.ok === true ||
        list.length > 0;

      if (!isSuccess && list.length === 0) {
        const message = res?.message || res?.msg || res?.error;
        if (message) {
          console.log(`[CJ Rating] API error for pid ${pid}: ${message}`);
        }
        return { list: [], total: 0, success: false };
      }

      return { list, total, success: true };
    };
    
    // Fetch first page
    const firstPageEndpoint = `/product/productComments?pid=${encodeURIComponent(pid)}&pageNum=1&pageSize=${PAGE_SIZE}`;
    const firstRes = await cjFetch<any>(firstPageEndpoint);
    console.log(`[CJ Rating] First page response for pid ${pid}:`, JSON.stringify(firstRes).slice(0, 800));
    
    const firstPage = parseResponse(firstRes);
    if (!firstPage.success) {
      return { rating: null, reviewCount: 0 };
    }
    
    const total = firstPage.total;
    console.log(`[CJ Rating] pid ${pid}: total=${total}, firstPageLength=${firstPage.list.length}`);
    
    if (firstPage.list.length === 0) {
      console.log(`[CJ Rating] No reviews found for pid ${pid}`);
      return { rating: null, reviewCount: total > 0 ? total : 0 };
    }
    
    // Collect all reviews - start with first page
    let allReviews = [...firstPage.list];
    
    // Fetch additional pages if there are more reviews
    const totalPages = Math.min(Math.ceil(total / PAGE_SIZE), MAX_PAGES);
    if (totalPages > 1) {
      console.log(`[CJ Rating] pid ${pid}: Fetching ${totalPages - 1} additional pages for ${total} total reviews`);
      
      for (let page = 2; page <= totalPages; page++) {
        try {
          const pageEndpoint = `/product/productComments?pid=${encodeURIComponent(pid)}&pageNum=${page}&pageSize=${PAGE_SIZE}`;
          const pageRes = await cjFetch<any>(pageEndpoint);
          const pageData = parseResponse(pageRes);
          
          if (pageData.success && pageData.list.length > 0) {
            allReviews = [...allReviews, ...pageData.list];
            console.log(`[CJ Rating] pid ${pid}: Page ${page} added ${pageData.list.length} reviews, total now: ${allReviews.length}`);
          } else {
            break; // Stop if no more data
          }
        } catch (e: any) {
          console.log(`[CJ Rating] pid ${pid}: Failed to fetch page ${page}: ${e?.message}`);
          break; // Continue with what we have
        }
      }
    }
    
    // Calculate average rating from ALL fetched reviews
    let sumScore = 0;
    let countScores = 0;
    for (const comment of allReviews) {
      const score = extractScore(comment);
      if (score !== null) {
        sumScore += score;
        countScores++;
      }
    }
    
    if (countScores === 0) {
      console.log(`[CJ Rating] pid ${pid}: ${total} reviews but no valid scores extracted`);
      return { rating: null, reviewCount: total };
    }
    
    const avgRating = sumScore / countScores;
    const roundedRating = Math.round(avgRating * 10) / 10; // Round to 1 decimal place
    
    console.log(`[CJ Rating] pid ${pid}: avgRating=${roundedRating} (from ${countScores}/${allReviews.length} scored reviews), totalReviews=${total}`);
    return { rating: roundedRating, reviewCount: total };
    
  } catch (e: any) {
    console.error(`[CJ Rating] Failed to fetch product rating for pid ${pid}:`, e?.message || e);
    return { rating: null, reviewCount: 0 };
  }
}

// Batch fetch ratings for multiple products (with concurrency limit)
export async function getProductRatings(pids: string[]): Promise<Map<string, { rating: number | null; reviewCount: number }>> {
  const results = new Map<string, { rating: number | null; reviewCount: number }>();
  const BATCH_SIZE = 5; // Limit concurrent requests
  
  for (let i = 0; i < pids.length; i += BATCH_SIZE) {
    const batch = pids.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (pid) => {
      const result = await getProductRating(pid);
      return { pid, result };
    });
    
    const batchResults = await Promise.allSettled(promises);
    for (const res of batchResults) {
      if (res.status === 'fulfilled') {
        results.set(res.value.pid, res.value.result);
      }
    }
  }
  
  return results;
}

// Helper: Parse JSON array fields from CJ API (e.g., materialNameEn: '["","metal"]')
function parseCjJsonArray(val: any): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(Boolean).map(String);
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed.startsWith('[')) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) return arr.filter(Boolean).map(String);
      } catch {}
    }
    return trimmed ? [trimmed] : [];
  }
  return [];
}

// Helper: Extract product list from listV2 response (handles various response structures)
function extractListV2Products(res: any): any[] {
  const content = res?.data?.content;
  if (Array.isArray(content) && content[0]?.productList) {
    return content[0].productList;
  }
  if (content && !Array.isArray(content) && content.productList) {
    return content.productList;
  }
  if (res?.data?.list) {
    return res.data.list;
  }
  if (Array.isArray(res?.data)) {
    return res.data;
  }
  return [];
}

// Helper: Copy useful fields from listV2 match to product data
function mergeListV2Fields(productData: any, match: any, source: string): void {
  const parseFiniteMetric = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const cleaned = value.replace(/,/g, '').trim();
      if (!cleaned) return null;

      const parsed = Number(cleaned);
      if (Number.isFinite(parsed)) {
        return parsed;
      }

      const matchNum = cleaned.match(/-?\d+(?:\.\d+)?/);
      if (matchNum) {
        const extracted = Number(matchNum[0]);
        if (Number.isFinite(extracted)) {
          return extracted;
        }
      }
    }

    return null;
  };

  if (match.description && !productData.description) {
    productData.description = match.description;
    console.log(`[CJ Details] Got description from listV2 (${source}): ${match.description.slice(0, 80)}...`);
  }
  if (match.threeCategoryName) productData.threeCategoryName = match.threeCategoryName;
  if (match.twoCategoryName) productData.twoCategoryName = match.twoCategoryName;
  if (match.oneCategoryName) productData.oneCategoryName = match.oneCategoryName;
  if (match.deliveryCycle) productData.deliveryCycle = match.deliveryCycle;
  if (match.categoryId && !productData.categoryId) productData.categoryId = match.categoryId;
  if (match.listedNum && !productData.listedNum) productData.listedNum = match.listedNum;
  if (match.addMarkStatus !== undefined) productData.addMarkStatus = match.addMarkStatus;
  
  // IMPORTANT: Copy inventory fields from listV2 (these are the REAL stock values)
  // warehouseInventoryNum = total inventory number
  // totalVerifiedInventory = CJ warehouse stock (verified)
  // totalUnVerifiedInventory = Factory/supplier stock (unverified)
  if (match.warehouseInventoryNum !== undefined && match.warehouseInventoryNum !== null) {
    productData.warehouseInventoryNum = Number(match.warehouseInventoryNum);
    console.log(`[CJ Details] Got warehouseInventoryNum from listV2 (${source}): ${productData.warehouseInventoryNum}`);
  }
  if (match.totalVerifiedInventory !== undefined && match.totalVerifiedInventory !== null) {
    productData.totalVerifiedInventory = Number(match.totalVerifiedInventory);
  }
  if (match.totalUnVerifiedInventory !== undefined && match.totalUnVerifiedInventory !== null) {
    productData.totalUnVerifiedInventory = Number(match.totalUnVerifiedInventory);
  }
  // Also copy listedNum for popularity (override if we have a better value)
  if (match.listedNum !== undefined && match.listedNum !== null && Number(match.listedNum) > 0) {
    productData.listedNum = Number(match.listedNum);
    console.log(`[CJ Details] Got listedNum from listV2 (${source}): ${productData.listedNum}`);
  }
  
  // Copy rating fields from listV2 (CJ products may have ratings in listing)
  const ratingVal =
    match.rating ??
    match.productRating ??
    match.score ??
    match.avgScore ??
    match.avgRating ??
    match.averageRating ??
    match.supplier?.supplierRating ??
    match.supplier?.supplierScore ??
    match.supplier?.rating ??
    match.supplier?.productRating ??
    match.supplier?.score ??
    match.supplier?.avgScore ??
    match.supplier?.avgRating ??
    match.supplier?.averageRating;
  if (ratingVal !== undefined && ratingVal !== null) {
    const parsedRating = parseFiniteMetric(ratingVal);
    if (typeof parsedRating === 'number' && parsedRating > 0 && parsedRating <= 5) {
      productData.rating = parsedRating;
      console.log(`[CJ Details] Got rating from listV2 (${source}): ${parsedRating}`);
    }
  }
  
  const reviewVal =
    match.reviewCount ??
    match.reviewNum ??
    match.review_count ??
    match.ratingCount ??
    match.rating_count ??
    match.reviews ??
    match.commentCount ??
    match.comment_count ??
    match.commentNum ??
    match.comment_num ??
    match.evaluateCount ??
    match.evaluationCount ??
    match.evaluateNum ??
    match.totalReview ??
    match.totalReviews ??
    match.totalComment ??
    match.totalComments ??
    match.total_comment_num ??
    match.supplier?.reviewCount ??
    match.supplier?.reviewNum ??
    match.supplier?.review_count ??
    match.supplier?.ratingCount ??
    match.supplier?.rating_count ??
    match.supplier?.reviews ??
    match.supplier?.commentCount ??
    match.supplier?.comment_count ??
    match.supplier?.commentNum ??
    match.supplier?.comment_num ??
    match.supplier?.evaluateCount ??
    match.supplier?.evaluationCount ??
    match.supplier?.evaluateNum ??
    match.supplier?.totalReview ??
    match.supplier?.totalReviews ??
    match.supplier?.totalComment ??
    match.supplier?.totalComments ??
    match.supplier?.total_comment_num;
  if (reviewVal !== undefined && reviewVal !== null) {
    const parsedCount = parseFiniteMetric(reviewVal);
    if (typeof parsedCount === 'number' && parsedCount >= 0) {
      productData.reviewCount = parsedCount;
      console.log(`[CJ Details] Got reviewCount from listV2 (${source}): ${parsedCount}`);
    }
  }
}

// Fetch full product details by PID - returns complete product with all images and variants
export async function fetchProductDetailsByPid(pid: string): Promise<any | null> {
  if (!pid) return null;
  const cacheKeyDetails = `cj:details:pid:${pid}`;
  try {
    const cached = await getCache<any>(cacheKeyDetails);
    if (cached) return cached;
  } catch {}
  
  try {
    // Fetch product details from /product/query
    const pr = await cjFetch<any>(`/product/query?pid=${encodeURIComponent(pid)}`);
    let productData = pr?.data || pr?.content || pr || null;
    
    if (!productData) return null;
    
    // Get the SKU for more targeted search
    const sku = productData.productSku || productData.sku || '';
    
    // Parse JSON array fields from /product/query (CJ returns some as JSON strings)
    // These contain material, packing info etc that we need for product specs
    const materialArr = parseCjJsonArray(productData.materialNameEn || productData.materialName);
    const packingArr = parseCjJsonArray(productData.packingNameEn || productData.packingName);
    const productKeyArr = parseCjJsonArray(productData.productKeyEn || productData.productKey);
    
    // Store parsed arrays as readable strings for display
    if (materialArr.length > 0 && !productData.materialParsed) {
      productData.materialParsed = materialArr.filter(m => m && m.length > 0).join(', ');
    }
    if (packingArr.length > 0 && !productData.packingParsed) {
      productData.packingParsed = packingArr.filter(p => p && p.length > 0).join(', ');
    }
    if (productKeyArr.length > 0 && !productData.productKeyParsed) {
      productData.productKeyParsed = productKeyArr.filter(k => k && k.length > 0).join(', ');
    }
    
    // Also enrich from listV2 with features parameter.
    // /product/query often omits some fidelity metrics (rating/review/listed/inventory),
    // so we fetch listV2 not only for description gaps but also when review signals are missing.
    const listV2Features = 'enable_description,enable_category';
    const ratingMetricKeys = ['rating', 'productRating', 'score', 'avgScore', 'avgRating', 'averageRating', 'supplierRating', 'supplierScore', 'starCount', 'star_count'];
    const reviewMetricKeys = ['reviewCount', 'reviewNum', 'review_count', 'ratingCount', 'rating_count', 'reviews', 'commentCount', 'comment_count', 'commentNum', 'comment_num', 'evaluateCount', 'evaluationCount', 'evaluateNum', 'totalReview', 'totalReviews', 'totalComment', 'totalComments', 'total_comment_num'];

    const parseMetric = (value: unknown): number | null => {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string') {
        const cleaned = value.replace(/,/g, '').trim();
        if (!cleaned) return null;

        const parsed = Number(cleaned);
        if (Number.isFinite(parsed)) return parsed;

        const matchNum = cleaned.match(/-?\d+(?:\.\d+)?/);
        if (matchNum) {
          const extracted = Number(matchNum[0]);
          if (Number.isFinite(extracted)) return extracted;
        }
      }
      return null;
    };

    const pickMetric = (candidate: any, keys: string[]): number | null => {
      if (!candidate || typeof candidate !== 'object') return null;
      for (const key of keys) {
        const parsed = parseMetric(candidate?.[key]);
        if (typeof parsed === 'number') return parsed;
      }
      return null;
    };

    const normalizeLookupToken = (value: unknown): string => String(value ?? '').trim().toLowerCase();
    const targetPid = normalizeLookupToken(pid);
    const targetSku = normalizeLookupToken(sku);
    const matchesPid = (candidate: any): boolean => {
      const candidatePid = normalizeLookupToken(candidate?.pid ?? candidate?.id ?? candidate?.productId);
      return candidatePid.length > 0 && candidatePid === targetPid;
    };
    const matchesSku = (candidate: any): boolean => {
      if (!targetSku) return false;
      const candidateSku = normalizeLookupToken(candidate?.sku ?? candidate?.productSku ?? candidate?.cjSku);
      return candidateSku.length > 0 && candidateSku === targetSku;
    };

    const hasRatingSignal = (candidate: any): boolean => {
      const direct = pickMetric(candidate, ratingMetricKeys);
      const nested = candidate?.supplier && typeof candidate.supplier === 'object'
        ? pickMetric(candidate.supplier, ratingMetricKeys)
        : null;
      const value = direct ?? nested;
      return typeof value === 'number' && value > 0 && value <= 5;
    };

    const hasReviewSignal = (candidate: any): boolean => {
      const direct = pickMetric(candidate, reviewMetricKeys);
      const nested = candidate?.supplier && typeof candidate.supplier === 'object'
        ? pickMetric(candidate.supplier, reviewMetricKeys)
        : null;
      const value = direct ?? nested;
      return typeof value === 'number' && value > 0;
    };

    const needsListV2Enrichment = (): boolean => {
      const listedNum = Number(productData?.listedNum);
      const warehouseInventoryNum = Number(productData?.warehouseInventoryNum);
      const hasListedNum = Number.isFinite(listedNum) && listedNum > 0;
      const hasInventoryNum = Number.isFinite(warehouseInventoryNum) && warehouseInventoryNum > 0;

      return (
        !productData?.description
        || !hasRatingSignal(productData)
        || !hasReviewSignal(productData)
        || !hasListedNum
        || !hasInventoryNum
      );
    };

    if (needsListV2Enrichment()) {
      // Strategy 1: Direct search by PID (most reliable if CJ indexes by PID)
      try {
        const listV2Res = await cjFetch<any>(`/product/listV2?keyWord=${encodeURIComponent(pid)}&page=1&size=5&features=${listV2Features}`);
        const productList = extractListV2Products(listV2Res);
        const match = productList.find((p: any) => matchesPid(p));
        if (match) {
          mergeListV2Fields(productData, match, `PID search ${pid}`);
        }
      } catch (e: any) {
        console.log(`[CJ Details] listV2 PID search failed for ${pid}:`, e?.message);
      }
    }
    
    // Strategy 2: Search by exact SKU (reliable for products with unique SKUs)
    if (needsListV2Enrichment() && sku) {
      try {
        const listV2Res = await cjFetch<any>(`/product/listV2?keyWord=${encodeURIComponent(sku)}&page=1&size=10&features=${listV2Features}`);
        const productList = extractListV2Products(listV2Res);
        // Find exact match by PID or SKU
        const match = productList.find((p: any) => matchesPid(p) || matchesSku(p));
        if (match) {
          mergeListV2Fields(productData, match, `SKU search ${sku}`);
        }
      } catch (e: any) {
        console.log(`[CJ Details] listV2 SKU search failed for ${pid}:`, e?.message);
      }
    }
    
    // Strategy 3: Search by product name if we still have missing fidelity signals
    if (needsListV2Enrichment()) {
      try {
        const productName = productData.productNameEn || productData.productName || productData.nameEn || '';
        if (productName && productName.length > 5) {
          // Use first 40 chars of product name for search (increased from 30)
          const searchTerm = productName.slice(0, 40).trim();
          const listV2Res = await cjFetch<any>(`/product/listV2?keyWord=${encodeURIComponent(searchTerm)}&page=1&size=20&features=${listV2Features}`);
          const productList = extractListV2Products(listV2Res);
          
          // Find exact match by PID first
          let match = productList.find((p: any) => matchesPid(p));
          
          // If no PID match, try SKU match
          if (!match && sku) {
            match = productList.find((p: any) => matchesSku(p));
          }
          
          if (match) {
            mergeListV2Fields(productData, match, `name search "${searchTerm.slice(0, 20)}..."`);
          }
        }
      } catch (e: any) {
        console.log(`[CJ Details] listV2 name search failed for ${pid}:`, e?.message);
      }
    }
    
    // Log all weight-related fields from CJ API for debugging shipping costs
    // For shipping, packWeight (total weight with packaging) is more accurate than productWeight (net)
    const weightFields = ['packWeight', 'packingWeight', 'productWeight', 'weight', 'grossWeight', 'netWeight'];
    const foundWeights: Record<string, any> = {};
    for (const f of weightFields) {
      if (productData[f] !== undefined && productData[f] !== null && productData[f] !== '') {
        foundWeights[f] = productData[f];
      }
    }
    if (Object.keys(foundWeights).length > 0) {
      console.log(`[CJ Details] Product ${pid} weight fields:`, JSON.stringify(foundWeights));
    } else {
      console.log(`[CJ Details] Product ${pid}: No weight data in CJ response`);
    }
    
    // Build synthesized productInfo from all available fields (used if no description HTML)
    // This ensures we always have SOMETHING to show on Page 3
    if (!productData.synthesizedInfo) {
      const infoLines: string[] = [];
      
      // Material info
      if (productData.materialParsed) {
        infoLines.push(`Material: ${productData.materialParsed}`);
      }
      
      // Packing/package info
      if (productData.packingParsed) {
        infoLines.push(`Package: ${productData.packingParsed}`);
      }
      
      // Product weight
      const weight = productData.productWeight || productData.packingWeight || productData.packWeight || productData.weight;
      if (weight && Number(weight) > 0) {
        infoLines.push(`Weight: ${weight}g`);
      }
      
      // Dimensions from packing
      const pL = productData.packLength;
      const pW = productData.packWidth;
      const pH = productData.packHeight;
      if (pL && pW && pH && Number(pL) > 0 && Number(pW) > 0 && Number(pH) > 0) {
        infoLines.push(`Package Size: ${pL} × ${pW} × ${pH} cm`);
      }
      
      // Product attributes (color, size options from productKeyEn)
      if (productData.productKeyParsed) {
        infoLines.push(`Attributes: ${productData.productKeyParsed}`);
      }
      
      // Category path
      const category = productData.threeCategoryName || productData.twoCategoryName || productData.categoryName || '';
      if (category && !category.includes('_')) {
        infoLines.push(`Category: ${category}`);
      }
      
      // Delivery cycle
      if (productData.deliveryCycle) {
        infoLines.push(`Delivery: ${productData.deliveryCycle} days`);
      }
      
      // HS code for customs (useful for international shipping)
      if (productData.entryCode && productData.entryNameEn) {
        infoLines.push(`HS Code: ${productData.entryCode} (${productData.entryNameEn})`);
      }
      
      if (infoLines.length > 0) {
        productData.synthesizedInfo = infoLines.join('<br/>');
        console.log(`[CJ Details] Built synthesizedInfo for ${pid}: ${infoLines.length} fields`);
      }
    }
    
    // Log available data fields for debugging
    const specFields = ['description', 'synthesizedInfo', 'materialParsed', 'packingParsed', 'productPropertyList', 'productWeight'];
    const availableSpecs: Record<string, string> = {};
    for (const field of specFields) {
      if (productData[field]) {
        const val = productData[field];
        if (typeof val === 'string') {
          availableSpecs[field] = `"${val.slice(0, 40)}..."`;
        } else if (Array.isArray(val)) {
          availableSpecs[field] = `[${val.length} items]`;
        } else {
          availableSpecs[field] = typeof val;
        }
      }
    }
    console.log(`[CJ Details] Product ${pid} spec fields:`, JSON.stringify(availableSpecs));
    
    // Fetch variants separately to get complete variant data with images
    try {
      const variantList = await getProductVariants(pid);
      if (Array.isArray(variantList) && variantList.length > 0) {
        console.log(`[CJ Details] Product ${pid} has ${variantList.length} variants`);
        productData = { ...productData, variantList };
      }
    } catch {}
    
    try { await setCache(cacheKeyDetails, productData, 43200); } catch {}
    return productData;
  } catch (e: any) {
    console.log(`[CJ Details] Failed to fetch details for ${pid}:`, e?.message);
    return null;
  }
}

// Batch fetch product details with concurrency control
export async function fetchProductDetailsBatch(pids: string[], concurrency: number = 5): Promise<Map<string, any>> {
  const results = new Map<string, any>();
  
  // Process in batches to avoid overwhelming the API
  for (let i = 0; i < pids.length; i += concurrency) {
    const batch = pids.slice(i, i + concurrency);
    const promises = batch.map(async (pid) => {
      const details = await fetchProductDetailsByPid(pid);
      if (details) {
        results.set(pid, details);
      }
    });
    await Promise.all(promises);
    
    // Small delay between batches to respect rate limits
    if (i + concurrency < pids.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  console.log(`[CJ Batch] Fetched details for ${results.size}/${pids.length} products`);
  return results;
}

// Query by keyword or PID (CJ sometimes exposes myProduct query); we attempt flexible endpoints.
export async function queryProductByPidOrKeyword(input: { pid?: string; keyword?: string }): Promise<any> {
  const { pid, keyword } = input;
  if (!pid && !keyword) throw new Error('Missing pid or keyword');

  // If PID provided, hit the exact PID endpoint first
  if (pid) {
    try {
      let guidPid = pid;
      // Resolve PID generically: the input may be a numeric web id or a SKU like CJTZ...; search to find the product pid
      try {
        const lr = await cjFetch<any>(`/product/list?keyWords=${encodeURIComponent(pid)}&pageSize=5&pageNum=1`);
        const cand = (Array.isArray(lr?.data?.list) ? lr.data.list : []) as any[];
        if (cand.length > 0 && cand[0]?.pid) {
          guidPid = String(cand[0].pid);
        }
      } catch {}

      // Fetch product details and variants using GUID pid
      const pr = await cjFetch<any>(`/product/query?pid=${encodeURIComponent(guidPid)}`);
      let base = pr?.data || pr?.content || pr || null;
      try {
        const vr = await cjFetch<any>(`/product/variant/query?pid=${encodeURIComponent(guidPid)}`);
        const vlist = Array.isArray(vr?.data) ? vr.data : [];
        if (base) base = { ...base, variantList: vlist };
      } catch { /* ignore variant errors */ }

      const content = base ? [base] : [];
      return { code: 200, data: { content } };
    } catch (e) {
      // Fall through to keyword mode as a last resort
    }
  }

  // Keyword search: try multiple endpoints (CJ requires min pageSize of 10)
  const term = String(keyword || pid);
  const qsKeyword = `keyword=${encodeURIComponent(term)}&pageSize=20&pageNumber=1`;
  const qsList = `keyWords=${encodeURIComponent(term)}&pageSize=20&pageNum=1`;
  const endpoints = [
    `/product/myProduct/query?${qsKeyword}`,
    `/product/query?${qsKeyword}`,
    `/product/list?${qsList}`,
  ];

  const collected: any[] = [];
  let lastErr: any = null;
  for (const ep of endpoints) {
    try {
      const r = await cjFetch<any>(ep);
      const arr = Array.isArray(r?.data?.list)
        ? r.data.list
        : Array.isArray(r?.data?.content)
          ? r.data.content
          : Array.isArray(r?.content)
            ? r.content
            : Array.isArray(r?.data)
              ? r.data
              : Array.isArray(r)
                ? r
                : [];
      for (const it of arr) collected.push(it);
      if (collected.length > 0) break;
    } catch (e: any) {
      lastErr = e;
    }
  }

  if (collected.length === 0 && lastErr) throw lastErr;
  return { code: 200, data: { content: collected } };
}

// Attempt to map a CJ response item to our internal structure.
export function mapCjItemToProductLike(item: any): CjProductLike | null {
  if (!item) return null;
  const productId = String(item.productId || item.pid || item.id || item.vid || item.sku || '');
  if (!productId) return null;
  // --- Title normalization ---
  function cleanTitle(s: string): string {
    try {
      const normalized = s.replace(/[“”„‟‛]/g, '"').replace(/[’‘`]/g, "'");
      const parts = normalized.split(/[",，、|]+/).map((p) => p.trim()).filter(Boolean);
      const uniq: string[] = [];
      for (const p of parts) if (!uniq.includes(p)) uniq.push(p);
      let out = (uniq.join(', ') || normalized).replace(/^"+|"+$/g, '').replace(/\s{2,}/g, ' ').trim();
      if (out.length > 120) { out = out.slice(0, 120).replace(/\s+\S*$/, '').trim(); }
      return out || 'Untitled';
    } catch { return s || 'Untitled'; }
  }
  // Prefer English/Latin/Arabic title if available; fall back to cleaned string with CJK stripped if dominant
  const rawTitle = String(item.nameEn || item.productNameEn || item.englishName || item.productName || item.name || item.title || 'Untitled');
  let name = cleanTitle(rawTitle);
  try {
    const cjk = (name.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
    if (cjk > 0 && cjk / Math.max(1, name.length) > 0.4) {
      const asciiish = name.replace(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, '').replace(/\s{2,}/g, ' ').trim();
      if (asciiish.length >= 10) name = cleanTitle(asciiish);
    }
  } catch {}
  // Optional: basic Arabic terminology replacement if enabled (non-AI, deterministic)
  function arabizeTitle(s: string): string {
    const map: Array<[RegExp, string]> = [
      [/\bwomen'?s\b/ig, 'للنساء'],
      [/\bwomen\b/ig, 'نساء'],
      [/\bmen'?s\b/ig, 'للرجال'],
      [/\bmen\b/ig, 'رجال'],
      [/\bdress(es)?\b/ig, 'فستان'],
      [/\bblouse(s)?\b/ig, 'بلوزة'],
      [/\bskirt(s)?\b/ig, 'تنورة'],
      [/\bshirt(s)?\b/ig, 'قميص'],
      [/\bt[- ]?shirt(s)?\b/ig, 'تيشيرت'],
      [/\bhoodie(s)?\b/ig, 'هودي'],
      [/\bsweater(s)?\b/ig, 'كنزة'],
      [/\bjeans?\b/ig, 'جينز'],
      [/\bpants?\b/ig, 'بنطال'],
      [/\bshorts?\b/ig, 'شورت'],
      [/\bshoes?\b/ig, 'أحذية'],
      [/\bsneakers?\b/ig, 'سنيكرز'],
      [/\blong sleeve(s)?\b/ig, 'أكمام طويلة'],
      [/\bshort sleeve(s)?\b/ig, 'أكمام قصيرة'],
    ];
    let out = s;
    for (const [re, ar] of map) out = out.replace(re, ar);
    return out;
  }
  try {
    if ((process.env.AUTO_ARABIC_TITLES || '').toLowerCase() === 'true') {
      name = arabizeTitle(name);
    }
  } catch {}

  // --- Image collection (shared deterministic CJ helper) ---
  const filteredImages: string[] = extractCjProductGalleryImages(item, 30);

  const sourceVideoUrl = extractCjProductVideoUrl(item);
  const videoDelivery = build4kVideoDelivery(sourceVideoUrl);
  const deliverableVideoUrl = videoDelivery.qualityGatePassed
    ? (videoDelivery.deliveryUrl || null)
    : null;

  // Helpers to coerce numbers from various shapes
  const toNum = (x: any): number | undefined => {
    if (typeof x === 'number' && isFinite(x)) return x;
    if (typeof x === 'string') {
      // Remove common separators and non-numeric chars except dot
      const m = x.replace(/[,\s]/g, '').match(/-?\d*\.?\d+/);
      if (m) {
        const n = parseFloat(m[0]);
        return isFinite(n) ? n : undefined;
      }
    }
    return undefined;
  };
  const pickNum = (...cands: any[]): number | undefined => {
    for (const c of cands) {
      const n = toNum(c);
      if (typeof n === 'number' && !isNaN(n)) return n;
    }
    return undefined;
  };

  // Variants: try multiple shapes (skuList, variantList, productSku, etc.)
  const variants: CjVariantLike[] = [];
  const rawVariants = item.variantList || item.skuList || item.productSkuList || item.variants || [];
  if (Array.isArray(rawVariants)) {
    for (const v of rawVariants) {
      const cjSku = v.cjSku || v.sku || v.skuId || v.barcode || null;
      // Extract size/color from multiple shapes
      const baseSize = v.size || v.attributeValue || (v.attributes && (v.attributes.size || v.attributes.Size || v.attributes.SIZE)) || v.optionValue || null;
      const baseColor = (v.color || v.colour || v.Color || (v.attributes && (v.attributes.color || v.attributes.Color || v.attributes.COLOUR))) || null;
      const kvs: Array<{ key: string; value: string }> = [];
      const pushKv = (k: any, val: any) => { if (typeof k === 'string' && typeof val === 'string' && k && val) kvs.push({ key: k, value: val }); };
      try {
        if (Array.isArray(v.attributes)) {
          for (const a of v.attributes) pushKv(a?.name || a?.key || a?.k, a?.value || a?.v);
        }
        if (Array.isArray(v.attributeList)) {
          for (const a of v.attributeList) pushKv(a?.name || a?.key, a?.value);
        }
        if (Array.isArray(v.properties)) {
          for (const a of v.properties) pushKv(a?.name || a?.key, a?.value);
        }
        if (typeof v.variantKey === 'string' && (v as any).variantValue) pushKv(v.variantKey, String((v as any).variantValue));
        if (typeof v.specKey === 'string' && (v as any).specValue) pushKv(v.specKey, String((v as any).specValue));
      } catch {}
      function deriveFromText(t?: string): { size?: string; color?: string } {
        const out: { size?: string; color?: string } = {};
        if (!t || typeof t !== 'string') return out;
        const s = t.trim();
        // Forms like "Color: Black; Size: L"
        const mColor = s.match(/(?:color|colour)\s*[:=]\s*([^;|,\/]*)/i);
        if (mColor && mColor[1]) out.color = mColor[1].trim();
        const mSize = s.match(/size\s*[:=]\s*([^;|,\/]*)/i);
        if (mSize && mSize[1]) {
          const parsed = mSize[1].trim();
          out.size = normalizeSingleSize(parsed, { allowNumeric: true }) || parsed;
        }
        // Hyphen or slash separated like "Black-L"
        if (!out.color || !out.size) {
          const parts = s.split(/[\-\/|]+/).map(x => x.trim()).filter(Boolean);
          const sizeTokens = new Set(['XS','S','M','L','XL','XXL','XXXL','2XL','3XL','4XL','5XL','One Size','Free Size']);
          const maybeSize = parts.find(p => sizeTokens.has(p.toUpperCase()) || /^\d{2}$/.test(p));
          const maybeColor = parts.find(p => p && p !== maybeSize);
          if (!out.size && maybeSize) {
            out.size = normalizeSingleSize(maybeSize, { allowNumeric: true }) || maybeSize;
          }
          if (!out.color && maybeColor) out.color = maybeColor;
        }
        return out;
      }
      let derivedSize: string | null = null;
      let derivedColor: string | null = null;
      try {
        // Prefer kv pairs
        for (const kv of kvs) {
          const k = String(kv.key).toLowerCase();
          if (!derivedColor && /(color|colour)/i.test(k) && kv.value) derivedColor = kv.value;
          if (!derivedSize && /size/i.test(k) && kv.value) derivedSize = kv.value;
        }
        if (!derivedColor || !derivedSize) {
          const t = String((v as any).skuName || (v as any).variantName || (v as any).variant || '');
          const got = deriveFromText(t);
          if (!derivedColor && got.color) derivedColor = got.color;
          if (!derivedSize && got.size) derivedSize = got.size;
        }
      } catch {}
      const size = baseSize || derivedSize || null;
      const color = baseColor || derivedColor || null;
      const price = pickNum(
        v.variantSellPrice, v.sellPrice, v.price, v.discountPrice, v.sellPriceUSD, v.usdPrice, v.listedPrice, v.originalPrice,
        (v.priceInfo && (v.priceInfo.sellPrice || v.priceInfo.price)),
        item.sellPrice, item.price
      );
      const stock = pickNum(
        v.inventoryNum, v.stock, v.quantity, v.sellStock, v.availableStock, v.inventory, v.inventoryQuantity, v.stockNum
      );
      // Try to coerce weight (grams) and dimensions (cm) from common CJ fields
      const weightCandidates = [
        v.variantWeight, v.weightGram, v.weight_g, v.weightGrams, v.weight,
        (v.packageWeight || v.packingWeight),
      ];
      let weightGrams: number | undefined = undefined;
      for (const c of weightCandidates) {
        const n = pickNum(c);
        if (typeof n === 'number') {
          // Heuristic: if looks like kilograms (very small number), convert to grams
          weightGrams = n < 30 ? Math.round(n * 1000) : Math.round(n);
          break;
        }
      }
      const lengthCm = pickNum(v.length, v.lengthCm, v.l) as number | undefined;
      const widthCm = pickNum(v.width, v.widthCm, v.w) as number | undefined;
      const heightCm = pickNum(v.height, v.heightCm, v.h) as number | undefined;

      // Extract variantKey (short name like "Black And Silver-2XL" or "Remote control-Boxed")
      const variantKey = v.variantKey || undefined;
      const vid = v.vid || v.variantId || undefined;
      
      // Extract variant name (may contain useful info)
      const variantName = v.variantNameEn || v.variantName || undefined;
      
      // If we don't have size/color but have variantKey, parse it
      // Format can be "Remote control-Boxed", "APP-Opp", "Black-L", etc.
      let finalSize = size;
      let finalColor = color;
      if ((!finalSize || !finalColor) && variantKey && typeof variantKey === 'string') {
        const parts = variantKey.split(/[\-\/]+/).map(p => p.trim()).filter(Boolean);
        if (parts.length >= 2) {
          // Check if any part looks like a size
          const sizeTokens = new Set(['XS','S','M','L','XL','XXL','XXXL','2XL','3XL','4XL','5XL','ONE SIZE','FREE SIZE','BOXED','OPP']);
          const maybeSize = parts.find(p => sizeTokens.has(p.toUpperCase()) || /^\d{2}$/.test(p));
          const maybeColor = parts.find(p => p && p !== maybeSize);
          if (!finalSize && maybeSize) finalSize = normalizeSingleSize(maybeSize, { allowNumeric: true }) || maybeSize;
          if (!finalColor && maybeColor) finalColor = maybeColor;
        }
        // If we only have one part, treat the whole variantKey as color/type
        if (parts.length === 1 && !finalColor) {
          finalColor = parts[0];
        }
      }

      if (finalSize) {
        finalSize = normalizeSingleSize(finalSize, { allowNumeric: true }) || finalSize;
      }

      const variantOptions = extractVariantOptionsFromRawVariant(v);
      if (finalColor) {
        const hasColor = Object.keys(variantOptions).some((name) => /color|colour/i.test(name));
        if (!hasColor) {
          variantOptions.Color = String(finalColor).trim();
        }
      }
      if (finalSize) {
        const hasSize = Object.keys(variantOptions).some((name) => /size/i.test(name));
        if (!hasSize) {
          variantOptions.Size = String(finalSize).trim();
        }
      }
      const optionSignature = buildOptionSignature(variantOptions);
      
      // Extract CJ and Factory stock separately
      const cjStock = pickNum(v.cjStock, v.cjInventory, v.cjAvailableNum);
      const factoryStock = pickNum(v.factoryStock, v.factoryInventory, v.supplierStock, v.factoryAvailableNum);
      
      // Get variant image (CJ uses variantImage field)
      const variantImage = v.variantImage || v.whiteImage || v.image || v.imageUrl || v.imgUrl || undefined;
      
      variants.push({
        cjSku: cjSku || v.variantSku || undefined,
        variantKey,
        variantName,
        vid,
        size: finalSize || undefined,
        color: finalColor || undefined,
        price,
        stock,
        cjStock,
        factoryStock,
        weightGrams,
        lengthCm: typeof lengthCm === 'number' ? lengthCm : undefined,
        widthCm: typeof widthCm === 'number' ? widthCm : undefined,
        heightCm: typeof heightCm === 'number' ? heightCm : undefined,
        imageUrl: (typeof variantImage === 'string' ? variantImage : undefined) as string | undefined,
        variantOptions,
        optionSignature: optionSignature || undefined,
      });

    }
  }

  // If no variants found, create one from product-level data
  // IMPORTANT: Never fabricate stock - use actual CJ data or undefined
  if (variants.length === 0) {
    const productPrice = pickNum(item.sellPrice, item.price, item.salePrice, item.costPrice);
    // Do NOT default to 100 - only use actual CJ stock data
    const productStock = pickNum(item.stock, item.inventory, item.warehouseInventoryNum, item.storageNum);
    const productSku = item.productSku || item.sku || null;
    variants.push({
      cjSku: productSku || undefined,
      price: productPrice,
      stock: typeof productStock === 'number' ? productStock : undefined, // undefined if not provided by CJ
    });
  }

  // Delivery/processing time (hours) if provided
  const deliveryTimeHours = typeof item.deliveryTime === 'number' ? item.deliveryTime : (typeof item.logisticAging === 'number' ? item.logisticAging : null);
  const processingTimeHours = (() => {
    const d = pickNum(item.processingTime, item.handleTime, item.handlingTime, item.processingDays, item.deliveryAging);
    if (typeof d === 'number') {
      // If looks like days (<= 60), convert to hours
      return d <= 60 ? Math.round(d * 24) : Math.round(d);
    }
    return null;
  })();

  const originArea = (item.defaultArea || item.warehouse || item.areaName || null) as string | null;
  const originCountryCode = (item.areaCountryCode || item.countryCode || null) as string | null;

  // Extract rating and review count
  // Check multiple possible field names for supplier/product rating
  const rating = pickNum(
    item.supplierRating, item.supplierScore, item.starCount, item.star_count,
    item.rating, item.productRating, item.score, item.avgScore, item.avgRating, item.averageRating
  ) ?? null;
  const reviewCount = pickNum(
    item.reviewCount,
    item.reviewNum,
    item.review_count,
    item.ratingCount,
    item.rating_count,
    item.reviews,
    item.commentCount,
    item.comment_count,
    item.commentNum,
    item.comment_num,
    item.evaluateCount,
    item.evaluationCount,
    item.evaluateNum,
    item.totalReview,
    item.totalReviews,
    item.totalComment,
    item.totalComments,
    item.total_comment_num
  ) ?? null;
  
  // Also check for nested supplier object
  const supplierName = (item.supplierName || item.supplier?.name || item.vendorName || null) as string | null;
  const supplierRatingFromNested = pickNum(
    item.supplier?.supplierRating,
    item.supplier?.supplierScore,
    item.supplier?.rating,
    item.supplier?.productRating,
    item.supplier?.score,
    item.supplier?.avgScore,
    item.supplier?.avgRating,
    item.supplier?.averageRating,
    item.supplier?.starCount,
    item.supplier?.star_count
  ) ?? null;
  const supplierReviewCountFromNested = pickNum(
    item.supplier?.reviewCount,
    item.supplier?.reviewNum,
    item.supplier?.review_count,
    item.supplier?.ratingCount,
    item.supplier?.rating_count,
    item.supplier?.reviews,
    item.supplier?.commentCount,
    item.supplier?.comment_count,
    item.supplier?.commentNum,
    item.supplier?.comment_num,
    item.supplier?.evaluateCount,
    item.supplier?.evaluationCount,
    item.supplier?.evaluateNum,
    item.supplier?.totalReview,
    item.supplier?.totalReviews,
    item.supplier?.totalComment,
    item.supplier?.totalComments,
    item.supplier?.total_comment_num
  ) ?? null;
  const finalRating = rating ?? supplierRatingFromNested;
  const finalReviewCount = reviewCount ?? supplierReviewCountFromNested;

  // Extract price range (use minimum variant price or product-level price)
  const variantPrices = variants.map(v => v.price).filter((p): p is number => typeof p === 'number' && p > 0);
  const minPrice = variantPrices.length > 0 ? Math.min(...variantPrices) : pickNum(item.sellPrice, item.price) ?? null;

  // Extract category name
  const categoryName = (item.categoryName || item.category || item.categoryPath || null) as string | null;

  // Extract main product SKU
  const sku = (item.productSku || item.sku || item.skuId || null) as string | null;

  // Extract weight (may be range string like "98.00-120.00")
  const weight = (item.productWeight || item.weight || null) as string | null;

  // Extract material and packing (parse JSON arrays if needed)
  const parseSafeArray = (val: any): string[] | null => {
    if (Array.isArray(val)) return val.filter(x => typeof x === 'string');
    if (typeof val === 'string' && val.startsWith('[')) {
      try {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) return parsed.filter(x => typeof x === 'string');
      } catch {}
    }
    return null;
  };
  const materialEn = parseSafeArray(item.materialNameEnSet || item.materialNameEn) ?? null;
  const packingEn = parseSafeArray(item.packingNameEnSet || item.packingNameEn) ?? null;

  const availableOptions = deriveAvailableOptionsFromVariants(variants, {
    includeOutOfStockDimensions: false,
  });
  const legacy = deriveLegacyOptionArrays(availableOptions);
  const availableColors = legacy.availableColors.length > 0 ? legacy.availableColors : null;
  const availableSizes = legacy.availableSizes.length > 0 ? legacy.availableSizes : null;
  const availableModels = legacy.availableModels.length > 0 ? legacy.availableModels : null;

  return {
    productId,
    name,
    images: filteredImages,
    videoUrl: deliverableVideoUrl,
    videoSourceUrl: videoDelivery.sourceUrl || null,
    video4kUrl: deliverableVideoUrl,
    videoDeliveryMode: videoDelivery.mode,
    videoQualityGatePassed: videoDelivery.qualityGatePassed,
    videoSourceQualityHint: videoDelivery.sourceQualityHint,
    variants,
    deliveryTimeHours,
    processingTimeHours,
    originArea,
    originCountryCode,
    // New fields for better product display
    rating: finalRating,  // Uses supplier rating if available
    reviewCount: finalReviewCount,
    supplierName,  // Supplier name from CJ API
    price: minPrice,
    categoryName,
    sku,
    weight,
    materialEn,
    packingEn,
    availableOptions,
    availableColors,
    availableSizes,
    availableModels,
  };
}

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getAccessToken, freightCalculate, fetchProductDetailsBatch, findCheapestConfiguredShippingOption, getInventoryByPid, queryVariantInventory, getProductVariants, fetchProductDetailsByPid } from '@/lib/cj/v2';
import { ensureAdmin } from '@/lib/auth/admin-guard';
import { fetchJson } from '@/lib/http';
import { loggerForRequest } from '@/lib/log';
import { enhanceProductImageUrl } from '@/lib/media/image-quality';
import { usdToSar, sarToUsd, computeRetailFromLanded } from '@/lib/pricing';
import { computeRating, normalizeDisplayedRating } from '@/lib/rating/engine';
import { buildSyntheticReviewProfile } from '@/lib/reviews/synthetic-feedback';
import { dedupeLabelsCaseInsensitive, extractCanonicalSize, normalizeCjProductId, normalizeSizeList } from '@/lib/import/normalization';
import { extractCjProductGalleryImages, normalizeCjImageKey, prioritizeCjHeroImage } from '@/lib/cj/image-gallery';
import { extractCjProductVideoCandidates, inferCjVideoQualityHint } from '@/lib/cj/video';
import { build4kVideoDelivery } from '@/lib/video/delivery';
import {
  buildOptionSignature,
  deriveAvailableOptionsFromVariants,
  deriveLegacyOptionArrays,
  extractVariantOptionsFromRawVariant,
} from '@/lib/variants/dynamic-options';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

type ShippingOption = {
  name: string;
  code: string;
  priceUSD: number;
  deliveryDays: string;
};

type PricedVariant = {
  variantId: string;
  variantSku: string;
  variantPriceUSD: number;
  shippingAvailable: boolean;
  shippingPriceUSD: number;
  shippingPriceSAR: number;
  deliveryDays: string;
  logisticName?: string;
  sellPriceSAR: number;
  sellPriceUSD?: number;
  totalCostSAR: number;
  totalCostUSD?: number;
  profitSAR: number;
  profitUSD?: number;
  marginPercent?: number;
  error?: string;
  stock?: number;
  cjStock?: number;          // CJ warehouse stock (verified)
  factoryStock?: number;     // Factory/supplier stock (unverified)
  variantName?: string;
  variantImage?: string;
  size?: string;
  color?: string;
  variantOptions?: Record<string, string>;
  optionSignature?: string;
  allShippingOptions?: ShippingOption[];
};

type WarehouseStock = {
  areaId: number;
  areaName: string;
  countryCode: string;
  totalInventory: number;
  cjInventory: number;
  factoryInventory: number;
};

type ProductInventory = {
  totalCJ: number;
  totalFactory: number;
  totalAvailable: number;
  warehouses: WarehouseStock[];
};

type InventoryVariant = {
  variantId: string;
  sku: string;
  shortName: string;
  priceUSD: number;
  cjStock: number;
  factoryStock: number;
  totalStock: number;
};

type PricedProduct = {
  pid: string;
  cjSku: string;
  name: string;
  images: string[];
  minPriceSAR: number;
  maxPriceSAR: number;
  avgPriceSAR: number;
  minPriceUSD?: number;
  maxPriceUSD?: number;
  avgPriceUSD?: number;
  profitMarginApplied?: number;
  stock: number;
  listedNum: number;
  // Inventory breakdown from CJ's dedicated inventory API
  totalVerifiedInventory?: number;    // CJ warehouse stock (verified)
  totalUnVerifiedInventory?: number;  // Factory/supplier stock (unverified)
  // Full warehouse inventory object for detailed display
  inventory?: ProductInventory;
  // Inventory status: 'ok' = successfully fetched, 'error' = failed to fetch, 'partial' = some data missing
  inventoryStatus?: 'ok' | 'error' | 'partial';
  inventoryErrorMessage?: string;
  variants: PricedVariant[];
  inventoryVariants?: InventoryVariant[];
  successfulVariants: number;
  totalVariants: number;
  description?: string;
  overview?: string;
  productInfo?: string;
  sizeInfo?: string;
  productNote?: string;
  packingList?: string;
  displayedRating?: number;
  ratingConfidence?: number;
  // Legacy fields kept for compatibility with any untouched callers.
  rating?: number;
  reviewCount?: number;
  supplierName?: string;
  itemAsDescribed?: number;
  serviceRating?: number;
  shippingSpeedRating?: number;
  categoryName?: string;
  productWeight?: number;
  packLength?: number;
  packWidth?: number;
  packHeight?: number;
  material?: string;
  productType?: string;
  sizeChartImages?: string[];
  processingTimeHours?: number;
  deliveryTimeHours?: number;
  estimatedProcessingDays?: string;
  estimatedDeliveryDays?: string;
  originCountry?: string;
  hsCode?: string;
  videoUrl?: string;
  videoSourceUrl?: string;
  video4kUrl?: string;
  videoDeliveryMode?: 'native' | 'enhanced' | 'passthrough';
  videoQualityGatePassed?: boolean;
  videoSourceQualityHint?: '4k' | 'hd' | 'sd' | 'unknown';
  availableOptions?: Array<{
    name: string;
    values: string[];
    inStockValues: string[];
    source?: string;
  }>;
  availableSizes?: string[];
  availableColors?: string[];
  availableModels?: string[];
  colorImageMap?: Record<string, string>;
};

async function appendCjProductIdsFromTable(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  tableName: 'product_queue' | 'products',
  target: Set<string>
): Promise<void> {
  if (!supabase) return;

  const pageSize = 1000;
  let offset = 0;

  for (let page = 0; page < 200; page++) {
    const { data, error } = await supabase
      .from(tableName)
      .select('cj_product_id')
      .not('cj_product_id', 'is', null)
      .order('cj_product_id', { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) {
      console.warn(`[Search&Price] Could not load existing CJ IDs from ${tableName}: ${error.message}`);
      break;
    }

    const rows = Array.isArray(data) ? data : [];
    for (const row of rows) {
      const normalized = normalizeCjProductId((row as any)?.cj_product_id);
      if (normalized) target.add(normalized);
    }

    if (rows.length < pageSize) break;
    offset += pageSize;
  }
}

async function loadExcludedCjProductIds(): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return new Set<string>();

  const excluded = new Set<string>();
  await appendCjProductIdsFromTable(supabase, 'product_queue', excluded);
  await appendCjProductIdsFromTable(supabase, 'products', excluded);
  return excluded;
}

type DiscoverMediaMode = 'any' | 'withVideo' | 'imagesOnly' | 'both';

function parseDiscoverMediaMode(value: string | null): DiscoverMediaMode {
  const normalized = String(value || '').trim();
  if (normalized === 'withVideo' || normalized === 'imagesOnly' || normalized === 'both') {
    return normalized;
  }
  return 'any';
}

const SUPPLIER_RATING_KEYS = [
  'rating',
  'productRating',
  'score',
  'avgScore',
  'avgRating',
  'averageRating',
  'supplierRating',
  'supplierScore',
  'starCount',
  'star_count',
];

const SUPPLIER_REVIEW_COUNT_KEYS = [
  'reviewCount',
  'reviewNum',
  'review_count',
  'ratingCount',
  'rating_count',
  'reviews',
  'commentCount',
  'comment_count',
  'evaluateCount',
  'evaluationCount',
  'evaluateNum',
  'totalReview',
  'totalReviews',
  'totalComment',
  'totalComments',
  'total_comment_num',
  'commentNum',
  'comment_num',
];

function pickFiniteNumber(source: any, keys: string[]): number | undefined {
  if (!source || typeof source !== 'object') return undefined;

  for (const key of keys) {
    const raw = source?.[key];
    if (raw === undefined || raw === null || raw === '') continue;

    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw;
    }

    if (typeof raw === 'string') {
      const cleaned = raw.replace(/,/g, '').trim();
      if (!cleaned) continue;

      const parsed = Number(cleaned);
      if (Number.isFinite(parsed)) {
        return parsed;
      }

      const match = cleaned.match(/-?\d+(?:\.\d+)?/);
      if (match) {
        const extracted = Number(match[0]);
        if (Number.isFinite(extracted)) {
          return extracted;
        }
      }
    }
  }

  return undefined;
}

function extractSupplierReviewMetrics(
  primary: any,
  fallback?: any
): { rating?: number; reviewCount: number; source: 'primary' | 'fallback' | 'none' } {
  const candidates: Array<{ label: 'primary' | 'fallback'; value: any }> = [
    { label: 'primary', value: primary },
    { label: 'fallback', value: fallback },
  ];

  let rating: number | undefined;
  let reviewCount = 0;
  let source: 'primary' | 'fallback' | 'none' = 'none';

  for (const candidate of candidates) {
    if (!candidate.value || typeof candidate.value !== 'object') continue;

    const directRating = pickFiniteNumber(candidate.value, SUPPLIER_RATING_KEYS);
    const nestedRating = candidate.value?.supplier && typeof candidate.value.supplier === 'object'
      ? pickFiniteNumber(candidate.value.supplier, SUPPLIER_RATING_KEYS)
      : undefined;
    const parsedRating = directRating ?? nestedRating;

    if (
      rating === undefined &&
      typeof parsedRating === 'number' &&
      Number.isFinite(parsedRating) &&
      parsedRating > 0 &&
      parsedRating <= 5
    ) {
      rating = parsedRating;
      source = candidate.label;
    }

    const directReviewCount = pickFiniteNumber(candidate.value, SUPPLIER_REVIEW_COUNT_KEYS);
    const nestedReviewCount = candidate.value?.supplier && typeof candidate.value.supplier === 'object'
      ? pickFiniteNumber(candidate.value.supplier, SUPPLIER_REVIEW_COUNT_KEYS)
      : undefined;
    const parsedReviewCount = directReviewCount ?? nestedReviewCount;

    if (
      reviewCount === 0 &&
      typeof parsedReviewCount === 'number' &&
      Number.isFinite(parsedReviewCount) &&
      parsedReviewCount > 0
    ) {
      reviewCount = Math.floor(parsedReviewCount);
      if (source === 'none') source = candidate.label;
    }

    if (rating !== undefined && reviewCount > 0) {
      break;
    }
  }

  return { rating, reviewCount, source };
}

function hasDiscoverVideo(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasDiscoverImages(images: unknown): boolean {
  return Array.isArray(images) && images.length > 0;
}

function matchesDiscoverMediaMode(mode: DiscoverMediaMode, hasVideo: boolean, hasImages: boolean): boolean {
  if (mode === 'withVideo') return hasVideo;
  if (mode === 'imagesOnly') return hasImages && !hasVideo;
  if (mode === 'both') return hasImages && hasVideo;
  return true;
}

function scoreMergedImageCandidate(url: string, index: number): number {
  const lower = String(url || '').toLowerCase();
  let score = 50 - Math.min(15, index * 0.35);

  if (/(\/original\/|\/big\/|\/large\/|highres|master)/i.test(lower)) score += 18;
  if (/(?:^|[^\d])(4096|3840|3200|2560|2048|1920|1600|1500|1440|1280|1200|1080|1000|900|800)x(?:4096|3840|3200|2560|2048|1920|1600|1500|1440|1280|1200|1080|1000|900|800)(?:[^\d]|$)/i.test(lower)) score += 16;
  if (/_3200|_2560|_2048|_1920|_1600|_1500|_1400|_1200|_1080|_1000|_900|_800|3200x|2560x|2048x|1920x|1600x|1500x|1400x|1200x|1080x|1000x|900x|800x/i.test(lower)) score += 14;
  if (/(thumb|thumbnail|tiny|mini)/i.test(lower)) score -= 30;

  const querySizes = Array.from(lower.matchAll(/[?&](?:w|width|h|height)=(\d{2,5})/gi))
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  if (querySizes.length > 0) {
    const maxQuerySize = Math.max(...querySizes);
    if (maxQuerySize >= 1800) score += 8;
    else if (maxQuerySize < 500) score -= 24;
  }

  return score;
}

async function fetchCjProductPage(
  token: string, 
  base: string, 
  categoryId: string | null,
  pageNum: number
): Promise<{ list: any[]; total: number }> {
  // Use /product/list for category filtering (stable and reliable)
  const params = new URLSearchParams();
  params.set('pageNum', String(pageNum));
  
  if (categoryId && categoryId !== 'all' && !categoryId.startsWith('first-') && !categoryId.startsWith('second-')) {
    params.set('categoryId', categoryId);
  }
  
  const url = `${base}/product/list?${params}`;
  console.log(`[Search&Price] Fetching product/list: ${url}`);
  
  try {
    const res = await fetchJson<any>(url, {
      headers: {
        'CJ-Access-Token': token,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      timeoutMs: 30000,
    });
    
    const list = res?.data?.list || [];
    const total = res?.data?.total || 0;
    console.log(`[Search&Price] Page ${pageNum} returned ${list.length} items (total: ${total})`);
    
    return { list, total };
  } catch (e: any) {
    console.error(`[Search&Price] Fetch error:`, e?.message);
    return { list: [], total: 0 };
  }
}

// Fetch inventory data from listV2 by PID keyword search
async function enrichWithListV2Inventory(
  token: string,
  base: string, 
  pid: string
): Promise<{ warehouseInventoryNum?: number; listedNum?: number; totalVerifiedInventory?: number; totalUnVerifiedInventory?: number } | null> {
  try {
    const url = `${base}/product/listV2?keyWord=${encodeURIComponent(pid)}&page=1&size=5&features=enable_description`;
    const res = await fetchJson<any>(url, {
      headers: {
        'CJ-Access-Token': token,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      timeoutMs: 10000,
    });
    
    // Extract product list from response
    const data = res?.data;
    let productList: any[] = [];
    if (Array.isArray(data)) {
      productList = data;
    } else if (data?.list) {
      productList = data.list;
    } else if (data?.products) {
      productList = data.products;
    }
    
    // Find matching product by PID
    const match = productList.find((p: any) => p.id === pid || p.pid === pid);
    if (match) {
      return {
        warehouseInventoryNum: Number(match.warehouseInventoryNum || 0),
        listedNum: Number(match.listedNum || 0),
        totalVerifiedInventory: Number(match.totalVerifiedInventory || 0),
        totalUnVerifiedInventory: Number(match.totalUnVerifiedInventory || 0),
      };
    }
    return null;
  } catch (e: any) {
    console.log(`[Search&Price] listV2 enrichment failed for ${pid}:`, e?.message);
    return null;
  }
}

async function getVariantsForProduct(token: string, base: string, pid: string): Promise<any[]> {
  // Delegate to shared cached helper; keep logging semantics
  try {
    const variants = await getProductVariants(pid);
    if (variants.length > 0) {
      const sample = variants[0];
      const keys = Object.keys(sample);
      const imageKeys = keys.filter(k => /image|img|photo|pic/i.test(k));
      console.log(`[Variants] Product ${pid}: ${variants.length} variants`);
      console.log(`[Variants] ALL fields: [${keys.join(', ')}]`);
      console.log(`[Variants] Image fields: [${imageKeys.join(', ')}]`);
      for (const k of imageKeys) {
        const val = (sample as any)[k];
        if (val) {
          console.log(`[Variants] ${k} = ${typeof val === 'string' ? val.slice(0, 100) : JSON.stringify(val).slice(0, 100)}`);
        }
      }
      console.log(`[Variants] vid = ${sample.vid || 'NOT_FOUND'}`);
      console.log(`[Variants] variantSku = ${sample.variantSku || 'NOT_FOUND'}`);
      if ((sample as any).variantKey) console.log(`[Variants] variantKey = ${(sample as any).variantKey}`);
      if ((sample as any).variantNameEn) console.log(`[Variants] variantNameEn = ${(sample as any).variantNameEn}`);
    }
    return variants;
  } catch (e: any) {
    console.log(`[Variants] Error for ${pid}:`, e?.message);
    return [];
  }
}

function calculateSellPriceWithMargin(landedCostSAR: number, profitMarginPercent: number): number {
  const margin = profitMarginPercent / 100;
  return computeRetailFromLanded(landedCostSAR, { margin });
}

function normalizeVariantColorToken(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveColorImageFromMap(
  color: string | undefined,
  colorImageMap: Record<string, string>,
  fallback?: string
): string | undefined {
  const normalizedFallback =
    typeof fallback === 'string' && fallback.startsWith('http')
      ? enhanceProductImageUrl(fallback.trim(), 'gallery')
      : fallback;

  if (typeof normalizedFallback === 'string' && normalizedFallback.startsWith('http')) return normalizedFallback;
  if (!color || !colorImageMap || Object.keys(colorImageMap).length === 0) return normalizedFallback;

  const exact = colorImageMap[color];
  if (typeof exact === 'string' && exact.startsWith('http')) {
    return enhanceProductImageUrl(exact.trim(), 'gallery');
  }

  const target = normalizeVariantColorToken(color);
  if (!target) return normalizedFallback;

  for (const [mapColor, imageUrl] of Object.entries(colorImageMap)) {
    if (typeof imageUrl !== 'string' || !imageUrl.startsWith('http')) continue;
    const key = normalizeVariantColorToken(mapColor);
    if (!key) continue;
    if (key === target || key.includes(target) || target.includes(key)) {
      return enhanceProductImageUrl(imageUrl.trim(), 'gallery');
    }
  }

  return normalizedFallback;
}

function extractVariantColorSize(variant: any, fallbackName?: string): { color?: string; size?: string } {
  let size = variant?.size || variant?.sizeNameEn || variant?.sizeName || undefined;
  let color = variant?.color || variant?.colour || variant?.colorNameEn || variant?.colorName || undefined;

  const normalizedExplicitSize = extractCanonicalSize(size);
  if (normalizedExplicitSize) size = normalizedExplicitSize;

  const variantKeyRaw = String(
    variant?.variantKey || variant?.variantNameEn || variant?.variantName || fallbackName || ''
  ).replace(/[\u4e00-\u9fff]/g, '').trim();

  if ((!color || !size) && variantKeyRaw.includes('-')) {
    const parts = variantKeyRaw.split('-').map((p: string) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const lastPart = parts[parts.length - 1];
      const firstPart = parts.slice(0, -1).join('-').trim();
      const normalizedFromKey = extractCanonicalSize(lastPart);
      if (normalizedFromKey) {
        if (!size) size = normalizedFromKey;
        if (!color) color = firstPart;
      } else if (!color) {
        color = variantKeyRaw;
      }
    }
  }

  if (!color && !size && variantKeyRaw) {
    color = variantKeyRaw;
  }

  const normalizedFinalSize = extractCanonicalSize(size);

  return {
    color: typeof color === 'string' && color.trim() ? color.trim() : undefined,
    size: normalizedFinalSize || undefined,
  };
}

function extractAllImages(item: any): string[] {
  return extractCjProductGalleryImages(item, 50);
}

type VideoExtractionSource = 'details' | 'list' | 'none';

type ExtractedVideoDiagnostics = {
  videoUrl?: string;
  videoDetected: boolean;
  videoSource: VideoExtractionSource;
  videoQualityHint: '4k' | 'hd' | 'sd' | 'unknown';
  candidatesChecked: number;
};

function extractBestVideo(primary: any, fallback?: any): ExtractedVideoDiagnostics {
  const primaryCandidates = extractCjProductVideoCandidates(primary, 12);
  if (primaryCandidates.length > 0) {
    const top = primaryCandidates[0];
    return {
      videoUrl: top,
      videoDetected: true,
      videoSource: 'details',
      videoQualityHint: inferCjVideoQualityHint(top),
      candidatesChecked: primaryCandidates.length,
    };
  }

  const fallbackCandidates = fallback ? extractCjProductVideoCandidates(fallback, 12) : [];
  if (fallbackCandidates.length > 0) {
    const top = fallbackCandidates[0];
    return {
      videoUrl: top,
      videoDetected: true,
      videoSource: 'list',
      videoQualityHint: inferCjVideoQualityHint(top),
      candidatesChecked: fallbackCandidates.length,
    };
  }

  return {
    videoUrl: undefined,
    videoDetected: false,
    videoSource: 'none',
    videoQualityHint: 'unknown',
    candidatesChecked: 0,
  };
}

// Support both GET (legacy) and POST (batch mode with large seenPids)
export async function POST(req: Request) {
  return handleSearch(req, true);
}

export async function GET(req: Request) {
  return handleSearch(req, false);
}

async function handleSearch(req: Request, isPost: boolean) {
  const log = loggerForRequest(req);
  try {
    const guard = await ensureAdmin();
    if (!guard.ok) {
      const r = NextResponse.json(
        { ok: false, error: guard.reason }, 
        { status: 401, headers: { 'Cache-Control': 'no-store' } }
      );
      r.headers.set('x-request-id', log.requestId);
      return r;
    }
    
    const { searchParams } = new URL(req.url);
    
    // For POST requests, parse body to get seenPids (can be large)
    let bodyData: any = {};
    if (isPost) {
      try {
        bodyData = await req.json();
      } catch {
        bodyData = {};
      }
    }
    
    const categoryIdsParam = searchParams.get('categoryIds') || 'all';
    const categoryIds = categoryIdsParam.split(',').filter(Boolean);
    const quantity = Math.max(1, Math.min(5000, Number(searchParams.get('quantity') || 50)));
    const minPrice = Number(searchParams.get('minPrice') || 0);
    const maxPrice = Number(searchParams.get('maxPrice') || 1000);
    const minStock = Number(searchParams.get('minStock') || 0);
    const profitMargin = Math.max(1, Number(searchParams.get('profitMargin') || 8));
    const popularity = searchParams.get('popularity') || 'any';
    const minRating = searchParams.get('minRating') || 'any';
    const freeShippingOnly = searchParams.get('freeShippingOnly') === '1';
    const shippingMethod = searchParams.get('shippingMethod') || 'any';
    const sizesParam = searchParams.get('sizes') || '';
    const mediaMode = parseDiscoverMediaMode(searchParams.get('mediaMode'));
    const modeParam = (searchParams.get('mode') || '').toLowerCase();
    const smartDiscoverEnabled = (process.env.SMART_DISCOVER || '') === '1';
    const fastMode = smartDiscoverEnabled && (modeParam === 'fast' || modeParam === 'lite' || modeParam === '1');
    
    // Batching parameters for Vercel timeout handling
    // batchSize: max products to fully process per request (default 3 for safe margin)
    // Cursor-based pagination: {categoryIndex, pageNum, itemOffset}
    const batchSize = Math.max(1, Math.min(10, Number(searchParams.get('batchSize') || 3)));
    const isBatchMode = searchParams.get('batchMode') === '1';
    
    // Cursor for resumable pagination: categoryIndex.pageNum.itemOffset
    // Example: "0.1.5" means category index 0, page 1, item offset 5
    const cursorParam = searchParams.get('cursor') || '0.1.0';
    const [cursorCatIdx, cursorPageNum, cursorItemOffset] = cursorParam.split('.').map(n => parseInt(n, 10) || 0);
    
    // remainingNeeded: how many more products the client needs (for exact quantity control)
    // If not provided, defaults to quantity (full request)
    // Allow 0 to short-circuit when client is already satisfied
    const remainingNeeded = Math.max(0, Number(searchParams.get('remainingNeeded') || quantity));
    
    // seenPids: already-processed product IDs from previous batches
    // For POST, get from body (supports large lists); for GET, get from query (limited)
    const seenPidsArray: string[] = isPost && bodyData.seenPids 
      ? bodyData.seenPids 
      : (searchParams.get('seenPids') || '').split(',').filter(Boolean);
    const seenPidsFromClient = new Set(
      seenPidsArray
        .map((value) => normalizeCjProductId(value))
        .filter(Boolean)
    );
    
    // Short-circuit when client already has enough products
    if (isBatchMode && remainingNeeded === 0) {
      console.log(`[Search&Price] remainingNeeded=0, returning empty batch`);
      const r = NextResponse.json({
        ok: true,
        products: [],
        count: 0,
        requestedQuantity: quantity,
        quantityFulfilled: true,
        mediaMode,
        duration: 0, // No processing time spent
        batch: {
          hasMore: false,
          cursor: cursorParam,
          attemptedPids: [],
          processedPids: [],
          totalCandidates: 0,
          productsThisBatch: 0,
          batchSize,
        }
      }, { headers: { 'Cache-Control': 'no-store' } });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }
    
    const requestedSizes = sizesParam
      ? Array.from(
          new Set(
            sizesParam
              .split(',')
              .map((s) => extractCanonicalSize(s))
              .filter((s): s is string => !!s)
          )
        )
      : [];

    const queueExcludedPids = new Set<string>();
    const storeExcludedPids = new Set<string>();
    try {
      const supabaseAdmin = getSupabaseAdmin();
      if (supabaseAdmin) {
        const [queueRowsRes, storeRowsRes] = await Promise.all([
          supabaseAdmin.from('product_queue').select('cj_product_id').not('cj_product_id', 'is', null),
          supabaseAdmin.from('products').select('cj_product_id').not('cj_product_id', 'is', null),
        ]);

        if (queueRowsRes.error) {
          console.error('[Search&Price] Failed to load queue exclusions:', queueRowsRes.error);
        } else {
          for (const row of queueRowsRes.data || []) {
            const pid = normalizeCjProductId((row as any)?.cj_product_id);
            if (pid) queueExcludedPids.add(pid);
          }
        }

        if (storeRowsRes.error) {
          console.error('[Search&Price] Failed to load store exclusions:', storeRowsRes.error);
        } else {
          for (const row of storeRowsRes.data || []) {
            const pid = normalizeCjProductId((row as any)?.cj_product_id);
            if (pid) storeExcludedPids.add(pid);
          }
        }
      }
    } catch (e: any) {
      console.error('[Search&Price] Failed to build exclusion sets:', e?.message || e);
    }
    const excludedPids = new Set<string>([...queueExcludedPids, ...storeExcludedPids]);

    console.log(`[Search&Price] ========================================`);
    console.log(`[Search&Price] Starting search with params:`);
    console.log(`[Search&Price]   categories: ${categoryIds.join(',')}`);
    console.log(`[Search&Price]   quantity: ${quantity}`);
    console.log(`[Search&Price]   price range: $${minPrice} - $${maxPrice}`);
    console.log(`[Search&Price]   minStock: ${minStock}`);
    console.log(`[Search&Price]   popularity: ${popularity}`);
    console.log(`[Search&Price]   minRating: ${minRating}`);
    console.log(`[Search&Price]   profitMargin: ${profitMargin}%`);
    console.log(`[Search&Price]   shippingMethod: ${shippingMethod}`);
    console.log(`[Search&Price]   sizes filter: ${requestedSizes.length > 0 ? requestedSizes.join(',') : 'none'}`);
    console.log(`[Search&Price]   mediaMode: ${mediaMode}`);
    console.log(`[Search&Price]   batchMode: ${isBatchMode}, batchSize: ${batchSize}`);
    console.log(`[Search&Price]   cursor: ${cursorParam} (cat=${cursorCatIdx}, page=${cursorPageNum}, offset=${cursorItemOffset})`);
    console.log(`[Search&Price]   seenPids: ${seenPidsFromClient.size} already processed`);
    console.log(`[Search&Price]   excluded queue/store/total: ${queueExcludedPids.size}/${storeExcludedPids.size}/${excludedPids.size}`);
    console.log(`[Search&Price] ========================================`);

    const token = await getAccessToken();
    if (!token) {
      console.error('[Search&Price] Failed to get access token');
      return NextResponse.json(
        { ok: false, error: 'Failed to authenticate with CJ API' },
        { status: 500, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    
    const base = process.env.CJ_API_BASE || 'https://developers.cjdropshipping.com/api2.0/v1';
    const excludedCjProductIds = await loadExcludedCjProductIds();
    console.log(`[Search&Price]   excluded existing queue/store products: ${excludedCjProductIds.size}`);
    
    const candidateProducts: any[] = [];
    const seenPids = new Set<string>();
    const startTime = Date.now();
    let skippedByQueueExclusion = 0;
    let skippedByStoreExclusion = 0;
    const mediaFilterStats = {
      mode: mediaMode,
      checked: 0,
      passed: 0,
      filteredOut: 0,
      missingVideo: 0,
      missingImages: 0,
      missingVideoAfterExtraction: 0,
      skippedMissingVideoPids: [] as string[],
      videoSource: {
        details: 0,
        list: 0,
        none: 0,
      },
      videoQualityHints: {
        '4k': 0,
        hd: 0,
        sd: 0,
        unknown: 0,
      },
      videoDeliveryModes: {
        native: 0,
        enhanced: 0,
        passthrough: 0,
      },
      videoQualityGate: {
        passed: 0,
        failed: 0,
      },
    };
    // In batch mode: 8 seconds max (Vercel has 10s limit, need buffer)
    // In non-batch mode: 5 minutes for legacy compatibility
    const maxDurationMs = isBatchMode ? 8000 : 300000;
    
    let totalFiltered = { price: 0, stock: 0, popularity: 0, rating: 0, existing: 0 };
    
    // For batch mode, use cursor-based pagination to resume from exact position
    // This avoids re-fetching pages that were already processed in previous batches
    // seenPidsFromClient is used as backup deduplication
    const mediaCandidateMultiplier = mediaMode === 'withVideo' || mediaMode === 'both'
      ? 12
      : mediaMode === 'imagesOnly'
        ? 6
        : 3;
    const neededCandidates = isBatchMode 
      ? batchSize * mediaCandidateMultiplier
      : quantity * mediaCandidateMultiplier;
    
    // Track ALL PIDs attempted in this batch (for returning to client)
    const attemptedPidsThisBatch: string[] = [];
    
    // Track current position for cursor (for next batch)
    let currentCatIdx = isBatchMode ? cursorCatIdx : 0;
    let currentPage = isBatchMode ? cursorPageNum : 1;
    let currentItemOffset = isBatchMode ? cursorItemOffset : 0;
    let exhaustedAllPages = false;
    
    // Start from cursor position (for batch mode) or from beginning (for non-batch)
    for (let catIdx = currentCatIdx; catIdx < categoryIds.length; catIdx++) {
      const catId = categoryIds[catIdx];
      if (candidateProducts.length >= neededCandidates) break;
      if (Date.now() - startTime > maxDurationMs) {
        console.log(`[Search&Price] Timeout reached during candidate collection`);
        break;
      }
      
      // For first category, start from cursor page; for subsequent categories, start from page 1
      const startPage = (catIdx === cursorCatIdx && isBatchMode) ? cursorPageNum : 1;
      console.log(`[Search&Price] Searching category: ${catId}, starting from page ${startPage}`);
      
      const maxPages = 100; // Increased for large quantity requests
      
      for (let page = startPage; page <= maxPages; page++) {
        if (Date.now() - startTime > maxDurationMs) break;
        if (candidateProducts.length >= neededCandidates) break;
        
        const pageResult = await fetchCjProductPage(token, base, catId, page);
        
        if (pageResult.list.length === 0) {
          console.log(`[Search&Price] No more products at page ${page} in category ${catId}`);
          // Advance cursor to next category (if any)
          if (catIdx < categoryIds.length - 1) {
            currentCatIdx = catIdx + 1;
            currentPage = 1;
            currentItemOffset = 0;
          } else {
            exhaustedAllPages = true;
          }
          break;
        }
        
        // For the cursor's exact page, skip items before the offset
        const startOffset = (catIdx === cursorCatIdx && page === cursorPageNum && isBatchMode) ? cursorItemOffset : 0;
        
        for (let itemIdx = startOffset; itemIdx < pageResult.list.length; itemIdx++) {
          // ALWAYS update cursor position, even for skipped items
          // This ensures we don't revisit the same items in the next batch
          currentCatIdx = catIdx;
          currentPage = page;
          currentItemOffset = itemIdx + 1; // Next item to process
          
          const item = pageResult.list[itemIdx];
          const pid = String(item.pid || item.productId || '');
          const normalizedPid = normalizeCjProductId(pid);
          if (!normalizedPid || seenPids.has(normalizedPid)) continue;
          
          // Skip PIDs already processed by previous batches (backup deduplication)
          if (isBatchMode && seenPidsFromClient.has(normalizedPid)) continue;

          // Exclude products already added to queue and/or store.
          if (excludedCjProductIds.has(normalizedPid)) {
            if (queueExcludedPids.has(normalizedPid)) skippedByQueueExclusion++;
            if (storeExcludedPids.has(normalizedPid)) skippedByStoreExclusion++;
            totalFiltered.existing++;
            continue;
          }
          
          seenPids.add(normalizedPid);
          attemptedPidsThisBatch.push(pid); // Track for returning to client
          
          const sellPrice = Number(item.sellPrice || item.price || 0);
          if (sellPrice < minPrice || sellPrice > maxPrice) {
            totalFiltered.price++;
            continue;
          }
          
          candidateProducts.push(item);
          
          if (candidateProducts.length >= neededCandidates) break;
        }
      }
    }
    
    console.log(`[Search&Price] ----------------------------------------`);
    console.log(`[Search&Price] Search complete:`);
    console.log(`[Search&Price]   Total candidates: ${candidateProducts.length}`);
    console.log(`[Search&Price]   Filtered by price: ${totalFiltered.price}`);
    console.log(`[Search&Price]   Filtered by stock: ${totalFiltered.stock}`);
    console.log(`[Search&Price]   Filtered by popularity: ${totalFiltered.popularity}`);
    console.log(`[Search&Price]   Filtered by rating: ${totalFiltered.rating}`);
    console.log(`[Search&Price]   Filtered as existing (queue/store): ${totalFiltered.existing}`);
    console.log(`[Search&Price]   Excluded by queue/store: ${skippedByQueueExclusion}/${skippedByStoreExclusion}`);
    console.log(`[Search&Price] ----------------------------------------`);
    
    if (candidateProducts.length === 0) {
      console.log(`[Search&Price] No candidates found! Returning empty result.`);
      const r = NextResponse.json({
        ok: true,
        products: [],
        count: 0,
        mediaMode,
        duration: Date.now() - startTime,
        debug: {
          categoriesSearched: categoryIds,
          totalSeen: seenPids.size,
          filtered: totalFiltered,
          exclusion: {
            excludedByQueue: queueExcludedPids.size,
            excludedByStore: storeExcludedPids.size,
            excludedTotal: excludedPids.size,
            skippedByQueue: skippedByQueueExclusion,
            skippedByStore: skippedByStoreExclusion,
          },
          mediaFilter: mediaFilterStats,
        }
      }, { headers: { 'Cache-Control': 'no-store' } });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }
    
    const targetProducts = isBatchMode ? remainingNeeded : quantity;

    // Fast mode: return LiteProduct[] without per-product details/variants/inventory/freight
    // Gated by SMART_DISCOVER and explicit mode param; preserves response envelope
    if (fastMode) {
      const liteProducts: PricedProduct[] = [];
      for (const item of candidateProducts) {
        if (liteProducts.length >= targetProducts) break;
        const pid = String(item.pid || item.productId || '');
        if (!pid) continue;
        const cjSku = String(item.productSku || item.sku || `CJ-${pid}`);
        const name = String(item.productNameEn || item.name || item.productName || '');
        let images = extractAllImages(item);
        if ((!images || images.length === 0) && typeof item.bigImage === 'string') images = [item.bigImage];
        if ((!images || images.length === 0) && typeof item.whiteImage === 'string') images = [item.whiteImage];
        const videoDiag = extractBestVideo(item);
        const videoDelivery = build4kVideoDelivery(videoDiag.videoUrl);
        const videoUrl = videoDelivery.deliveryUrl || undefined;
        const listedNum = Number(item.listedNum || 0);
        const stockApprox = Number(item.warehouseInventoryNum || item.totalVerifiedInventory || 0);
        const priceUsd = Number(item.sellPrice || item.price || 0);
        const minPriceUSD = Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : undefined;
        const maxPriceUSD = minPriceUSD;
        const minPriceSAR = minPriceUSD ? usdToSar(minPriceUSD) : 0;
        const maxPriceSAR = maxPriceUSD ? usdToSar(maxPriceUSD) : 0;
        const avgPriceSAR = (minPriceSAR && maxPriceSAR)
          ? (minPriceSAR + maxPriceSAR) / 2
          : (minPriceSAR || maxPriceSAR || 0);
        const displayedRating = Number(item.rating || item.avgRating || item.score || 0) || undefined;
        const reviewCount = Number(item.reviewCount || item.commentCount || 0) || undefined;

        liteProducts.push({
          pid,
          cjSku,
          name,
          images: Array.isArray(images) ? images : [],
          minPriceSAR,
          maxPriceSAR,
          avgPriceSAR,
          minPriceUSD,
          maxPriceUSD,
          stock: Number.isFinite(stockApprox) ? stockApprox : 0,
          listedNum,
          inventory: undefined,
          inventoryStatus: undefined,
          inventoryErrorMessage: undefined,
          variants: [],
          inventoryVariants: undefined,
          successfulVariants: 0,
          totalVariants: 0,
          description: undefined,
          overview: undefined,
          productInfo: undefined,
          sizeInfo: undefined,
          productNote: undefined,
          packingList: undefined,
          displayedRating,
          ratingConfidence: undefined,
          rating: displayedRating,
          reviewCount,
          supplierName: undefined,
          itemAsDescribed: undefined,
          serviceRating: undefined,
          shippingSpeedRating: undefined,
          categoryName: String(item.categoryName || item.threeCategoryName || item.twoCategoryName || item.category || ''),
          productWeight: undefined,
          packLength: undefined,
          packWidth: undefined,
          packHeight: undefined,
          material: undefined,
          productType: undefined,
          sizeChartImages: undefined,
          processingTimeHours: undefined,
          deliveryTimeHours: undefined,
          estimatedProcessingDays: undefined,
          estimatedDeliveryDays: undefined,
          originCountry: undefined,
          hsCode: undefined,
          videoUrl,
          videoSourceUrl: undefined,
          video4kUrl: undefined,
          videoDeliveryMode: videoUrl ? videoDelivery.mode : undefined,
          videoQualityGatePassed: videoUrl ? videoDelivery.qualityGatePassed : undefined,
          videoSourceQualityHint: videoUrl ? videoDelivery.sourceQualityHint : undefined,
          availableSizes: undefined,
          availableColors: undefined,
          availableModels: undefined,
          colorImageMap: undefined,
        });
      }

      const r = NextResponse.json({
        ok: true,
        products: liteProducts,
        count: liteProducts.length,
        mediaMode,
        duration: Date.now() - startTime,
        batch: isBatchMode ? {
          hasMore: !exhaustedAllPages && (candidateProducts.length > liteProducts.length),
          cursor: `${currentCatIdx}.${currentPage}.${currentItemOffset}`,
          attemptedPids: attemptedPidsThisBatch,
          processedPids: liteProducts.map((p) => p.pid),
          totalCandidates: candidateProducts.length,
          productsThisBatch: liteProducts.length,
          batchSize,
        } : undefined,
      }, { headers: { 'Cache-Control': 'no-store' } });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }

    // Process candidates until we reach the needed quantity
    // In batch mode: use remainingNeeded (what client still needs)
    // In non-batch mode: use quantity (full request)
    console.log(`[Search&Price] Processing candidates to get ${targetProducts} products (batch mode: ${isBatchMode})...`);
    console.log(`[Search&Price] Available candidates: ${candidateProducts.length}`);
    
    const pricedProducts: PricedProduct[] = [];
    let skippedNoVariants = 0;
    let skippedNoShipping = 0;
    const shippingErrors: Record<string, number> = {}; // Track error reasons
    // In batch mode: always start from 0 since we collect fresh candidates each batch
    // In non-batch mode: start from 0 as well (process all candidates)
    let candidateIndex = 0;
    let consecutiveRateLimitErrors = 0; // Track consecutive rate limit errors to detect real quota issues
    let productsProcessedThisBatch = 0; // Count for batch mode limit
    
    // Process candidates until we have the target quantity or run out
    // In batch mode: stop after batchSize products OR after reaching remainingNeeded
    while (pricedProducts.length < targetProducts && candidateIndex < candidateProducts.length) {
      // In batch mode, stop after processing batchSize products
      if (isBatchMode && productsProcessedThisBatch >= batchSize) {
        console.log(`[Search&Price] Batch limit reached (${batchSize} products)`);
        break;
      }
      // Check time limit
      if (Date.now() - startTime > maxDurationMs) {
        console.log(`[Search&Price] Time limit reached after ${pricedProducts.length} products`);
        break;
      }
      
      // Check for rate limit issues
      if (consecutiveRateLimitErrors >= 5) {
        console.log(`[Search&Price] Stopping due to ${consecutiveRateLimitErrors} consecutive rate limit errors`);
        break;
      }
      
      const item = candidateProducts[candidateIndex];
      candidateIndex++;
      
      // Reactive rate limiting: only add delay if we hit rate limit errors recently
      // This keeps things fast when CJ API is responsive
      if (consecutiveRateLimitErrors > 0 && candidateIndex > 1) {
        const backoffMs = Math.min(consecutiveRateLimitErrors * 500, 2000); // 500ms, 1s, 1.5s, max 2s
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
      const pid = String(item.pid || item.productId || '');
      const cjSku = String(item.productSku || item.sku || `CJ-${pid}`);
      const name = String(item.productNameEn || item.name || item.productName || '');
      
      // Fetch full product details for this product (on-demand)
      let fullDetails: any = null;
      try {
        const detailsMap = await fetchProductDetailsBatch([pid], 1);
        fullDetails = detailsMap.get(pid) || null;
      } catch (e: any) {
        console.log(`[Search&Price] Product ${pid} - Failed to fetch details: ${e?.message}`);
      }

      const source = fullDetails || item;
      let images = extractAllImages(source);
      if (images.length === 0 && source !== item) {
        images = extractAllImages(item);
      }
      const videoDiagnostics = extractBestVideo(source, source !== item ? item : undefined);
      const videoUrl = videoDiagnostics.videoUrl;
      const hasVideo = videoDiagnostics.videoDetected;
      const hasImages = hasDiscoverImages(images);
      const videoDelivery = build4kVideoDelivery(videoUrl);
      const storefrontVideoUrl = videoDelivery.deliveryUrl;
      const hasDeliverableVideo =
        typeof storefrontVideoUrl === 'string' &&
        storefrontVideoUrl.length > 0 &&
        videoDelivery.qualityGatePassed;
      const hasVideoForMediaFilter = hasVideo;

      mediaFilterStats.checked++;
      mediaFilterStats.videoSource[videoDiagnostics.videoSource]++;
      mediaFilterStats.videoQualityHints[videoDiagnostics.videoQualityHint]++;
      mediaFilterStats.videoDeliveryModes[videoDelivery.mode]++;
      if (hasVideo) {
        if (videoDelivery.qualityGatePassed) {
          mediaFilterStats.videoQualityGate.passed++;
        } else {
          mediaFilterStats.videoQualityGate.failed++;
        }
      }
      if (!hasVideo) {
        mediaFilterStats.missingVideoAfterExtraction++;
      }

      console.log(
        `[Search&Price] Product ${pid} media diagnostics: source=${videoDiagnostics.videoSource}, detected=${videoDiagnostics.videoDetected}, deliverable4k=${hasDeliverableVideo}, hint=${videoDiagnostics.videoQualityHint}, candidates=${videoDiagnostics.candidatesChecked}, hasImages=${hasImages}`
      );

      if (!matchesDiscoverMediaMode(mediaMode, hasVideoForMediaFilter, hasImages)) {
        mediaFilterStats.filteredOut++;
        if (!hasVideoForMediaFilter) {
          mediaFilterStats.missingVideo++;
          if (mediaFilterStats.skippedMissingVideoPids.length < 25) {
            mediaFilterStats.skippedMissingVideoPids.push(pid);
          }
        }
        if (!hasImages) mediaFilterStats.missingImages++;
        console.log(`[Search&Price] Product ${pid} skipped by media filter mode=${mediaMode} hasVideo=${hasVideoForMediaFilter} hasDeliverableVideo=${hasDeliverableVideo} hasImages=${hasImages}`);
        continue;
      }
      mediaFilterStats.passed++;
      
      // Legacy supplier/comment rating sources are intentionally not used.
      // Internal rating engine values are computed later from product signals.
      
      // CRITICAL: Fetch REAL inventory data from CJ's dedicated inventory API
      // This is the ONLY reliable way to get per-warehouse stock breakdown
      // GET /product/stock/getInventoryByPid returns: inventories[].{areaId, areaEn, cjInventoryNum, factoryInventoryNum}
      let realInventory: { 
        totalCJ: number; 
        totalFactory: number; 
        totalAvailable: number; 
        warehouses: Array<{ areaId: number; areaName: string; countryCode: string; totalInventory: number; cjInventory: number; factoryInventory: number }>;
      } | null = null;
      
      // Map to store per-variant inventory with MULTIPLE KEYS for reliable matching
      // Store same stock data under: normalized SKU, vid, variantId, variantKey
      const variantStockMap = new Map<string, { cjStock: number; factoryStock: number; totalStock: number }>();
      
      // Normalize key for matching: lowercase, trim, remove special chars
      const normalizeKey = (s: string | undefined | null): string => {
        if (!s) return '';
        return String(s).toLowerCase().trim().replace(/[\s\-_\.]/g, '');
      };
      
      // Function to look up variant stock by multiple possible keys
      // Uses the SAME normalization as storage
      const getVariantStock = (identifiers: {
        vid?: string;
        variantId?: string;
        sku?: string;
        variantKey?: string;
        variantName?: string;
      }): { cjStock: number; factoryStock: number; totalStock: number } | undefined => {
        // Try ALL possible keys in priority order
        const keysToTry = [
          normalizeKey(identifiers.sku),         // Try SKU first (most common match)
          normalizeKey(identifiers.vid),          // Try vid (variant ID)
          normalizeKey(identifiers.variantId),    // Try variantId
          normalizeKey(identifiers.variantKey),   // Try variantKey (e.g., "White-L")
          normalizeKey(identifiers.variantName),  // Try variant name
        ].filter(k => k.length > 0);
        
        for (const key of keysToTry) {
          const stock = variantStockMap.get(key);
          if (stock) return stock;
        }
        
        // Fallback: scan all stored entries for partial match
        if (keysToTry.length > 0) {
          for (const [storedKey, stockData] of variantStockMap.entries()) {
            for (const searchKey of keysToTry) {
              if (searchKey && (storedKey.includes(searchKey) || searchKey.includes(storedKey))) {
                return stockData;
              }
            }
          }
        }
        
        return undefined;
      };
      
      // Track inventory fetch status for UI feedback
      let inventoryStatus: 'ok' | 'error' | 'partial' = 'ok';
      let inventoryErrorMessage: string | undefined;
      
      // Declare variantInventory outside try block so it's accessible for inventoryVariants building
      let variantInventory: Awaited<ReturnType<typeof queryVariantInventory>> = [];
      
      try {
        // Fetch product-level inventory from dedicated API
        realInventory = await getInventoryByPid(pid);
        if (realInventory) {
          console.log(`[Search&Price] Product ${pid} - Inventory from getInventoryByPid:`);
          console.log(`  - Total: ${realInventory.totalAvailable} (CJ: ${realInventory.totalCJ}, Factory: ${realInventory.totalFactory})`);
          console.log(`  - Warehouses: ${realInventory.warehouses.length}`);
          for (const wh of realInventory.warehouses) {
            console.log(`    - ${wh.areaName}: CJ=${wh.cjInventory}, Factory=${wh.factoryInventory}, Total=${wh.totalInventory}`);
          }
        } else {
          console.log(`[Search&Price] Product ${pid} - No inventory data returned from getInventoryByPid`);
          inventoryStatus = 'partial';
          inventoryErrorMessage = 'Could not fetch warehouse inventory';
        }
        
        // Also fetch per-variant inventory (CJ vs Factory breakdown per variant)
        // This matches CJ's "Inventory Details" modal showing: White-L (CJ:0, Factory:6714), etc.
        // NOTE: Removed waitForCjRateLimit() call - it was adding 1100ms delay per product
        // The CJ API handles rate limiting itself; we only slow down on actual rate limit errors
        
        try {
          variantInventory = await queryVariantInventory(pid);
        } catch (e: any) {
          const errorMsg = e?.message || 'Failed to fetch variant inventory';
          console.log(`[Search&Price] Product ${pid} - queryVariantInventory error: ${errorMsg}`);
          inventoryStatus = inventoryStatus === 'ok' ? 'partial' : 'error';
          inventoryErrorMessage = inventoryErrorMessage ? `${inventoryErrorMessage}; ${errorMsg}` : errorMsg;
        }
        if (variantInventory && variantInventory.length > 0) {
          console.log(`[Search&Price] Product ${pid} - Per-variant inventory: ${variantInventory.length} variants`);
          for (const vi of variantInventory) {
            const stockData = {
              cjStock: vi.cjStock,
              factoryStock: vi.factoryStock,
              totalStock: vi.totalStock,
            };
            // Store under ALL possible normalized keys for robust matching
            // This ensures we can match by ANY identifier CJ uses
            const keysToStore = [
              normalizeKey(vi.variantSku),
              normalizeKey(vi.vid),
              normalizeKey(vi.variantId),
              normalizeKey(vi.variantKey),
              normalizeKey(vi.variantName),
            ].filter(k => k && k.length > 0);
            
            for (const key of keysToStore) {
              variantStockMap.set(key, stockData);
            }
            console.log(`    - ${vi.variantName || vi.variantSku}: CJ=${vi.cjStock}, Factory=${vi.factoryStock}, Total=${vi.totalStock} (${keysToStore.length} keys stored)`);
          }
          console.log(`[Search&Price] Product ${pid} - Stored ${variantStockMap.size} total stock keys`);
        } else if (!inventoryErrorMessage) {
          // No variants returned but no error - mark as partial
          inventoryStatus = inventoryStatus === 'ok' ? 'partial' : inventoryStatus;
        }
      } catch (e: any) {
        console.log(`[Search&Price] Product ${pid} - Error fetching inventory: ${e?.message}`);
        inventoryStatus = 'error';
        inventoryErrorMessage = e?.message || 'Failed to fetch inventory data';
      }
      
      // Build inventoryVariants array from ALL variant inventory data
      // This is for the blue Inventory Details box on Page 4 - shows ALL variants
      const inventoryVariants: InventoryVariant[] = [];
      if (variantInventory && variantInventory.length > 0) {
        for (const vi of variantInventory) {
          // Only include variants with stock > 0
          if (vi.totalStock <= 0) continue;
          
          // Parse short name from variantKey or variantName (format: "Black-L", "HA0127-XXL")
          const variantKeyRaw = String(vi.variantKey || vi.variantName || vi.variantSku || '');
          let shortName = variantKeyRaw;
          
          // Clean up the name - remove any Chinese characters
          shortName = shortName.replace(/[\u4e00-\u9fff]/g, '').trim();
          
          // If still empty, use SKU
          if (!shortName) {
            shortName = vi.variantSku || `Variant-${vi.vid || vi.variantId || '?'}`;
          }
          
          inventoryVariants.push({
            variantId: String(vi.vid || vi.variantId || ''),
            sku: vi.variantSku,
            shortName,
            priceUSD: vi.price,
            cjStock: vi.cjStock,
            factoryStock: vi.factoryStock,
            totalStock: vi.totalStock,
          });
        }
        console.log(`[Search&Price] Product ${pid} - Built ${inventoryVariants.length} inventoryVariants for display`);
      }
      
      // Fallback: if no inventoryVariants but we have product-level stock,
      // try to build from product's variant list (from fullDetails or item)
      // IMPORTANT: We show real variant names/prices but mark stock as -1 (unknown)
      // to maintain 100% accuracy - we never fabricate per-variant stock counts
      if (inventoryVariants.length === 0 && (realInventory?.totalAvailable || 0) > 0) {
        const productSource = fullDetails || item;
        const productVariantList = productSource?.variantList || productSource?.skuList || productSource?.variants || [];
        
        if (Array.isArray(productVariantList) && productVariantList.length > 0) {
          // Build inventoryVariants from product's variant list
          // Show real names and prices, but use -1 for stock (indicates "per-variant unknown")
          // The UI can display total stock from product-level data separately
          for (const pv of productVariantList) {
            const sku = pv.variantSku || pv.sku || pv.vid || '';
            // IMPORTANT: variantKey is the SHORT name like "Black And Silver-2XL"
            // variantNameEn is the LONG descriptive name - use as fallback
            const variantKeyShort = pv.variantKey || '';
            const variantNameLong = pv.variantNameEn || pv.variantName || pv.skuName || '';
            const price = Number(pv.variantSellPrice || pv.sellPrice || pv.variantPrice || pv.price || 0);
            const vid = pv.vid || '';
            
            // Parse a clean short name - prioritize variantKey (short) over variantNameEn (long)
            let shortName = variantKeyShort || variantNameLong;
            shortName = shortName.replace(/[\u4e00-\u9fff]/g, '').trim();
            if (!shortName) {
              shortName = sku || `Variant-${vid || '?'}`;
            }
            
            // Use -1 to indicate "per-variant stock unknown" 
            // This maintains accuracy - we don't fabricate numbers
            inventoryVariants.push({
              variantId: vid || sku,
              sku,
              shortName,
              priceUSD: price,
              cjStock: -1,      // Unknown per-variant
              factoryStock: -1, // Unknown per-variant
              totalStock: -1,   // Unknown per-variant
            });
          }
          console.log(`[Search&Price] Product ${pid} - Built ${inventoryVariants.length} inventoryVariants from product variant list (stock marked unknown)`);
        } else {
          // True single-variant product - show actual totals
          inventoryVariants.push({
            variantId: cjSku,
            sku: cjSku,
            shortName: 'Default',
            priceUSD: 0,
            cjStock: realInventory?.totalCJ ?? 0,
            factoryStock: realInventory?.totalFactory ?? 0,
            totalStock: realInventory?.totalAvailable ?? 0,
          });
          console.log(`[Search&Price] Product ${pid} - Used product-level inventory as single inventoryVariant`);
        }
      }
      
      // Use REAL inventory data from dedicated API (most accurate)
      const stock = realInventory?.totalAvailable ?? Number(item.stock || 0);
      const totalVerifiedInventory = realInventory?.totalCJ ?? 0;
      const totalUnVerifiedInventory = realInventory?.totalFactory ?? 0;
      
      // listedNum comes from listV2 or fullDetails - not inventory API
      const listedNum = fullDetails?.listedNum ?? Number(item.listedNum || 0);
      
      console.log(`[Search&Price] Product ${pid} => Final: stock=${stock}, listedNum=${listedNum}, CJ=${totalVerifiedInventory}, Factory=${totalUnVerifiedInventory}`);
      console.log(`[Search&Price] Product ${pid}: ${images.length} images from primary source`);
      if (videoUrl) {
        console.log(
          `[Search&Price] Product ${pid}: video URL detected (source=${videoDiagnostics.videoSource}, hint=${videoDiagnostics.videoQualityHint}, deliveryMode=${videoDelivery.mode}, qualityGate=${videoDelivery.qualityGatePassed})`
        );
      }

      // Extract additional product info from fullDetails or item
      const rawDescriptionHtml = String(source.description || source.productDescription || source.descriptionEn || source.productDescEn || source.desc || '').trim();
      
      let rating: number | undefined;
      let reviewCount = 0;
      let reviewMetricsSource: 'supplier' | 'synthetic' | 'none' = 'none';
      const supplierName = String(
        source.supplierName || source.supplier?.name || source.vendorName || source.supplierNickName || ''
      ).trim() || undefined;
      const itemAsDescribed = pickFiniteNumber(source, ['itemAsDescribed', 'descriptionScore']);
      const serviceRating = pickFiniteNumber(source, ['serviceRating', 'serviceScore']);
      const shippingSpeedRating = pickFiniteNumber(source, ['shippingSpeedRating', 'shippingScore']);
      
      const categoryName = String(source.categoryName || source.categoryNameEn || source.category || '').trim() || undefined;
      
      // Extract product weight - check all possible CJ field names
      // For shipping, use packWeight (product + packaging) which is what carriers charge for
      // CJ API returns: packWeight/packingWeight (total) and productWeight (net)
      const weightCandidates: Array<{ field: string; value: any }> = [
        { field: 'packWeight', value: source.packWeight },           // Total weight (preferred for shipping)
        { field: 'packingWeight', value: source.packingWeight },     // Same as packWeight
        { field: 'productWeight', value: source.productWeight },     // Net weight only
        { field: 'weight', value: source.weight },                   // Alternative field name
        { field: 'grossWeight', value: source.grossWeight },
        { field: 'netWeight', value: source.netWeight },
      ];
      
      // Find the first valid weight value
      let productWeight: number | undefined = undefined;
      let weightSource = 'none';
      for (const { field, value } of weightCandidates) {
        if (value !== undefined && value !== null && value !== '') {
          const numVal = Number(value);
          if (Number.isFinite(numVal) && numVal > 0) {
            // CJ typically returns weight in grams, but check if it might be kg
            productWeight = numVal < 30 ? Math.round(numVal * 1000) : Math.round(numVal);
            weightSource = field;
            break;
          }
        }
      }
      
      const packLength = source.packLength !== undefined ? Number(source.packLength) : (source.length !== undefined ? Number(source.length) : undefined);
      const packWidth = source.packWidth !== undefined ? Number(source.packWidth) : (source.width !== undefined ? Number(source.width) : undefined);
      const packHeight = source.packHeight !== undefined ? Number(source.packHeight) : (source.height !== undefined ? Number(source.height) : undefined);
      
      // Debug: Log extracted weight/dimensions for shipping calculation accuracy
      console.log(`[Search&Price] Product ${pid} dimensions: weight=${productWeight}g (from ${weightSource}), L=${packLength}cm, W=${packWidth}cm, H=${packHeight}cm`);
      
      // Log all available weight-related fields for debugging if weight not found
      if (!productWeight) {
        const weightFields = Object.entries(source).filter(([k, v]) => 
          /weight/i.test(k) && v !== undefined && v !== null && v !== ''
        );
        if (weightFields.length > 0) {
          console.log(`[Search&Price] Product ${pid} available weight fields: ${JSON.stringify(Object.fromEntries(weightFields))}`);
        }
      }
      const productType = String(source.productType || source.type || source.productTypeName || '').trim() || undefined;
      
      // Helper: Parse CJ JSON array fields like '["","metal"]' into readable string
      const parseCjJsonArray = (val: any): string => {
        if (!val) return '';
        if (Array.isArray(val)) return val.filter(Boolean).map(String).join(', ');
        if (typeof val === 'string') {
          const trimmed = val.trim();
          if (trimmed.startsWith('[')) {
            try {
              const arr = JSON.parse(trimmed);
              if (Array.isArray(arr)) return arr.filter(Boolean).map(String).join(', ');
            } catch {}
          }
          return trimmed;
        }
        return '';
      };
      
      // Try to get material - first try parsed arrays (from fullDetails), then raw field, then parse locally
      let material = source.materialParsed || '';
      if (!material) {
        const rawMaterial = source.material || source.productMaterial || source.materialNameEn || source.materialName || '';
        material = parseCjJsonArray(rawMaterial);
      }
      material = material.trim() || undefined;
      
      // Try to get packing info similarly
      let packingInfo = source.packingParsed || '';
      if (!packingInfo) {
        const rawPacking = source.packingNameEn || source.packingName || source.packingList || '';
        packingInfo = parseCjJsonArray(rawPacking);
      }
      packingInfo = packingInfo.trim() || undefined;
      
      // Helper: Sanitize HTML - remove supplier links/contacts but keep usable content
      const sanitizeHtml = (html: string): string | undefined => {
        if (!html || typeof html !== 'string') return undefined;
        let cleaned = html
          // Remove 1688.com and other supplier links
          .replace(/<a[^>]*href=[^>]*(1688|taobao|alibaba|aliexpress|tmall)[^>]*>.*?<\/a>/gi, '')
          .replace(/https?:\/\/[^\s<>"]*?(1688|taobao|alibaba|aliexpress|tmall)[^\s<>"]*/gi, '')
          // Remove WeChat/QQ/supplier contact info
          .replace(/<[^>]*>(.*?(微信|QQ|联系|客服|淘宝|阿里巴巴|天猫|拼多多|抖音|快手).*?)<\/[^>]*>/gi, '')
          // Remove emoji patterns
          .replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '')
          // Remove empty elements
          .replace(/<(\w+)[^>]*>\s*<\/\1>/g, '')
          // Remove multiple whitespace and line breaks
          .replace(/\s+/g, ' ')
          .trim();
        
        // Check if remaining content has any useful content
        const textOnly = cleaned.replace(/<[^>]*>/g, '').trim();
        const hasEnglish = /[a-zA-Z]/.test(textOnly); // Single letter is enough
        const hasArabic = /[\u0600-\u06FF]/.test(textOnly);
        const hasNumbers = /\d/.test(textOnly);
        const hasUnits = /\b(cm|mm|m|kg|g|ml|l|inch|oz|lb)\b/i.test(textOnly);
        
        // If no useful content remains, return undefined
        if (!hasEnglish && !hasArabic && !hasNumbers && textOnly.length === 0) return undefined;
        
        // Accept content if it has numbers or units (likely specs) even if Chinese-heavy
        if (hasNumbers || hasUnits) {
          return cleaned.length > 0 ? cleaned : undefined;
        }
        
        // For pure text, if >90% Chinese with no English, skip it
        const chineseChars = (textOnly.match(/[\u4e00-\u9fff]/g) || []).length;
        if (textOnly.length > 0 && !hasEnglish && !hasArabic && chineseChars > textOnly.length * 0.9) return undefined;
        
        // Return cleaned content if it has any text
        return cleaned.length > 0 ? cleaned : undefined;
      };
      
      // Helper: Build product info from productPropertyList if description is empty
      // CJ propertyList structure: { propertyName, propertyNameEn, propertyValueList: [{propertyValueName, propertyValueNameEn}] }
      const buildInfoFromProperties = (props: any[]): string => {
        if (!Array.isArray(props) || props.length === 0) return '';
        const lines: string[] = [];
        
        // Helper to clean a value - strip pure Chinese, keep mixed/numeric content
        const cleanValue = (val: string): string => {
          if (!val) return '';
          const trimmed = val.trim();
          // If it has numbers or units, keep it even with Chinese
          if (/\d/.test(trimmed) || /\b(cm|mm|m|kg|g|ml|l|inch|oz|lb|pcs|pc|set)\b/i.test(trimmed)) {
            // Remove pure Chinese segments but keep numbers and English
            return trimmed.replace(/^[\u4e00-\u9fff\s]+(?=\d)/g, '').replace(/[\u4e00-\u9fff]+$/g, '').trim();
          }
          // If it has English letters, keep it
          if (/[a-zA-Z]/.test(trimmed)) {
            return trimmed;
          }
          // Pure Chinese with no useful content
          return '';
        };
        
        for (const prop of props) {
          // Try EN name first, then fallback to base name
          let name = String(prop.propertyNameEn || '').trim();
          if (!name) {
            name = String(prop.propertyName || prop.name || prop.key || '').trim();
            // Skip if name is pure Chinese
            if (/^[\u4e00-\u9fff\s]+$/.test(name)) continue;
          }
          if (!name) continue;
          
          // Handle nested propertyValueList array (common CJ structure)
          const valueList = prop.propertyValueList || prop.values || prop.options || [];
          if (Array.isArray(valueList) && valueList.length > 0) {
            const values: string[] = [];
            for (const v of valueList) {
              // Try multiple value fields with fallbacks
              const raw = String(v.propertyValueNameEn || v.propertyValueName || v.valueNameEn || v.valueName || v.name || v.value || '').trim();
              const cleaned = cleanValue(raw);
              if (cleaned) {
                values.push(cleaned);
              }
            }
            if (values.length > 0) {
              lines.push(`${name}: ${values.join(', ')}`);
            }
          } else {
            // Handle scalar value (fallback) - try multiple fields
            const raw = String(prop.propertyValueNameEn || prop.propertyValueName || prop.propertyValue || prop.value || prop.valueName || '').trim();
            const cleaned = cleanValue(raw);
            if (cleaned) {
              lines.push(`${name}: ${cleaned}`);
            }
          }
        }
        return lines.join('<br/>');
      };
      
      // Helper: Extract specs from HTML description (tables, lists, key:value patterns)
      const extractSpecsFromHtml = (html: string): string => {
        if (!html || typeof html !== 'string') return '';
        const lines: string[] = [];
        
        // Remove supplier junk first
        let cleaned = html
          .replace(/<a[^>]*href=[^>]*(1688|taobao|alibaba|aliexpress|tmall)[^>]*>.*?<\/a>/gi, '')
          .replace(/https?:\/\/[^\s<>"]*?(1688|taobao|alibaba|aliexpress|tmall)[^\s<>"]*/gi, '')
          .replace(/<[^>]*>(.*?(微信|QQ|联系|客服|淘宝|阿里巴巴).*?)<\/[^>]*>/gi, '');
        
        // Extract key:value patterns like "Material: Cotton" or "Size: S-XL"
        const kvPatterns = cleaned.match(/([A-Za-z][A-Za-z\s]{2,30})[\s]*[:\-：][\s]*([A-Za-z0-9][A-Za-z0-9\s,.\-\/×xX%]+)/g) || [];
        for (const kv of kvPatterns) {
          const match = kv.match(/([A-Za-z][A-Za-z\s]{2,30})[\s]*[:\-：][\s]*(.+)/);
          if (match && match[1] && match[2]) {
            const key = match[1].trim();
            const value = match[2].trim();
            // Skip if mostly Chinese in value
            const chineseChars = (value.match(/[\u4e00-\u9fff]/g) || []).length;
            if (chineseChars < value.length * 0.5 && value.length > 1) {
              lines.push(`${key}: ${value}`);
            }
          }
        }
        
        // Extract from <li> items that look like specs
        const liItems = cleaned.match(/<li[^>]*>([^<]+)<\/li>/gi) || [];
        for (const li of liItems) {
          const text = li.replace(/<[^>]*>/g, '').trim();
          // Must have English letters and not be too long
          if (/[a-zA-Z]/.test(text) && text.length > 3 && text.length < 100) {
            const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
            if (chineseChars < text.length * 0.3) {
              lines.push(text);
            }
          }
        }
        
        // Deduplicate
        const seen = new Set<string>();
        const uniqueLines: string[] = [];
        for (const line of lines) {
          const normalized = line.toLowerCase().replace(/\s+/g, ' ');
          if (!seen.has(normalized)) {
            seen.add(normalized);
            uniqueLines.push(line);
          }
        }
        
        return uniqueLines.slice(0, 20).join('<br/>');
      };
      
      // Helper: Build basic specs from product fields (only meaningful customer-facing data)
      const buildBasicSpecs = (): string => {
        const specs: string[] = [];
        if (material && material.length > 1) specs.push(`Material: ${material}`);
        if (packingInfo && packingInfo.length > 1) specs.push(`Package: ${packingInfo}`);
        if (productWeight && productWeight > 0) specs.push(`Weight: ${productWeight}g`);
        if (packLength && packWidth && packHeight) {
          specs.push(`Package Size: ${packLength} × ${packWidth} × ${packHeight} cm`);
        }
        // Add delivery cycle if available
        const deliveryCycle = source.deliveryCycle;
        if (deliveryCycle) {
          specs.push(`Delivery: ${deliveryCycle} days`);
        }
        // Only include category if we have other specs too
        if (specs.length > 0 && categoryName && !categoryName.includes('_')) {
          specs.push(`Category: ${categoryName}`);
        }
        return specs.join('<br/>');
      };
      
      // Sanitize the description HTML (apply after sanitizeHtml is defined)
      const description = sanitizeHtml(rawDescriptionHtml);
      
      // Extract Product Information - check multiple sources
      let rawProductInfo = String(source.description || source.productDescription || source.descriptionEn || source.productDescEn || source.desc || '').trim();
      const descriptionHtml = rawProductInfo; // Save for later extraction
      
      // First try productPropertyList (best quality specs)
      const propList = source.productPropertyList || source.propertyList || source.properties || source.specs || source.attributes || [];
      const propsInfo = buildInfoFromProperties(propList);
      if (propsInfo && propsInfo.length > 10) {
        rawProductInfo = propsInfo;
      }
      
      // If no specs from property list, try to extract from HTML description
      if (!rawProductInfo || rawProductInfo.length < 10) {
        const htmlSpecs = extractSpecsFromHtml(descriptionHtml);
        if (htmlSpecs && htmlSpecs.length > 10) {
          rawProductInfo = htmlSpecs;
        }
      }
      
      // If still nothing, check nested data structures
      if (!rawProductInfo || rawProductInfo.length < 10) {
        const nested = source.data || source.product || source.detail || source.info || {};
        if (typeof nested === 'object') {
          const nestedDesc = String(nested.description || nested.productDescription || nested.descriptionEn || '').trim();
          if (nestedDesc) {
            const nestedSpecs = extractSpecsFromHtml(nestedDesc);
            if (nestedSpecs && nestedSpecs.length > 10) {
              rawProductInfo = nestedSpecs;
            }
          }
        }
      }
      
      // Try synthesizedInfo from fetchProductDetailsByPid (contains parsed material, packing, weight, etc.)
      if (!rawProductInfo || rawProductInfo.length < 10) {
        if (source.synthesizedInfo) {
          rawProductInfo = source.synthesizedInfo;
          console.log(`[Search&Price] Product ${pid}: Using synthesizedInfo as productInfo fallback`);
        }
      }
      
      // Last resort: build basic specs from known fields
      if (!rawProductInfo || rawProductInfo.length < 10) {
        const basicSpecs = buildBasicSpecs();
        if (basicSpecs) {
          rawProductInfo = basicSpecs;
        }
      }
      
      const productInfo = sanitizeHtml(rawProductInfo);
      
      // Extract Product Note (sizing/color notes from CJ) - heavily sanitize
      const rawProductNote = String(source.productNote || source.note || source.notes || source.remark || source.memo || source.comment || source.remarkEn || '').trim();
      const productNote = sanitizeHtml(rawProductNote);
      
      // Extract Packing List - check multiple field names
      let rawPackingList = String(source.packingList || source.packing || source.packageContent || source.packageList || source.packingNameEn || source.packingName || source.packageInfo || '').trim();
      
      // If packingList is empty, check if it's in a nested structure or property list
      if (!rawPackingList) {
        const propList = source.productPropertyList || source.propertyList || [];
        if (Array.isArray(propList)) {
          for (const prop of propList) {
            const name = String(prop.propertyNameEn || prop.propertyName || prop.name || '').toLowerCase();
            if (name.includes('pack') || name.includes('includ') || name.includes('content') || name.includes('box')) {
              // Handle nested propertyValueList array
              const valueList = prop.propertyValueList || prop.values || [];
              if (Array.isArray(valueList) && valueList.length > 0) {
                const values: string[] = [];
                for (const v of valueList) {
                  const val = String(v.propertyValueNameEn || v.propertyValueName || v.value || '').trim();
                  if (val && !/[\u4e00-\u9fff]/.test(val)) values.push(val);
                }
                if (values.length > 0) {
                  rawPackingList = values.join(', ');
                  break;
                }
              } else {
                // Scalar value fallback
                rawPackingList = String(prop.propertyValueNameEn || prop.propertyValueName || prop.value || '').trim();
                if (rawPackingList) break;
              }
            }
          }
        }
      }
      
      const packingList = sanitizeHtml(rawPackingList) || (rawPackingList && rawPackingList.length > 2 && !/[\u4e00-\u9fff]/.test(rawPackingList) ? rawPackingList : undefined);
      
      // Extract Overview - short product summary from name/category
      // ALWAYS build overview with whatever data we have - this ensures Page 3 shows something
      let overview: string | undefined;
      const categoryDisplay = source.threeCategoryName || source.twoCategoryName || source.oneCategoryName || categoryName || '';
      const overviewParts: string[] = [];
      
      // Category - always include if available
      if (categoryDisplay && !categoryDisplay.includes('_')) {
        overviewParts.push(`Category: ${categoryDisplay}`);
      }
      
      // Material - include if available and not Chinese-only
      if (material && material.length > 1 && !/[\u4e00-\u9fff]/.test(material)) {
        overviewParts.push(`Material: ${material}`);
      }
      
      // Packing/Package info
      if (packingInfo && packingInfo.length > 1 && !/[\u4e00-\u9fff]/.test(packingInfo)) {
        overviewParts.push(`Package: ${packingInfo}`);
      }
      
      // Weight
      if (productWeight && productWeight > 0) {
        overviewParts.push(`Weight: ${productWeight}g`);
      }
      
      // Dimensions
      if (packLength && packWidth && packHeight) {
        overviewParts.push(`Dimensions: ${packLength} × ${packWidth} × ${packHeight} cm`);
      }
      
      // Delivery cycle
      if (source.deliveryCycle) {
        overviewParts.push(`Delivery: ${source.deliveryCycle} days`);
      }
      
      // HS Code for customs info
      if (source.entryCode && source.entryNameEn) {
        overviewParts.push(`HS Code: ${source.entryCode}`);
      }
      
      // Product type
      if (productType && productType.length > 1 && productType !== 'ORDINARY_PRODUCT') {
        overviewParts.push(`Type: ${productType}`);
      }
      
      if (overviewParts.length > 0) {
        overview = overviewParts.join('<br/>');
      }
      
      // If Overview only has Category (meaning we didn't find material/weight/etc from raw fields),
      // try to use synthesizedInfo which was built in fetchProductDetailsByPid with this data
      if (overviewParts.length <= 1 && source.synthesizedInfo) {
        // synthesizedInfo contains Material, Package, Weight, Dimensions, Category, Delivery, HS Code
        // Split on <br/> BEFORE sanitizing to preserve line structure, then sanitize each line
        const synthLines = String(source.synthesizedInfo).split(/<br\s*\/?>/i);
        const cleanedLines: string[] = [];
        for (const line of synthLines) {
          const cleaned = sanitizeHtml(line);
          if (cleaned && cleaned.length > 2) {
            cleanedLines.push(cleaned);
          }
        }
        if (cleanedLines.length > 1) {
          overview = cleanedLines.join('<br/>');
          console.log(`[Search&Price] Product ${pid}: Using synthesizedInfo as Overview (${cleanedLines.length} lines)`);
        }
      }
      
      // Extract Size Info - dimensions, size options from properties and variants
      let sizeInfo: string | undefined;
      const sizeLines: string[] = [];
      
      // Add pack dimensions if available
      if (packLength && packWidth && packHeight) {
        sizeLines.push(`Package Size: ${packLength} × ${packWidth} × ${packHeight} cm`);
      }
      
      // Extract size properties from propertyList
      const sizePropList = source.productPropertyList || source.propertyList || [];
      if (Array.isArray(sizePropList)) {
        for (const prop of sizePropList) {
          const propName = String(prop.propertyNameEn || prop.propertyName || prop.name || '').toLowerCase();
          if (propName.includes('size') || propName.includes('dimension') || propName.includes('length') || 
              propName.includes('width') || propName.includes('height') || propName.includes('bust') || 
              propName.includes('waist') || propName.includes('hip')) {
            const valueList = prop.propertyValueList || prop.values || [];
            if (Array.isArray(valueList) && valueList.length > 0) {
              const values: string[] = [];
              for (const v of valueList) {
                const val = String(v.propertyValueNameEn || v.propertyValueName || v.value || '').trim();
                if (val && !/^[\u4e00-\u9fff]+$/.test(val)) values.push(val);
              }
              if (values.length > 0) {
                const displayName = prop.propertyNameEn || prop.propertyName || 'Size';
                sizeLines.push(`${displayName}: ${values.join(', ')}`);
              }
            }
          }
        }
      }
      
      if (sizeLines.length > 0) {
        sizeInfo = sizeLines.join('<br/>');
      }
      
      // Extract Size Chart Images (CJ provides these as separate images)
      const sizeChartImages: string[] = [];
      const sizeChartFields = ['sizeChartImage', 'sizeChart', 'sizeImage', 'measurementImage', 'chartImage'];
      for (const field of sizeChartFields) {
        const val = source[field];
        if (typeof val === 'string' && val.startsWith('http')) {
          sizeChartImages.push(val);
        } else if (Array.isArray(val)) {
          for (const img of val) {
            if (typeof img === 'string' && img.startsWith('http')) {
              sizeChartImages.push(img);
            }
          }
        }
      }
      // Also check detailImageList for size chart images (often contain measurement diagrams)
      const detailImages = source.detailImageList || source.descriptionImages || [];
      if (Array.isArray(detailImages)) {
        for (const img of detailImages) {
          const url = typeof img === 'string' ? img : (img?.url || img?.imageUrl || '');
          if (typeof url === 'string' && url.startsWith('http') && /size|chart|measure|dimension/i.test(url)) {
            sizeChartImages.push(url);
          }
        }
      }
      
      // Log what we found for debugging - all 6 Page 3 fields
      console.log(`[Search&Price] Product ${pid} Page 3 fields:`);
      console.log(`  - description: ${description ? `YES (${description.length} chars)` : 'NO'}`);
      console.log(`  - overview: ${overview ? `YES (${overview.length} chars)` : 'NO'}`);
      console.log(`  - productInfo: ${productInfo ? `YES (${productInfo.length} chars)` : 'NO'}`);
      console.log(`  - sizeInfo: ${sizeInfo ? `YES (${sizeInfo.length} chars)` : 'NO'}`);
      console.log(`  - productNote: ${productNote ? `YES (${productNote.length} chars)` : 'NO'}`);
      console.log(`  - packingList: ${packingList ? `YES (${packingList.length} chars)` : 'NO'}`);
      console.log(`  - sizeChartImages: ${sizeChartImages.length}`);
      
      // Fetch variants - CJ returns only purchasable variants in this API
      const variants = await getVariantsForProduct(token, base, pid);
      
      // Build set of images from variants (these are the purchasable color options)
      const variantImages: string[] = [];
      const seenVariantImageKeys = new Set<string>();
      const pushVariantImage = (url: unknown, preferFront: boolean = false) => {
        if (typeof url !== 'string') return;
        const cleaned = enhanceProductImageUrl(url.trim(), 'gallery');
        if (!cleaned.startsWith('http')) return;
        const key = normalizeCjImageKey(cleaned);
        if (!key || seenVariantImageKeys.has(key)) return;
        seenVariantImageKeys.add(key);
        if (preferFront) variantImages.unshift(cleaned);
        else variantImages.push(cleaned);
      };
      
      // Build COLOR-TO-IMAGE mapping from productPropertyList (CJ's structured color data)
      // This maps color names like "Gold", "Silver" to their specific product images
      const colorImageMap: Record<string, string> = {};
      const colorPropertyList = source.productPropertyList || source.propertyList || source.productOptions || [];
      if (Array.isArray(colorPropertyList)) {
        for (const prop of colorPropertyList) {
          const propName = String(prop.propertyNameEn || prop.propertyName || prop.name || '').toLowerCase();
          // Check if this property is for colors
          if (propName.includes('color') || propName.includes('colour')) {
            const valueList = prop.propertyValueList || prop.values || prop.options || [];
            if (Array.isArray(valueList)) {
              for (const pv of valueList) {
                const colorValue = String(pv.propertyValueNameEn || pv.propertyValueName || pv.value || pv.name || '').trim();
                // Clean: remove Chinese characters, keep only clean color names
                const cleanColor = colorValue.replace(/[\u4e00-\u9fff]/g, '').trim();
                // Get the image for this color option
                const colorImg = pv.image || pv.imageUrl || pv.propImage || pv.bigImage || pv.pic || '';
                if (cleanColor && cleanColor.length > 0 && cleanColor.length < 50 && /[a-zA-Z]/.test(cleanColor)) {
                  if (typeof colorImg === 'string' && colorImg.startsWith('http')) {
                    const normalizedColorImage = enhanceProductImageUrl(colorImg.trim(), 'gallery');
                    colorImageMap[cleanColor] = normalizedColorImage;
                    // Also add to variantImages list
                    pushVariantImage(normalizedColorImage);
                  }
                }
              }
            }
          }
        }
        if (Object.keys(colorImageMap).length > 0) {
          console.log(`[Search&Price] Product ${pid}: Built colorImageMap with ${Object.keys(colorImageMap).length} colors: ${Object.keys(colorImageMap).join(', ')}`);
        }
      }
      
      // First, add the main product image (this is always the hero image)
      const mainImage = source.productImage || source.image || source.bigImage || item.productImage || item.image || item.bigImage;
      pushVariantImage(mainImage, true); // Main image goes first
      
      // Extract images from ALL variants (CJ only returns purchasable ones)
      // Check all possible image field names
      const imgFields = ['variantImage', 'whiteImage', 'image', 'imageUrl', 'imgUrl', 'bigImage', 'variantImg', 'skuImage', 'pic', 'picture', 'photo'];
      
      for (const v of variants) {
        for (const field of imgFields) {
          pushVariantImage(v[field]);
        }
        
        // Also check nested structures like variantProperty
        const variantProps = v.variantPropertyList || v.propertyList || v.properties || [];
        if (Array.isArray(variantProps)) {
          for (const prop of variantProps) {
            pushVariantImage(prop?.image || prop?.propImage || prop?.imageUrl || prop?.pic);
          }
        }
      }
      
      console.log(`[Search&Price] Product ${pid}: ${variantImages.length} images from variants + colorImageMap`);
      
      // Build combined product info: start with productInfo, then add variant colors/sizes
      // This ensures we show BOTH material/packing specs AND variant options
      const allSpecs: string[] = [];
      
      // Initialize extracted sizes/colors for filtering
      let extractedSizes: string[] = [];
      let extractedColors: string[] = [];
      
      // PRIMARY SOURCE: Extract colors directly from CJ's productPropertyList (structured data)
      // This provides the REAL color options as shown on CJ website
      const productPropertyList = source.productPropertyList || source.propertyList || source.productOptions || [];
      if (Array.isArray(productPropertyList)) {
        for (const prop of productPropertyList) {
          const propName = String(prop.propertyNameEn || prop.propertyName || prop.name || '').toLowerCase();
          // Check if this property is for colors
          if (propName.includes('color') || propName.includes('colour')) {
            const valueList = prop.propertyValueList || prop.values || prop.options || [];
            if (Array.isArray(valueList)) {
              for (const pv of valueList) {
                const colorValue = String(pv.propertyValueNameEn || pv.propertyValueName || pv.value || pv.name || '').trim();
                // Clean: remove Chinese characters, keep only clean color names
                const cleanColor = colorValue.replace(/[\u4e00-\u9fff]/g, '').trim();
                if (cleanColor && cleanColor.length > 0 && cleanColor.length < 50 && /[a-zA-Z]/.test(cleanColor)) {
                  extractedColors.push(cleanColor);
                }
              }
            }
          }
        }
        if (extractedColors.length > 0) {
          extractedColors = dedupeLabelsCaseInsensitive(extractedColors);
          console.log(`[Search&Price] Product ${pid}: Found ${extractedColors.length} colors from productPropertyList: ${extractedColors.join(', ')}`);
        }
      }
      
      // First, add base product specs (material, packing, weight, etc.)
      let baseSpecs = productInfo;
      if (!baseSpecs && source.synthesizedInfo) {
        // Split on <br/> BEFORE sanitizing to preserve line structure
        const synthLines = String(source.synthesizedInfo).split(/<br\s*\/?>/i);
        const cleanedLines: string[] = [];
        for (const line of synthLines) {
          const cleaned = sanitizeHtml(line);
          if (cleaned && cleaned.length > 2) {
            cleanedLines.push(cleaned);
          }
        }
        if (cleanedLines.length > 0) {
          baseSpecs = cleanedLines.join('<br/>');
          console.log(`[Search&Price] Product ${pid}: Using synthesizedInfo for base specs (${cleanedLines.length} lines)`);
        }
      }
      if (!baseSpecs) {
        const basicSpecs = buildBasicSpecs();
        if (basicSpecs && basicSpecs.length > 10) {
          baseSpecs = basicSpecs;
          console.log(`[Search&Price] Product ${pid}: Using buildBasicSpecs for base specs`);
        }
      }
      
      // Add base specs to allSpecs
      if (baseSpecs) {
        allSpecs.push(baseSpecs);
      }
      
      // Now extract variant colors/sizes/models and ADD them (not replace)
      let extractedModels: string[] = [];
      
      if (variants.length > 0) {
        // Debug: Log first variant structure to understand CJ format
        const sampleVariant = variants[0];
        console.log(`[Search&Price] Product ${pid}: Sample variant keys: ${Object.keys(sampleVariant).join(', ')}`);
        console.log(`[Search&Price] Product ${pid}: Sample variant data: ${JSON.stringify(sampleVariant).substring(0, 500)}`);
        
        const colors = new Set<string>();
        const sizes = new Set<string>();
        const models = new Set<string>();
        
        // Extended color list for matching
        const colorList = ['Black', 'White', 'Red', 'Blue', 'Green', 'Yellow', 'Pink', 'Purple', 'Orange', 'Brown', 'Grey', 'Gray', 'Beige', 'Navy', 'Khaki', 'Apricot', 'Wine', 'Coffee', 'Camel', 'Cream', 'Rose', 'Gold', 'Silver', 'Ivory', 'Mint', 'Coral', 'Burgundy', 'Maroon', 'Olive', 'Teal', 'Turquoise', 'Lavender', 'Lilac', 'Peach', 'Tan', 'Charcoal', 'Violet', 'Nude', 'Dark Grey', 'Light Grey', 'Dark Blue', 'Light Blue', 'Sky Blue', 'Dark Green', 'Light Green', 'Dark Pink', 'Light Pink', 'Off White'];
        const colorSet = new Set(colorList.map(c => c.toLowerCase()));
        const colorPattern = /\b(Black|White|Red|Blue|Green|Yellow|Pink|Purple|Orange|Brown|Grey|Gray|Beige|Navy|Khaki|Apricot|Wine|Coffee|Camel|Cream|Rose|Gold|Silver|Ivory|Mint|Coral|Burgundy|Maroon|Olive|Teal|Turquoise|Lavender|Lilac|Peach|Tan|Charcoal|Sky Blue|Dark Blue|Light Blue|Light Green|Dark Green|Light Pink|Dark Pink|Off White|Nude|Violet|Dark Grey|Light Grey)\b/gi;
        
        // Device model patterns (phones, tablets, etc.)
        const deviceModelPattern = /\b(iPhone\s*\d+\s*(?:Pro|Plus|Max|mini|SE)?(?:\s*Max)?|Samsung\s*(?:S|A|Note|Galaxy)\s*\d+(?:\s*(?:Plus|Ultra|FE))?|Xiaomi|Huawei|Redmi|OPPO|Vivo|OnePlus|Pixel|iPad|Galaxy\s*Tab)/i;
        
        // Helper function to check if a string is a known color (use non-global regex to avoid lastIndex issues)
        const isColor = (s: string): boolean => {
          const lower = s.toLowerCase().trim();
          if (colorSet.has(lower)) return true;
          // Use non-global regex for test() to avoid lastIndex state issues
          const colorTestPattern = /\b(Black|White|Red|Blue|Green|Yellow|Pink|Purple|Orange|Brown|Grey|Gray|Beige|Navy|Khaki|Apricot|Wine|Coffee|Camel|Cream|Rose|Gold|Silver|Ivory|Mint|Coral|Burgundy|Maroon|Olive|Teal|Turquoise|Lavender|Lilac|Peach|Tan|Charcoal|Sky Blue|Dark Blue|Light Blue|Light Green|Dark Green|Light Pink|Dark Pink|Off White|Nude|Violet|Dark Grey|Light Grey)\b/i;
          return colorTestPattern.test(s);
        };
        
        // Helper function to check if a string is a device model (use non-global regex)
        const isDeviceModel = (s: string): boolean => {
          const deviceTestPattern = /\b(iPhone\s*\d+\s*(?:Pro|Plus|Max|mini|SE)?(?:\s*Max)?|Samsung\s*(?:S|A|Note|Galaxy)\s*\d+(?:\s*(?:Plus|Ultra|FE))?|Xiaomi|Huawei|Redmi|OPPO|Vivo|OnePlus|Pixel|iPad|Galaxy\s*Tab)/i;
          return deviceTestPattern.test(s);
        };

        const tryAddCanonicalSize = (value: unknown): string | null => {
          const canonicalSize = extractCanonicalSize(value);
          if (canonicalSize) {
            sizes.add(canonicalSize);
            return canonicalSize;
          }
          return null;
        };
        
        // Helper to parse a combined value like "Violet-iPhone 11Pro Max"
        const parseVariantValue = (value: string) => {
          if (!value) return;
          
          // Clean Chinese characters
          let cleanVal = value.replace(/[\u4e00-\u9fff]/g, '').trim();
          if (!cleanVal || cleanVal.length > 60) return;
          
          // Try to split on common delimiters
          const delimiters = ['-', '/', '|', '_'];
          let parts: string[] = [cleanVal];
          
          for (const delim of delimiters) {
            if (cleanVal.includes(delim)) {
              // Split and check if first part looks like a color
              const splitParts = cleanVal.split(delim).map(p => p.trim()).filter(Boolean);
              if (splitParts.length >= 2 && isColor(splitParts[0])) {
                parts = splitParts;
                break;
              }
            }
          }
          
          if (parts.length >= 2 && isColor(parts[0])) {
            // First part is color, rest is model/size
            colors.add(parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase());
            const remainder = parts.slice(1).join(' ').trim();
            if (remainder) {
              if (isDeviceModel(remainder)) {
                models.add(remainder);
              } else {
                tryAddCanonicalSize(remainder);
              }
            }
          } else if (parts.length === 1) {
            // Single value - classify it
            const val = parts[0];
            if (isColor(val)) {
              colors.add(val.charAt(0).toUpperCase() + val.slice(1).toLowerCase());
            } else if (isDeviceModel(val)) {
              models.add(val);
            } else {
              tryAddCanonicalSize(val);
            }
          }
        };
        
        for (const v of variants) {
          // 1. First try explicit fields (most reliable)
          const explicitSize = v.size || v.sizeNameEn || v.sizeName;
          const explicitColor = v.color || v.colour || v.colorNameEn || v.colorName;
          const explicitModel = v.model || v.modelNameEn || v.modelName;
          
          if (explicitColor) {
            const cleanColor = String(explicitColor).replace(/[\u4e00-\u9fff]/g, '').trim();
            if (cleanColor && cleanColor.length > 0 && cleanColor.length < 50 && /[a-zA-Z]/.test(cleanColor)) {
              colors.add(cleanColor);
            }
          }
          
          if (explicitSize) {
            const cleanSize = String(explicitSize).replace(/[\u4e00-\u9fff]/g, '').trim();
            if (cleanSize && cleanSize.length > 0 && cleanSize.length < 50) {
              if (!tryAddCanonicalSize(cleanSize) && isDeviceModel(cleanSize)) {
                models.add(cleanSize);
              }
            }
          }
          
          if (explicitModel) {
            const cleanModel = String(explicitModel).replace(/[\u4e00-\u9fff]/g, '').trim();
            if (cleanModel && cleanModel.length > 0 && cleanModel.length < 50) {
              models.add(cleanModel);
            }
          }
          
          // 2. Check variant properties (structured data)
          const vProps = v.variantPropertyList || v.propertyList || v.properties || [];
          if (Array.isArray(vProps)) {
            for (const p of vProps) {
              const propName = String(p.propertyNameEn || p.propertyName || p.name || '').toLowerCase();
              const propValue = String(p.propertyValueNameEn || p.propertyValueName || p.value || p.name || '').trim();
              if (propValue && propValue.length > 0 && propValue.length < 50) {
                const cleanValue = propValue.replace(/[\u4e00-\u9fff]/g, '').trim();
                if (!cleanValue) continue;
                
                if (propName.includes('color') || propName.includes('colour')) {
                  if (/[a-zA-Z]/.test(cleanValue)) {
                    colors.add(cleanValue);
                  }
                } else if (propName.includes('model') || propName.includes('device') || propName.includes('phone')) {
                  models.add(cleanValue);
                } else if (propName.includes('size') || propName.includes('type') || propName.includes('version')) {
                  const canonicalSize = extractCanonicalSize(cleanValue);
                  if (canonicalSize) {
                    sizes.add(canonicalSize);
                  } else if (isDeviceModel(cleanValue)) {
                    models.add(cleanValue);
                  }
                }
              }
            }
          }
          
          // 3. Parse variantKey (may contain combined color-model like "Violet-iPhone 11Pro")
          // Always parse for sizes/models extraction
          if (v.variantKey) {
            parseVariantValue(String(v.variantKey));
          }
          
          // NOTE: variantNameEn parsing REMOVED - it causes garbage data like "Retro-style shoes gold 35"
          // Colors should come from productPropertyList (structured data) or explicit variant fields only
        }
        
        // Sanitize values - strip any HTML/script tags
        const stripHtml = (s: string) => s.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').trim();
        const safeColors = dedupeLabelsCaseInsensitive(
          [...colors].map(stripHtml).filter(c => c.length > 0 && c.length < 50)
        );
        const safeSizes = normalizeSizeList([...sizes].map(stripHtml).filter(Boolean));
        const safeModels = dedupeLabelsCaseInsensitive(
          [...models].map(stripHtml).filter(m => m.length > 0 && m.length < 50)
        );
        
        // Only add to specs if not already present (avoid duplicates)
        // Use extractedColors (from productPropertyList) if available, otherwise use variant-extracted colors
        const baseSpecsLower = (baseSpecs || '').toLowerCase();
        const displayColors = extractedColors.length > 0 ? extractedColors : safeColors;
        if (displayColors.length > 0 && !baseSpecsLower.includes('colors:')) {
          allSpecs.push(`Colors: ${displayColors.slice(0, 15).join(', ')}`);
        }
        if (safeModels.length > 0) {
          allSpecs.push(`Compatible Devices: ${safeModels.slice(0, 25).join(', ')}`);
        }
        if (safeSizes.length > 0 && !baseSpecsLower.includes('sizes:')) {
          allSpecs.push(`Sizes: ${safeSizes.slice(0, 15).join(', ')}`);
        }
        
        console.log(`[Search&Price] Product ${pid}: ${safeColors.length} colors, ${safeSizes.length} sizes, ${safeModels.length} models from ${variants.length} variants`);
        
        // Store for later use - preserve productPropertyList colors if they exist (they are the primary source)
        extractedSizes = safeSizes;
        if (extractedColors.length === 0) {
          // Only use variant-extracted colors if productPropertyList didn't provide any
          extractedColors = safeColors;
        }
        extractedModels = safeModels;
      }
      
      // Combine all specs into finalProductInfo
      // Note: productInfo should contain variant specs (colors, sizes) while Overview has basic product specs
      // This prevents duplication between the two sections
      let finalProductInfo: string | undefined = allSpecs.length > 0 ? allSpecs.join('<br/>') : undefined;
      
      // Don't add duplicate fallback here - Overview already shows Category, Material, Weight etc.
      // productInfo is specifically for variant/specification details not shown in Overview
      
      // Merge with deterministic source ordering:
      // 1) full-details extraction (already hero-ranked), 2) color map, 3) variant media, 4) list item fallback.
      const byCanonicalKey = new Map<string, { url: string; score: number; firstSeenAt: number }>();
      let imageSequence = 0;
      const pushFinalImage = (url: unknown) => {
        if (typeof url !== 'string') return;
        const cleaned = enhanceProductImageUrl(url.trim(), 'gallery');
        if (!cleaned.startsWith('http')) return;
        const key = normalizeCjImageKey(cleaned);
        if (!key) return;

        const score = scoreMergedImageCandidate(cleaned, imageSequence);
        const existing = byCanonicalKey.get(key);
        if (!existing) {
          byCanonicalKey.set(key, { url: cleaned, score, firstSeenAt: imageSequence });
          imageSequence += 1;
          return;
        }

        if (score > existing.score) {
          byCanonicalKey.set(key, {
            url: cleaned,
            score,
            firstSeenAt: existing.firstSeenAt,
          });
        }

        imageSequence += 1;
      };

      for (const img of images) pushFinalImage(img);
      for (const colorImg of Object.values(colorImageMap)) pushFinalImage(colorImg);
      for (const img of variantImages) pushFinalImage(img);
      if (source !== item) {
        for (const fallbackImg of extractAllImages(item)) {
          pushFinalImage(fallbackImg);
        }
      }

      const allImages = Array.from(byCanonicalKey.values())
        .sort((a, b) => a.firstSeenAt - b.firstSeenAt)
        .map((entry) => entry.url);

      images = prioritizeCjHeroImage(allImages).slice(0, 50);
      console.log(`[Search&Price] Product ${pid}: Final ${images.length} images (deterministic merge)`);
      
      // Log colorImageMap if populated (for debugging)
      if (Object.keys(colorImageMap).length > 0) {
        console.log(`[Search&Price] Product ${pid}: colorImageMap = ${JSON.stringify(colorImageMap)}`);
      }
      
      const pricedVariants: PricedVariant[] = [];
      
      
      if (variants.length === 0) {
        // Single variant product - try to get exact shipping using product-level vid
        const sellPrice = Number(item.sellPrice || item.price || 0);
        const costSAR = usdToSar(sellPrice);
        const singleVariantOptions = extractVariantOptionsFromRawVariant(item);
        const singleVariantSignature = buildOptionSignature(singleVariantOptions);
        
        // For single-variant products, use pid or product-level vid
        const variantVid = String(item.vid || item.variants?.[0]?.vid || pid || '');
        
        let shippingPriceUSD = 0;
        let shippingPriceSAR = 0;
        let shippingAvailable = false;
        let deliveryDays = 'Unknown';
        let logisticName: string | undefined;
        let shippingError: string | undefined;
        
        if (variantVid) {
          // Reactive rate limiting: only add delay if we recently hit rate limits
          if (consecutiveRateLimitErrors > 0) {
            const backoffMs = Math.min(consecutiveRateLimitErrors * 500, 2000);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
          }
          
          try {
            const freight = await freightCalculate({
              countryCode: 'US',
              vid: variantVid,
              quantity: 1,
            });
            
            if (!freight.ok) {
              shippingError = freight.message;
              // Check for rate limit error (code 1600200)
              if (freight.message.includes('1600200') || freight.message.includes('Too Many Requests')) {
                consecutiveRateLimitErrors++;
                console.log(`[Search&Price] Rate limit error #${consecutiveRateLimitErrors}: ${freight.message}`);
              }
            } else if (freight.options.length > 0) {
              consecutiveRateLimitErrors = 0; // Reset on success
              const selectedShippingOption = findCheapestConfiguredShippingOption(freight.options);
              if (selectedShippingOption) {
                shippingPriceUSD = selectedShippingOption.price;
                shippingPriceSAR = usdToSar(shippingPriceUSD);
                shippingAvailable = true;
                logisticName = selectedShippingOption.name;
                if (selectedShippingOption.logisticAgingDays) {
                  const { min, max } = selectedShippingOption.logisticAgingDays;
                  deliveryDays = max ? `${min}-${max} days` : `${min} days`;
                }
              } else {
                shippingError = 'No configured shipping methods available';
              }
            } else {
              shippingError = 'No shipping options to USA';
            }
          } catch (e: any) {
            shippingError = e?.message || 'Shipping failed';
            if (shippingError && (shippingError.includes('429') || shippingError.includes('Too Many'))) {
              consecutiveRateLimitErrors++;
            }
          }
        } else {
          shippingError = 'No variant ID available';
        }
        
        if (shippingAvailable) {
          const totalCostSAR = costSAR + shippingPriceSAR;
          const sellPriceSAR = calculateSellPriceWithMargin(totalCostSAR, profitMargin);
          const profitSAR = sellPriceSAR - totalCostSAR;
          const totalCostUSD = Number((sellPrice + shippingPriceUSD).toFixed(2));
          const sellPriceUSD = sarToUsd(sellPriceSAR);
          const profitUSD = Number((sellPriceUSD - totalCostUSD).toFixed(2));
          const marginPercent = sellPriceUSD > 0
            ? Number(((profitUSD / sellPriceUSD) * 100).toFixed(2))
            : 0;
          
          // Get variant stock from the inventory map using multiple key fallbacks
          // Single-variant product: try productSku, pid, or first available stock entry (aggregate if multiple rows)
          let variantStock = getVariantStock({
            vid: pid,
            sku: item.productSku,
          });
          if (!variantStock && variantStockMap.size > 0) {
            // For single-variant products with multiple inventory rows (e.g., different warehouses),
            // aggregate all entries to get the total stock
            const allStocks = Array.from(variantStockMap.values());
            variantStock = {
              cjStock: allStocks.reduce((sum, s) => sum + s.cjStock, 0),
              factoryStock: allStocks.reduce((sum, s) => sum + s.factoryStock, 0),
              totalStock: allStocks.reduce((sum, s) => sum + s.totalStock, 0),
            };
          }
          // FALLBACK: For single-variant products, use product-level inventory if per-variant lookup failed
          // This ensures we don't show 0/0 when product-level data is available
          if (!variantStock && realInventory) {
            console.log(`[Search&Price] Product ${pid}: Using product-level inventory for single variant`);
            variantStock = {
              cjStock: realInventory.totalCJ,
              factoryStock: realInventory.totalFactory,
              totalStock: realInventory.totalAvailable,
            };
          }
          
          pricedVariants.push({
            variantId: pid,
            variantSku: item.productSku || pid,
            variantPriceUSD: sellPrice,
            shippingAvailable,
            shippingPriceUSD,
            shippingPriceSAR,
            deliveryDays,
            logisticName,
            sellPriceSAR,
            sellPriceUSD,
            totalCostSAR,
            totalCostUSD,
            profitSAR,
            profitUSD,
            marginPercent,
            error: shippingError,
            stock: variantStock?.totalStock,
            cjStock: variantStock?.cjStock,
            factoryStock: variantStock?.factoryStock,
            variantOptions: Object.keys(singleVariantOptions).length > 0 ? singleVariantOptions : undefined,
            optionSignature: singleVariantSignature || undefined,
          });
        }
        
        // Stop processing if we hit 3+ consecutive rate limit errors (likely real quota issue)
        if (consecutiveRateLimitErrors >= 3) {
          console.log(`[Search&Price] Stopping after ${consecutiveRateLimitErrors} consecutive rate limit errors`);
          break;
        }
      } else {
        // Multi-variant product - check heaviest variants first to find HIGHEST shipping cost
        // This ensures we match CJ's "According to Shipping Method" which uses the heaviest variant
        const MAX_VARIANTS_TO_CHECK = 2; // Only check 2 variants (heaviest first) to stay within timeout
        
        // Sort variants by weight (descending) to check heaviest first
        // CJ shipping cost is primarily driven by weight, so heaviest = highest shipping
        const sortedVariants = [...variants].sort((a, b) => {
          const weightA = Number(a.packWeight || a.variantWeight || a.weight || 0);
          const weightB = Number(b.packWeight || b.variantWeight || b.weight || 0);
          return weightB - weightA; // Descending (heaviest first)
        });
        
        // Collect all valid shipping quotes, then pick the highest
        const variantShippingQuotes: Array<{
          variantIndex: number;
          variant: any;
          shippingPriceUSD: number;
          shippingPriceSAR: number;
          deliveryDays: string;
          logisticName: string;
        }> = [];
        
        for (let i = 0; i < Math.min(sortedVariants.length, MAX_VARIANTS_TO_CHECK); i++) {
          // Stop checking if we hit rate limit or time budget exceeded
          if (consecutiveRateLimitErrors >= 3) break;
          if (Date.now() - startTime > 50000) {
            console.log(`[Search&Price] Time budget exceeded (50s), stopping variant checks`);
            break;
          }
          
          const variant = sortedVariants[i];
          const variantId = String(variant.vid || variant.variantId || variant.id || '');
          const variantSku = String(variant.variantSku || variant.sku || variantId);
          const variantPriceUSD = Number(variant.variantSellPrice || variant.sellPrice || variant.price || 0);
          const costSAR = usdToSar(variantPriceUSD);
          
          const variantName = String(variant.variantNameEn || variant.variantName || '').replace(/[\u4e00-\u9fff]/g, '').trim() || undefined;
          const variantImage = variant.variantImage || variant.whiteImage || variant.image || undefined;
          const size = variant.size || variant.sizeNameEn || undefined;
          const color = variant.color || variant.colorNameEn || undefined;
          
          let shippingPriceUSD = 0;
          let shippingPriceSAR = 0;
          let shippingAvailable = false;
          let deliveryDays = 'Unknown';
          let logisticName: string | undefined;
          let shippingError: string | undefined;
          
          if (variantId) {
            // Reactive rate limiting: only add delay if we recently hit rate limits
            if (consecutiveRateLimitErrors > 0) {
              const backoffMs = Math.min(consecutiveRateLimitErrors * 500, 2000);
              await new Promise(resolve => setTimeout(resolve, backoffMs));
            }
            
            try {
              const freight = await freightCalculate({
                countryCode: 'US',
                vid: variantId,
                quantity: 1,
              });
              
              if (!freight.ok) {
                shippingError = freight.message;
                shippingErrors[shippingError] = (shippingErrors[shippingError] || 0) + 1;
                // Check for rate limit error
                if (freight.message.includes('1600200') || freight.message.includes('Too Many Requests')) {
                  consecutiveRateLimitErrors++;
                  console.log(`[Search&Price] Rate limit error #${consecutiveRateLimitErrors}: ${freight.message}`);
                }
              } else if (freight.options.length > 0) {
                consecutiveRateLimitErrors = 0; // Reset on success
                const selectedShippingOption = findCheapestConfiguredShippingOption(freight.options);
                if (selectedShippingOption) {
                  shippingPriceUSD = selectedShippingOption.price;
                  shippingPriceSAR = usdToSar(shippingPriceUSD);
                  shippingAvailable = true;
                  logisticName = selectedShippingOption.name;
                  if (selectedShippingOption.logisticAgingDays) {
                    const { min, max } = selectedShippingOption.logisticAgingDays;
                    deliveryDays = max ? `${min}-${max} days` : `${min} days`;
                  }
                } else {
                  shippingError = 'No configured shipping methods available';
                  shippingErrors[shippingError] = (shippingErrors[shippingError] || 0) + 1;
                }
              } else {
                shippingError = 'No shipping options to USA';
                shippingErrors[shippingError] = (shippingErrors[shippingError] || 0) + 1;
              }
            } catch (e: any) {
              shippingError = e?.message || 'Shipping failed';
              if (shippingError) {
                shippingErrors[shippingError] = (shippingErrors[shippingError] || 0) + 1;
                if (shippingError.includes('429') || shippingError.includes('Too Many')) {
                  consecutiveRateLimitErrors++;
                }
              }
            }
          }
          
          // Stop checking variants if we hit too many consecutive rate limit errors
          if (consecutiveRateLimitErrors >= 3) {
            console.log(`[Search&Price] Stopping variant check after ${consecutiveRateLimitErrors} consecutive rate limit errors`);
            break;
          }
          
          if (shippingAvailable && logisticName) {
            // Collect this quote - we'll pick the highest later
            variantShippingQuotes.push({
              variantIndex: i,
              variant,
              shippingPriceUSD,
              shippingPriceSAR,
              deliveryDays,
              logisticName,
            });
            console.log(`[Search&Price] Product ${pid} variant ${i + 1}: selected configured shipping ${logisticName} $${shippingPriceUSD.toFixed(2)}`);
          } else {
            console.log(`[Search&Price] Product ${pid} variant ${i+1}: ${shippingError}`);
          }
        }
        
        // Now pick the variant with the HIGHEST shipping cost (matches CJ's heaviest variant logic)
        if (variantShippingQuotes.length > 0) {
          // Sort by shipping price descending and take the highest
          variantShippingQuotes.sort((a, b) => b.shippingPriceUSD - a.shippingPriceUSD);
          const highest = variantShippingQuotes[0];
          
          console.log(`[Search&Price] Product ${pid}: Using HIGHEST shipping $${highest.shippingPriceUSD.toFixed(2)} from variant ${highest.variantIndex + 1} of ${variantShippingQuotes.length} checked`);

          // Keep per-variant product pricing while reusing the selected shipping baseline.
          // This preserves color/size fidelity in queue/import and prevents one-variant collapse.
          for (const variant of variants) {
            const variantId = String(variant.vid || variant.variantId || variant.id || '');
            const variantSku = String(variant.variantSku || variant.sku || variantId);
            const rawVariantPriceUSD = Number(variant.variantSellPrice || variant.sellPrice || variant.price || 0);
            const variantPriceUSD = Number.isFinite(rawVariantPriceUSD) && rawVariantPriceUSD > 0
              ? rawVariantPriceUSD
              : Number(item.sellPrice || item.price || 0);

            if (!Number.isFinite(variantPriceUSD) || variantPriceUSD <= 0) {
              continue;
            }

            const costSAR = usdToSar(variantPriceUSD);
            const variantName = String(variant.variantNameEn || variant.variantName || '').replace(/[\u4e00-\u9fff]/g, '').trim() || undefined;
            const { size, color } = extractVariantColorSize(variant, variantName);
            const variantOptions = extractVariantOptionsFromRawVariant(variant);
            if (color && !Object.keys(variantOptions).some((name) => /color|colour/i.test(name))) {
              variantOptions.Color = color;
            }
            if (size && !Object.keys(variantOptions).some((name) => /size/i.test(name))) {
              variantOptions.Size = size;
            }
            const optionSignature = buildOptionSignature(variantOptions);
            const variantImage = resolveColorImageFromMap(
              color,
              colorImageMap,
              variant.variantImage || variant.whiteImage || variant.image || undefined
            );

            const totalCostSAR = costSAR + highest.shippingPriceSAR;
            const sellPriceSAR = calculateSellPriceWithMargin(totalCostSAR, profitMargin);
            const profitSAR = sellPriceSAR - totalCostSAR;
            const totalCostUSD = Number((variantPriceUSD + highest.shippingPriceUSD).toFixed(2));
            const sellPriceUSD = sarToUsd(sellPriceSAR);
            const profitUSD = Number((sellPriceUSD - totalCostUSD).toFixed(2));
            const marginPercent = sellPriceUSD > 0
              ? Number(((profitUSD / sellPriceUSD) * 100).toFixed(2))
              : 0;

            const variantKey = String(variant.variantKey || '');
            const variantStock = getVariantStock({
              vid: variantId,
              variantId,
              sku: variantSku,
              variantKey,
              variantName,
            });

            pricedVariants.push({
              variantId,
              variantSku,
              variantPriceUSD,
              shippingAvailable: true,
              shippingPriceUSD: highest.shippingPriceUSD,
              shippingPriceSAR: highest.shippingPriceSAR,
              deliveryDays: highest.deliveryDays,
              logisticName: highest.logisticName,
              sellPriceSAR,
              sellPriceUSD,
              totalCostSAR,
              totalCostUSD,
              profitSAR,
              profitUSD,
              marginPercent,
              variantName,
              variantImage,
              size,
              color,
              stock: variantStock?.totalStock,
              cjStock: variantStock?.cjStock,
              factoryStock: variantStock?.factoryStock,
              variantOptions: Object.keys(variantOptions).length > 0 ? variantOptions : undefined,
              optionSignature: optionSignature || undefined,
            });
          }

          console.log(
            `[Search&Price] Product ${pid}: Priced ${pricedVariants.length}/${variants.length} variants using shared shipping baseline ${highest.shippingPriceUSD.toFixed(2)} USD`
          );
        }
      }
      
      // Stop processing more products if we hit too many consecutive rate limit errors
      if (consecutiveRateLimitErrors >= 3) {
        console.log(`[Search&Price] Stopping product processing after ${consecutiveRateLimitErrors} consecutive rate limit errors`);
        break;
      }
      
      if (pricedVariants.length === 0) {
        // No allowed shipping method quote was available for this product
        console.log(`[Search&Price] Product ${pid} - no configured shipping quote available, skipping`);
        skippedNoShipping++;
        continue;
      }
      
      const successfulVariants = pricedVariants.filter(v => v.shippingAvailable).length;
      const prices = pricedVariants.map(v => v.sellPriceSAR);
      const minPriceSAR = Math.min(...prices);
      const maxPriceSAR = Math.max(...prices);
      const avgPriceSAR = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
      const usdPrices = pricedVariants
        .map(v => Number(v.sellPriceUSD ?? sarToUsd(v.sellPriceSAR)))
        .filter((price) => Number.isFinite(price) && price > 0);
      const minPriceUSD = usdPrices.length > 0 ? Math.min(...usdPrices) : 0;
      const maxPriceUSD = usdPrices.length > 0 ? Math.max(...usdPrices) : 0;
      const avgPriceUSD = usdPrices.length > 0
        ? Number((usdPrices.reduce((sum, price) => sum + price, 0) / usdPrices.length).toFixed(2))
        : 0;

      const supplierMetrics = extractSupplierReviewMetrics(source, source !== item ? item : undefined);
      rating = supplierMetrics.rating;
      reviewCount = supplierMetrics.reviewCount;
      reviewMetricsSource = supplierMetrics.source === 'none' ? 'none' : 'supplier';

      if (!(Number.isFinite(reviewCount) && reviewCount > 0)) {
        const syntheticReviewProfile = buildSyntheticReviewProfile(pid);
        reviewCount = syntheticReviewProfile.reviewCount;
        reviewMetricsSource = 'synthetic';
      }

      console.log(
        `[Search&Price] Product ${pid} review metrics: rating=${typeof rating === 'number' ? rating.toFixed(2) : 'n/a'} reviewCount=${reviewCount} source=${reviewMetricsSource}`
      );

      let displayedRating: number | undefined;
      let ratingConfidence: number | undefined;
      try {
        const imagesCount = Array.isArray(images) ? images.length : 0;
        const minVariantUsd = pricedVariants.length > 0 ? Math.min(...pricedVariants.map(v => v.variantPriceUSD || 0)) : 0;
        const imgNorm = Math.max(0, Math.min(1, imagesCount / 15));
        const priceNorm = Math.max(0, Math.min(1, minVariantUsd / 50));
        const dynQuality = Math.max(0, Math.min(1, 0.6 * imgNorm + 0.4 * (1 - priceNorm)));
        const out = computeRating({
          imageCount: imagesCount,
          stock,
          variantCount: pricedVariants.length,
          qualityScore: dynQuality,
          priceUsd: minVariantUsd,
          sentiment: 0,
          orderVolume: listedNum,
        });

        const hasSupplierRating = typeof rating === 'number' && Number.isFinite(rating) && rating > 0;
        if (hasSupplierRating) {
          displayedRating = normalizeDisplayedRating(rating);
          rating = displayedRating;
        } else {
          displayedRating = out.displayedRating;
        }

        if (hasSupplierRating && reviewCount > 0) {
          const countBasedConfidence = Math.min(1, 0.65 + (Math.log10(reviewCount + 1) / 4));
          ratingConfidence = Math.max(out.ratingConfidence, Number(countBasedConfidence.toFixed(2)));
        } else {
          ratingConfidence = out.ratingConfidence;
        }

        const minRatingNum = minRating === 'any' ? 0 : Number(minRating);
        if (Number.isFinite(minRatingNum) && displayedRating < minRatingNum) {
          totalFiltered.rating++;
          continue;
        }
      } catch {}
      
      // Extract processing/delivery time estimates from CJ data
      const deliveryCycle = source.deliveryCycle;
      const processDay = source.processDay || source.processingTime || source.processTime || source.prepareDay;
      
      // Helper to parse time values (can be "3", "2-7", "3-7 days", etc.)
      const parseTimeValue = (val: any): { display: string | undefined; hours: number | undefined } => {
        if (!val) return { display: undefined, hours: undefined };
        const strVal = String(val).trim();
        if (!strVal) return { display: undefined, hours: undefined };
        
        // Check if already has time units
        const hasUnits = /day|hour|week/i.test(strVal);
        const display = hasUnits ? strVal : `${strVal} days`;
        
        // Extract first number for hours calculation (if pure number or range start)
        const numMatch = strVal.match(/^(\d+)/);
        const hours = numMatch ? Number(numMatch[1]) * 24 : undefined;
        
        return { display, hours: (hours && !isNaN(hours)) ? hours : undefined };
      };
      
      const processingParsed = parseTimeValue(processDay);
      const deliveryParsed = parseTimeValue(deliveryCycle);
      
      const estimatedProcessingDays = processingParsed.display;
      const estimatedDeliveryDays = deliveryParsed.display;
      const processingTimeHours = processingParsed.hours;
      const deliveryTimeHours = deliveryParsed.hours;
      
      // Extract origin country and HS code
      const originCountry = String(source.originCountry || source.countryOrigin || source.originArea || '').trim() || undefined;
      const hsCode = source.entryCode ? `${source.entryCode}${source.entryNameEn ? ` (${source.entryNameEn})` : ''}` : undefined;

      const availableOptions = deriveAvailableOptionsFromVariants(
        pricedVariants.map((variant) => ({
          variantOptions: variant.variantOptions,
          stock: variant.stock,
          cjStock: variant.cjStock,
          factoryStock: variant.factoryStock,
          color: variant.color,
          size: variant.size,
        })),
        { includeOutOfStockDimensions: false }
      );
      const legacyFromDynamicOptions = deriveLegacyOptionArrays(availableOptions);
      const resolvedAvailableSizes = legacyFromDynamicOptions.availableSizes;
      const resolvedAvailableColors = legacyFromDynamicOptions.availableColors;
      const resolvedAvailableModels = legacyFromDynamicOptions.availableModels;
      
      pricedProducts.push({
        pid,
        cjSku,
        name,
        images,
        minPriceSAR,
        maxPriceSAR,
        avgPriceSAR,
        minPriceUSD,
        maxPriceUSD,
        avgPriceUSD,
        profitMarginApplied: profitMargin,
        stock,
        listedNum,
        // Inventory breakdown from CJ's dedicated inventory API (most accurate)
        totalVerifiedInventory: totalVerifiedInventory > 0 ? totalVerifiedInventory : undefined,
        totalUnVerifiedInventory: totalUnVerifiedInventory > 0 ? totalUnVerifiedInventory : undefined,
        // Full warehouse inventory object (for detailed display on Page 4)
        inventory: realInventory ? {
          totalCJ: realInventory.totalCJ,
          totalFactory: realInventory.totalFactory,
          totalAvailable: realInventory.totalAvailable,
          warehouses: realInventory.warehouses,
        } : undefined,
        // Inventory fetch status for UI feedback
        inventoryStatus,
        inventoryErrorMessage: inventoryErrorMessage || undefined,
        variants: pricedVariants,
        // ALL variant inventory data for Page 4 blue box display
        inventoryVariants: inventoryVariants.length > 0 ? inventoryVariants : undefined,
        successfulVariants,
        totalVariants: pricedVariants.length,
        description,
        overview,
        productInfo: finalProductInfo,
        sizeInfo,
        productNote,
        packingList,
        displayedRating,
        ratingConfidence,
        rating,
        reviewCount,
        supplierName,
        itemAsDescribed,
        serviceRating,
        shippingSpeedRating,
        categoryName,
        productWeight,
        packLength,
        packWidth,
        packHeight,
        material,
        productType,
        sizeChartImages: sizeChartImages.length > 0 ? sizeChartImages : undefined,
        processingTimeHours,
        deliveryTimeHours,
        estimatedProcessingDays,
        estimatedDeliveryDays,
        originCountry,
        hsCode,
        videoUrl: hasDeliverableVideo ? storefrontVideoUrl : undefined,
        videoSourceUrl: videoDelivery.sourceUrl,
        video4kUrl: hasDeliverableVideo ? storefrontVideoUrl : undefined,
        videoDeliveryMode: videoDelivery.mode,
        videoQualityGatePassed: videoDelivery.qualityGatePassed,
        videoSourceQualityHint: videoDelivery.sourceQualityHint,
        availableOptions: availableOptions.length > 0 ? availableOptions : undefined,
        availableSizes: resolvedAvailableSizes.length > 0 ? resolvedAvailableSizes : undefined,
        availableColors: resolvedAvailableColors.length > 0 ? resolvedAvailableColors : undefined,
        availableModels: resolvedAvailableModels.length > 0 ? resolvedAvailableModels : undefined,
        // Color-to-image mapping for color swatches
        colorImageMap: Object.keys(colorImageMap).length > 0 ? colorImageMap : undefined,
      });
      
      // Track batch progress
      productsProcessedThisBatch++;
    }
    
    // Apply post-hydration filters (sizes)
    let filteredProducts = pricedProducts;
    let filteredBySizes = 0;
    
    // Filter by requested sizes
    if (requestedSizes.length > 0) {
      const beforeCount = filteredProducts.length;
      filteredProducts = filteredProducts.filter(p => {
        const productSizes = (p as any).availableSizes || [];
        // Products without sizes (e.g., electronics) pass through
        if (productSizes.length === 0) return true;
        // Check if any requested size matches product sizes
        const normalizedProductSizes = normalizeSizeList(productSizes);
        return requestedSizes.some(rs => normalizedProductSizes.includes(rs));
      });
      filteredBySizes = beforeCount - filteredProducts.length;
      console.log(`[Search&Price] Filtered ${filteredBySizes} products not matching sizes: ${requestedSizes.join(',')}`);
    }
    
    // NOTE: Inventory is now fetched DURING product processing loop via getInventoryByPid
    // This ensures each product has inventory data before being pushed to pricedProducts
    
    const duration = Date.now() - startTime;
    console.log(`[Search&Price] Complete: ${filteredProducts.length}/${quantity} products returned (${pricedProducts.length} priced, ${skippedNoShipping} skipped no shipping, ${filteredBySizes} filtered by size, ${totalFiltered.existing} excluded existing) in ${duration}ms`);
    console.log(`[Search&Price] Media filter stats:`, mediaFilterStats);
    console.log(`[Search&Price] Shipping error breakdown:`, shippingErrors);
    
    // Determine fulfillment status
    const quantityFulfilled = filteredProducts.length >= quantity;
    const hitRateLimit = consecutiveRateLimitErrors >= 3;
    const hitTimeLimit = Date.now() - startTime > maxDurationMs;
    const exhaustedCandidates = candidateIndex >= candidateProducts.length;
    
    // Determine shortfall reason
    let shortfallReason: string | undefined;
    if (!quantityFulfilled) {
      if (hitRateLimit) {
        shortfallReason = 'CJ API rate limit reached. Try again in a few minutes.';
      } else if (hitTimeLimit) {
        shortfallReason = `Processing time exceeded. Got ${filteredProducts.length}/${quantity} products.`;
      } else if (mediaMode !== 'any' && mediaFilterStats.passed === 0) {
        shortfallReason = `No products matched media filter "${mediaMode}". Checked ${mediaFilterStats.checked} candidates and filtered out ${mediaFilterStats.filteredOut}.`;
      } else if (exhaustedCandidates) {
        shortfallReason = mediaMode === 'any'
          ? `Not enough matching products found. Got ${filteredProducts.length}/${quantity} products.`
          : `Not enough products matching media filter "${mediaMode}". Got ${filteredProducts.length}/${quantity} products.`;
      } else {
        shortfallReason = `Shipping calculation failed for some products. Got ${filteredProducts.length}/${quantity} products.`;
      }
      console.log(`[Search&Price] Quantity shortfall: ${shortfallReason}`);
    }
    
    // Return error if no products at all and rate limited
    if (hitRateLimit && filteredProducts.length === 0) {
      console.log(`[Search&Price] Rate limit hit with no products - returning error`);
      const r = NextResponse.json({
        ok: false,
        error: 'CJ API rate limit reached. Please wait a minute and try again with fewer products.',
        quotaExhausted: true,
        products: [],
        count: 0,
        requestedQuantity: quantity,
        quantityFulfilled: false,
        mediaMode,
        duration,
        debug: {
          candidatesFound: candidateProducts.length,
          productsProcessed: candidateIndex,
          pricedSuccessfully: 0,
          skippedNoShipping,
          shippingErrors,
          consecutiveRateLimitErrors,
          mediaFilter: mediaFilterStats,
        }
      }, { status: 429, headers: { 'Cache-Control': 'no-store' } });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }
    
    // In batch mode, calculate pagination info
    // hasMore is true when EITHER:
    // 1. There are more pages to fetch (not exhaustedAllPages), OR
    // 2. There are unprocessed candidates remaining from this batch
    // AND we're not rate limited
    const hasMoreCandidatesInBatch = candidateIndex < candidateProducts.length;
    const moreSourcePagesExist = !exhaustedAllPages;
    const hasMoreToProcess = (moreSourcePagesExist || hasMoreCandidatesInBatch) && !hitRateLimit;
    
    // Return ALL attempted PIDs (including filtered/failed) so client can skip them in next batch
    // This is simpler and more reliable than complex cursor tracking
    
    // In batch mode, limit returned products to remainingNeeded (exact quantity control)
    const productsToReturn = isBatchMode 
      ? filteredProducts.slice(0, remainingNeeded)
      : filteredProducts;
    
    const r = NextResponse.json({
      ok: true,
      products: productsToReturn,
      count: productsToReturn.length,
      requestedQuantity: quantity,
      mediaMode,
      quantityFulfilled,
      shortfallReason: quantityFulfilled ? undefined : shortfallReason,
      duration,
      quotaExhausted: hitRateLimit,
      excludedByQueue: queueExcludedPids.size,
      excludedByStore: storeExcludedPids.size,
      excludedTotal: excludedPids.size,
      // Batch mode pagination info
      batch: isBatchMode ? {
        hasMore: hasMoreToProcess && !hitRateLimit,
        // Cursor for resuming: categoryIndex.pageNum.itemOffset
        cursor: `${currentCatIdx}.${currentPage}.${currentItemOffset}`,
        // Return ALL attempted PIDs so client can skip them (backup deduplication)
        attemptedPids: attemptedPidsThisBatch,
        processedPids: productsToReturn.map(p => p.pid),
        totalCandidates: candidateProducts.length,
        productsThisBatch: productsProcessedThisBatch,
        batchSize,
      } : undefined,
      debug: {
        candidatesFound: candidateProducts.length,
        productsProcessed: candidateIndex,
        pricedSuccessfully: pricedProducts.length,
        skippedNoShipping,
        filteredBySizes,
        filteredExisting: totalFiltered.existing,
        shippingErrors,
        hitTimeLimit,
        hitRateLimit,
        exhaustedCandidates,
        exclusion: {
          excludedByQueue: queueExcludedPids.size,
          excludedByStore: storeExcludedPids.size,
          excludedTotal: excludedPids.size,
          skippedByQueue: skippedByQueueExclusion,
          skippedByStore: skippedByStoreExclusion,
        },
        mediaFilter: mediaFilterStats,
      }
    }, { headers: { 'Cache-Control': 'no-store' } });
    r.headers.set('x-request-id', log.requestId);
    return r;
    
  } catch (e: any) {
    console.error('[Search&Price] Error:', e?.message, e?.stack);
    const r = NextResponse.json(
      { ok: false, error: e?.message || 'Search and price failed' }, 
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
    r.headers.set('x-request-id', loggerForRequest(req).requestId);
    return r;
  }
}

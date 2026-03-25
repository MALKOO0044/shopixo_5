import { NextResponse } from 'next/server';
import { ensureAdmin } from '@/lib/auth/admin-guard';
import { getAccessToken, freightCalculate, fetchProductDetailsByPid, getInventoryByPid, queryVariantInventory, getProductVariants, findCheapestConfiguredShippingOption } from '@/lib/cj/v2';
import type { PricedProduct, PricedVariant, InventoryVariant, ProductInventory } from '@/components/admin/import/preview/types';
import { computeRating, normalizeDisplayedRating } from '@/lib/rating/engine';
import { buildSyntheticReviewProfile } from '@/lib/reviews/synthetic-feedback';
import { createClient } from '@supabase/supabase-js';
import { hasTable } from '@/lib/db-features';
import { enhanceProductImageUrl } from '@/lib/media/image-quality';
import { computeRetailFromLanded, sarToUsd, usdToSar } from '@/lib/pricing';
import { extractCjProductGalleryImages, normalizeCjImageKey, prioritizeCjHeroImage } from '@/lib/cj/image-gallery';
import { extractCjProductVideoUrl } from '@/lib/cj/video';
import { normalizeSingleSize, normalizeSizeList } from '@/lib/cj/size-normalization';
import { build4kVideoDelivery } from '@/lib/video/delivery';
import {
  buildOptionSignature,
  deriveAvailableOptionsFromVariants,
  deriveLegacyOptionArrays,
  extractVariantOptionsFromRawVariant,
} from '@/lib/variants/dynamic-options';

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
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

function normalizeVariantColorToken(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveColorImageFromMap(
  color: string | undefined,
  colorImageMap: Record<string, string>,
  fallback?: string
): string | undefined {
  if (fallback && typeof fallback === 'string' && fallback.startsWith('http')) return fallback;
  if (!color || !colorImageMap || Object.keys(colorImageMap).length === 0) return fallback;

  const exact = colorImageMap[color];
  if (typeof exact === 'string' && exact.startsWith('http')) return exact;

  const target = normalizeVariantColorToken(color);
  if (!target) return fallback;

  for (const [mapColor, imageUrl] of Object.entries(colorImageMap)) {
    if (typeof imageUrl !== 'string' || !imageUrl.startsWith('http')) continue;
    const key = normalizeVariantColorToken(mapColor);
    if (!key) continue;
    if (key === target || key.includes(target) || target.includes(key)) {
      return imageUrl;
    }
  }

  return fallback;
}

function extractVariantColorSize(variant: any, fallbackName?: string): { color?: string; size?: string } {
  let size = variant?.size || variant?.sizeNameEn || variant?.sizeName || undefined;
  let color = variant?.color || variant?.colour || variant?.colorNameEn || variant?.colorName || undefined;

  const normalizedExplicitSize = normalizeSingleSize(size, { allowNumeric: false });
  if (normalizedExplicitSize) size = normalizedExplicitSize;

  const variantKeyRaw = String(
    variant?.variantKey || variant?.variantNameEn || variant?.variantName || fallbackName || ''
  ).replace(/[\u4e00-\u9fff]/g, '').trim();

  if ((!color || !size) && variantKeyRaw.includes('-')) {
    const parts = variantKeyRaw.split('-').map((p: string) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const lastPart = parts[parts.length - 1];
      const firstPart = parts.slice(0, -1).join('-').trim();
      const normalizedFromKey = normalizeSingleSize(lastPart, { allowNumeric: false });
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

  const normalizedFinalSize = normalizeSingleSize(size, { allowNumeric: false });

  return {
    color: typeof color === 'string' && color.trim() ? color.trim() : undefined,
    size: normalizedFinalSize || undefined,
  };
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
      rating === undefined
      && typeof parsedRating === 'number'
      && Number.isFinite(parsedRating)
      && parsedRating > 0
      && parsedRating <= 5
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
      reviewCount === 0
      && typeof parsedReviewCount === 'number'
      && Number.isFinite(parsedReviewCount)
      && parsedReviewCount > 0
    ) {
      reviewCount = Math.floor(parsedReviewCount);
      if (source === 'none') source = candidate.label;
    }

    if (rating !== undefined && reviewCount > 0) break;
  }

  return { rating, reviewCount, source };
}

/**
 * GET /api/admin/cj/products/[pid]/details
 * 
 * Returns a full PricedProduct for a single CJ product, using the same
 * comprehensive data processing as the search-and-price route.
 * 
 * This ensures 100% accurate data display matching the Product Discovery preview modal.
 */
export async function GET(
  req: Request,
  { params }: { params: { pid: string } }
) {
  try {
    const guard = await ensureAdmin();
    if (!guard.ok) {
      return NextResponse.json(
        { ok: false, error: guard.reason },
        { status: 401, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const pid = params.pid;
    if (!pid) {
      return NextResponse.json(
        { ok: false, error: 'Product ID required' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const { searchParams } = new URL(req.url);
    const profitMargin = Math.max(1, Number(searchParams.get('profitMargin') || 8));

    console.log(`[ProductDetails] Fetching full details for product ${pid}`);
    const startTime = Date.now();

    const token = await getAccessToken();
    if (!token) {
      return NextResponse.json(
        { ok: false, error: 'Failed to authenticate with CJ API' },
        { status: 500, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // Fetch full product details
    const fullDetails = await fetchProductDetailsByPid(pid);
    if (!fullDetails) {
      return NextResponse.json(
        { ok: false, error: 'Product not found in CJ API' },
        { status: 404, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const source = fullDetails;
    const name = String(source.productNameEn || source.name || source.productName || '');
    const cjSku = String(source.productSku || source.sku || `CJ-${pid}`);

    let rating: number | undefined;
    let reviewCount = 0;
    let reviewMetricsSource: 'supplier' | 'synthetic' | 'none' = 'none';
    let displayedRating: number | undefined;
    let ratingConfidence: number | undefined;

    // --- Fetch inventory ---
    let realInventory: ProductInventory | null = null;
    let inventoryStatus: 'ok' | 'error' | 'partial' = 'ok';
    let inventoryErrorMessage: string | undefined;
    const variantStockMap = new Map<string, { cjStock: number; factoryStock: number; totalStock: number }>();
    
    const normalizeKey = (s: string | undefined | null): string => {
      if (!s) return '';
      return String(s).toLowerCase().trim().replace(/[\s\-_\.]/g, '');
    };

    const getVariantStock = (identifiers: {
      vid?: string;
      variantId?: string;
      sku?: string;
      variantKey?: string;
      variantName?: string;
    }): { cjStock: number; factoryStock: number; totalStock: number } | undefined => {
      const keysToTry = [
        normalizeKey(identifiers.sku),
        normalizeKey(identifiers.vid),
        normalizeKey(identifiers.variantId),
        normalizeKey(identifiers.variantKey),
        normalizeKey(identifiers.variantName),
      ].filter(k => k.length > 0);
      
      for (const key of keysToTry) {
        const stock = variantStockMap.get(key);
        if (stock) return stock;
      }
      
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

    let variantInventory: Awaited<ReturnType<typeof queryVariantInventory>> = [];
    
    try {
      const invResult = await getInventoryByPid(pid);
      if (invResult) {
        realInventory = {
          totalCJ: invResult.totalCJ,
          totalFactory: invResult.totalFactory,
          totalAvailable: invResult.totalAvailable,
          warehouses: invResult.warehouses,
        };
      } else {
        inventoryStatus = 'partial';
        inventoryErrorMessage = 'Could not fetch warehouse inventory';
      }

      variantInventory = await queryVariantInventory(pid);
      if (variantInventory && variantInventory.length > 0) {
        for (const vi of variantInventory) {
          const stockData = {
            cjStock: vi.cjStock,
            factoryStock: vi.factoryStock,
            totalStock: vi.totalStock,
          };
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
        }
      }
    } catch (e: any) {
      console.log(`[ProductDetails] Error fetching inventory: ${e?.message}`);
      inventoryStatus = 'error';
      inventoryErrorMessage = e?.message || 'Failed to fetch inventory data';
    }

    // Build inventoryVariants array
    const inventoryVariants: InventoryVariant[] = [];
    if (variantInventory && variantInventory.length > 0) {
      for (const vi of variantInventory) {
        if (vi.totalStock <= 0) continue;
        
        const variantKeyRaw = String(vi.variantKey || vi.variantName || vi.variantSku || '');
        let shortName = variantKeyRaw.replace(/[\u4e00-\u9fff]/g, '').trim();
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
    }

    const stock = realInventory?.totalAvailable ?? Number(source.stock || 0);
    const totalVerifiedInventory = realInventory?.totalCJ ?? 0;
    const totalUnVerifiedInventory = realInventory?.totalFactory ?? 0;
    const listedNum = Number(source.listedNum || 0);

    // --- Extract images ---
    let images = extractAllImages(source);
    console.log(`[ProductDetails] Product ${pid}: ${images.length} images from primary source`);

    // --- Extract product info fields ---
    const rawDescriptionHtml = String(source.description || source.productDescription || source.descriptionEn || source.productDescEn || source.desc || '').trim();
    const categoryName = String(source.categoryName || source.categoryNameEn || source.category || '').trim() || undefined;

    // Weight
    const weightCandidates: Array<{ field: string; value: any }> = [
      { field: 'packWeight', value: source.packWeight },
      { field: 'packingWeight', value: source.packingWeight },
      { field: 'productWeight', value: source.productWeight },
      { field: 'weight', value: source.weight },
      { field: 'grossWeight', value: source.grossWeight },
      { field: 'netWeight', value: source.netWeight },
    ];
    
    let productWeight: number | undefined;
    for (const { value } of weightCandidates) {
      if (value !== undefined && value !== null && value !== '') {
        const numVal = Number(value);
        if (Number.isFinite(numVal) && numVal > 0) {
          productWeight = numVal < 30 ? Math.round(numVal * 1000) : Math.round(numVal);
          break;
        }
      }
    }

    const packLength = source.packLength !== undefined ? Number(source.packLength) : undefined;
    const packWidth = source.packWidth !== undefined ? Number(source.packWidth) : undefined;
    const packHeight = source.packHeight !== undefined ? Number(source.packHeight) : undefined;
    const productType = String(source.productType || source.type || '').trim() || undefined;

    // Parse JSON arrays
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

    let material = source.materialParsed || '';
    if (!material) {
      const rawMaterial = source.material || source.productMaterial || source.materialNameEn || source.materialName || '';
      material = parseCjJsonArray(rawMaterial);
    }
    material = material.trim() || undefined;

    let packingInfo = source.packingParsed || '';
    if (!packingInfo) {
      const rawPacking = source.packingNameEn || source.packingName || source.packingList || '';
      packingInfo = parseCjJsonArray(rawPacking);
    }
    packingInfo = packingInfo.trim() || undefined;

    // Sanitize HTML
    const sanitizeHtml = (html: string): string | undefined => {
      if (!html || typeof html !== 'string') return undefined;
      let cleaned = html
        .replace(/<a[^>]*href=[^>]*(1688|taobao|alibaba|aliexpress|tmall)[^>]*>.*?<\/a>/gi, '')
        .replace(/https?:\/\/[^\s<>"]*?(1688|taobao|alibaba|aliexpress|tmall)[^\s<>"]*/gi, '')
        .replace(/<[^>]*>(.*?(微信|QQ|联系|客服|淘宝|阿里巴巴|天猫|拼多多|抖音|快手).*?)<\/[^>]*>/gi, '')
        .replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '')
        .replace(/<(\w+)[^>]*>\s*<\/\1>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      
      const textOnly = cleaned.replace(/<[^>]*>/g, '').trim();
      const hasEnglish = /[a-zA-Z]/.test(textOnly);
      const hasNumbers = /\d/.test(textOnly);
      
      if (!hasEnglish && !hasNumbers && textOnly.length === 0) return undefined;
      return cleaned.length > 0 ? cleaned : undefined;
    };

    const description = sanitizeHtml(rawDescriptionHtml);

    // Build overview
    const overviewParts: string[] = [];
    const categoryDisplay = source.threeCategoryName || source.twoCategoryName || source.oneCategoryName || categoryName || '';
    if (categoryDisplay && !categoryDisplay.includes('_')) {
      overviewParts.push(`Category: ${categoryDisplay}`);
    }
    if (material && !/[\u4e00-\u9fff]/.test(String(material))) {
      overviewParts.push(`Material: ${material}`);
    }
    if (packingInfo && !/[\u4e00-\u9fff]/.test(String(packingInfo))) {
      overviewParts.push(`Package: ${packingInfo}`);
    }
    if (productWeight && productWeight > 0) {
      overviewParts.push(`Weight: ${productWeight}g`);
    }
    if (packLength && packWidth && packHeight) {
      overviewParts.push(`Dimensions: ${packLength} × ${packWidth} × ${packHeight} cm`);
    }
    if (source.deliveryCycle) {
      overviewParts.push(`Delivery: ${source.deliveryCycle} days`);
    }
    if (source.entryCode && source.entryNameEn) {
      overviewParts.push(`HS Code: ${source.entryCode}`);
    }
    const overview = overviewParts.length > 0 ? overviewParts.join('<br/>') : undefined;

    // Extract size info
    let sizeInfo: string | undefined;
    const sizeLines: string[] = [];
    if (packLength && packWidth && packHeight) {
      sizeLines.push(`Package Size: ${packLength} × ${packWidth} × ${packHeight} cm`);
    }
    const sizePropList = source.productPropertyList || source.propertyList || [];
    if (Array.isArray(sizePropList)) {
      for (const prop of sizePropList) {
        const propName = String(prop.propertyNameEn || prop.propertyName || prop.name || '').toLowerCase();
        if (propName.includes('size') || propName.includes('dimension') || propName.includes('length')) {
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

    // Size chart images
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

    // Extract packing list
    let rawPackingList = String(source.packingList || source.packing || source.packageContent || '').trim();
    const packingList = sanitizeHtml(rawPackingList) || undefined;

    // Extract product note
    const rawProductNote = String(source.productNote || source.note || source.notes || '').trim();
    const productNote = sanitizeHtml(rawProductNote) || undefined;

    // --- Fetch variants ---
    const variants = await getProductVariants(pid);
    console.log(`[ProductDetails] Fetched ${variants.length} variants`);
    const variantOptionsByVariantId = new Map<string, { options: Record<string, string> }>();

    for (const variant of variants) {
      const variantId = String(variant?.vid || variant?.variantId || variant?.id || '').trim();
      if (!variantId) continue;
      const options = extractVariantOptionsFromRawVariant(variant);
      variantOptionsByVariantId.set(variantId, {
        options,
      });
    }

    // Build set of images from variants (purchasable options) + structured color map.
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

    const colorImageMap: Record<string, string> = {};
    const colorPropertyList = source.productPropertyList || source.propertyList || source.productOptions || [];
    if (Array.isArray(colorPropertyList)) {
      for (const prop of colorPropertyList) {
        const propName = String(prop.propertyNameEn || prop.propertyName || prop.name || '').toLowerCase();
        if (!propName.includes('color') && !propName.includes('colour')) continue;

        const valueList = prop.propertyValueList || prop.values || prop.options || [];
        if (!Array.isArray(valueList)) continue;

        for (const pv of valueList) {
          const colorValue = String(
            pv.propertyValueNameEn || pv.propertyValueName || pv.value || pv.name || ''
          ).trim();
          const cleanColor = colorValue.replace(/[\u4e00-\u9fff]/g, '').trim();
          const colorImg = pv.image || pv.imageUrl || pv.propImage || pv.bigImage || pv.pic || '';

          if (
            cleanColor
            && cleanColor.length > 0
            && cleanColor.length < 50
            && /[a-zA-Z]/.test(cleanColor)
            && typeof colorImg === 'string'
            && colorImg.startsWith('http')
          ) {
            const normalizedColorImage = enhanceProductImageUrl(colorImg.trim(), 'gallery');
            colorImageMap[cleanColor] = normalizedColorImage;
            pushVariantImage(normalizedColorImage);
          }
        }
      }
    }

    const mainImage = source.productImage || source.image || source.bigImage;
    pushVariantImage(mainImage, true);

    const variantImageFields = [
      'variantImage',
      'whiteImage',
      'image',
      'imageUrl',
      'imgUrl',
      'bigImage',
      'variantImg',
      'skuImage',
      'pic',
      'picture',
      'photo',
    ];

    for (const variant of variants) {
      for (const field of variantImageFields) {
        pushVariantImage(variant[field]);
      }

      const variantProps = variant.variantPropertyList || variant.propertyList || variant.properties || [];
      if (Array.isArray(variantProps)) {
        for (const prop of variantProps) {
          pushVariantImage(prop?.image || prop?.propImage || prop?.imageUrl || prop?.pic);
        }
      }
    }

    // Deterministic source ordering:
    // 1) full-details extraction (already hero-ranked), 2) color map, 3) variant media.
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

    const allImages = Array.from(byCanonicalKey.values())
      .sort((a, b) => a.firstSeenAt - b.firstSeenAt)
      .map((entry) => entry.url);

    images = prioritizeCjHeroImage(allImages).slice(0, 50);
    console.log(`[ProductDetails] Product ${pid}: Final ${images.length} images (deterministic merge)`);

    // Extract colors, sizes, models from variants
    const colors = new Set<string>();
    const sizes = new Set<string>();
    const models = new Set<string>();

    const colorList = ['Black', 'White', 'Red', 'Blue', 'Green', 'Yellow', 'Pink', 'Purple', 'Orange', 'Brown', 'Grey', 'Gray', 'Beige', 'Navy', 'Khaki', 'Apricot', 'Wine', 'Coffee', 'Camel', 'Cream', 'Rose', 'Gold', 'Silver', 'Ivory', 'Mint', 'Coral', 'Burgundy', 'Maroon', 'Olive', 'Teal', 'Turquoise', 'Lavender', 'Lilac', 'Peach', 'Tan', 'Charcoal', 'Violet', 'Nude'];
    const colorSet = new Set(colorList.map(c => c.toLowerCase()));
    const colorTestPattern = /\b(Black|White|Red|Blue|Green|Yellow|Pink|Purple|Orange|Brown|Grey|Gray|Beige|Navy|Khaki|Apricot|Wine|Coffee|Camel|Cream|Rose|Gold|Silver|Ivory|Mint|Coral|Burgundy|Maroon|Olive|Teal|Turquoise|Lavender|Lilac|Peach|Tan|Charcoal|Violet|Nude)\b/i;
    const devicePattern = /\b(iPhone|Samsung|Xiaomi|Huawei|Redmi|OPPO|Vivo|OnePlus|Pixel|iPad|Galaxy)/i;

    const isColor = (s: string): boolean => {
      const lower = s.toLowerCase().trim();
      if (colorSet.has(lower)) return true;
      return colorTestPattern.test(s);
    };

    const isClothingSize = (s: string): boolean => !!normalizeSingleSize(s, { allowNumeric: false });
    const isDeviceModel = (s: string): boolean => devicePattern.test(s);

    const addNormalizedSize = (rawValue: unknown) => {
      const normalized = normalizeSingleSize(rawValue, { allowNumeric: false });
      if (normalized) {
        sizes.add(normalized);
      }
    };

    for (const v of variants) {
      const explicitColor = v.color || v.colour || v.colorNameEn || v.colorName;
      const explicitSize = v.size || v.sizeNameEn || v.sizeName;
      
      if (explicitColor) {
        const cleanColor = String(explicitColor).replace(/[\u4e00-\u9fff]/g, '').trim();
        if (cleanColor && /[a-zA-Z]/.test(cleanColor)) {
          colors.add(cleanColor);
        }
      }
      
      if (explicitSize) {
        const cleanSize = String(explicitSize).replace(/[\u4e00-\u9fff]/g, '').trim();
        if (cleanSize) {
          if (isDeviceModel(cleanSize)) {
            models.add(cleanSize);
          } else {
            addNormalizedSize(cleanSize);
          }
        }
      }

      // Parse variantKey
      if (v.variantKey) {
        const variantKeyRaw = String(v.variantKey).replace(/[\u4e00-\u9fff]/g, '').trim();
        const parts = variantKeyRaw.split(/[-\/|_]/).map(p => p.trim()).filter(Boolean);
        
        for (const part of parts) {
          if (isColor(part)) {
            colors.add(part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());
          } else if (isDeviceModel(part)) {
            models.add(part);
          } else if (isClothingSize(part)) {
            addNormalizedSize(part);
          } else if (part.length < 20) {
            addNormalizedSize(part);
          }
        }
      }
    }

    const extractedColors = [...colors].slice(0, 20);
    const extractedSizes = normalizeSizeList([...sizes], { allowNumeric: false }).slice(0, 20);
    const extractedModels = [...models].slice(0, 25);

    // Build product info with variant colors/sizes
    const allSpecs: string[] = [];
    if (material) allSpecs.push(`Material: ${material}`);
    if (packingInfo) allSpecs.push(`Package: ${packingInfo}`);
    if (productWeight) allSpecs.push(`Weight: ${productWeight}g`);
    if (extractedColors.length > 0) allSpecs.push(`Colors: ${extractedColors.join(', ')}`);
    if (extractedSizes.length > 0) allSpecs.push(`Sizes: ${extractedSizes.join(', ')}`);
    if (extractedModels.length > 0) allSpecs.push(`Compatible Devices: ${extractedModels.join(', ')}`);
    const productInfo = allSpecs.length > 0 ? allSpecs.join('<br/>') : undefined;

    // --- Build priced variants with shipping ---
    const pricedVariants: PricedVariant[] = [];

    const calculateSellPriceWithMargin = (landedCostSar: number, marginPercent: number): number => {
      const margin = marginPercent / 100;
      return computeRetailFromLanded(landedCostSar, { margin });
    };

    // Process up to 10 variants for shipping quotes
    const variantsToProcess = variants.slice(0, 10);
    
    for (const variant of variantsToProcess) {
      const variantId = String(variant.vid || variant.variantId || variant.id || '');
      const variantSku = String(variant.variantSku || variant.sku || variantId);
      const variantPriceUSD = Number(variant.variantSellPrice || variant.sellPrice || variant.price || 0);
      const costSAR = usdToSar(variantPriceUSD);
      
      const variantName = String(variant.variantNameEn || variant.variantName || '').replace(/[\u4e00-\u9fff]/g, '').trim() || undefined;
      const { size, color } = extractVariantColorSize(variant, variantName);
      const variantImage = resolveColorImageFromMap(
        color,
        colorImageMap,
        variant.variantImage || variant.whiteImage || variant.image || undefined
      );

      let shippingPriceUSD = 0;
      let shippingPriceSAR = 0;
      let shippingAvailable = false;
      let deliveryDays = 'Unknown';
      let logisticName: string | undefined;
      let shippingError: string | undefined;

      if (variantId) {
        try {
          const freight = await freightCalculate({
            countryCode: 'US',
            vid: variantId,
            quantity: 1,
          });
          
          if (freight.ok && freight.options.length > 0) {
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
          } else if (freight.ok) {
            shippingError = 'No shipping options to USA';
          } else if (!freight.ok) {
            shippingError = freight.message;
          }
        } catch (e: any) {
          shippingError = e?.message || 'Shipping failed';
        }
      }

      const variantStock = getVariantStock({
        vid: variantId,
        sku: variantSku,
        variantKey: variant.variantKey,
        variantName: variantName,
      });
      const resolvedVariantOptions = (() => {
        const base = variantOptionsByVariantId.get(variantId)?.options || extractVariantOptionsFromRawVariant(variant);
        if (color && !Object.keys(base).some((name) => /color|colour/i.test(name))) {
          base.Color = color;
        }
        if (size && !Object.keys(base).some((name) => /size/i.test(name))) {
          base.Size = size;
        }
        return base;
      })();
      const optionSignature = buildOptionSignature(resolvedVariantOptions);

      if (shippingAvailable) {
        const totalCostSAR = costSAR + shippingPriceSAR;
        const sellPriceSAR = calculateSellPriceWithMargin(totalCostSAR, profitMargin);
        const profitSAR = sellPriceSAR - totalCostSAR;
        const totalCostUSD = Number((variantPriceUSD + shippingPriceUSD).toFixed(2));
        const sellPriceUSD = sarToUsd(sellPriceSAR);
        const profitUSD = Number((sellPriceUSD - totalCostUSD).toFixed(2));
        const marginPercent = sellPriceUSD > 0
          ? Number(((profitUSD / sellPriceUSD) * 100).toFixed(2))
          : 0;

        pricedVariants.push({
          variantId,
          variantSku,
          variantPriceUSD,
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
          variantName,
          variantImage,
          size,
          color,
          variantOptions: Object.keys(resolvedVariantOptions).length > 0 ? resolvedVariantOptions : undefined,
          optionSignature: optionSignature || undefined,
          stock: variantStock?.totalStock,
          cjStock: variantStock?.cjStock,
          factoryStock: variantStock?.factoryStock,
          error: shippingError,
        });
      } else {
        // Include variant even without shipping for display
        pricedVariants.push({
          variantId,
          variantSku,
          variantPriceUSD,
          shippingAvailable: false,
          shippingPriceUSD: 0,
          shippingPriceSAR: 0,
          deliveryDays: 'Unknown',
          sellPriceSAR: 0,
          sellPriceUSD: 0,
          totalCostSAR: costSAR,
          totalCostUSD: Number(variantPriceUSD.toFixed(2)),
          profitSAR: 0,
          profitUSD: 0,
          marginPercent: 0,
          variantName,
          variantImage,
          size,
          color,
          variantOptions: Object.keys(resolvedVariantOptions).length > 0 ? resolvedVariantOptions : undefined,
          optionSignature: optionSignature || undefined,
          stock: variantStock?.totalStock,
          cjStock: variantStock?.cjStock,
          factoryStock: variantStock?.factoryStock,
          error: shippingError || 'No shipping data',
        });
      }
    }

    // Calculate price ranges
    const successfulVariants = pricedVariants.filter(v => v.shippingAvailable).length;
    const prices = pricedVariants.filter(v => v.sellPriceSAR > 0).map(v => v.sellPriceSAR);
    const minPriceSAR = prices.length > 0 ? Math.min(...prices) : 0;
    const maxPriceSAR = prices.length > 0 ? Math.max(...prices) : 0;
    const avgPriceSAR = prices.length > 0 ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : 0;
    const usdPrices = pricedVariants
      .map(v => Number(v.sellPriceUSD ?? sarToUsd(v.sellPriceSAR)))
      .filter((price) => Number.isFinite(price) && price > 0);
    const minPriceUSD = usdPrices.length > 0 ? Math.min(...usdPrices) : 0;
    const maxPriceUSD = usdPrices.length > 0 ? Math.max(...usdPrices) : 0;
    const avgPriceUSD = usdPrices.length > 0
      ? Number((usdPrices.reduce((sum, price) => sum + price, 0) / usdPrices.length).toFixed(2))
      : 0;

    // Time estimates
    const parseTimeValue = (val: any): { display: string | undefined; hours: number | undefined } => {
      if (!val) return { display: undefined, hours: undefined };
      const strVal = String(val).trim();
      if (!strVal) return { display: undefined, hours: undefined };
      const hasUnits = /day|hour|week/i.test(strVal);
      const display = hasUnits ? strVal : `${strVal} days`;
      const numMatch = strVal.match(/^(\d+)/);
      const hours = numMatch ? Number(numMatch[1]) * 24 : undefined;
      return { display, hours: (hours && !isNaN(hours)) ? hours : undefined };
    };

    const processingParsed = parseTimeValue(source.processDay || source.processingTime);
    const deliveryParsed = parseTimeValue(source.deliveryCycle);
    
    const originCountry = String(source.originCountry || source.countryOrigin || '').trim() || undefined;
    const hsCode = source.entryCode ? `${source.entryCode}${source.entryNameEn ? ` (${source.entryNameEn})` : ''}` : undefined;
    const availableOptions = deriveAvailableOptionsFromVariants(
      variants.map((variant: any) => {
        const variantId = String(variant?.vid || variant?.variantId || variant?.id || '').trim();
        const base = variantOptionsByVariantId.get(variantId)?.options ?? extractVariantOptionsFromRawVariant(variant);
        const variantName = String(variant?.variantNameEn || variant?.variantName || '').replace(/[\u4e00-\u9fff]/g, '').trim() || undefined;
        const variantSku = String(variant?.variantSku || variant?.sku || variantId || '');
        const variantStock = getVariantStock({
          vid: variantId,
          sku: variantSku,
          variantKey: variant?.variantKey,
          variantName,
        });
        return {
          variantOptions: base,
          stock: variantStock?.totalStock ?? variant?.stock,
          totalStock: variantStock?.totalStock,
          cjStock: variantStock?.cjStock,
          factoryStock: variantStock?.factoryStock,
        };
      }),
      { includeOutOfStockDimensions: false }
    );
    const legacyFromDynamicOptions = deriveLegacyOptionArrays(availableOptions);
    const resolvedAvailableColors = legacyFromDynamicOptions.availableColors;
    const resolvedAvailableSizes = legacyFromDynamicOptions.availableSizes;
    const resolvedAvailableModels = legacyFromDynamicOptions.availableModels;
    const sourceVideoUrl = extractCjProductVideoUrl(source);
    const videoDelivery = build4kVideoDelivery(sourceVideoUrl);
    const hasDeliverableVideo =
      typeof videoDelivery.deliveryUrl === 'string' &&
      videoDelivery.deliveryUrl.length > 0 &&
      videoDelivery.qualityGatePassed;

    const supplierMetrics = extractSupplierReviewMetrics(source);
    rating = supplierMetrics.rating;
    reviewCount = supplierMetrics.reviewCount;
    reviewMetricsSource = supplierMetrics.source === 'none' ? 'none' : 'supplier';

    if (!(Number.isFinite(reviewCount) && reviewCount > 0)) {
      const syntheticReviewProfile = buildSyntheticReviewProfile(pid);
      reviewCount = syntheticReviewProfile.reviewCount;
      reviewMetricsSource = 'synthetic';
    }

    console.log(
      `[ProductDetails] Product ${pid} review metrics: rating=${typeof rating === 'number' ? rating.toFixed(2) : 'n/a'} reviewCount=${reviewCount} source=${reviewMetricsSource}`
    );

    // Compute internal rating from signals with supplier/comment metrics override when available.
    try {
      const imagesCount = Array.isArray(images) ? images.length : 0;
      const variantCount = Array.isArray(variantsToProcess) ? variantsToProcess.length : 0;
      const minVariantUsd = pricedVariants.length > 0 ? Math.min(...pricedVariants.map(v => v.variantPriceUSD || 0)) : 0;

      const imgNorm = Math.max(0, Math.min(1, imagesCount / 15));
      const priceNorm = Math.max(0, Math.min(1, minVariantUsd / 50));
      const dynQuality = Math.max(0, Math.min(1, 0.6 * imgNorm + 0.4 * (1 - priceNorm)));

      const ratingOut = computeRating({
        imageCount: imagesCount,
        stock: typeof stock === 'number' ? stock : 0,
        variantCount,
        qualityScore: dynQuality,
        priceUsd: minVariantUsd,
        sentiment: 0,
        orderVolume: 0,
      });

      const hasSupplierRating = typeof rating === 'number' && Number.isFinite(rating) && rating > 0;
      if (hasSupplierRating) {
        displayedRating = normalizeDisplayedRating(rating);
        rating = displayedRating;
      } else {
        displayedRating = ratingOut.displayedRating;
      }

      if (hasSupplierRating && reviewCount > 0) {
        const countBasedConfidence = Math.min(1, 0.65 + (Math.log10(reviewCount + 1) / 4));
        ratingConfidence = Math.max(ratingOut.ratingConfidence, Number(countBasedConfidence.toFixed(2)));
      } else {
        ratingConfidence = ratingOut.ratingConfidence;
      }

      try {
        const admin = getSupabaseAdmin();
        if (admin) {
          const hasSignals = await hasTable('product_rating_signals').catch(() => false);
          if (hasSignals) {
            await admin.from('product_rating_signals').insert({
              product_id: null,
              cj_product_id: pid,
              context: 'details',
              signals: ratingOut.signals,
              displayed_rating: ratingOut.displayedRating,
              rating_confidence: ratingOut.ratingConfidence,
            });
          }
        }
      } catch {}
    } catch {}

    // Build final PricedProduct
    const pricedProduct: PricedProduct = {
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
      totalVerifiedInventory: totalVerifiedInventory > 0 ? totalVerifiedInventory : undefined,
      totalUnVerifiedInventory: totalUnVerifiedInventory > 0 ? totalUnVerifiedInventory : undefined,
      inventory: realInventory || undefined,
      inventoryStatus,
      inventoryErrorMessage,
      variants: pricedVariants,
      inventoryVariants: inventoryVariants.length > 0 ? inventoryVariants : undefined,
      successfulVariants,
      totalVariants: pricedVariants.length,
      description,
      overview,
      productInfo,
      sizeInfo,
      productNote,
      packingList,
      displayedRating,
      ratingConfidence,
      rating,
      reviewCount,
      categoryName,
      productWeight,
      packLength,
      packWidth,
      packHeight,
      material: material || undefined,
      productType,
      sizeChartImages: sizeChartImages.length > 0 ? sizeChartImages : undefined,
      processingTimeHours: processingParsed.hours,
      deliveryTimeHours: deliveryParsed.hours,
      estimatedProcessingDays: processingParsed.display,
      estimatedDeliveryDays: deliveryParsed.display,
      originCountry,
      hsCode,
      videoUrl: hasDeliverableVideo ? videoDelivery.deliveryUrl : undefined,
      videoSourceUrl: videoDelivery.sourceUrl,
      video4kUrl: hasDeliverableVideo ? videoDelivery.deliveryUrl : undefined,
      videoDeliveryMode: videoDelivery.mode,
      videoQualityGatePassed: videoDelivery.qualityGatePassed,
      videoSourceQualityHint: videoDelivery.sourceQualityHint,
      availableOptions: availableOptions.length > 0 ? availableOptions : undefined,
      availableSizes: resolvedAvailableSizes.length > 0 ? resolvedAvailableSizes : undefined,
      availableColors: resolvedAvailableColors.length > 0 ? resolvedAvailableColors : undefined,
      availableModels: resolvedAvailableModels.length > 0 ? resolvedAvailableModels : undefined,
      colorImageMap: Object.keys(colorImageMap).length > 0 ? colorImageMap : undefined,
    };

    const duration = Date.now() - startTime;
    console.log(`[ProductDetails] Complete in ${duration}ms`);

    return NextResponse.json({
      ok: true,
      product: pricedProduct,
      duration,
    }, { headers: { 'Cache-Control': 'no-store' } });

  } catch (e: any) {
    console.error('[ProductDetails] Error:', e?.message, e?.stack);
    return NextResponse.json(
      { ok: false, error: e?.message || 'Failed to fetch product details' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

function extractAllImages(item: any): string[] {
  return extractCjProductGalleryImages(item, 50);
}

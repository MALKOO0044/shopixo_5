import type { PricedProduct, PricedVariant, InventoryVariant, ProductInventory } from '@/components/admin/import/preview/types';
import { getCache, setCache } from '@/lib/cache/cj-cache';
import {
  fetchProductDetailsByPid,
  getProductVariants,
  getInventoryByPid,
  queryVariantInventory,
  freightCalculate,
  findCheapestConfiguredShippingOption,
} from '@/lib/cj/v2';
import { enhanceProductImageUrl } from '@/lib/media/image-quality';
import { extractCjProductGalleryImages, normalizeCjImageKey, prioritizeCjHeroImage } from '@/lib/cj/image-gallery';
import { extractCjProductVideoUrl } from '@/lib/cj/video';
import { build4kVideoDelivery } from '@/lib/video/delivery';
import { computeRetailFromLanded, sarToUsd, usdToSar } from '@/lib/pricing';
import { computeRating, normalizeDisplayedRating } from '@/lib/rating/engine';
import { normalizeSingleSize } from '@/lib/cj/size-normalization';
import {
  buildOptionSignature,
  deriveAvailableOptionsFromVariants,
  deriveLegacyOptionArrays,
  extractVariantOptionsFromRawVariant,
} from '@/lib/variants/dynamic-options';

export type HydrateOptions = {
  profitMargin?: number; // percent, default 8
  countryCode?: string; // default 'US'
  dispersionThreshold?: number; // percent, default 20
  force?: boolean; // ignore hydrated cache
};

function parseTimeValue(val: any): { display: string | undefined; hours: number | undefined } {
  if (!val) return { display: undefined, hours: undefined };
  const strVal = String(val).trim();
  if (!strVal) return { display: undefined, hours: undefined };
  const hasUnits = /day|hour|week/i.test(strVal);
  const display = hasUnits ? strVal : `${strVal} days`;
  const numMatch = strVal.match(/^(\d+)/);
  const hours = numMatch ? Number(numMatch[1]) * 24 : undefined;
  return { display, hours: (hours && !isNaN(hours)) ? hours : undefined };
}

function extractAllImages(item: any): string[] {
  return extractCjProductGalleryImages(item, 50);
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

  const normalizedFinalSize = normalizeSingleSize(size, { allowNumeric: false });

  return {
    color: typeof color === 'string' && color.trim() ? color.trim() : undefined,
    size: normalizedFinalSize || undefined,
  };
}

export async function ensureHydrated(pid: string, opts: HydrateOptions = {}): Promise<PricedProduct> {
  const start = Date.now();
  const profitMargin = Math.max(1, Number(opts.profitMargin ?? 8));
  const countryCode = opts.countryCode || 'US';
  const dispersionThreshold = Math.max(0, Number(opts.dispersionThreshold ?? 20));

  if (!pid) throw new Error('pid is required');

  const cacheKey = `cj:hydrated:v1:${pid}:m${profitMargin}`;
  if (!opts.force) {
    try {
      const cached = await getCache<PricedProduct>(cacheKey);
      if (cached) return cached;
    } catch {}
  }

  // --- Fetch base product data ---
  const source = await fetchProductDetailsByPid(pid);
  if (!source) throw new Error('Product not found');

  const name = String(source.productNameEn || source.name || source.productName || '');
  const cjSku = String(source.productSku || source.sku || `CJ-${pid}`);

  // --- Inventory ---
  let realInventory: ProductInventory | null = null;
  let inventoryStatus: 'ok' | 'error' | 'partial' = 'ok';
  let inventoryErrorMessage: string | undefined;

  const variantStockMap = new Map<string, { cjStock: number; factoryStock: number; totalStock: number }>();
  const normalizeKey = (s: string | undefined | null): string => String(s ?? '').toLowerCase().trim().replace(/[\s\-_\.]/g, '');
  const getVariantStock = (identifiers: { vid?: string; variantId?: string; sku?: string; variantKey?: string; variantName?: string; }): { cjStock: number; factoryStock: number; totalStock: number } | undefined => {
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
        const stockData = { cjStock: vi.cjStock, factoryStock: vi.factoryStock, totalStock: vi.totalStock };
        const keysToStore = [
          normalizeKey(vi.variantSku),
          normalizeKey(vi.vid),
          normalizeKey(vi.variantId),
          normalizeKey(vi.variantKey),
          normalizeKey(vi.variantName),
        ].filter(k => k && k.length > 0);
        for (const key of keysToStore) variantStockMap.set(key, stockData);
      }
    }
  } catch (e: any) {
    inventoryStatus = 'error';
    inventoryErrorMessage = e?.message || 'Failed to fetch inventory data';
  }

  const stock = realInventory?.totalAvailable ?? Number(source.stock || 0);
  const totalVerifiedInventory = realInventory?.totalCJ ?? 0;
  const totalUnVerifiedInventory = realInventory?.totalFactory ?? 0;
  const listedNum = Number(source.listedNum || 0);

  // --- Images ---
  let images = extractAllImages(source);
  // Build variant images + color map
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
        const colorValue = String(pv.propertyValueNameEn || pv.propertyValueName || pv.value || pv.name || '').trim();
        const cleanColor = colorValue.replace(/[\u4e00-\u9fff]/g, '').trim();
        const colorImg = pv.image || pv.imageUrl || pv.propImage || pv.bigImage || pv.pic || '';
        if (cleanColor && /[a-zA-Z]/.test(cleanColor) && typeof colorImg === 'string' && colorImg.startsWith('http')) {
          const normalizedColorImage = enhanceProductImageUrl(colorImg.trim(), 'gallery');
          colorImageMap[cleanColor] = normalizedColorImage;
          pushVariantImage(normalizedColorImage);
        }
      }
    }
  }

  const variants = await getProductVariants(pid);
  const variantOptionsByVariantId = new Map<string, { options: Record<string, string>; optionSignature: string }>();

  for (const variant of variants) {
    const variantId = String(variant?.vid || variant?.variantId || variant?.id || '').trim();
    if (!variantId) continue;

    const extractedOptions = extractVariantOptionsFromRawVariant(variant);
    const optionSignature = buildOptionSignature(extractedOptions);
    variantOptionsByVariantId.set(variantId, {
      options: extractedOptions,
      optionSignature,
    });
  }
  const mainImage = source.productImage || source.image || source.bigImage;
  pushVariantImage(mainImage, true);
  const variantImageFields = ['variantImage','whiteImage','image','imageUrl','imgUrl','bigImage','variantImg','skuImage','pic','picture','photo'];
  for (const v of variants) {
    for (const f of variantImageFields) pushVariantImage(v[f]);
    const vProps = v.variantPropertyList || v.propertyList || v.properties || [];
    if (Array.isArray(vProps)) {
      for (const prop of vProps) pushVariantImage(prop?.image || prop?.propImage || prop?.imageUrl || prop?.pic);
    }
  }

  // Deterministic image merge
  const byCanonicalKey = new Map<string, { url: string; score: number; firstSeenAt: number }>();
  let imageSeq = 0;
  const pushFinalImage = (url: unknown) => {
    if (typeof url !== 'string') return;
    const cleaned = enhanceProductImageUrl(url.trim(), 'gallery');
    if (!cleaned.startsWith('http')) return;
    const key = normalizeCjImageKey(cleaned);
    if (!key) return;
    const score = 50 - Math.min(15, imageSeq * 0.35);
    const existing = byCanonicalKey.get(key);
    if (!existing) {
      byCanonicalKey.set(key, { url: cleaned, score, firstSeenAt: imageSeq });
      imageSeq += 1; return;
    }
    if (score > existing.score) {
      byCanonicalKey.set(key, { url: cleaned, score, firstSeenAt: existing.firstSeenAt });
    }
    imageSeq += 1;
  };
  for (const img of images) pushFinalImage(img);
  for (const colorImg of Object.values(colorImageMap)) pushFinalImage(colorImg);
  for (const img of variantImages) pushFinalImage(img);
  images = prioritizeCjHeroImage(Array.from(byCanonicalKey.values()).sort((a,b)=>a.firstSeenAt-b.firstSeenAt).map(e=>e.url)).slice(0,50);

  // --- Product info fields ---
  const rawDescriptionHtml = String(source.description || source.productDescription || source.descriptionEn || source.productDescEn || source.desc || '').trim();
  const categoryName = String(source.categoryName || source.categoryNameEn || source.category || '').trim() || undefined;

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

  const sanitizeHtml = (html: string): string | undefined => {
    if (!html || typeof html !== 'string') return undefined;
    let cleaned = html
      .replace(/<a[^>]*href=[^>]*(1688|taobao|alibaba|aliexpress|tmall)[^>]*>.*?<\/a>/gi, '')
      .replace(/https?:\/\/[^\s<>\"]*?(1688|taobao|alibaba|aliexpress|tmall)[^\s<>\"]*/gi, '')
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

  const overviewParts: string[] = [];
  const categoryDisplay = source.threeCategoryName || source.twoCategoryName || source.oneCategoryName || categoryName || '';
  if (categoryDisplay && !categoryDisplay.includes('_')) overviewParts.push(`Category: ${categoryDisplay}`);
  if (material && !/[\u4e00-\u9fff]/.test(String(material))) overviewParts.push(`Material: ${material}`);
  if (packingInfo && !/[\u4e00-\u9fff]/.test(String(packingInfo))) overviewParts.push(`Package: ${packingInfo}`);
  if (productWeight && productWeight > 0) overviewParts.push(`Weight: ${productWeight}g`);
  if (packLength && packWidth && packHeight) overviewParts.push(`Dimensions: ${packLength} × ${packWidth} × ${packHeight} cm`);
  if (source.deliveryCycle) overviewParts.push(`Delivery: ${source.deliveryCycle} days`);
  if (source.entryCode && source.entryNameEn) overviewParts.push(`HS Code: ${source.entryCode}`);
  const overview = overviewParts.length > 0 ? overviewParts.join('<br/>') : undefined;

  // Size info
  let sizeInfo: string | undefined;
  const sizeLines: string[] = [];
  if (packLength && packWidth && packHeight) sizeLines.push(`Package Size: ${packLength} × ${packWidth} × ${packHeight} cm`);
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
  if (sizeLines.length > 0) sizeInfo = sizeLines.join('<br/>');

  // Size chart images
  const sizeChartImages: string[] = [];
  const sizeChartFields = ['sizeChartImage', 'sizeChart', 'sizeImage', 'measurementImage', 'chartImage'];
  for (const field of sizeChartFields) {
    const val = (source as any)[field];
    if (typeof val === 'string' && val.startsWith('http')) sizeChartImages.push(val);
    else if (Array.isArray(val)) {
      for (const img of val) if (typeof img === 'string' && img.startsWith('http')) sizeChartImages.push(img);
    }
  }

  // Packing list & product note
  const rawPackingList = String(source.packingList || source.packing || source.packageContent || '').trim();
  const packingList = sanitizeHtml(rawPackingList) || undefined;
  const rawProductNote = String(source.productNote || source.note || source.notes || '').trim();
  const productNote = sanitizeHtml(rawProductNote) || undefined;

  const availableOptions = deriveAvailableOptionsFromVariants(
    variants.map((variant: any) => {
      const variantId = String(variant?.vid || variant?.variantId || variant?.id || '').trim();
      const base = variantOptionsByVariantId.get(variantId);
      const variantName = String(variant?.variantNameEn || variant?.variantName || '').replace(/[\u4e00-\u9fff]/g, '').trim() || undefined;
      const variantSku = String(variant?.variantSku || variant?.sku || variantId || '');
      const variantStock = getVariantStock({
        vid: variantId,
        variantId,
        sku: variantSku,
        variantKey: variant?.variantKey,
        variantName,
      });

      return {
        variantOptions: base?.options ?? extractVariantOptionsFromRawVariant(variant),
        stock: variantStock?.totalStock ?? variant?.stock,
        totalStock: variantStock?.totalStock,
        cjStock: variantStock?.cjStock,
        factoryStock: variantStock?.factoryStock,
      };
    }),
    { includeOutOfStockDimensions: false }
  );
  const derivedLegacyOptions = deriveLegacyOptionArrays(availableOptions);
  const resolvedAvailableColors = derivedLegacyOptions.availableColors;
  const resolvedAvailableSizes = derivedLegacyOptions.availableSizes;
  const resolvedAvailableModels = derivedLegacyOptions.availableModels;

  // --- Shipping & pricing (single-freight policy with dispersion fallback) ---
  const calculateSellPriceWithMargin = (landedCostSar: number, marginPercent: number): number => {
    const margin = marginPercent / 100;
    return computeRetailFromLanded(landedCostSar, { margin });
  };

  const pricedVariants: PricedVariant[] = [];

  if (variants.length === 0) {
    // Single-variant product using product-level vid fallback
    const sellPrice = Number(source.sellPrice || source.price || 0);
    const costSAR = usdToSar(sellPrice);
    const variantVid = String(source.vid || pid || '');
    let shippingPriceUSD = 0; let shippingPriceSAR = 0; let shippingAvailable = false; let deliveryDays = 'Unknown'; let logisticName: string | undefined; let shippingError: string | undefined;
    if (variantVid) {
      try {
        const freight = await freightCalculate({ countryCode, vid: variantVid, quantity: 1 });
        if (freight.ok && freight.options.length > 0) {
          const selected = findCheapestConfiguredShippingOption(freight.options);
          if (selected) {
            shippingPriceUSD = selected.price; shippingPriceSAR = usdToSar(shippingPriceUSD); shippingAvailable = true; logisticName = selected.name;
            if (selected.logisticAgingDays) { const { min, max } = selected.logisticAgingDays; deliveryDays = max ? `${min}-${max} days` : `${min} days`; }
          }
        } else if (!freight.ok) shippingError = freight.message;
      } catch (e: any) { shippingError = e?.message || 'Shipping failed'; }
    }
    const totalCostSAR = costSAR + (shippingAvailable ? shippingPriceSAR : 0);
    const sellPriceSAR = shippingAvailable ? calculateSellPriceWithMargin(totalCostSAR, profitMargin) : 0;
    const totalCostUSD = Number((sellPrice + shippingPriceUSD).toFixed(2));
    const sellPriceUSD = shippingAvailable ? sarToUsd(sellPriceSAR) : 0;
    const profitUSD = shippingAvailable ? Number((sellPriceUSD - totalCostUSD).toFixed(2)) : 0;
    const marginPercent = sellPriceUSD > 0 ? Number(((profitUSD / sellPriceUSD) * 100).toFixed(2)) : 0;
    pricedVariants.push({
      variantId: pid,
      variantSku: source.productSku || pid,
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
      profitSAR: sellPriceSAR > 0 ? (sellPriceSAR - totalCostSAR) : 0,
      profitUSD,
      marginPercent,
      error: shippingError,
      variantOptions: {},
      optionSignature: '',
    });
  } else {
    // Multi-variant: find heaviest variants, quote 2, take highest shipping as baseline
    const MAX_CHECK = 2;
    const sortedByWeight = [...variants].sort((a,b)=> (Number(b.packWeight||b.variantWeight||b.weight||0)) - (Number(a.packWeight||a.variantWeight||a.weight||0)));
    const quotes: Array<{ priceUSD: number; priceSAR: number; deliveryDays: string; logisticName: string } > = [];
    for (let i=0;i<Math.min(sortedByWeight.length, MAX_CHECK);i++) {
      const v = sortedByWeight[i];
      const variantId = String(v.vid || v.variantId || v.id || '');
      if (!variantId) continue;
      try {
        const freight = await freightCalculate({ countryCode, vid: variantId, quantity: 1 });
        if (freight.ok && freight.options.length > 0) {
          const selected = findCheapestConfiguredShippingOption(freight.options);
          if (selected) {
            const priceUSD = selected.price; const priceSAR = usdToSar(priceUSD);
            const deliveryDays = selected.logisticAgingDays ? (selected.logisticAgingDays.max ? `${selected.logisticAgingDays.min}-${selected.logisticAgingDays.max} days` : `${selected.logisticAgingDays.min} days`) : 'Unknown';
            quotes.push({ priceUSD, priceSAR, deliveryDays, logisticName: selected.name });
          }
        }
      } catch {}
    }
    if (quotes.length > 0) {
      // pick highest as baseline
      quotes.sort((a,b)=> b.priceUSD - a.priceUSD);
      const baseline = quotes[0];
      // dispersion check
      if (quotes.length > 1) {
        const minUSD = quotes[quotes.length-1].priceUSD;
        const maxUSD = quotes[0].priceUSD;
        const dispersion = maxUSD > 0 ? ((maxUSD - minUSD) / maxUSD) * 100 : 0;
        if (dispersion > dispersionThreshold) {
          // Already picked highest; policy ok. If needed, could fetch third quote.
        }
      }
      for (const v of variants) {
        const variantId = String(v.vid || v.variantId || v.id || '');
        const variantSku = String(v.variantSku || v.sku || variantId);
        const rawVariantPriceUSD = Number(v.variantSellPrice || v.sellPrice || v.price || 0);
        if (!Number.isFinite(rawVariantPriceUSD) || rawVariantPriceUSD <= 0) continue;
        const costSAR = usdToSar(rawVariantPriceUSD);
        const variantName = String(v.variantNameEn || v.variantName || '').replace(/[\u4e00-\u9fff]/g, '').trim() || undefined;
        const { size, color } = extractVariantColorSize(v, variantName);
        const mappedOptions = variantOptionsByVariantId.get(variantId);
        const variantOptions = mappedOptions?.options ?? extractVariantOptionsFromRawVariant(v);
        if (color && !Object.keys(variantOptions).some((name) => /color|colour/i.test(name))) {
          variantOptions.Color = color;
        }
        if (size && !Object.keys(variantOptions).some((name) => /size/i.test(name))) {
          variantOptions.Size = size;
        }
        const optionSignature = mappedOptions?.optionSignature || buildOptionSignature(variantOptions);
        const variantImage = ((): string | undefined => {
          const colorImage = color ? colorImageMap[color] : undefined;
          return colorImage || v.variantImage || v.whiteImage || v.image || undefined;
        })();
        const totalCostSAR = costSAR + baseline.priceSAR;
        const sellPriceSAR = calculateSellPriceWithMargin(totalCostSAR, profitMargin);
        const profitSAR = sellPriceSAR - totalCostSAR;
        const totalCostUSD = Number((rawVariantPriceUSD + baseline.priceUSD).toFixed(2));
        const sellPriceUSD = sarToUsd(sellPriceSAR);
        const profitUSD = Number((sellPriceUSD - totalCostUSD).toFixed(2));
        const marginPercent = sellPriceUSD > 0 ? Number(((profitUSD / sellPriceUSD) * 100).toFixed(2)) : 0;
        const variantStock = getVariantStock({ vid: variantId, variantId, sku: variantSku, variantKey: v.variantKey, variantName });
        pricedVariants.push({
          variantId,
          variantSku,
          variantPriceUSD: rawVariantPriceUSD,
          shippingAvailable: true,
          shippingPriceUSD: baseline.priceUSD,
          shippingPriceSAR: baseline.priceSAR,
          deliveryDays: baseline.deliveryDays,
          logisticName: baseline.logisticName,
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
          variantOptions,
          optionSignature,
          stock: variantStock?.totalStock,
          cjStock: variantStock?.cjStock,
          factoryStock: variantStock?.factoryStock,
        });
      }
    }
  }

  // Product-level price ranges
  const successfulVariants = pricedVariants.filter(v => v.shippingAvailable).length;
  const pricesSar = pricedVariants.filter(v => v.sellPriceSAR > 0).map(v => v.sellPriceSAR);
  const minPriceSAR = pricesSar.length > 0 ? Math.min(...pricesSar) : 0;
  const maxPriceSAR = pricesSar.length > 0 ? Math.max(...pricesSar) : 0;
  const avgPriceSAR = pricesSar.length > 0 ? Math.round(pricesSar.reduce((a,b)=>a+b,0) / pricesSar.length) : 0;
  const usdPrices = pricedVariants.map(v => Number(v.sellPriceUSD ?? sarToUsd(v.sellPriceSAR))).filter((p)=> Number.isFinite(p) && p > 0);
  const minPriceUSD = usdPrices.length > 0 ? Math.min(...usdPrices) : 0;
  const maxPriceUSD = usdPrices.length > 0 ? Math.max(...usdPrices) : 0;
  const avgPriceUSD = usdPrices.length > 0 ? Number((usdPrices.reduce((sum,p)=>sum+p,0)/usdPrices.length).toFixed(2)) : 0;

  // Times, origin, HS code
  const processingParsed = parseTimeValue(source.processDay || source.processingTime);
  const deliveryParsed = parseTimeValue(source.deliveryCycle);
  const originCountry = String(source.originCountry || source.countryOrigin || '').trim() || undefined;
  const hsCode = source.entryCode ? `${source.entryCode}${source.entryNameEn ? ` (${source.entryNameEn})` : ''}` : undefined;

  // Video
  const sourceVideoUrl = extractCjProductVideoUrl(source);
  const videoDelivery = build4kVideoDelivery(sourceVideoUrl);
  const hasDeliverableVideo = typeof videoDelivery.deliveryUrl === 'string' && videoDelivery.deliveryUrl.length > 0 && videoDelivery.qualityGatePassed;

  // Rating metrics
  let displayedRating: number | undefined; let ratingConfidence: number | undefined; let rating: number | undefined; let reviewCount: number | undefined;
  try {
    const imagesCount = Array.isArray(images) ? images.length : 0;
    const minVariantUsd = pricedVariants.length > 0 ? Math.min(...pricedVariants.map(v => v.variantPriceUSD || 0)) : 0;
    const imgNorm = Math.max(0, Math.min(1, imagesCount / 15));
    const priceNorm = Math.max(0, Math.min(1, minVariantUsd / 50));
    const dynQuality = Math.max(0, Math.min(1, 0.6 * imgNorm + 0.4 * (1 - priceNorm)));
    const out = computeRating({ imageCount: imagesCount, stock, variantCount: pricedVariants.length, qualityScore: dynQuality, priceUsd: minVariantUsd, sentiment: 0, orderVolume: listedNum });
    const hasSupplierRating = typeof source.rating === 'number' && Number.isFinite(source.rating) && source.rating > 0;
    if (hasSupplierRating) {
      displayedRating = normalizeDisplayedRating(source.rating);
      rating = displayedRating;
    } else {
      displayedRating = out.displayedRating;
      rating = displayedRating;
    }
    if (hasSupplierRating && typeof source.reviewCount === 'number' && source.reviewCount > 0) {
      const countBasedConfidence = Math.min(1, 0.65 + (Math.log10(source.reviewCount + 1) / 4));
      ratingConfidence = Math.max(out.ratingConfidence, Number(countBasedConfidence.toFixed(2)));
    } else {
      ratingConfidence = out.ratingConfidence;
    }
    if (typeof source.reviewCount === 'number' && source.reviewCount > 0) reviewCount = Math.floor(source.reviewCount);
  } catch {}

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
    inventory: realInventory ? { totalCJ: realInventory.totalCJ, totalFactory: realInventory.totalFactory, totalAvailable: realInventory.totalAvailable, warehouses: realInventory.warehouses } : undefined,
    inventoryStatus,
    inventoryErrorMessage: inventoryErrorMessage || undefined,
    variants: pricedVariants,
    inventoryVariants: (variantInventory && variantInventory.length > 0)
      ? variantInventory.filter(v => v.totalStock > 0).map<InventoryVariant>((vi) => ({
          variantId: String(vi.vid || vi.variantId || ''),
          sku: vi.variantSku,
          shortName: String(vi.variantKey || vi.variantName || vi.variantSku || '').replace(/[\u4e00-\u9fff]/g, '').trim() || (vi.variantSku || `Variant-${vi.vid || vi.variantId || '?'}`),
          priceUSD: vi.price,
          cjStock: vi.cjStock,
          factoryStock: vi.factoryStock,
          totalStock: vi.totalStock,
        }))
      : undefined,
    successfulVariants,
    totalVariants: pricedVariants.length,
    description,
    overview,
    productInfo: [
      material ? `Material: ${material}` : '',
      packingInfo ? `Package: ${packingInfo}` : '',
      productWeight ? `Weight: ${productWeight}g` : '',
      resolvedAvailableColors.length > 0 ? `Colors: ${resolvedAvailableColors.join(', ')}` : '',
      resolvedAvailableSizes.length > 0 ? `Sizes: ${resolvedAvailableSizes.join(', ')}` : '',
      resolvedAvailableModels.length > 0 ? `Compatible Devices: ${resolvedAvailableModels.join(', ')}` : '',
    ].filter(Boolean).join('<br/>') || undefined,
    sizeInfo,
    productNote,
    packingList,
    displayedRating,
    ratingConfidence,
    rating,
    reviewCount,
    supplierName: source?.supplier?.name || undefined,
    categoryName,
    productWeight,
    packLength,
    packWidth,
    packHeight,
    material,
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

  try { await setCache(cacheKey, pricedProduct, 60 * 60 * 12); } catch {}
  const duration = Date.now() - start;
  console.log(`[Hydration] Hydrated ${pid} in ${duration}ms (variants=${variants.length}, priced=${pricedVariants.length})`);

  return pricedProduct;
}

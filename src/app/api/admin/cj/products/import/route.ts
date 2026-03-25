import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { queryProductByPidOrKeyword, mapCjItemToProductLike, type CjProductLike } from '@/lib/cj/v2';
import { slugify } from '@/lib/utils/slug';
import { ensureAdmin } from '@/lib/auth/admin-guard';
import { hasTable, hasColumn } from '@/lib/db-features';
import { loggerForRequest } from '@/lib/log';
import { isKillSwitchOn } from '@/lib/settings';
import { normalizeSingleSize, normalizeSizeList } from '@/lib/cj/size-normalization';
import { normalizeCjImageKey } from '@/lib/cj/image-gallery';
import { enhanceProductImageUrl } from '@/lib/media/image-quality';
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

async function ensureUniqueSlug(admin: any, base: string): Promise<string> {
  const s = slugify(base);
  let candidate = s;
  for (let i = 2; i <= 50; i++) {
    const { data } = await admin
      .from('products')
      .select('id')
      .eq('slug', candidate)
      .maybeSingle();
    if (!data) return candidate;
    candidate = `${s}-${i}`;
  }
  return `${s}-${Date.now()}`;
}

export async function POST(req: Request) {
  const log = loggerForRequest(req);
  try {
    const guard = await ensureAdmin();
    if (!guard.ok) {
      const r = NextResponse.json({ ok: false, version: 'import-v2', error: guard.reason }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      const r = NextResponse.json({ ok: false, error: 'Server not configured' }, { status: 500 });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }

    // Global kill-switch enforcement: block write operations
    if (await isKillSwitchOn()) {
      const r = NextResponse.json({ ok: false, version: 'import-v2', error: 'Kill switch is ON. Import is temporarily disabled.' }, { status: 423, headers: { 'Cache-Control': 'no-store' } });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }

    const body = await req.json();
    const pid: string | undefined = body?.pid || undefined;
    const itemsIn: CjProductLike[] | undefined = body?.items || undefined;
    const categoryParam: string = (body?.category || 'General').trim();
    const mediaMode: string | undefined = typeof body?.mediaMode === 'string' ? body.mediaMode : undefined;

    let items: CjProductLike[] = [];
    if (Array.isArray(itemsIn) && itemsIn.length > 0) {
      items = itemsIn;
    } else if (pid) {
      const raw = await queryProductByPidOrKeyword({ pid });
      const listRaw = Array.isArray(raw?.data?.content)
        ? raw.data.content
        : Array.isArray(raw?.content)
          ? raw.content
          : Array.isArray(raw?.data)
            ? raw.data
            : Array.isArray(raw)
              ? raw
              : [];
      items = (listRaw as any[]).map((it) => mapCjItemToProductLike(it)).filter(Boolean) as CjProductLike[];
      if (items.length === 0) {
        const r = NextResponse.json({ ok: false, error: 'No CJ products found for pid' }, { status: 404 });
        r.headers.set('x-request-id', log.requestId);
        return r;
      }
    } else {
      const r = NextResponse.json({ ok: false, error: 'Provide pid or items' }, { status: 400 });
      r.headers.set('x-request-id', log.requestId);
      return r;
    }

    const results: any[] = [];
    const hasVariantsTable = await hasTable('product_variants');
    const productOptionalColumns = [
      'is_active',
      'video_url',
      'video_source_url',
      'video_4k_url',
      'video_delivery_mode',
      'video_quality_gate_passed',
      'video_source_quality_hint',
      'media_mode',
      'has_video',
      'available_options',
      'available_sizes',
      'available_colors',
    ] as const;
    const optionalColumnSet = new Set<string>();
    const optionalColumnResults = await Promise.all(
      productOptionalColumns.map(async (col) => ({ col, exists: await hasColumn('products', col).catch(() => false) }))
    );
    for (const result of optionalColumnResults) {
      if (result.exists) optionalColumnSet.add(result.col);
    }

    const variantOptionalColumns = ['variant_options', 'option_signature'] as const;
    const variantOptionalColumnSet = new Set<string>();
    if (hasVariantsTable) {
      const variantOptionalColumnResults = await Promise.all(
        variantOptionalColumns.map(async (col) => ({
          col,
          exists: await hasColumn('product_variants', col).catch(() => false),
        }))
      );
      for (const result of variantOptionalColumnResults) {
        if (result.exists) variantOptionalColumnSet.add(result.col);
      }
    }

    for (const cj of items) {
      try {
        // If product with same cj_product_id exists, we will update it; otherwise insert.
        const { data: existing } = await supabase
          .from('products')
          .select('id, slug')
          .eq('cj_product_id', cj.productId)
          .maybeSingle();

        const baseSlug = await ensureUniqueSlug(supabase, cj.name);
        const priceCandidates = (cj.variants || []).map((v) => (typeof v.price === 'number' ? v.price : NaN)).filter((n) => !isNaN(n));
        const defaultPrice = priceCandidates.length > 0 ? Math.min(...priceCandidates) : 0;
        
        // 100% ACCURACY MANDATE: Import ALL variants exactly as CJ provides them
        // Calculate totalStock from known values only, but keep ALL variants (even with unknown stock)
        // If ALL variants have unknown stock, product stock should be null (not 0)
        const variants = cj.variants || [];
        const dynamicAvailableOptions = deriveAvailableOptionsFromVariants(variants, {
          includeOutOfStockDimensions: false,
        });
        const legacy = deriveLegacyOptionArrays(dynamicAvailableOptions);
        const deduplicatedAvailableSizes = legacy.availableSizes;
        const deduplicatedAvailableColors = legacy.availableColors;

        const variantsWithKnownStock = variants.filter((v) => {
          if (typeof v.stock === 'number' && v.stock >= 0) return true;
          if (typeof v.cjStock === 'number' && v.cjStock >= 0) return true;
          if (typeof v.factoryStock === 'number' && v.factoryStock >= 0) return true;
          return false;
        });
        
        // If no variants have known stock, totalStock is null (unknown, not fabricated 0)
        const totalStock: number | null = variantsWithKnownStock.length === 0 
          ? null 
          : variantsWithKnownStock.reduce((acc, v) => {
              if (typeof v.stock === 'number' && v.stock >= 0) return acc + v.stock;
              const cjVal = (typeof v.cjStock === 'number' && v.cjStock >= 0) ? v.cjStock : 0;
              const factoryVal = (typeof v.factoryStock === 'number' && v.factoryStock >= 0) ? v.factoryStock : 0;
              return acc + cjVal + factoryVal;
            }, 0);

        const normalizedImages: string[] = [];
        const seenImageKeys = new Set<string>();
        for (const imageUrl of Array.isArray(cj.images) ? cj.images : []) {
          if (typeof imageUrl !== 'string') continue;
          const enhanced = enhanceProductImageUrl(imageUrl.trim(), 'gallery');
          if (!/^https?:\/\//i.test(enhanced)) continue;
          const key = normalizeCjImageKey(enhanced) || enhanced;
          if (seenImageKeys.has(key)) continue;
          seenImageKeys.add(key);
          normalizedImages.push(enhanced);
        }

        let productPayload: any = {
          title: cj.name,
          slug: existing?.slug || baseSlug,
          description: '',
          price: defaultPrice,
          images: normalizedImages,
          category: categoryParam,
          stock: totalStock,
          video_url: cj.videoUrl || null,
          video_source_url: cj.videoSourceUrl || null,
          video_4k_url: cj.video4kUrl || null,
          video_delivery_mode: cj.videoDeliveryMode || null,
          video_quality_gate_passed:
            typeof cj.videoQualityGatePassed === 'boolean' ? cj.videoQualityGatePassed : null,
          video_source_quality_hint: cj.videoSourceQualityHint || null,
          media_mode: mediaMode || null,
          has_video: Boolean(cj.video4kUrl || cj.videoUrl),
          available_options: dynamicAvailableOptions.length > 0 ? dynamicAvailableOptions : null,
          available_sizes: deduplicatedAvailableSizes.length > 0 ? deduplicatedAvailableSizes : null,
          available_colors: deduplicatedAvailableColors.length > 0 ? deduplicatedAvailableColors : null,
          processing_time_hours: null,
          delivery_time_hours: cj.deliveryTimeHours ?? null,
          origin_area: cj.originArea ?? null,
          origin_country_code: cj.originCountryCode ?? null,
          free_shipping: true,
          inventory_shipping_fee: 0,
          last_mile_fee: 0,
          cj_product_id: cj.productId,
          shipping_from: cj.originArea ?? null,
          is_active: true,
        };

        // Omit is_active if column missing in this environment
        if (!(await hasColumn('products', 'is_active'))) {
          const { is_active, ...rest } = productPayload;
          productPayload = rest;
        }

        for (const col of productOptionalColumns) {
          if (!optionalColumnSet.has(col) && col in productPayload) {
            delete productPayload[col];
          }
        }

        let productId: number;
        if (existing?.id) {
          const { data: upd, error: upErr } = await supabase
            .from('products')
            .update(productPayload)
            .eq('id', existing.id)
            .select('id')
            .single();
          if (upErr || !upd) throw upErr || new Error('Failed to update product');
          productId = upd.id as number;

          // Clear old variants
          await supabase.from('product_variants').delete().eq('product_id', productId);
        } else {
          // Insert with basic idempotency on slug conflicts
          let insResult: any = null;
          try {
            const { data: ins, error: insErr } = await supabase
              .from('products')
              .insert(productPayload)
              .select('id')
              .single();
            if (insErr || !ins) throw insErr || new Error('Failed to insert product');
            insResult = ins;
          } catch (e: any) {
            const msg = String(e?.message || e || '');
            if (/duplicate key|unique constraint|unique violation|already exists/i.test(msg)) {
              const base = productPayload.slug || slugify(cj.name);
              productPayload.slug = await ensureUniqueSlug(supabase, base);
              const { data: ins2, error: err2 } = await supabase
                .from('products')
                .insert(productPayload)
                .select('id')
                .single();
              if (err2 || !ins2) throw err2 || new Error('Failed to insert product (retry)');
              insResult = ins2;
            } else {
              throw e;
            }
          }
          productId = insResult.id as number;
        }

        // Insert variants if table exists
        // CRITICAL: Only import variants with accurate stock data (100% accuracy mandate)
        if (hasVariantsTable) {
          const variantsRows = (cj.variants || [])
            .filter((v) => v && (v.size || v.cjSku || v.variantKey))
            .map((v) => {
              const normalizedSize =
                normalizeSingleSize(v.size, { allowNumeric: true }) ||
                (typeof v.size === 'string' ? v.size.trim() : null);
              const normalizedVariantKeySize =
                normalizeSingleSize(v.variantKey, { allowNumeric: true }) || null;

              // Handle stock values with 100% accuracy:
              // - null/undefined means unknown - skip this variant
              // - -1 is a sentinel for "per-variant unknown" - skip this variant  
              // - 0+ is actual known stock - use this value
              const cjStockRaw = v.cjStock;
              const factoryStockRaw = v.factoryStock;
              
              // Convert to DB values: null for unknown, actual value for known
              const cjStockVal = (typeof cjStockRaw === 'number' && cjStockRaw >= 0) ? cjStockRaw : null;
              const factoryStockVal = (typeof factoryStockRaw === 'number' && factoryStockRaw >= 0) ? factoryStockRaw : null;
              
              // Calculate total stock - ONLY from known CJ data, never fabricated
              // 1. If explicit v.stock provided and >= 0, use it
              // 2. If cj + factory are known, sum them
              // 3. If only one is known, use that
              // 4. If neither is known, mark as null (will be filtered out)
              let totalStock: number | null;
              if (typeof v.stock === 'number' && v.stock >= 0) {
                // CJ provided explicit total for this variant
                totalStock = v.stock;
              } else if (cjStockVal !== null && factoryStockVal !== null) {
                // Both warehouse values known - sum them
                totalStock = cjStockVal + factoryStockVal;
              } else if (cjStockVal !== null) {
                // Only CJ stock known - use it
                totalStock = cjStockVal;
              } else if (factoryStockVal !== null) {
                // Only Factory stock known - use it
                totalStock = factoryStockVal;
              } else {
                // Neither is known - cannot import without fabricating data
                totalStock = null;
              }

              const variantOptions = extractVariantOptionsFromRawVariant(v);
              if (v.color && !Object.keys(variantOptions).some((name) => /color|colour/i.test(name))) {
                variantOptions.Color = String(v.color).trim();
              }
              if (normalizedSize && !Object.keys(variantOptions).some((name) => /size/i.test(name))) {
                variantOptions.Size = normalizedSize;
              }
              const optionSignature = buildOptionSignature(variantOptions);
              
              return {
                product_id: productId,
                option_name: 'Size',
                option_value: normalizedSize || normalizedVariantKeySize || v.variantKey || '-',
                variant_options: Object.keys(variantOptions).length > 0 ? variantOptions : null,
                option_signature: optionSignature || null,
                cj_sku: v.cjSku || null,
                cj_variant_id: v.vid || null,
                variant_key: v.variantKey || null, // Short name like "Black And Silver-2XL"
                price: typeof v.price === 'number' ? v.price : null,
                stock: totalStock, // null if unknown (will be filtered out)
                cj_stock: cjStockVal, // null if unknown, actual value if known
                factory_stock: factoryStockVal, // null if unknown, actual value if known
                weight_grams: typeof v.weightGrams === 'number' ? v.weightGrams : null,
                length_cm: typeof v.lengthCm === 'number' ? v.lengthCm : null,
                width_cm: typeof v.widthCm === 'number' ? v.widthCm : null,
                height_cm: typeof v.heightCm === 'number' ? v.heightCm : null,
              };
            });
          // 100% ACCURACY: Keep ALL variants from CJ, store null for unknown stock
          // Do NOT filter out variants - that would misrepresent CJ's catalog
            
          if (variantsRows.length > 0) {
            const safeVariantsRows = variantsRows.map((row) => {
              const next: Record<string, any> = { ...row };
              for (const col of variantOptionalColumns) {
                if (!variantOptionalColumnSet.has(col)) {
                  delete next[col];
                }
              }
              return next;
            });

            const { error: vErr } = await supabase
              .from('product_variants')
              .insert(safeVariantsRows);
            if (vErr) throw vErr;
          }
        }

        // Best-effort: recompute product stock using trigger or RPC (optional)
        try {
          await supabase.rpc('recompute_product_stock', { product_id_in: productId });
        } catch {}

        results.push({ ok: true, productId, title: cj.name });
      } catch (e: any) {
        results.push({ ok: false, error: e?.message || String(e), title: cj?.name });
      }
    }

    const r = NextResponse.json({ ok: true, version: 'import-v2', results }, { headers: { 'Cache-Control': 'no-store' } });
    r.headers.set('x-request-id', log.requestId);
    return r;
  } catch (e: any) {
    const r = NextResponse.json({ ok: false, version: 'import-v2', error: e?.message || 'CJ import failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
    r.headers.set('x-request-id', log.requestId);
    return r;
  }
}

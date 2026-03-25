import { NextRequest, NextResponse } from "next/server";
import { ensureAdmin } from "@/lib/auth/admin-guard";
import {
  isImportDbConfigured,
  testImportDbConnection,
  createImportBatch,
  addProductToQueue,
  logImportAction,
  getBatches,
  checkProductQueueSchema
} from "@/lib/db/import-db";
import { extractCjProductVideoUrl, normalizeCjVideoUrl } from "@/lib/cj/video";
import { build4kVideoDelivery, requiresVideoForMediaMode } from "@/lib/video/delivery";
import { normalizeSizeList } from "@/lib/cj/size-normalization";
import { ensureHydrated } from "@/lib/hydration/service";

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  console.log('[Import Batch] POST request received');
  try {
    const guard = await ensureAdmin();
    console.log('[Import Batch] Admin guard result:', guard.ok ? 'authenticated' : guard.reason);
    if (!guard.ok) {
      return NextResponse.json({ ok: false, error: guard.reason }, { status: 401 });
    }
    
    if (!isImportDbConfigured()) {
      console.error('[Import Batch] Supabase not configured');
      return NextResponse.json({ ok: false, error: "Database not configured. Please contact support." }, { status: 500 });
    }
    
    console.log('[Import Batch] Database configured, testing connection...');
    const connTest = await testImportDbConnection();
    if (!connTest.ok) {
      console.error('[Import Batch] Database connection test failed:', connTest.error);
      return NextResponse.json({ ok: false, error: connTest.error || "Database connection failed" }, { status: 500 });
    }
    
    console.log('[Import Batch] Database connection verified, checking schema...');
    
    // Check if schema has all required columns
    const schemaCheck = await checkProductQueueSchema();
    if (!schemaCheck.ready) {
      console.warn('[Import Batch] Schema check reported missing columns; continuing with graceful write fallback:', schemaCheck.missingColumns);
    }
    
    console.log('[Import Batch] Schema verified, processing batch...');
    
    const body = await req.json();
    const { name, keywords, category, filters, products, mediaMode } = body;
    const requiresVideo = requiresVideoForMediaMode(mediaMode);
    
    if (!products || !Array.isArray(products) || products.length === 0) {
      return NextResponse.json({ ok: false, error: "No products provided" }, { status: 400 });
    }

    // Hydration gating happens per-product below, so we remove early validation here.

    const batch = await createImportBatch({
      name: name || `Import ${new Date().toISOString()}`,
      keywords: keywords || "",
      category: category || "General",
      filters: filters || {},
      productsFound: products.length,
    });

    if (!batch) {
      console.error("Failed to create batch");
      return NextResponse.json({ ok: false, error: "Failed to create batch" }, { status: 500 });
    }

    let addedCount = 0;
    let failedCount = 0;
    let skippedMissingVideoCount = 0;
    let skippedVideoQualityGateCount = 0;
    const failedProducts: string[] = [];
    const errorMessages: string[] = [];
    
    for (const input of products) {
      // Resolve product ID from incoming payload
      const productId = input.cjProductId || input.pid || input.productId;
      if (!productId) {
        failedCount++;
        failedProducts.push(String(productId));
        if (errorMessages.length < 3) errorMessages.push("Missing required field: pid");
        continue;
      }

      // Ensure full hydration on the server to guarantee fidelity parity
      let p: any = input;
      try {
        const hydrated = await ensureHydrated(String(productId), { dispersionThreshold: 20 });
        p = {
          ...input,
          pid: productId,
          cjProductId: productId,
          cjSku: hydrated.cjSku || input.cjSku,
          name: hydrated.name || input.name,
          images: Array.isArray(hydrated.images) && hydrated.images.length > 0 ? hydrated.images : input.images,
          variants: Array.isArray(hydrated.variants) && hydrated.variants.length > 0 ? hydrated.variants : (input.variants || []),
          avgPriceSAR: hydrated.avgPriceSAR ?? input.avgPriceSAR,
          stock: typeof hydrated.stock === 'number' ? hydrated.stock : input.stock,
          displayedRating: hydrated.displayedRating ?? input.displayedRating,
          ratingConfidence: hydrated.ratingConfidence ?? input.ratingConfidence,
          reviewCount: hydrated.reviewCount ?? input.reviewCount,
          categoryName: hydrated.categoryName ?? input.categoryName,
          availableSizes: hydrated.availableSizes ?? input.availableSizes,
          availableColors: hydrated.availableColors ?? input.availableColors,
          availableModels: hydrated.availableModels ?? input.availableModels,
          description: hydrated.description ?? input.description,
          overview: hydrated.overview ?? input.overview,
          productInfo: hydrated.productInfo ?? input.productInfo,
          sizeInfo: hydrated.sizeInfo ?? input.sizeInfo,
          productNote: hydrated.productNote ?? input.productNote,
          packingList: hydrated.packingList ?? input.packingList,
          videoUrl: hydrated.videoUrl ?? input.videoUrl,
          videoSourceUrl: hydrated.videoSourceUrl ?? input.videoSourceUrl,
          video4kUrl: hydrated.video4kUrl ?? input.video4kUrl,
          videoDeliveryMode: hydrated.videoDeliveryMode ?? input.videoDeliveryMode,
          videoQualityGatePassed: hydrated.videoQualityGatePassed ?? input.videoQualityGatePassed,
          videoSourceQualityHint: hydrated.videoSourceQualityHint ?? input.videoSourceQualityHint,
          inventory: hydrated.inventory ?? input.inventory,
          inventoryByWarehouse: input.inventoryByWarehouse || hydrated.inventory,
          inventoryStatus: hydrated.inventoryStatus ?? input.inventoryStatus,
          inventoryErrorMessage: hydrated.inventoryErrorMessage ?? input.inventoryErrorMessage,
          colorImageMap: hydrated.colorImageMap ?? input.colorImageMap,
          productWeight: hydrated.productWeight ?? input.productWeight,
          packLength: hydrated.packLength ?? input.packLength,
          packWidth: hydrated.packWidth ?? input.packWidth,
          packHeight: hydrated.packHeight ?? input.packHeight,
          originCountry: hydrated.originCountry ?? input.originCountry,
          hsCode: hydrated.hsCode ?? input.hsCode,
          profitMargin: hydrated.profitMarginApplied ?? input.profitMargin,
        };
      } catch (e: any) {
        failedCount++;
        failedProducts.push(String(productId));
        if (errorMessages.length < 3) errorMessages.push(`Hydration failed for ${productId}: ${e?.message || 'unknown error'}`);
        continue;
      }

      // Post-hydration validation for required fields
      if (!p?.name) {
        failedCount++;
        failedProducts.push(String(productId));
        if (errorMessages.length < 3) errorMessages.push(`Missing required field: name for ${productId}`);
        continue;
      }
      if (!Array.isArray(p?.variants) || p.variants.length === 0) {
        failedCount++;
        failedProducts.push(String(productId));
        if (errorMessages.length < 3) errorMessages.push(`Missing required field: variants for ${productId}`);
        continue;
      }
      for (const v of p.variants) {
        if (!v?.variantSku || v?.sellPriceSAR == null) {
          failedCount++;
          failedProducts.push(String(productId));
          if (errorMessages.length < 3) errorMessages.push(`Invalid variant data for ${productId}`);
          p = null; break;
        }
      }
      if (!p) continue;

      let avgPrice = p.avgPriceSAR || 0;
      if (!avgPrice && p.variants?.length > 0) {
        avgPrice = p.variants.reduce((sum: number, v: any) => sum + (v.price || v.variantSellPrice || v.sellPriceUSD || 0), 0) / p.variants.length;
      }

      let totalStock = p.stock || 0;
      if (!totalStock && p.variants?.length > 0) {
        totalStock = p.variants.reduce((sum: number, v: any) => sum + (v.stock || v.variantQuantity || 0), 0);
      }
      
      // Handle images - could be array or single image
      let images: string[] = [];
      if (Array.isArray(p.images)) {
        images = p.images;
      } else if (p.image) {
        images = [p.image];
      }

      const extractedVideoUrl = extractCjProductVideoUrl(p);
      const fallbackVideoUrl = normalizeCjVideoUrl(p?.videoUrl || p?.video || p?.productVideo);
      const videoUrl = extractedVideoUrl || fallbackVideoUrl || undefined;
      const videoDelivery = build4kVideoDelivery(videoUrl);
      const deliverableVideoUrl = videoDelivery.qualityGatePassed ? videoDelivery.deliveryUrl : undefined;

      if (requiresVideo && !videoDelivery.deliveryUrl) {
        skippedMissingVideoCount++;
        failedCount++;
        failedProducts.push(productId);
        if (errorMessages.length < 3) {
          errorMessages.push(`Skipped product ${productId}: missing video for mediaMode=${String(mediaMode || 'unknown')}`);
        }
        continue;
      }

      if (requiresVideo && !videoDelivery.qualityGatePassed) {
        skippedVideoQualityGateCount++;
        failedCount++;
        failedProducts.push(productId);
        if (errorMessages.length < 3) {
          errorMessages.push(
            `Skipped product ${productId}: video quality gate failed (mode=${videoDelivery.mode}, sourceHint=${videoDelivery.sourceQualityHint}).`
          );
        }
        continue;
      }

      // Keep queue payload canonical so review/import steps see one normalized size set.
      const normalizedAvailableSizes = Array.isArray(p.availableSizes)
        ? normalizeSizeList(p.availableSizes, { allowNumeric: false })
        : undefined;

      const result = await addProductToQueue(batch.id, {
        productId,
        cjSku: p.cjSku || undefined,
        storeSku: p.storeSku || undefined,
        name: p.name || undefined,
        description: p.description || undefined,
        overview: p.overview || undefined,
        productInfo: p.productInfo || undefined,
        sizeInfo: p.sizeInfo || undefined,
        productNote: p.productNote || undefined,
        packingList: p.packingList || undefined,
        category: p.categoryName || category || "General",
        images,
        videoUrl: deliverableVideoUrl,
        videoSourceUrl: videoDelivery.sourceUrl,
        video4kUrl: deliverableVideoUrl,
        videoDeliveryMode: videoDelivery.mode,
        videoQualityGatePassed: videoDelivery.qualityGatePassed,
        videoSourceQualityHint: videoDelivery.sourceQualityHint,
        mediaMode: typeof mediaMode === 'string' ? mediaMode : (p.mediaMode || p.media || undefined),
        variants: p.variants || [],
        avgPrice,
        supplierRating: Number.isFinite(Number(p.supplierRating ?? p.rating))
          ? Number(p.supplierRating ?? p.rating)
          : undefined,
        reviewCount: Number.isFinite(Number(p.reviewCount))
          ? Math.max(0, Math.floor(Number(p.reviewCount)))
          : undefined,
        displayedRating: typeof p.displayedRating === 'number' ? p.displayedRating : undefined,
        ratingConfidence: typeof p.ratingConfidence === 'number' ? p.ratingConfidence : undefined,
        totalStock,
        processingDays: p.processingDays ?? undefined,
        deliveryDaysMin: p.deliveryDaysMin ?? undefined,
        deliveryDaysMax: p.deliveryDaysMax ?? undefined,
        qualityScore: p.qualityScore ?? undefined,
        weightG: p.productWeight || undefined,
        packLength: p.packLength || undefined,
        packWidth: p.packWidth || undefined,
        packHeight: p.packHeight || undefined,
        material: p.material || undefined,
        productType: p.productType || undefined,
        originCountry: p.originCountry || undefined,
        hsCode: p.hsCode || undefined,
        sizeChartImages: p.sizeChartImages || undefined,
        availableSizes: normalizedAvailableSizes,
        availableColors: p.availableColors || undefined,
        availableModels: p.availableModels || undefined,
        categoryName: p.categoryName || undefined,
        cjCategoryId: p.cjCategoryId || undefined,
        supabaseCategoryId: p.supabaseCategoryId || undefined,
        supabaseCategorySlug: p.supabaseCategorySlug || undefined,
        variantPricing: p.variantPricing || [],
        sizeChartData: p.sizeChartData || undefined,
        specifications: p.specifications || undefined,
        sellingPoints: p.sellingPoints || undefined,
        inventoryByWarehouse: p.inventoryByWarehouse || p.inventory || undefined,
        inventoryStatus: p.inventoryStatus || undefined,
        inventoryErrorMessage: p.inventoryErrorMessage || undefined,
        priceBreakdown: p.priceBreakdown || undefined,
        colorImageMap: p.colorImageMap || undefined,
        cjTotalCost: p.cjTotalCost || undefined,
        cjShippingCost: p.cjShippingCost || undefined,
        cjProductCost: p.cjProductCost || undefined,
        profitMargin: p.profitMargin || undefined,
      });

      if (result.success) {
        addedCount++;
      } else {
        failedCount++;
        failedProducts.push(productId);
        if (result.error && errorMessages.length < 3) {
          errorMessages.push(result.error);
        }
      }
    }
    
    if (addedCount === 0 && products.length > 0) {
      const errorDetail = errorMessages.length > 0 
        ? ` First error: ${errorMessages[0]}`
        : '';
      const mediaDetail = skippedMissingVideoCount > 0
        ? ` ${skippedMissingVideoCount} products were excluded because media mode requires video.`
        : '';
      const qualityDetail = skippedVideoQualityGateCount > 0
        ? ` ${skippedVideoQualityGateCount} products were excluded because video failed strict 4K quality gate.`
        : '';
      return NextResponse.json({ 
        ok: false, 
        error: `Failed to add any products to queue. ${failedCount} products failed.${mediaDetail}${qualityDetail}${errorDetail}`,
        failedProducts: failedProducts.slice(0, 10),
        errorDetails: errorMessages,
        skippedMissingVideo: skippedMissingVideoCount,
        skippedVideoQualityGate: skippedVideoQualityGateCount,
      }, { status: 500 });
    }

    await logImportAction(batch.id, "batch_created", "success", { 
      products_count: products.length, 
      media_mode: mediaMode || 'any',
      requires_video: requiresVideo,
      skipped_missing_video: skippedMissingVideoCount,
      skipped_video_quality_gate: skippedVideoQualityGateCount,
      keywords, 
      category 
    });

    return NextResponse.json({
      ok: true,
      batchId: batch.id,
      productsAdded: addedCount,
      productsFailed: failedCount,
      productsSkippedMissingVideo: skippedMissingVideoCount,
      productsSkippedVideoQualityGate: skippedVideoQualityGateCount,
      ...(failedCount > 0 && { warning: `${failedCount} products failed to add` }),
    });
  } catch (e: any) {
    console.error("Batch creation error:", e);
    return NextResponse.json({ ok: false, error: e?.message || "Server error" }, { status: 500 });
  }
}

export async function GET() {
  try {
    const batches = await getBatches(50);
    return NextResponse.json({ ok: true, batches });
  } catch (e: any) {
    console.error("Failed to fetch batches:", e);
    return NextResponse.json({ ok: false, error: e?.message || "Server error" }, { status: 500 });
  }
}

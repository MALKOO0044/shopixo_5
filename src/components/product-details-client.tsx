"use client";

import { useState, useRef, useMemo, useEffect } from "react";
import { formatCurrency, cn } from "@/lib/utils";
import type { Product, ProductVariant } from "@/lib/types";
import AddToCart from "@/components/add-to-cart";
import SmartImage from "@/components/smart-image";
import { Heart, Star, ChevronUp, ChevronDown, X, Plus, Minus, Truck, Shield, RotateCcw, Ruler } from "lucide-react";
import SizeGuideModal from "@/components/product/SizeGuideModal";
import ProductTabs from "@/components/product/ProductTabs";
import YouMayAlsoLike from "@/components/product/YouMayAlsoLike";
import MakeItAMatch from "@/components/product/MakeItAMatch";
import { enhanceProductImageUrl } from "@/lib/media/image-quality";
import { computeBilledWeightKg, resolveDdpShippingSar } from "@/lib/pricing";
import { normalizeDisplayedRating } from "@/lib/rating/engine";
import { normalizeSingleSize, normalizeSizeList as normalizeCjSizeList } from "@/lib/cj/size-normalization";
import { extractImagesFromHtml, parseProductDescription } from "@/components/product/SafeHtmlRenderer";
import {
  buildOptionSignature,
  deriveAvailableOptionsFromVariants,
  type DynamicAvailableOption,
  isVariantInStockStrict,
  normalizeOptionNameKey,
  parseDynamicAvailableOptions,
  parseDynamicVariantOptions,
} from "@/lib/variants/dynamic-options";

function isLikelyImageUrl(s: string): boolean {
  if (!s) return false;
  if (s.startsWith('http://') || s.startsWith('https://')) return true;
  if (s.startsWith('/')) return true;
  if (s.startsWith('data:image/')) return true;
  return false;
}

function isLikelyVideoUrl(s: string): boolean {
  if (!s) return false;
  const str = s.trim().toLowerCase();
  if (str.startsWith('data:video/')) return true;
  if (/(\.mp4|\.webm|\.ogg|\.m3u8)(\?|#|$)/.test(str)) return true;
  if (str.includes('res.cloudinary.com') && (str.includes('/video/upload/') || str.includes('/video/fetch/'))) return true;
  if (str.startsWith('/storage/v1/object/public/') || /^\/?[^:\/]+\/.+/.test(str)) {
    return /(\.mp4|\.webm|\.ogg|\.m3u8)(\?|#|$)/.test(str);
  }
  return false;
}

function buildSupabasePublicUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return path;
  const cleaned = path.replace(/^\/+/, "");
  return `${base.replace(/\/$/, "")}/storage/v1/object/public/${cleaned}`;
}

function videoMimeFromUrl(url: string): string | undefined {
  try {
    const u = normalizeImageUrl(url).toLowerCase();
    if (u.includes('.mp4')) return 'video/mp4';
    if (u.includes('.webm')) return 'video/webm';
    if (u.includes('.ogg')) return 'video/ogg';
    if (u.includes('.m3u8')) return 'application/vnd.apple.mpegURL';
  } catch {}
  return undefined;
}

function transformVideo(url: string): string {
  try {
    url = normalizeImageUrl(url);
    if (typeof url === 'string' && url.includes('res.cloudinary.com') && url.includes('/video/')) {
      const isUpload = url.includes('/video/upload/');
      const isFetch = url.includes('/video/fetch/');
      const marker = isUpload ? '/video/upload/' : (isFetch ? '/video/fetch/' : null);
      if (!marker) return url;
      const idx = url.indexOf(marker);
      const before = url.slice(0, idx + marker.length);
      const after = url.slice(idx + marker.length);
      const has4kTransforms = /(w_3840|h_2160|w_4096|2160p|\b4k\b|3840x2160|4096x2160)/i.test(after);
      const inject = 'f_mp4,vc_h264,ac_aac,q_auto:best,c_limit,w_3840,h_2160/';
      const core = has4kTransforms ? after : (inject + after);
      return (before + core).replace(/\.(mp4|webm|ogg|m3u8)(\?.*)?$/i, '.mp4');
    }
    const cloud = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
    const isHttp = typeof url === 'string' && /^https?:\/\//i.test(url);
    const isMp4 = typeof url === 'string' && /\.mp4(\?|#|$)/i.test(url);
    if (cloud && isHttp && !isMp4) {
      return `https://res.cloudinary.com/${cloud}/video/fetch/f_mp4,vc_h264,ac_aac,q_auto:best,c_limit,w_3840,h_2160/${encodeURIComponent(url)}`;
    }
  } catch {}
  return url;
}

function normalizeImageUrl(url: string): string {
  try {
    if (!url) return url;
    if (url.startsWith('http://')) return 'https://' + url.slice('http://'.length);
    if (url.startsWith('https://') || url.startsWith('data:')) return url;
    if (url.startsWith('/storage/v1/object/public/')) {
      const base = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
      return `${base.replace(/\/$/, '')}${url}`;
    }
    if (/^\/(?!storage\/v1\/object\/public\/)[^:\/]+\/.+/.test(url)) {
      return buildSupabasePublicUrl(url.slice(1));
    }
    if (/^[^:\/]+\/.+/.test(url)) {
      return buildSupabasePublicUrl(url);
    }
  } catch {}
  return url;
}

function normalizeColorKey(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveColorImageForColor(colorValue: unknown, colorMap: Record<string, string>): string | null {
  const color = String(colorValue ?? '').trim();
  if (!color || !colorMap || Object.keys(colorMap).length === 0) return null;

  const exact = colorMap[color];
  if (typeof exact === 'string' && exact) return exact;

  const target = normalizeColorKey(color);
  if (!target) return null;

  for (const [mapColor, imageUrl] of Object.entries(colorMap)) {
    if (!imageUrl) continue;
    const key = normalizeColorKey(mapColor);
    if (!key) continue;
    if (key === target || key.includes(target) || target.includes(key)) {
      return imageUrl;
    }
  }

  return null;
}

function findOptionValueByNormalizedKey(options: Record<string, string>, key: string): string {
  for (const [name, value] of Object.entries(options || {})) {
    if (normalizeOptionNameKey(name) === key) {
      return String(value || '').trim();
    }
  }
  return '';
}

function selectedOptionsMatchVariantOptions(
  selected: Record<string, string>,
  variant: Record<string, string>
): boolean {
  const selectedEntries = Object.entries(selected || {}).filter(
    ([name, value]) => String(name).trim().length > 0 && String(value).trim().length > 0
  );
  if (selectedEntries.length === 0) return false;

  for (const [name, value] of selectedEntries) {
    const key = normalizeOptionNameKey(name);
    const selectedValue = String(value || '').trim().toLowerCase();
    const variantValue = findOptionValueByNormalizedKey(variant, key).toLowerCase();
    if (!variantValue || variantValue !== selectedValue) {
      return false;
    }
  }

  return true;
}

function htmlToPlainText(value: unknown): string {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const BLOCKED_SPEC_KEYS = new Set([
  'productinfo',
  'sizeinfo',
  'overview',
  'productnote',
  'packinglist',
  'description',
]);

function getCloudinaryVideoPoster(url: string): string | null {
  try {
    const u = normalizeImageUrl(url);
    if (typeof u === 'string' && u.includes('res.cloudinary.com') && (u.includes('/video/upload/') || u.includes('/video/fetch/'))) {
      const markerUpload = '/video/upload/';
      const markerFetch = '/video/fetch/';
      const marker = u.includes(markerUpload) ? markerUpload : (u.includes(markerFetch) ? markerFetch : null);
      if (!marker) return null;
      const idx = u.indexOf(marker);
      if (idx === -1) return null;
      const before = u.slice(0, idx + marker.length);
      const after = u.slice(idx + marker.length);
      const inject = 'so_0,q_auto:best/';
      const core = after.replace(/\.(mp4|webm|ogg|m3u8)(\?.*)?$/i, '');
      return `${before}${inject}${core}.jpg`;
    }
  } catch {}
  return null;
}

function transformImage(url: string, preset: 'gallery' | 'zoom' = 'gallery'): string {
  return enhanceProductImageUrl(normalizeImageUrl(url), preset);
}

interface MediaGalleryProps {
  images: string[];
  title: string;
  videoUrl?: string | null;
  selectedColor?: string;
  colorImageMap?: Record<string, string>;
  availableColors?: string[];
  descriptionImages?: string[];
}

function MediaGallery({ images, title, videoUrl, selectedColor, colorImageMap = {}, availableColors = [], descriptionImages = [] }: MediaGalleryProps) {
  const baseMedia = useMemo(() => {
    return (Array.isArray(images) ? images : [])
      .map((s) => (typeof s === 'string' ? normalizeImageUrl(s) : s))
      .filter((s) => typeof s === 'string' && !!String(s).trim()) as string[];
  }, [images]);

  const hasCanonicalBaseGallery = baseMedia.length > 0;

  const colorMedia = useMemo(() => {
    if (hasCanonicalBaseGallery) return [];

    const values = Object.values(colorImageMap || {});
    return values
      .map((s) => (typeof s === 'string' ? normalizeImageUrl(s) : s))
      .filter((s) => typeof s === 'string' && !!String(s).trim() && !baseMedia.includes(s)) as string[];
  }, [colorImageMap, baseMedia, hasCanonicalBaseGallery]);

  const extraImages = useMemo(() => {
    if (hasCanonicalBaseGallery) return [];

    return (Array.isArray(descriptionImages) ? descriptionImages : [])
      .map((s) => (typeof s === 'string' ? normalizeImageUrl(s) : s))
      .filter(
        (s) =>
          typeof s === 'string' &&
          !!String(s).trim() &&
          !baseMedia.includes(s) &&
          !colorMedia.includes(s)
      )
      .slice(0, 12) as string[];
  }, [descriptionImages, baseMedia, colorMedia, hasCanonicalBaseGallery]);

  const media = useMemo(() => {
    if (hasCanonicalBaseGallery) return baseMedia;
    return [...colorMedia, ...extraImages];
  }, [baseMedia, colorMedia, extraImages, hasCanonicalBaseGallery]);

  const items = useMemo(() => {
    const arr = [...media];
    if (videoUrl && typeof videoUrl === 'string' && videoUrl.trim()) arr.unshift(videoUrl.trim());
    return arr.length > 0 ? arr : ["/placeholder.svg"];
  }, [media, videoUrl]);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const selected = items[selectedIndex] || items[0];
  const thumbnailContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedIndex >= items.length) {
      setSelectedIndex(0);
    }
  }, [items.length, selectedIndex]);
  
  // When selectedColor changes, update the main gallery image
  // Strategy: Find the color's image in the gallery by URL matching or positional fallback
  useEffect(() => {
    if (!selectedColor) return;
    
    const colorImage = resolveColorImageForColor(selectedColor, colorImageMap) || undefined;
    
    let targetIndex = -1;
    
    // Strategy 1: Try to find the exact image URL in items
    if (colorImage) {
      const normalizedColorImage = normalizeImageUrl(colorImage);
      targetIndex = items.findIndex(item => {
        const normalizedItem = normalizeImageUrl(item);
        // Exact match or partial match (URL might have query params)
        return normalizedItem === normalizedColorImage || 
               item === colorImage ||
               normalizedItem.includes(normalizedColorImage) ||
               normalizedColorImage.includes(normalizedItem);
      });
    }
    
    // Strategy 2: Positional fallback - use color's index in available_colors
    // The gallery images are typically ordered to match color order
    if (targetIndex < 0 && selectedColor && availableColors.length > 0) {
      // Positional fallback is only safe when gallery image slots exactly match color count.
      const hasVideo = items.length > 0 && isLikelyVideoUrl(items[0] || '');
      const mediaSlots = hasVideo ? Math.max(items.length - 1, 0) : items.length;
      const positionalFallbackSafe = mediaSlots === availableColors.length;

      if (positionalFallbackSafe) {
        const normalizedSelectedColor = selectedColor.toLowerCase().trim();
        const colorIndex = availableColors.findIndex(
          (c) => String(c || '').toLowerCase().trim() === normalizedSelectedColor
        );
        if (colorIndex >= 0 && colorIndex < mediaSlots) {
          targetIndex = hasVideo ? colorIndex + 1 : colorIndex;
        }
      }
    }
    
    if (targetIndex >= 0 && targetIndex < items.length) {
      setSelectedIndex((prev) => (prev === targetIndex ? prev : targetIndex));
    }
  }, [selectedColor, colorImageMap, items, availableColors]);

  const [zoomOpen, setZoomOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  function openZoom() {
    setScale(1); setTx(0); setTy(0); setZoomOpen(true);
  }
  function closeZoom() { setZoomOpen(false); }

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.1 : -0.1;
    setScale((s) => Math.min(4, Math.max(1, +(s + delta).toFixed(2))));
  }

  function onPointerDown(e: React.PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, tx, ty };
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!dragging || !dragStart.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setTx(dragStart.current.tx + dx);
    setTy(dragStart.current.ty + dy);
  }

  function onPointerUp(e: React.PointerEvent) {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    setDragging(false);
    dragStart.current = null;
  }

  const scrollThumbnails = (direction: 'up' | 'down') => {
    if (thumbnailContainerRef.current) {
      const scrollAmount = 80;
      thumbnailContainerRef.current.scrollBy({
        top: direction === 'up' ? -scrollAmount : scrollAmount,
        behavior: 'smooth'
      });
    }
  };

  const goToPrev = () => {
    setSelectedIndex((prev) => (prev > 0 ? prev - 1 : items.length - 1));
  };
  const goToNext = () => {
    setSelectedIndex((prev) => (prev < items.length - 1 ? prev + 1 : 0));
  };

  return (
    <div className="flex gap-2" dir="ltr">
      {/* Thumbnails on LEFT - small and tight */}
      <div className="flex flex-col w-[52px] md:w-[56px] shrink-0">
        <div
          ref={thumbnailContainerRef}
          className="flex flex-col gap-1 overflow-y-auto scrollbar-hide"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none', maxHeight: '500px' }}
        >
          {items.map((item, index) => (
            <button
              key={index}
              onClick={() => setSelectedIndex(index)}
              className={cn(
                "relative w-[48px] h-[48px] md:w-[52px] md:h-[52px] rounded overflow-hidden border transition-all shrink-0",
                selectedIndex === index 
                  ? "border-primary border-2" 
                  : "border-gray-200 hover:border-gray-400"
              )}
            >
              {isLikelyVideoUrl(item) ? (
                <div className="w-full h-full bg-muted flex items-center justify-center">
                  <div className="w-0 h-0 border-l-[8px] border-l-foreground border-y-[5px] border-y-transparent" />
                </div>
              ) : (
                <SmartImage
                  src={transformImage(item)}
                  alt={`Image ${index + 1}`}
                  fill
                  quality={95}
                  className="object-cover"
                  loading="lazy"
                  onError={(e: any) => {
                    try {
                      const el = e.currentTarget as HTMLImageElement;
                      if (el && !el.src.endsWith('/placeholder.svg')) {
                        el.src = '/placeholder.svg';
                      }
                    } catch {}
                  }}
                />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Main image with overlaid navigation arrows */}
      <div className="relative w-[400px] md:w-[480px] lg:w-[500px]">
        <div
          className="relative w-full aspect-[3/4] rounded overflow-hidden bg-gray-50 cursor-zoom-in"
          onClick={() => !isLikelyVideoUrl(selected) && openZoom()}
          role={!isLikelyVideoUrl(selected) ? 'button' : undefined}
          aria-label={!isLikelyVideoUrl(selected) ? 'Zoom image' : undefined}
        >
          {isLikelyVideoUrl(selected) ? (
            <video
              className="h-full w-full object-cover"
              controls
              playsInline
              preload="metadata"
              crossOrigin="anonymous"
              poster={getCloudinaryVideoPoster(selected) || undefined}
            >
              <source src={transformVideo(selected)} type={videoMimeFromUrl(selected)} />
            </video>
          ) : (
            <SmartImage
              src={transformImage(selected)}
              alt={title}
              fill
              quality={95}
              className="object-cover"
              loading="eager"
              onError={(e: any) => {
                try {
                  const el = e.currentTarget as HTMLImageElement;
                  if (el && !el.src.endsWith('/placeholder.svg')) {
                    el.src = '/placeholder.svg';
                  }
                } catch {}
              }}
            />
          )}
          {/* Navigation arrows overlaid on image */}
          {items.length > 1 && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); goToPrev(); }}
                className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 md:w-10 md:h-10 rounded-full bg-white/80 hover:bg-white shadow flex items-center justify-center transition-colors"
                aria-label="Previous image"
              >
                <ChevronUp className="w-5 h-5 -rotate-90" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); goToNext(); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 md:w-10 md:h-10 rounded-full bg-white/80 hover:bg-white shadow flex items-center justify-center transition-colors"
                aria-label="Next image"
              >
                <ChevronDown className="w-5 h-5 -rotate-90" />
              </button>
            </>
          )}
        </div>
      </div>

      {zoomOpen && !isLikelyVideoUrl(selected) && (
        <div className="fixed inset-0 z-50" aria-modal="true" role="dialog">
          <div className="absolute inset-0 bg-black/80" onClick={closeZoom} />
          <button
            aria-label="Close"
            onClick={closeZoom}
            className="absolute top-4 right-4 z-10 rounded-full bg-white/90 p-2 hover:bg-white transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
          <div className="absolute top-4 left-4 z-10 flex gap-2">
            <button onClick={() => setScale((s) => Math.min(4, +(s + 0.2).toFixed(2)))} className="rounded-full bg-white/90 p-2 hover:bg-white transition-colors">
              <Plus className="w-5 h-5" />
            </button>
            <button onClick={() => setScale((s) => Math.max(1, +(s - 0.2).toFixed(2)))} className="rounded-full bg-white/90 p-2 hover:bg-white transition-colors">
              <Minus className="w-5 h-5" />
            </button>
          </div>
          <div
            className="absolute inset-0 flex items-center justify-center touch-pan-y"
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={transformImage(selected, 'zoom')}
              alt={title}
              className="pointer-events-none select-none max-w-[90vw] max-h-[90vh]"
              style={{
                transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
                transformOrigin: 'center center',
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

interface DetailHeaderProps {
  title: string;
  storeSku?: string | null;
  productCode?: string | null;
  rating: number;
  reviewCount?: number;
}

function DetailHeader({ title, storeSku, productCode, rating, reviewCount = 0 }: DetailHeaderProps) {
  const hasRating = Number.isFinite(rating) && rating > 0;
  const displayRating = hasRating ? normalizeDisplayedRating(rating) : 0;
  const fullStars = Math.floor(displayRating);
  const hasHalfStar = displayRating % 1 >= 0.5;

  return (
    <div className="space-y-2">
      <h1 className="text-lg md:text-xl font-bold text-foreground leading-tight">
        {title}
      </h1>

      {storeSku && (
        <p className="text-sm text-muted-foreground">
          Store SKU: <span className="font-mono text-foreground">{storeSku}</span>
        </p>
      )}
      
      {productCode && productCode !== storeSku && (
        <p className="text-sm text-muted-foreground">
          Product Code: <span className="font-mono text-foreground">{productCode}</span>
        </p>
      )}

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-0.5">
          {[...Array(5)].map((_, i) => (
            <Star
              key={i}
              className={cn(
                "w-4 h-4",
                i < fullStars 
                  ? "fill-amber-400 text-amber-400" 
                  : i === fullStars && hasHalfStar
                    ? "fill-amber-400/50 text-amber-400"
                    : "fill-muted text-muted"
              )}
            />
          ))}
        </div>
        <span className="text-sm text-muted-foreground">
          {hasRating
            ? `${displayRating.toFixed(1)} (${reviewCount > 0 ? reviewCount.toLocaleString('en-US') : '0'} Reviewed)`
            : 'No reviews yet'}
        </span>
      </div>
    </div>
  );
}

interface PriceBlockProps {
  price: number;
  originalPrice?: number;
  isAvailable: boolean;
  minPrice?: number;
  maxPrice?: number;
  showRange?: boolean;
}

function PriceBlock({ price, originalPrice, isAvailable, minPrice, maxPrice, showRange }: PriceBlockProps) {
  const hasDiscount = originalPrice && originalPrice > price;
  const discountPercent = hasDiscount ? Math.round((1 - price / originalPrice) * 100) : 0;
  const hasPriceRange = showRange && minPrice && maxPrice && minPrice !== maxPrice;

  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-3 flex-wrap">
        {hasPriceRange ? (
          <span className="text-xl md:text-2xl font-bold text-foreground">
            {formatCurrency(minPrice)} - {formatCurrency(maxPrice)}
          </span>
        ) : (
          <span className="text-xl md:text-2xl font-bold text-foreground">
            {formatCurrency(price)}
          </span>
        )}
        {hasDiscount && !hasPriceRange && (
          <>
            <span className="text-base text-muted-foreground line-through">
              {formatCurrency(originalPrice)}
            </span>
            <span className="px-2 py-0.5 bg-red-100 text-red-700 text-sm font-medium rounded">
              -{discountPercent}%
            </span>
          </>
        )}
      </div>
      <div className={cn(
        "text-sm font-medium",
        isAvailable ? "text-green-600" : "text-red-600"
      )}>
        {isAvailable ? 'In Stock' : 'Out of Stock'}
      </div>
    </div>
  );
}

interface ColorSelectorProps {
  colors: string[];
  selectedColor: string;
  onColorChange: (color: string) => void;
  colorImages?: Record<string, string>;
  hotColors?: string[];
}

// Map color names to CSS colors for swatch display
const COLOR_NAME_MAP: Record<string, string> = {
  // Basic colors
  'white': '#FFFFFF', 'black': '#000000', 'red': '#E53935', 'blue': '#1E88E5',
  'green': '#43A047', 'yellow': '#FDD835', 'orange': '#FB8C00', 'purple': '#8E24AA',
  'pink': '#EC407A', 'brown': '#6D4C41', 'gray': '#757575', 'grey': '#757575',
  'gold': '#FFD700', 'silver': '#C0C0C0', 'beige': '#F5F5DC', 'ivory': '#FFFFF0',
  'cream': '#FFFDD0', 'tan': '#D2B48C', 'khaki': '#C3B091', 'navy': '#000080',
  'teal': '#008080', 'cyan': '#00BCD4', 'maroon': '#800000', 'olive': '#808000',
  'coral': '#FF7F50', 'salmon': '#FA8072', 'turquoise': '#40E0D0', 'indigo': '#3F51B5',
  'violet': '#EE82EE', 'magenta': '#FF00FF', 'lavender': '#E6E6FA', 'burgundy': '#800020',
  'rose': '#FF007F', 'peach': '#FFCBA4', 'mint': '#98FF98', 'aqua': '#00FFFF',
  'nude': '#E3BC9A', 'champagne': '#F7E7CE', 'camel': '#C19A6B', 'coffee': '#6F4E37',
  'wine': '#722F37', 'charcoal': '#36454F', 'slate': '#708090', 'taupe': '#483C32',
  // Light/Dark variants
  'light blue': '#87CEEB', 'light brown': '#C4A484', 'light green': '#90EE90',
  'light grey': '#D3D3D3', 'light gray': '#D3D3D3', 'light pink': '#FFB6C1',
  'dark blue': '#00008B', 'dark brown': '#654321', 'dark green': '#006400',
  'dark grey': '#A9A9A9', 'dark gray': '#A9A9A9', 'dark red': '#8B0000',
  'sky blue': '#87CEEB', 'royal blue': '#4169E1', 'baby blue': '#89CFF0',
  'hot pink': '#FF69B4', 'deep pink': '#FF1493', 'pale pink': '#FADADD',
  // Common product colors
  'apricot': '#FBCEB1', 'leopard': '#A17249', 'camouflage': '#78866B', 'camo': '#78866B',
  'multicolor': 'linear-gradient(135deg, #FF6B6B, #4ECDC4, #45B7D1, #96E6A1, #DDA0DD)',
  'multi': 'linear-gradient(135deg, #FF6B6B, #4ECDC4, #45B7D1, #96E6A1, #DDA0DD)',
  'rainbow': 'linear-gradient(135deg, red, orange, yellow, green, blue, violet)',
  'transparent': 'linear-gradient(45deg, #ccc 25%, transparent 25%, transparent 75%, #ccc 75%, #ccc), linear-gradient(45deg, #ccc 25%, transparent 25%, transparent 75%, #ccc 75%, #ccc)',
  'clear': 'linear-gradient(45deg, #eee 25%, transparent 25%, transparent 75%, #eee 75%, #eee), linear-gradient(45deg, #eee 25%, transparent 25%, transparent 75%, #eee 75%, #eee)',
};

function getColorFromName(colorName: string): string | null {
  const lowerName = colorName.toLowerCase().trim();
  
  // Direct match
  if (COLOR_NAME_MAP[lowerName]) return COLOR_NAME_MAP[lowerName];
  
  // Check if any key is contained in the color name
  for (const [key, value] of Object.entries(COLOR_NAME_MAP)) {
    if (lowerName.includes(key)) return value;
  }
  
  // Try to parse hex colors if provided directly
  if (/^#[0-9A-Fa-f]{6}$/.test(colorName)) return colorName;
  if (/^#[0-9A-Fa-f]{3}$/.test(colorName)) return colorName;
  
  return null;
}

function ColorSelector({ colors, selectedColor, onColorChange, colorImages = {}, hotColors = [] }: ColorSelectorProps) {
  if (colors.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-foreground">Color:</span>
        <span className="text-sm text-primary font-medium">{selectedColor}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {colors.map((color) => {
          const isSelected = color === selectedColor;
          const isHot = hotColors.includes(color);
          const colorImageUrl = colorImages[color];
          const cssColor = getColorFromName(color);
          const isTransparent = color.toLowerCase().includes('transparent') || color.toLowerCase().includes('clear');

          return (
            <button
              key={color}
              onClick={() => onColorChange(color)}
              className={cn(
                "relative w-10 h-10 md:w-12 md:h-12 rounded-md overflow-hidden transition-all",
                isSelected 
                  ? "ring-2 ring-primary ring-offset-2" 
                  : "border border-gray-300 hover:border-gray-500"
              )}
              title={color}
            >
              {colorImageUrl ? (
                <SmartImage
                  src={enhanceProductImageUrl(normalizeImageUrl(colorImageUrl), 'thumbnail')}
                  alt={color}
                  fill
                  quality={95}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              ) : cssColor ? (
                <div 
                  className="w-full h-full"
                  style={{ 
                    background: cssColor,
                    backgroundSize: isTransparent ? '8px 8px' : undefined,
                    backgroundPosition: isTransparent ? '0 0, 4px 4px' : undefined,
                  }}
                />
              ) : (
                <div className="w-full h-full bg-gradient-to-br from-gray-200 to-gray-300 flex items-center justify-center">
                  <span className="text-[10px] text-gray-600 font-medium text-center leading-tight px-0.5">
                    {color.slice(0, 4).toUpperCase()}
                  </span>
                </div>
              )}
              {isHot && (
                <span className="absolute -top-1 -right-1 px-1 py-0.5 bg-red-500 text-white text-[10px] font-bold rounded">
                  HOT
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface SizeSelectorProps {
  sizes: string[];
  selectedSize: string;
  onSizeChange: (size: string) => void;
  sizeStock?: Record<string, number>;
}

function SizeSelector({ sizes, selectedSize, onSizeChange, sizeStock = {} }: SizeSelectorProps) {
  if (sizes.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-foreground">Size:</span>
        <span className="text-sm text-muted-foreground">{selectedSize}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {sizes.map((size) => {
          const isSelected = size === selectedSize;
          // Treat stock=0, null, undefined as "available" (CJ often returns 0 as default)
          const stockValue = sizeStock[size];
          const hasExplicitStock = stockValue !== undefined && stockValue !== null && stockValue !== 0;
          // Only mark out of stock if stock is explicitly negative (shouldn't happen)
          const isOutOfStock = hasExplicitStock && stockValue < 0;
          const isLowStock = hasExplicitStock && stockValue > 0 && stockValue <= 3;

          return (
            <button
              key={size}
              onClick={() => !isOutOfStock && onSizeChange(size)}
              disabled={isOutOfStock}
              className={cn(
                "relative min-w-[48px] px-4 py-2 rounded-md text-sm font-medium transition-all",
                isSelected
                  ? "bg-primary text-primary-foreground"
                  : isOutOfStock
                    ? "bg-muted text-muted-foreground cursor-not-allowed line-through"
                    : "bg-card border border-border hover:border-primary text-foreground"
              )}
            >
              {size}
              {isLowStock && !isSelected && (
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-amber-500 rounded-full" />
              )}
            </button>
          );
        })}
      </div>
      {sizeStock[selectedSize] !== undefined && sizeStock[selectedSize] > 0 && sizeStock[selectedSize] <= 3 && (
        <p className="text-sm text-amber-600">
          Only {sizeStock[selectedSize]} left!
        </p>
      )}
    </div>
  );
}

interface ActionPanelProps {
  productId: number;
  productSlug: string;
  selectedOptions: Record<string, string>;
  disabled: boolean;
  onWishlistToggle?: () => void;
  isWishlisted?: boolean;
}

function ActionPanel({ productId, productSlug, selectedOptions, disabled, onWishlistToggle, isWishlisted = false }: ActionPanelProps) {
  return (
    <div className="flex gap-3">
      <div className="flex-1">
        <AddToCart 
          productId={productId} 
          productSlug={productSlug as any} 
          selectedOptions={selectedOptions} 
          disabled={disabled} 
        />
      </div>
      {onWishlistToggle && (
        <button
          onClick={onWishlistToggle}
          className={cn(
            "w-12 h-12 flex items-center justify-center rounded-md border transition-colors",
            isWishlisted 
              ? "bg-red-50 border-red-200 text-red-500" 
              : "bg-card border-border text-muted-foreground hover:text-red-500 hover:border-red-200"
          )}
          aria-label={isWishlisted ? "Remove from wishlist" : "Add to wishlist"}
        >
          <Heart className={cn("w-5 h-5", isWishlisted && "fill-current")} />
        </button>
      )}
    </div>
  );
}

interface ShippingInfoProps {
  cjPid?: string;
  quote: { retailSar: number; shippingSar: number; options: any[] } | null;
  quoteLoading: boolean;
  selectedVariant: ProductVariant | null;
  product: Product;
}

function ShippingInfo({ cjPid, quote, quoteLoading, selectedVariant, product }: ShippingInfoProps) {
  const hasLiveQuote = cjPid && quote;
  
  const fallbackShipping = useMemo(() => {
    if (!selectedVariant) return null;
    const actualKg = typeof selectedVariant.weight_grams === 'number' && selectedVariant.weight_grams > 0 
      ? selectedVariant.weight_grams / 1000 
      : 0.4;
    const L = typeof selectedVariant.length_cm === 'number' ? selectedVariant.length_cm : 30;
    const W = typeof selectedVariant.width_cm === 'number' ? selectedVariant.width_cm : 25;
    const H = typeof selectedVariant.height_cm === 'number' ? selectedVariant.height_cm : 5;
    const billedKg = computeBilledWeightKg({ actualKg, lengthCm: L, widthCm: W, heightCm: H });
    const ddp = resolveDdpShippingSar(billedKg);
    return { ddp, total: (selectedVariant.price ?? product.price) + ddp };
  }, [selectedVariant, product.price]);

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div className="grid grid-cols-3 gap-4 pb-3 border-b">
        <div className="flex flex-col items-center gap-1 text-center">
          <Truck className="w-5 h-5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Fast Shipping</span>
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <Shield className="w-5 h-5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Secure Payment</span>
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <RotateCcw className="w-5 h-5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Easy Returns</span>
        </div>
      </div>
      
      <div className="space-y-2 text-sm">
        <div className="font-medium">Shipping & Delivery (Estimated)</div>
        
        {((product as any).origin_area || (product as any).origin_country_code) && (
          <div className="text-xs text-muted-foreground">
            Ships from: {(product as any).origin_area || '-'}
            {(product as any).origin_country_code ? `, ${(product as any).origin_country_code}` : ''}
          </div>
        )}
        
        {!selectedVariant && (
          <p className="text-muted-foreground">Select a size to view shipping and total.</p>
        )}
        
        {selectedVariant && quoteLoading && (
          <p className="text-muted-foreground">Calculating shipping cost...</p>
        )}
        
        {selectedVariant && !quoteLoading && hasLiveQuote && quote && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-muted-foreground">Cheapest Shipping</div>
                <div className="font-medium">{formatCurrency(quote.shippingSar)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Delivery Price</div>
                <div className="font-medium">{formatCurrency(quote.retailSar)}</div>
              </div>
            </div>
            {quote.options.length > 0 && (
              <div>
                <div className="text-muted-foreground mb-1">Shipping Options</div>
                <ul className="list-disc pr-5 text-xs space-y-1">
                  {quote.options.slice(0, 3).map((o: any, i: number) => {
                    const rng = o.logisticAgingDays;
                    const days = rng ? (rng.max ? `${rng.min || rng.max}-${rng.max} days` : `${rng.min} days`) : null;
                    return (
                      <li key={i}>{o.name || o.code}: {formatCurrency(Number(o.price || 0))}{days ? ` · ${days}` : ''}</li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        )}
        
        {selectedVariant && !quoteLoading && !hasLiveQuote && fallbackShipping && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-muted-foreground">Shipping Fee (DDP)</div>
              <div className="font-medium">{formatCurrency(fallbackShipping.ddp)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Total</div>
              <div className="font-medium">{formatCurrency(fallbackShipping.total)}</div>
            </div>
          </div>
        )}
        
        {selectedVariant && !quoteLoading && (
          <div className="grid grid-cols-2 gap-2 pt-2 border-t">
            <div>
              <div className="text-muted-foreground">Processing Time</div>
              <div className="text-foreground">
                {typeof (product as any).processing_time_hours === 'number' 
                  ? `${Math.max(1, Math.round((product as any).processing_time_hours / 24))}–${Math.max(1, Math.ceil(((product as any).processing_time_hours + 24) / 24))} days` 
                  : '—'}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Delivery Time</div>
              <div className="text-foreground">
                {typeof (product as any).delivery_time_hours === 'number' 
                  ? `${Math.max(1, Math.round((product as any).delivery_time_hours / 24))}–${Math.max(1, Math.ceil(((product as any).delivery_time_hours + 24) / 24))} days` 
                  : '—'}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ProductDetailsClient({ 
  product, 
  variantRows, 
  children 
}: { 
  product: Product; 
  variantRows?: ProductVariant[]; 
  children?: React.ReactNode;
}) {
  // Known size tokens for accurate parsing
  const SIZE_TOKENS = new Set([
    'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '2XL', '3XL', '4XL', '5XL', '6XL',
    'ONE SIZE', 'FREE SIZE', 'OS', 'FS', 'F', 'SMALL', 'MEDIUM', 'LARGE',
    'BOXED', 'OPP', 'A', 'B', 'C', 'D', 'E',
    '30', '32', '34', '36', '38', '40', '42', '44', '46', '48', '50',
    '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16'
  ]);
  
  function isSkuCode(str: string): boolean {
    if (!str) return false;
    const upper = str.toUpperCase().trim();
    
    if (/^CJ[A-Z]{2,}\d{5,}/.test(upper)) return true;
    
    if (/^[A-Z]{2}\d{4,}[A-Z]+\d+/.test(upper)) return true;
    
    if (/^\d{7,}/.test(str)) return true;
    
    if (/^[A-Z]{2,3}\d{6,}/.test(upper)) return true;
    
    return false;
  }

  function splitColorSize(v: string): { color?: string; size?: string } {
    if (!v) return {};
    const str = String(v).trim();
    
    // Strategy 1: Try "/" separator first (most reliable)
    if (str.includes(' / ') || str.includes('/')) {
      const parts = str.split(/\s*\/\s*/).map(s => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const potentialColor = parts[0];
        const potentialSize = parts[1];
        const color = (potentialColor && !isSkuCode(potentialColor)) ? potentialColor : undefined;
        const normalizedSize = normalizeSingleSize(potentialSize, { allowNumeric: true });
        return { color, size: normalizedSize || potentialSize || undefined };
      }
    }
    
    // Strategy 2: For hyphen separator, be smarter - find last hyphen where right side is a known size
    // This handles "Dark Blue-L" correctly (color="Dark Blue", size="L")
    // Also handles "Moon And Night-S" correctly
    const lastHyphenIdx = str.lastIndexOf('-');
    if (lastHyphenIdx > 0 && lastHyphenIdx < str.length - 1) {
      const potentialColor = str.slice(0, lastHyphenIdx).trim();
      const potentialSize = str.slice(lastHyphenIdx + 1).trim();
      
      // Check if the right side looks like a size
      if (SIZE_TOKENS.has(potentialSize.toUpperCase()) || /^\d{1,2}$/.test(potentialSize)) {
        const color = isSkuCode(potentialColor) ? undefined : potentialColor;
        const normalizedSize = normalizeSingleSize(potentialSize, { allowNumeric: true });
        return { color, size: normalizedSize || potentialSize || undefined };
      }
      
      // If right side doesn't look like a size, still try splitting (legacy behavior)
      // but only if color part doesn't look like it has a compound name
      const parts = str.split('-').map(s => s.trim()).filter(Boolean);
      if (parts.length === 2) {
        const color = isSkuCode(parts[0]) ? undefined : parts[0];
        const normalizedSize = normalizeSingleSize(parts[1], { allowNumeric: true });
        return { color, size: normalizedSize || parts[1] || undefined };
      }
    }
    
    // Check if the entire string is a SKU code
    if (isSkuCode(str)) {
      return {};
    }
    
    // No separator found - treat as size only
    const normalizedStandaloneSize = normalizeSingleSize(str, { allowNumeric: true });
    return { size: normalizedStandaloneSize || str };
  }

  function normalizeAndDedupeSizes(values: unknown[]): string[] {
    const canonicalCandidates: string[] = [];
    const fallbackMap = new Map<string, string>();

    for (const value of values) {
      let raw = String(value ?? '').trim();
      if (!raw) continue;

      const lastHyphen = raw.lastIndexOf('-');
      if (lastHyphen > 0 && lastHyphen < raw.length - 1) {
        const leftPart = raw.slice(0, lastHyphen).trim();
        const rightPart = raw.slice(lastHyphen + 1).trim();
        if (isSkuCode(leftPart) && rightPart) {
          raw = rightPart;
        }
      }

      if (!raw || isSkuCode(raw)) continue;

      const normalized = normalizeSingleSize(raw, { allowNumeric: true });
      if (normalized) {
        canonicalCandidates.push(normalized);
        continue;
      }

      const fallbackKey = raw.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!fallbackMap.has(fallbackKey)) {
        fallbackMap.set(fallbackKey, raw);
      }
    }

    const canonicalSizes = normalizeCjSizeList(canonicalCandidates, { allowNumeric: true });
    return [...canonicalSizes, ...Array.from(fallbackMap.values())];
  }

  const hasRows = Array.isArray(variantRows) && variantRows.length > 0;
  const dynamicAvailableOptions = useMemo(() => {
    const direct = parseDynamicAvailableOptions((product as any).available_options ?? (product as any).availableOptions);
    if (direct.length > 0) return direct;

    if (hasRows) {
      const fromRows = deriveAvailableOptionsFromVariants(
        (variantRows || []).map((row) => ({
          ...row,
          variantOptions: parseDynamicVariantOptions((row as any).variant_options),
        })),
        { includeOutOfStockDimensions: false }
      );
      if (fromRows.length > 0) return fromRows;
    }

    const variantsJson = (product as any).variants;
    if (Array.isArray(variantsJson) && variantsJson.length > 0) {
      return deriveAvailableOptionsFromVariants(variantsJson, { includeOutOfStockDimensions: false });
    }

    return [];
  }, [product, hasRows, variantRows]);

  const dynamicOptionDimensions = useMemo(() => {
    return dynamicAvailableOptions
      .map((option: DynamicAvailableOption) => {
        const sourceValues = Array.isArray(option.inStockValues) && option.inStockValues.length > 0
          ? option.inStockValues
          : (Array.isArray(option.values) ? option.values : []);
        const dedupe = new Map<string, string>();
        for (const value of sourceValues) {
          const clean = String(value || '').trim();
          if (!clean) continue;
          const key = clean.toLowerCase();
          if (!dedupe.has(key)) dedupe.set(key, clean);
        }
        return {
          ...option,
          valuesForSelector: Array.from(dedupe.values()),
        };
      })
      .filter((option: DynamicAvailableOption & { valuesForSelector: string[] }) => option.valuesForSelector.length > 0);
  }, [dynamicAvailableOptions]);

  const colorDynamicOption = useMemo(
    () => dynamicOptionDimensions.find((option: DynamicAvailableOption & { valuesForSelector: string[] }) => /color|colour/.test(normalizeOptionNameKey(option.name))),
    [dynamicOptionDimensions]
  );

  const sizeDynamicOption = useMemo(
    () => dynamicOptionDimensions.find((option: DynamicAvailableOption & { valuesForSelector: string[] }) => /size/.test(normalizeOptionNameKey(option.name))),
    [dynamicOptionDimensions]
  );

  const extraDynamicOptions = useMemo(
    () =>
      dynamicOptionDimensions.filter((option: DynamicAvailableOption & { valuesForSelector: string[] }) => {
        const key = normalizeOptionNameKey(option.name);
        return !/color|colour/.test(key) && !/size/.test(key);
      }),
    [dynamicOptionDimensions]
  );
  
  // Primary: Check variant rows from product_variants table
  const bothDims = useMemo(() => {
    if (!hasRows) return false;
    const withSep = (variantRows || []).filter(r => /\s\/\s|\s-\s/.test(String(r.option_value)));
    return withSep.length >= Math.max(1, Math.floor((variantRows || []).length * 0.6));
  }, [hasRows, variantRows]);

  // Extract colors from variant rows (primary source) - WITH DEDUPLICATION
  const variantRowColors = useMemo(() => {
    if (!hasRows || !bothDims) return [] as string[];
    
    // Use a map to deduplicate by normalized key while preserving first seen display name
    const colorMap = new Map<string, string>(); // normalized -> display
    
    for (const r of variantRows!) {
      const cs = splitColorSize(r.option_value || '');
      if (cs.color) {
        const normalizedKey = cs.color.toLowerCase().trim().replace(/\s+/g, ' ');
        if (!colorMap.has(normalizedKey)) {
          colorMap.set(normalizedKey, cs.color.trim());
        }
      }
    }
    
    return Array.from(colorMap.values());
  }, [hasRows, bothDims, variantRows]);

  // Extract sizes from variant rows (primary source)  
  const variantRowSizes = useMemo(() => {
    if (!hasRows) return [] as string[];
    if (bothDims) {
      const sizes: string[] = [];
      for (const r of variantRows!) {
        const cs = splitColorSize(r.option_value || '');
        if (cs.size) sizes.push(cs.size);
      }
      return normalizeAndDedupeSizes(sizes);
    }
    return normalizeAndDedupeSizes(variantRows!.map(v => v.option_value));
  }, [hasRows, bothDims, variantRows]);

  // PRIMARY: Get available colors/sizes from product fields (available_colors, available_sizes arrays)
  // These are stored during import and contain ALL colors/sizes from CJ - WITH DEDUPLICATION AND SKU FILTERING
  const productColors = useMemo(() => {
    if (colorDynamicOption && colorDynamicOption.valuesForSelector.length > 0) {
      return colorDynamicOption.valuesForSelector;
    }

    // Helper to deduplicate colors by normalized key AND filter out SKU codes
    const deduplicateAndFilterColors = (colors: string[]): string[] => {
      const colorMap = new Map<string, string>();
      for (const c of colors) {
        if (typeof c !== 'string' || !c.trim()) continue;
        const trimmed = c.trim();
        // Skip if it looks like a SKU code
        if (isSkuCode(trimmed)) continue;
        const normalizedKey = trimmed.toLowerCase().replace(/\s+/g, ' ');
        if (!colorMap.has(normalizedKey)) {
          colorMap.set(normalizedKey, trimmed);
        }
      }
      return Array.from(colorMap.values());
    };
    
    // First try available_colors array (most complete source from CJ import)
    const ac = (product as any).available_colors;
    if (Array.isArray(ac) && ac.length > 0) {
      return deduplicateAndFilterColors(ac);
    }
    // Fallback to variants JSONB field
    const variants = (product as any).variants;
    if (Array.isArray(variants)) {
      const colors: string[] = [];
      variants.forEach((v: any) => { if (v.color && typeof v.color === 'string') colors.push(v.color); });
      if (colors.length > 0) return deduplicateAndFilterColors(colors);
    }
    // Last resort: extract from variantRows if available (already deduplicated)
    if (hasRows && bothDims) {
      return variantRowColors;
    }
    return [];
  }, [product, hasRows, bothDims, variantRowColors, colorDynamicOption]);

  const productSizes = useMemo(() => {
    if (sizeDynamicOption && sizeDynamicOption.valuesForSelector.length > 0) {
      return sizeDynamicOption.valuesForSelector;
    }

    // First try available_sizes array (most complete source from CJ import)
    const as = (product as any).available_sizes;
    if (Array.isArray(as) && as.length > 0) {
      return normalizeAndDedupeSizes(as);
    }
    // Fallback to variants JSONB field
    const variants = (product as any).variants;
    if (Array.isArray(variants)) {
      const sizes: string[] = [];
      variants.forEach((v: any) => { if (v.size && typeof v.size === 'string') sizes.push(v.size); });
      if (sizes.length > 0) return normalizeAndDedupeSizes(sizes);
    }
    // Last resort: extract from variantRows if available
    if (hasRows) {
      return normalizeAndDedupeSizes(variantRowSizes);
    }
    return [];
  }, [product, hasRows, variantRowSizes, sizeDynamicOption]);

  // Use variant rows as primary, fallback to product-level arrays
  const hasFallbackDims = productColors.length > 0 && productSizes.length > 0;
  const effectiveBothDims = bothDims || hasFallbackDims;

  const colorOptions = useMemo(() => {
    // Use productColors as primary (from available_colors array)
    if (productColors.length > 0) return productColors;
    // Fallback to variantRows extraction
    if (variantRowColors.length > 0) return variantRowColors;
    // If no colors found (all were SKU codes), return empty array
    // The UI will handle this by showing only sizes (no color selector)
    return [];
  }, [productColors, variantRowColors]);

  // CJ PRODUCTS: ALL sizes are available for ALL colors
  // We use the UNION of all sizes across the entire product for every color
  const sizeOptionsByColor = useMemo(() => {
    // Step 1: Collect ALL unique sizes from all sources
    const rawSizes: string[] = [];
    
    // From productSizes array (primary source from import)
    if (productSizes.length > 0) {
      rawSizes.push(...productSizes);
    }
    
    // Also extract from variantRows to ensure completeness
    if (hasRows && variantRows) {
      for (const r of variantRows) {
        const cs = splitColorSize(r.option_value || '');
        if (cs.size) rawSizes.push(cs.size);
      }
    }
    
    // Also check variants JSONB field
    const variantsJson = (product as any).variants;
    if (Array.isArray(variantsJson)) {
      for (const v of variantsJson) {
        if (v.size && typeof v.size === 'string') rawSizes.push(v.size.trim());
      }
    }

    const allSizes = normalizeAndDedupeSizes(rawSizes);
    
    // Step 2: Collect ALL colors from all sources (with deduplication)
    const rawColors: string[] = [];
    
    // From productColors (primary - from available_colors array)
    if (productColors.length > 0) {
      rawColors.push(...productColors);
    }
    
    // From variantRowColors (extracted from product_variants)
    if (variantRowColors.length > 0) {
      rawColors.push(...variantRowColors);
    }
    
    // From variantRows (parse option_value) - use robust fallback for legacy data
    if (hasRows && variantRows) {
      for (const r of variantRows) {
        const optVal = r.option_value || '';
        const cs = splitColorSize(optVal);
        if (cs.color) {
          rawColors.push(cs.color);
        } else if (optVal.includes('-') || optVal.includes('/')) {
          // Fallback: For legacy format "Color-Size" or "Color / Size", extract left part as color
          const sep = optVal.includes('/') ? '/' : '-';
          const parts = optVal.split(sep).map(p => p.trim()).filter(Boolean);
          if (parts.length >= 2) {
            // Last part is likely size, everything before is color
            const potentialColor = parts.slice(0, -1).join(' ').trim();
            if (potentialColor && potentialColor.length > 0) {
              rawColors.push(potentialColor);
            }
          }
        }
      }
    }
    
    // From variants JSONB field
    if (Array.isArray(variantsJson)) {
      for (const v of variantsJson) {
        if (v.color && typeof v.color === 'string') rawColors.push(v.color.trim());
      }
    }
    
    // Step 3: Assign ALL sizes to EVERY color - this is the CJ model
    // Colors and sizes are independent dimensions
    // CRITICAL: Use colorOptions as keys to ensure exact match with selectedColor
    if (colorOptions.length > 0 && allSizes.length > 0) {
      const map: Record<string, string[]> = {};
      for (const color of colorOptions) {
        map[color] = allSizes;
      }
      return map;
    }
    
    return {} as Record<string, string[]>;
  }, [hasRows, variantRows, productColors, productSizes, variantRowColors, product, colorOptions]);

  const singleDimOptions = useMemo(() => {
    // Primary: Use variant row sizes
    if (hasRows && !bothDims && variantRowSizes.length > 0) return variantRowSizes;
    // Fallback: Use product-level sizes when no colors
    if (!hasRows && productSizes.length > 0 && productColors.length === 0) return productSizes;
    return [] as string[];
  }, [hasRows, bothDims, variantRowSizes, productSizes, productColors]);

  const singleDimName = useMemo(() => {
    if (sizeDynamicOption?.name) return sizeDynamicOption.name;
    if (!hasRows || bothDims) return 'Size';
    return variantRows![0]?.option_name || 'Size';
  }, [hasRows, bothDims, variantRows, sizeDynamicOption]);

  const twoDimNames = useMemo(() => {
    if (colorDynamicOption?.name || sizeDynamicOption?.name) {
      return {
        color: colorDynamicOption?.name || 'Color',
        size: sizeDynamicOption?.name || 'Size',
      };
    }
    if (!hasRows || !bothDims) return { color: 'Color', size: 'Size' };
    const first = variantRows![0];
    const optName = first?.option_name || '';
    if (optName.includes('/')) {
      const parts = optName.split('/').map(s => s.trim());
      return { color: parts[0] || 'Color', size: parts[1] || 'Size' };
    }
    if (optName.includes('-')) {
      const parts = optName.split('-').map(s => s.trim());
      return { color: parts[0] || 'Color', size: parts[1] || 'Size' };
    }
    return { color: 'Color', size: 'Size' };
  }, [hasRows, bothDims, variantRows, colorDynamicOption, sizeDynamicOption]);

  const [selectedColor, setSelectedColor] = useState('');
  const [selectedSize, setSelectedSize] = useState('');
  const [selectedExtraOptions, setSelectedExtraOptions] = useState<Record<string, string>>({});
  
  // Initialize color and size once data is available
  useEffect(() => {
    if (!selectedColor && colorOptions.length > 0) {
      setSelectedColor(colorOptions[0]);
    }
  }, [colorOptions, selectedColor]);

  useEffect(() => {
    setSelectedExtraOptions((prev: Record<string, string>) => {
      if (extraDynamicOptions.length === 0) {
        return Object.keys(prev).length > 0 ? {} : prev;
      }

      const next: Record<string, string> = {};
      let changed = false;

      for (const option of extraDynamicOptions) {
        const allowed = option.valuesForSelector;
        const prevValue = String(prev[option.name] || '').trim();
        if (prevValue && allowed.some((value: string) => value.toLowerCase() === prevValue.toLowerCase())) {
          next[option.name] = allowed.find((value: string) => value.toLowerCase() === prevValue.toLowerCase()) || prevValue;
        } else if (allowed.length > 0) {
          next[option.name] = allowed[0];
          if (prevValue !== next[option.name]) changed = true;
        }
      }

      for (const key of Object.keys(prev)) {
        if (!(key in next)) {
          changed = true;
        }
      }

      for (const [key, value] of Object.entries(next)) {
        if (prev[key] !== value) {
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [extraDynamicOptions]);
  
  useEffect(() => {
    if (effectiveBothDims && selectedColor) {
      const sizes = sizeOptionsByColor[selectedColor] || [];
      if (!selectedSize || !sizes.includes(selectedSize)) {
        setSelectedSize(sizes[0] || '');
      }
    } else if (!effectiveBothDims && singleDimOptions.length > 0) {
      if (!selectedSize || !singleDimOptions.includes(selectedSize)) {
        setSelectedSize(singleDimOptions[0] || '');
      }
    }
  }, [effectiveBothDims, selectedColor, sizeOptionsByColor, singleDimOptions, selectedSize]);

  const selectedOptions = useMemo(() => {
    const opts: Record<string, string> = {};
    if (effectiveBothDims) {
      if (selectedColor) opts[twoDimNames.color] = selectedColor;
      if (selectedSize) opts[twoDimNames.size] = selectedSize;
    } else {
      if (colorOptions.length > 0 && selectedColor) {
        opts[twoDimNames.color] = selectedColor;
      }
      if (singleDimOptions.length > 0 && selectedSize) {
        opts[singleDimName] = selectedSize;
      }
    }

    for (const option of extraDynamicOptions) {
      const selectedValue = String(selectedExtraOptions[option.name] || '').trim();
      if (selectedValue) {
        opts[option.name] = selectedValue;
      }
    }

    return opts;
  }, [
    effectiveBothDims,
    selectedColor,
    selectedSize,
    colorOptions.length,
    singleDimOptions.length,
    singleDimName,
    twoDimNames,
    extraDynamicOptions,
    selectedExtraOptions,
  ]);

  const selectedOptionsExcludingSize = useMemo(() => {
    const next: Record<string, string> = {};
    for (const [name, value] of Object.entries(selectedOptions)) {
      if (normalizeOptionNameKey(name) === 'size') continue;
      const clean = String(value || '').trim();
      if (!clean) continue;
      next[name] = clean;
    }
    return next;
  }, [selectedOptions]);

  const selectedVariant = useMemo(() => {
    if (!variantRows || variantRows.length === 0) return null;

    const selectedSignature = buildOptionSignature(selectedOptions);
    if (selectedSignature) {
      const bySignature = variantRows.find((variant) => {
        const signature = String((variant as any).option_signature || '').trim();
        return signature.length > 0 && signature === selectedSignature;
      });
      if (bySignature) return bySignature;

      const byVariantOptions = variantRows.find((variant) => {
        const optionMap = parseDynamicVariantOptions((variant as any).variant_options);
        if (Object.keys(optionMap).length === 0) return false;
        if (selectedOptionsMatchVariantOptions(selectedOptions, optionMap)) return true;
        const signature = buildOptionSignature(optionMap);
        return signature.length > 0 && signature === selectedSignature;
      });
      if (byVariantOptions) return byVariantOptions;
    }

    if (bothDims) {
      if (!selectedColor || !selectedSize) return null;
      const normalizedSelectedColor = selectedColor.toLowerCase().trim();
      return variantRows.find(v => {
        const cs = splitColorSize(v.option_value || '');
        return String(cs.color || '').toLowerCase().trim() === normalizedSelectedColor && cs.size === selectedSize;
      }) || null;
    }

    if (!selectedSize && selectedColor) {
      const normalizedSelectedColor = selectedColor.toLowerCase().trim();
      const legacyColorMatch = variantRows.find((variant) => {
        const optionNameKey = normalizeOptionNameKey((variant as any).option_name || '');
        if (!/color|colour/.test(optionNameKey)) return false;
        return String((variant as any).option_value || '').toLowerCase().trim() === normalizedSelectedColor;
      });
      if (legacyColorMatch) return legacyColorMatch;
    }

    if (!selectedSize) return null;
    return variantRows.find((v) => {
      const normalizedOptionSize =
        normalizeSingleSize(v.option_value, { allowNumeric: true }) || String(v.option_value || '').trim();
      return normalizedOptionSize === selectedSize;
    }) || null;
  }, [variantRows, selectedColor, selectedSize, bothDims, selectedOptions]);

  // sizeStockMap: Maps size -> stock value
  // CRITICAL: undefined/null stock means UNKNOWN (treat as available), NOT out of stock
  // Only explicitly 0 stock means out of stock
  const sizeStockMap = useMemo(() => {
    const map: Record<string, number | undefined> = {};
    
    // Primary: Use variantRows from product_variants table
    if (hasRows) {
      if (sizeDynamicOption?.valuesForSelector?.length) {
        for (const r of variantRows || []) {
          const optionMap = parseDynamicVariantOptions((r as any).variant_options);
          if (Object.keys(optionMap).length === 0) continue;

          const sizeValue = findOptionValueByNormalizedKey(optionMap, 'size');
          if (!sizeValue) continue;

          if (
            Object.keys(selectedOptionsExcludingSize).length > 0 &&
            !selectedOptionsMatchVariantOptions(selectedOptionsExcludingSize, optionMap)
          ) {
            continue;
          }

          map[sizeValue] = r.stock ?? undefined;
        }

        if (Object.keys(map).length > 0) {
          return map;
        }
      }

      if (bothDims && selectedColor) {
        for (const r of variantRows!) {
          const cs = splitColorSize(r.option_value || '');
          // Normalize color comparison for matching
          const normalizedRowColor = (cs.color || '').toLowerCase().trim();
          const normalizedSelectedColor = selectedColor.toLowerCase().trim();
          if (normalizedRowColor === normalizedSelectedColor && cs.size) {
            // Keep stock as-is: undefined means unknown, not 0
            map[cs.size] = r.stock ?? undefined;
          }
        }
      } else {
        for (const r of variantRows!) {
          const normalizedOptionSize =
            normalizeSingleSize(r.option_value, { allowNumeric: true }) || String(r.option_value || '').trim();
          if (!normalizedOptionSize) continue;
          map[normalizedOptionSize] = r.stock ?? undefined;
        }
      }
      return map;
    }
    
    // Fallback: Use product.variants JSONB when no variant rows
    const variants = (product as any).variants;
    if (Array.isArray(variants) && variants.length > 0) {
      if (effectiveBothDims && selectedColor) {
        for (const v of variants) {
          const normalizedVColor = (v.color || '').toLowerCase().trim();
          const normalizedSelectedColor = selectedColor.toLowerCase().trim();
          const normalizedVSize = normalizeSingleSize(v.size, { allowNumeric: true }) || String(v.size || '').trim();
          if (normalizedVColor === normalizedSelectedColor && normalizedVSize) {
            map[normalizedVSize] = v.stock ?? undefined;
          }
        }
      } else {
        for (const v of variants) {
          const normalizedVSize = normalizeSingleSize(v.size, { allowNumeric: true }) || String(v.size || '').trim();
          if (normalizedVSize) {
            map[normalizedVSize] = v.stock ?? undefined;
          }
        }
      }
      if (Object.keys(map).length > 0) return map;
    }
    
    // Last fallback: Empty map - sizes will be treated as available (unknown stock)
    return map;
  }, [
    hasRows,
    variantRows,
    bothDims,
    effectiveBothDims,
    selectedColor,
    product,
    sizeDynamicOption,
    selectedOptionsExcludingSize,
  ]);

  const colorImageMap = useMemo(() => {
    const map: Record<string, string> = {};
    
    // Priority 0: Use product.color_image_map if available (authoritative from CJ import)
    const productColorImageMap = (product as any).color_image_map;
    if (productColorImageMap && typeof productColorImageMap === 'object') {
      for (const [color, imageUrl] of Object.entries(productColorImageMap)) {
        if (typeof imageUrl === 'string' && imageUrl && !map[color]) {
          map[color] = imageUrl;
        }
      }
    }
    
    // Priority 1: Try to get color images from product_variants table (variantRows)
    if (hasRows && variantRows) {
      for (const v of variantRows) {
        const vAny = v as any;
        const parsed = splitColorSize(String(vAny.option_value || ''));
        const variantColor = vAny.color || parsed.color;
        if (variantColor && vAny.image_url && !map[variantColor]) {
          map[variantColor] = vAny.image_url;
        }
      }
    }
    
    // Priority 2: Try to get color images from product.variants JSONB
    const variants = (product as any).variants;
    if (Array.isArray(variants)) {
      for (const v of variants) {
        if (v.color && v.image_url && !map[v.color]) {
          map[v.color] = v.image_url;
        }
      }
    }
    
    // Priority 3: CLIENT-SIDE FALLBACK - Smart color-to-image matching
    // This enables immediate color swapping for existing products without database migration
    const availableColors = (product as any).available_colors;
    if (Array.isArray(availableColors) && availableColors.length > 0 && Object.keys(map).length < availableColors.length) {
      const images = product.images || [];
      
      // Helper: Normalize color name for matching (lowercase, remove spaces/special chars)
      const normalizeForMatch = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      
      // Strategy 1: Try URL-based matching (CJ often includes color names in image URLs)
      // e.g., "...product/Black/..." or "...Black-xxxxx.jpg"
      for (const color of availableColors) {
        if (map[color]) continue;
        const colorNorm = normalizeForMatch(color);
        if (colorNorm.length < 3) continue; // Skip very short color names to avoid false matches
        
        for (const imgUrl of images) {
          if (typeof imgUrl !== 'string') continue;
          const urlLower = imgUrl.toLowerCase();
          // Check if color name appears in URL path or filename
          if (urlLower.includes(colorNorm) || urlLower.includes(color.toLowerCase().replace(/ /g, '-'))) {
            map[color] = imgUrl;
            break;
          }
        }
      }
      
      // Strategy 2: Positional matching ONLY if exact length match (high confidence)
      // This avoids misalignment when there are extra hero/lifestyle images
      const unmappedColors = availableColors.filter((c: string) => !map[c]);
      if (unmappedColors.length > 0) {
        // Count how many images we have that aren't already mapped
        const mappedUrls = new Set(Object.values(map));
        const unmappedImages = images.filter(img => !mappedUrls.has(img));
        
        // Only use positional matching when counts match exactly (high confidence).
        if (unmappedImages.length === unmappedColors.length && unmappedColors.length > 0) {
          for (let i = 0; i < unmappedColors.length; i++) {
            const color = unmappedColors[i];
            if (!map[color] && unmappedImages[i]) {
              map[color] = unmappedImages[i];
            }
          }
        }
      }
    }
    
    // Align keys with actual color options using normalized lookup.
    const alignedMap: Record<string, string> = {};
    for (const color of colorOptions) {
      const resolved = resolveColorImageForColor(color, map);
      if (resolved) {
        alignedMap[color] = resolved;
      }
    }

    const hasReliableColorMap = Object.keys(alignedMap).length > 0 || Object.keys(map).length > 0;
    if (hasReliableColorMap) {
      return { ...map, ...alignedMap };
    }

    // Last-resort fallback only when there is no known color-image relation at all.
    const firstImage = product.images[0] || '';
    if (!firstImage) return { ...map };
    for (const color of colorOptions) {
      alignedMap[color] = firstImage;
    }
    return alignedMap;
  }, [colorOptions, product.images, product, hasRows, variantRows]);

  const currentSizes = useMemo(() => {
    if (sizeDynamicOption?.valuesForSelector?.length) {
      const baseSizes = sizeDynamicOption.valuesForSelector;

      if (hasRows && Array.isArray(variantRows) && variantRows.length > 0) {
        const dedupe = new Map<string, string>();

        for (const row of variantRows) {
          const optionMap = parseDynamicVariantOptions((row as any).variant_options);
          if (Object.keys(optionMap).length === 0) continue;

          const sizeValue = findOptionValueByNormalizedKey(optionMap, 'size');
          if (!sizeValue) continue;

          if (
            Object.keys(selectedOptionsExcludingSize).length > 0 &&
            !selectedOptionsMatchVariantOptions(selectedOptionsExcludingSize, optionMap)
          ) {
            continue;
          }

          if (!isVariantInStockStrict(row as any)) {
            continue;
          }

          const key = sizeValue.toLowerCase();
          if (!dedupe.has(key)) dedupe.set(key, sizeValue);
        }

        const filteredSizes = Array.from(dedupe.values());
        if (filteredSizes.length > 0) {
          return filteredSizes;
        }
      }

      return baseSizes;
    }

    return effectiveBothDims
      ? (sizeOptionsByColor[selectedColor] || [])
      : singleDimOptions;
  }, [
    sizeDynamicOption,
    hasRows,
    variantRows,
    selectedOptionsExcludingSize,
    effectiveBothDims,
    sizeOptionsByColor,
    selectedColor,
    singleDimOptions,
  ]);

  useEffect(() => {
    if (currentSizes.length === 0) {
      if (selectedSize) setSelectedSize('');
      return;
    }
    if (!selectedSize || !currentSizes.includes(selectedSize)) {
      setSelectedSize(currentSizes[0] || '');
    }
  }, [currentSizes, selectedSize]);

  const cjPid = (product as any)?.cj_product_id as string | undefined;
  const [quote, setQuote] = useState<{ retailSar: number; shippingSar: number; options: any[] } | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!cjPid || !selectedVariant?.cj_sku) { 
        setQuote(null); 
        setQuoteLoading(false);
        return; 
      }
      setQuoteLoading(true);
      try {
        const res = await fetch('/api/cj/pricing/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid: cjPid, sku: selectedVariant.cj_sku, countryCode: 'SA', quantity: 1 }),
          cache: 'no-store',
        });
        const j = await res.json();
        if (cancelled) return;
        if (res.ok && j && j.ok) setQuote({ retailSar: j.retailSar, shippingSar: j.shippingSar, options: j.options || [] });
        else setQuote(null);
      } catch {
        if (!cancelled) setQuote(null);
      } finally {
        if (!cancelled) setQuoteLoading(false);
      }
    }
    run();
    return () => { cancelled = true; };
  }, [cjPid, selectedVariant?.cj_sku]);

  // Check stock - null/undefined means "unknown availability" = treat as available (CJ products)
  // Only mark out of stock when stock is EXPLICITLY 0
  const productStockUnknown = product.stock === null || product.stock === undefined;
  const hasProductStock = productStockUnknown || (product.stock ?? 0) > 0;
  
  const hasVariantStock = hasRows && variantRows!.some(v => {
    // null/undefined stock = unknown = available
    if (v.stock === null || v.stock === undefined) return true;
    return v.stock > 0;
  });
  const hasFallbackVariantStock = !hasRows && Array.isArray((product as any).variants) && 
    (product as any).variants.some((v: any) => {
      if (v.stock === null || v.stock === undefined) return true;
      return v.stock > 0;
    });
  
  const hasOptionsAvailable =
    colorOptions.length > 0 ||
    currentSizes.length > 0 ||
    extraDynamicOptions.some((option: DynamicAvailableOption & { valuesForSelector: string[] }) => option.valuesForSelector.length > 0);
  
  // Out of stock only if no stock from any source
  const isOutOfStock = !hasProductStock && !hasVariantStock && !hasFallbackVariantStock && !hasOptionsAvailable;
  
  const hasUnselectedExtraOption = extraDynamicOptions.some((option: DynamicAvailableOption & { valuesForSelector: string[] }) => {
    const value = String(selectedExtraOptions[option.name] || '').trim();
    return option.valuesForSelector.length > 0 && !value;
  });

  // Disable add to cart if: out of stock, or required selectors are incomplete
  const addToCartDisabled = isOutOfStock || (currentSizes.length > 0 && !selectedSize) || hasUnselectedExtraOption;

  // Use min_price as default when no variant selected, fallback to product.price
  const minPrice = (product as any).min_price ?? product.price;
  const maxPrice = (product as any).max_price ?? product.price;
  const hasVariantPricing = minPrice !== maxPrice && maxPrice > minPrice;
  
  // When variant is selected, use variant price; otherwise use min_price
  const currentPrice = selectedVariant?.price ?? minPrice;
  const storeSku = ((product as any).store_sku || product.product_code || null) as string | null;

  const descriptionImages = useMemo(() => {
    if (!product.description) return [];
    return extractImagesFromHtml(product.description);
  }, [product.description]);

  return (
    <div className="w-full">
      <div className="grid grid-cols-1 lg:grid-cols-[auto_1fr] gap-4 lg:gap-6 items-start">
        <div className="w-full lg:w-auto lg:max-w-[580px]">
          <MediaGallery 
            images={product.images} 
            title={product.title}
            videoUrl={(product as any).video_4k_url || (product as any).video_url}
            selectedColor={selectedColor}
            colorImageMap={colorImageMap}
            availableColors={colorOptions}
            descriptionImages={descriptionImages}
          />
        </div>

        <div className="w-full space-y-4">
          <DetailHeader
            title={product.title}
            storeSku={storeSku}
            productCode={product.product_code}
            rating={product.displayed_rating ?? (product as any).supplier_rating ?? 0}
            reviewCount={(product as any).review_count || 0}
          />

          <PriceBlock
            price={currentPrice}
            originalPrice={(product as any).original_price}
            isAvailable={!isOutOfStock && (hasOptionsAvailable || hasProductStock)}
            minPrice={minPrice}
            maxPrice={maxPrice}
            showRange={hasVariantPricing && !selectedVariant}
          />

          {colorOptions.length > 0 && (
            <ColorSelector
              colors={colorOptions}
              selectedColor={selectedColor}
              onColorChange={setSelectedColor}
              colorImages={colorImageMap}
              hotColors={colorOptions.slice(0, 2)}
            />
          )}

          {extraDynamicOptions.map((option: DynamicAvailableOption & { valuesForSelector: string[] }) => {
            const selectedValue = String(selectedExtraOptions[option.name] || '').trim();
            const values = option.valuesForSelector;
            if (!Array.isArray(values) || values.length === 0) return null;

            return (
              <div key={option.name} className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{option.name}:</span>
                  <span className="text-sm text-muted-foreground">{selectedValue}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {values.map((value) => {
                    const isSelected = String(value).toLowerCase() === selectedValue.toLowerCase();
                    return (
                      <button
                        key={`${option.name}-${value}`}
                        onClick={() =>
                          setSelectedExtraOptions((prev: Record<string, string>) => ({
                            ...prev,
                            [option.name]: value,
                          }))
                        }
                        className={cn(
                          "relative min-w-[48px] px-4 py-2 rounded-md text-sm font-medium transition-all",
                          isSelected
                            ? "bg-primary text-primary-foreground"
                            : "bg-card border border-border hover:border-primary text-foreground"
                        )}
                      >
                        {value}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {currentSizes.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{twoDimNames.size}:</span>
                  <span className="text-sm text-muted-foreground">{selectedSize}</span>
                </div>
                <SizeGuideModal />
              </div>
              <div className="flex flex-wrap gap-2">
                {currentSizes.map((size: string) => {
                  const isSelected = size === selectedSize;
                  // Treat stock=0, null, undefined as "available" (CJ often returns 0 as default)
                  const stockValue = sizeStockMap[size];
                  const hasExplicitStock = stockValue !== undefined && stockValue !== null && stockValue !== 0;
                  // Only mark out of stock if stock is explicitly negative (shouldn't happen)
                  const isOutOfStockSize = hasExplicitStock && stockValue < 0;
                  const isLowStock = hasExplicitStock && stockValue > 0 && stockValue <= 3;

                  return (
                    <button
                      key={size}
                      onClick={() => !isOutOfStockSize && setSelectedSize(size)}
                      disabled={isOutOfStockSize}
                      className={cn(
                        "relative min-w-[48px] px-4 py-2 rounded-md text-sm font-medium transition-all",
                        isSelected
                          ? "bg-primary text-primary-foreground"
                          : isOutOfStockSize
                            ? "bg-muted text-muted-foreground cursor-not-allowed line-through"
                            : "bg-card border border-border hover:border-primary text-foreground"
                      )}
                    >
                      {size}
                      {isLowStock && !isSelected && (
                        <span className="absolute -top-1 -right-1 w-2 h-2 bg-amber-500 rounded-full" />
                      )}
                    </button>
                  );
                })}
              </div>
              {sizeStockMap[selectedSize] !== undefined && sizeStockMap[selectedSize] !== null && (sizeStockMap[selectedSize] as number) > 0 && (sizeStockMap[selectedSize] as number) <= 3 && (
                <p className="text-sm text-amber-600">
                  Only {sizeStockMap[selectedSize]} left!
                </p>
              )}
            </div>
          )}

          <div className="hidden md:block">
            <ActionPanel
              productId={product.id}
              productSlug={product.slug}
              selectedOptions={selectedOptions}
              disabled={addToCartDisabled}
            />
          </div>

          <ShippingInfo 
            cjPid={cjPid}
            quote={quote}
            quoteLoading={quoteLoading}
            selectedVariant={selectedVariant}
            product={product}
          />

          {children}
        </div>
      </div>

      <ProductTabs
        description={product.description}
        overviewHtml={(product as any).overview || undefined}
        productInfoHtml={(product as any).product_info || (product as any).productInfo || undefined}
        sizeInfoHtml={(product as any).size_info || (product as any).sizeInfo || undefined}
        productNoteHtml={(product as any).product_note || (product as any).productNote || undefined}
        packingListHtml={(product as any).packing_list || (product as any).packingList || undefined}
        reviews={Array.isArray((product as any).reviews) ? (product as any).reviews : []}
        averageRating={Number.isFinite(Number((product as any).average_rating))
          ? Number((product as any).average_rating)
          : (product.displayed_rating || 0)}
        totalReviews={Number.isFinite(Number((product as any).review_count))
          ? Math.max(0, Math.floor(Number((product as any).review_count)))
          : 0}
        productTitle={product.title}
        highlights={(() => {
          // Extract highlights from product specifications or description
          const highlights: string[] = [];
          const specs = (product as any).specifications;
          if (specs && typeof specs === 'object') {
            for (const [key, value] of Object.entries(specs)) {
              const keyText = String(key || '').trim();
              const normalizedKey = keyText.toLowerCase().replace(/[^a-z0-9]/g, '');
              if (BLOCKED_SPEC_KEYS.has(normalizedKey)) continue;
              const valueText = htmlToPlainText(value);
              if (keyText && valueText) {
                highlights.push(`${keyText}: ${valueText}`);
              }
            }
          }
          return highlights.slice(0, 6);
        })()}
        sellingPoints={(() => {
          // Use real selling points from product if available
          const sp = (product as any).selling_points;
          if (Array.isArray(sp) && sp.length > 0) {
            return sp
              .map((p: any) => htmlToPlainText(p))
              .filter((p: string) => !!p)
              .slice(0, 5);
          }
          // Fallback to generated selling points
          return [
            `${product.category || "Fashion"} > ${(product as any).category_name || product.title?.split(' ').slice(0, 3).join(' ')}`,
            `Gender: ${(product as any).gender || "Unisex"}`,
            `Style: ${(product as any).style || "Casual"}`,
          ];
        })()}
        specifications={(() => {
          // Use real specifications from product if available
          const specs = (product as any).specifications;
          if (specs && typeof specs === 'object' && Object.keys(specs).length > 0) {
            const cleanSpecs: Record<string, string> = {};
            for (const [key, value] of Object.entries(specs)) {
              const keyText = String(key || '').trim();
              if (!keyText) continue;
              const normalizedKey = keyText.toLowerCase().replace(/[^a-z0-9]/g, '');
              if (BLOCKED_SPEC_KEYS.has(normalizedKey)) continue;
              const cleanValue = htmlToPlainText(value);
              if (!cleanValue) continue;
              cleanSpecs[keyText] = cleanValue;
            }
            if (Object.keys(cleanSpecs).length > 0) return cleanSpecs;
          }
          // Fallback
          return {
            "Category": `${product.category || "Fashion"} > ${(product as any).category_name || "General"}`,
            "Gender": (product as any).gender || "Unisex",
            "Style": (product as any).style || "Casual",
            "Fit Type": (product as any).fit_type || "Regular Fit",
            "Season": (product as any).season || "All Seasons",
          };
        })()}
      />

      <div className="md:hidden fixed bottom-0 left-0 right-0 z-30 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 p-3 safe-area-inset-bottom">
        <div className="mx-auto flex max-w-md items-center gap-3">
          <div className="shrink-0">
            <div className="text-xs text-muted-foreground">Price</div>
            <div className="text-lg font-bold text-primary">{formatCurrency(currentPrice)}</div>
          </div>
          <div className="flex-1">
            <AddToCart 
              productId={product.id} 
              productSlug={product.slug as any} 
              selectedOptions={selectedOptions} 
              disabled={addToCartDisabled} 
            />
          </div>
        </div>
      </div>
    </div>
  );
}

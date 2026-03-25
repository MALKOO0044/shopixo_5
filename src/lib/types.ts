export type ProductVariant = {
  id: number;
  product_id: number;
  option_name: string; // e.g., "Size"
  option_value: string; // e.g., S | M | L | XL | XXL | XXXL
  variant_options?: Record<string, string> | null;
  option_signature?: string | null;
  cj_sku: string | null;
  cj_variant_id?: string | null;
  price: number | null; // if null, fallback to product.price
  stock: number | null; // null = unknown (CJ didn't provide), 0 = truly zero, positive = known
  // Color-specific image URL (for color swatch display)
  image_url?: string | null;
  color?: string | null; // Color name extracted from option_value when option_name is "Color"
  // CJ-specific variant data
  variant_key?: string | null; // Short variant name from CJ (e.g., "Black And Silver-2XL")
  cj_stock?: number | null; // Stock in CJ warehouse (verified, ready to ship)
  factory_stock?: number | null; // Stock at supplier factory (may require 1-3 days processing)
  // Optional shipping metadata (if available from CJ)
  weight_grams?: number | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
};

export type ProductVariantJson = {
  name?: string;
  options?: string[];
  color?: string | null;
  size?: string | null;
  stock?: number | null;
  image_url?: string | null;
  [key: string]: any;
};

export type Product = {
  id: number;
  title: string;
  slug: string;
  description: string;
  price: number;
  compare_at_price?: number | null;
  original_price?: number | null;
  min_price?: number | null;
  max_price?: number | null;
  images: string[];
  image?: string | null;
  category: string;
  displayed_rating?: number | null;
  rating_confidence?: number | null;
  supplier_rating?: number | null;
  review_count?: number | null;
  stock: number | null; // null = all variants have unknown stock
  // UI-oriented variants selector (kept for backward compatibility)
  variants: ProductVariantJson[];
  is_active?: boolean; // soft delete flag (optional to avoid breaking existing code)

  // Product codes
  product_code?: string | null; // Shopixo public code (XO00001 format) - visible to customers
  store_sku?: string | null; // Deterministic store SKU used in admin/storefront views
  supplier_sku?: string | null; // Supplier SKU from CJ - admin only

  // Shipping and CJ linkage metadata (optional)
  video_url?: string | null;
  video_source_url?: string | null;
  video_4k_url?: string | null;
  video_delivery_mode?: 'native' | 'enhanced' | 'passthrough' | null;
  video_quality_gate_passed?: boolean | null;
  video_source_quality_hint?: '4k' | 'hd' | 'sd' | 'unknown' | null;
  media_mode?: string | null;
  processing_time_hours?: number | null;
  delivery_time_hours?: number | null;
  origin_area?: string | null;
  origin_country_code?: string | null;
  free_shipping?: boolean;
  inventory_shipping_fee?: number | null;
  last_mile_fee?: number | null;
  cj_product_id?: string | null;
  shipping_from?: string | null;

  // Optional merchandising metadata
  available_options?: Array<{
    name: string;
    values: string[];
    inStockValues: string[];
    source?: string;
  }> | null;
  available_colors?: string[] | null;
  available_sizes?: string[] | null;
  color_image_map?: Record<string, string> | null;
  specifications?: Record<string, string> | null;
  selling_points?: string[] | null;
  category_name?: string | null;
  gender?: string | null;
  style?: string | null;
  fit_type?: string | null;
  season?: string | null;
};

export type OrderItem = {
  id: number;
  quantity: number;
  price: number;
  product: Product;
};

export type Order = {
  id: number;
  created_at: string;
  total_amount: number;
  status: string;
  user_id: string;
  order_items: OrderItem[];
  // This will be populated after joining with the users table
  user_email?: string;
  // Stripe metadata
  stripe_session_id?: string | null;
  // CJ fulfillment and tracking
  cj_order_no?: string | null;
  shipping_status?: string | null;
  tracking_number?: string | null;
  carrier?: string | null;
};

export type CartItem = {
  id: number;
  quantity: number;
  product: Product | null;
  variant?: ProductVariant | null;
  variantName?: string | null; // Customer's selected variant (e.g., "Star blue-XL") for CJ matching
  selectedColor?: string | null; // Customer's selected color for display
  selectedSize?: string | null;  // Customer's selected size for display
};

export type Address = {
  id: number;
  user_id: string;
  full_name: string;
  phone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  postal_code: string | null;
  country: string;
  is_default: boolean;
  created_at?: string;
};

export type Review = {
  id: number;
  user_id: string;
  product_id: number;
  rating: number; // 1..5
  title: string | null;
  body: string | null;
  created_at?: string;
};

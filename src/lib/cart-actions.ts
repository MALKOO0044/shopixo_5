"use server";

import { createServerComponentClient } from "@supabase/auth-helpers-nextjs";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { CartItem, Product } from "./types";
import {
  buildOptionSignature,
  normalizeOptionNameKey,
  parseDynamicVariantOptions,
} from "./variants/dynamic-options";

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

// Cache for cart_items column existence (checked once per server lifecycle)
let cartItemsColumnsCache: {
  hasVariantId: boolean;
  hasVariantName: boolean;
  hasSelectedColor: boolean;
  hasSelectedSize: boolean;
  checked: boolean;
  checkedAt: number;
} = {
  hasVariantId: true,
  hasVariantName: true,
  hasSelectedColor: true,
  hasSelectedSize: true,
  checked: false,
  checkedAt: 0,
};

// Cache TTL: 5 minutes - allows picking up schema changes without restart
const CACHE_TTL_MS = 5 * 60 * 1000;

function isColumnMissingError(error: any): boolean {
  if (!error) return false;
  // PostgreSQL error code 42703 = undefined column
  if (error.code === "42703") return true;
  const msg = String(error.message || "").toLowerCase();
  return msg.includes("does not exist") || msg.includes("column") && msg.includes("not");
}

async function detectCartItemsColumns(admin: any): Promise<typeof cartItemsColumnsCache> {
  const now = Date.now();
  
  // Return cached result if still valid
  if (cartItemsColumnsCache.checked && (now - cartItemsColumnsCache.checkedAt) < CACHE_TTL_MS) {
    return cartItemsColumnsCache;
  }
  
  // Detect each column - only mark as missing on specific column errors (42703)
  // Other errors (network, auth) should NOT cache as "missing"
  const results = {
    hasSelectedColor: true,
    hasSelectedSize: true,
    hasVariantId: true,
    hasVariantName: true,
  };
  
  const { error: colorErr } = await admin
    .from("cart_items")
    .select("selected_color")
    .limit(1);
  if (isColumnMissingError(colorErr)) {
    results.hasSelectedColor = false;
  } else if (colorErr) {
    console.warn("[cart-actions] Non-schema error checking selected_color:", colorErr.message);
  }
  
  const { error: sizeErr } = await admin
    .from("cart_items")
    .select("selected_size")
    .limit(1);
  if (isColumnMissingError(sizeErr)) {
    results.hasSelectedSize = false;
  } else if (sizeErr) {
    console.warn("[cart-actions] Non-schema error checking selected_size:", sizeErr.message);
  }
    
  const { error: varIdErr } = await admin
    .from("cart_items")
    .select("variant_id")
    .limit(1);
  if (isColumnMissingError(varIdErr)) {
    results.hasVariantId = false;
  } else if (varIdErr) {
    console.warn("[cart-actions] Non-schema error checking variant_id:", varIdErr.message);
  }
    
  const { error: varNameErr } = await admin
    .from("cart_items")
    .select("variant_name")
    .limit(1);
  if (isColumnMissingError(varNameErr)) {
    results.hasVariantName = false;
  } else if (varNameErr) {
    console.warn("[cart-actions] Non-schema error checking variant_name:", varNameErr.message);
  }
  
  cartItemsColumnsCache = {
    ...results,
    checked: true,
    checkedAt: now,
  };
  
  console.log("[cart-actions] Detected cart_items columns:", results);
  
  return cartItemsColumnsCache;
}

// Fetch product with graceful fallback if `is_active` column is missing (pre-migration)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getProductById(admin: any, id: number) {
  // Try selecting with is_active first
  const { data, error } = await admin
    .from("products")
    .select("id, stock, title, is_active")
    .eq("id", id)
    .single();

  if (error && (String((error as any).message || "").includes("is_active") || (error as any).code === "42703")) {
    const fb = await admin
      .from("products")
      .select("id, stock, title")
      .eq("id", id)
      .single();
    return (fb.data as any) ?? null;
  }

  return (data as any) ?? null;
}

const addItemSchema = z.object({
  productId: z.number(),
  quantity: z.number().min(1),
  productSlug: z.string().min(1).optional(),
});

function parseSelectedOption(formData: FormData): { name: string; value: string } | null {
  const known = new Set(["productId", "quantity", "productSlug"]);
  for (const [k, v] of formData.entries()) {
    if (known.has(k)) continue;
    const val = typeof v === "string" ? v : String(v);
    const clean = val.trim();
    if (clean.length > 0) {
      return { name: k, value: clean };
    }
  }
  return null;
}

/**
 * Parse ALL selected options from form data (Color, Size, etc.)
 * Returns array of {name, value} pairs
 */
function parseAllSelectedOptions(formData: FormData): { name: string; value: string }[] {
  const known = new Set(["productId", "quantity", "productSlug"]);
  const options: { name: string; value: string }[] = [];
  
  for (const [k, v] of formData.entries()) {
    if (known.has(k)) continue;
    const val = typeof v === "string" ? v : String(v);
    const clean = val.trim();
    if (clean.length > 0) {
      options.push({ name: k, value: clean });
    }
  }
  return options;
}

/**
 * Build a variant name string from options (e.g., "Star blue-XL")
 * Format: {Color}-{Size} or just {Size} if only one option
 */
function buildVariantName(options: { name: string; value: string }[]): string | null {
  if (options.length === 0) return null;
  
  // Sort options: Color first, then Size, then others
  const sorted = [...options].sort((a, b) => {
    const order: Record<string, number> = { 'Color': 0, 'color': 0, 'Size': 1, 'size': 1 };
    const aOrder = order[a.name] ?? 99;
    const bOrder = order[b.name] ?? 99;
    return aOrder - bOrder;
  });
  
  // Join values with hyphen
  return sorted.map(o => o.value).join('-');
}

function buildSelectedOptionMap(options: { name: string; value: string }[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const option of options) {
    const name = String(option.name || "").trim();
    const value = String(option.value || "").trim();
    if (!name || !value) continue;
    map[name] = value;
  }
  return map;
}

function extractVariantOptionMapFromRow(row: any): Record<string, string> {
  const parsed = parseDynamicVariantOptions(row?.variant_options);
  if (Object.keys(parsed).length > 0) return parsed;

  const optionName = String(row?.option_name || "").trim();
  const optionValue = String(row?.option_value || "").trim();
  if (optionName && optionValue) {
    return { [optionName]: optionValue };
  }

  return {};
}

function findOptionValueByKey(options: Record<string, string>, optionKey: string): string {
  for (const [name, value] of Object.entries(options || {})) {
    if (normalizeOptionNameKey(name) === optionKey) {
      return String(value || "").trim();
    }
  }
  return "";
}

function optionsMatchByNormalizedNameAndValue(
  left: Record<string, string>,
  right: Record<string, string>
): boolean {
  const leftEntries = Object.entries(left || {}).filter(([name, value]) => String(name).trim() && String(value).trim());
  const rightEntries = Object.entries(right || {}).filter(([name, value]) => String(name).trim() && String(value).trim());
  if (leftEntries.length !== rightEntries.length) return false;

  for (const [name, rawValue] of leftEntries) {
    const key = normalizeOptionNameKey(name);
    const leftValue = String(rawValue || "").trim().toLowerCase();
    const rightValue = findOptionValueByKey(right, key).toLowerCase();
    if (!rightValue || rightValue !== leftValue) {
      return false;
    }
  }

  return true;
}

async function getOrCreateCart() {
  const supabaseAuth = createServerComponentClient({ cookies });
  const { data: { user } } = await supabaseAuth.auth.getUser();
  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) {
    throw new Error("Could not create a cart.");
  }

  // If user is logged in, try to find their existing cart
  if (user) {
    const { data: cart, error } = await supabaseAdmin
      .from('cart_sessions')
      .select('id')
      .eq('user_id', user.id)
      .single();
    
    if (cart) {
      // Set cookie and return existing cart ID
      cookies().set("cart_id", cart.id, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === 'production',
      });
      return { id: cart.id };
    }
  }

  const cartId = cookies().get("cart_id")?.value;

  if (cartId) {
    const { data: cart } = await supabaseAdmin
      .from("cart_sessions")
      .select("id, user_id")
      .eq("id", cartId)
      .single();
    if (cart) {
        // If user is now logged in, associate the cart with them
        if (user && !cart.user_id) {
          await supabaseAdmin.from('cart_sessions').update({ user_id: user.id }).eq('id', cart.id);
        }
        return { id: cart.id };
    }
  }

  // If no cart_id cookie or cart not found, create a new one
  const { data: newCart, error } = await supabaseAdmin
    .from("cart_sessions")
    .insert({ user_id: user?.id })
    .select("id")
    .single();

  if (error || !newCart) {
    throw new Error("Could not create a cart.");
  }

  cookies().set("cart_id", newCart.id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });

  return newCart;
}

export async function getCartItemCount(): Promise<number> {
  const cartId = cookies().get("cart_id")?.value;
  if (!cartId) return 0;
  
  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) return 0;
  
  const { data: items, error } = await supabaseAdmin
    .from("cart_items")
    .select("quantity, product_id")
    .eq("session_id", cartId);
  
  if (error) {
    console.error("getCartItemCount error:", error);
    return 0;
  }
  
  if (!items || items.length === 0) return 0;
  
  const productIds = items.map((i: any) => i.product_id).filter(Boolean);
  if (productIds.length === 0) return 0;
  
  const { data: products } = await supabaseAdmin
    .from("products")
    .select("id")
    .in("id", productIds);
  
  const validProductIds = new Set((products || []).map((p: any) => p.id));
  
  return items
    .filter((item: any) => validProductIds.has(item.product_id))
    .reduce((sum: number, item: { quantity: number }) => sum + item.quantity, 0);
}

export async function getCart() {
  const cartId = cookies().get("cart_id")?.value;

  if (!cartId) {
    return [];
  }
  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) {
    console.warn("getCart: Supabase service role env vars missing; returning empty cart.");
    return [];
  }

  // Try with variant_id and variant_name first, fall back if columns don't exist
  let items: any[] | null = null;
  let hasVariantIdColumn = true;
  
  const { data: itemsWithVariant, error: errorWithVariant } = await supabaseAdmin
    .from("cart_items")
    .select(`id, quantity, variant_id, variant_name, product_id`)
    .eq("session_id", cartId)
    .order("created_at", { ascending: true });

  if (errorWithVariant && (errorWithVariant.code === "42703" || String(errorWithVariant.message || "").includes("variant_id"))) {
    // variant_id column doesn't exist, try without it
    hasVariantIdColumn = false;
    const { data: itemsWithoutVariant, error: errorWithoutVariant } = await supabaseAdmin
      .from("cart_items")
      .select(`id, quantity, product_id`)
      .eq("session_id", cartId)
      .order("created_at", { ascending: true });
    
    if (errorWithoutVariant) {
      console.error("Error fetching cart:", errorWithoutVariant);
      return [];
    }
    items = itemsWithoutVariant;
  } else if (errorWithVariant) {
    console.error("Error fetching cart:", errorWithVariant);
    return [];
  } else {
    items = itemsWithVariant;
  }

  if (!items || items.length === 0) {
    return [];
  }

  const productIds = items.map((i: any) => i.product_id).filter(Boolean);
  let productsMap: Record<number, any> = {};
  if (productIds.length > 0) {
    const { data: products } = await supabaseAdmin
      .from("products")
      .select("*")
      .in("id", productIds);
    if (products) {
      productsMap = Object.fromEntries(products.map((p: any) => [p.id, p]));
    }
  }

  let variantsMap: Record<number, any> = {};
  if (hasVariantIdColumn) {
    const variantIds = items.map((i: any) => i.variant_id).filter(Boolean);
    if (variantIds.length > 0) {
      const { data: variants } = await supabaseAdmin
        .from("product_variants")
        .select("*")
        .in("id", variantIds);
      if (variants) {
        variantsMap = Object.fromEntries(variants.map((v: any) => [v.id, v]));
      }
    }
  }

  const cartItems = items
    .filter((item: any) => productsMap[item.product_id])
    .map((item: any) => ({
      id: item.id,
      quantity: item.quantity,
      product: productsMap[item.product_id],
      variant: hasVariantIdColumn && item.variant_id ? variantsMap[item.variant_id] ?? null : null,
      variantName: item.variant_name || null, // Pass variant_name through to checkout
    }));

  return cartItems as CartItem[];
}

export async function getCartItemsBySessionId(cartSessionId: string) {
  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) {
    console.warn("getCartItemsBySessionId: Supabase service role env vars missing; returning empty list.");
    return { items: [], error: null };
  }

  // Detect which columns exist
  const cols = await detectCartItemsColumns(supabaseAdmin);
  
  // Build SELECT fields based on detected columns
  const selectFields = ["id", "quantity", "product_id"];
  if (cols.hasVariantId) selectFields.push("variant_id");
  if (cols.hasVariantName) selectFields.push("variant_name");
  if (cols.hasSelectedColor) selectFields.push("selected_color");
  if (cols.hasSelectedSize) selectFields.push("selected_size");
  
  const { data: items, error } = await supabaseAdmin
    .from("cart_items")
    .select(selectFields.join(", "))
    .eq("session_id", cartSessionId);

  if (error) {
    console.error("Error fetching cart items by session ID:", error);
    return { items: null, error };
  }
  
  const hasVariantIdColumn = cols.hasVariantId;

  if (!items || items.length === 0) {
    return { items: [], error: null };
  }

  const productIds = items.map((i: any) => i.product_id).filter(Boolean);
  let productsMap: Record<number, any> = {};
  if (productIds.length > 0) {
    const { data: products } = await supabaseAdmin
      .from("products")
      .select("*")
      .in("id", productIds);
    if (products) {
      productsMap = Object.fromEntries(products.map((p: any) => [p.id, p]));
    }
  }

  let variantsMap: Record<number, any> = {};
  if (hasVariantIdColumn) {
    const variantIds = items.map((i: any) => i.variant_id).filter(Boolean);
    if (variantIds.length > 0) {
      const { data: variants } = await supabaseAdmin
        .from("product_variants")
        .select("*")
        .in("id", variantIds);
      if (variants) {
        variantsMap = Object.fromEntries(variants.map((v: any) => [v.id, v]));
      }
    }
  }

  // Parse color from variant_name to look up color-specific image
  const parseColorFromVariantName = (variantName: string | null): string | null => {
    if (!variantName) return null;
    const lastHyphenIdx = variantName.lastIndexOf('-');
    if (lastHyphenIdx > 0) {
      return variantName.slice(0, lastHyphenIdx).trim();
    }
    return variantName.trim();
  };

  // Fetch color variants for products that have variant_name but might not have image_url
  const colorVariantsMap: Record<string, any> = {}; // key: "productId-colorLower"
  const colorLookups: { productId: number; color: string }[] = [];
  
  for (const item of items as any[]) {
    if (item.variant_name) {
      const color = parseColorFromVariantName(item.variant_name);
      if (color) {
        colorLookups.push({ productId: item.product_id, color });
      }
    }
  }

  // Batch fetch color variants
  if (colorLookups.length > 0) {
    const uniqueProductIds = [...new Set(colorLookups.map(c => c.productId))];
    const { data: colorVariants } = await supabaseAdmin
      .from("product_variants")
      .select("*")
      .in("product_id", uniqueProductIds)
      .eq("option_name", "Color");
    
    if (colorVariants) {
      for (const cv of colorVariants) {
        const key = `${cv.product_id}-${(cv.option_value || '').toLowerCase()}`;
        colorVariantsMap[key] = cv;
      }
    }
  }

  const cartItems: CartItem[] = items
    .filter((item: any) => productsMap[item.product_id])
    .map((item: any) => {
      let variant = hasVariantIdColumn && item.variant_id ? variantsMap[item.variant_id] ?? null : null;
      
      // If variant doesn't have image_url, try to get it from color variant
      if (item.variant_name) {
        const color = parseColorFromVariantName(item.variant_name);
        if (color) {
          const colorKey = `${item.product_id}-${color.toLowerCase()}`;
          const colorVariant = colorVariantsMap[colorKey];
          if (colorVariant?.image_url) {
            // Merge color variant image into the existing variant or create new
            if (variant) {
              variant = { ...variant, image_url: colorVariant.image_url };
            } else {
              variant = colorVariant;
            }
          }
        }
      }
      
      return {
        id: item.id,
        quantity: item.quantity,
        product: productsMap[item.product_id] as Product,
        variant,
        variantName: item.variant_name || null,
        selectedColor: item.selected_color || null,
        selectedSize: item.selected_size || null,
      };
    });

  return { items: cartItems, error: null };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getProductBySlug(admin: any, slug: string) {
  const { data, error } = await admin
    .from("products")
    .select("id, stock, title, is_active")
    .eq("slug", slug)
    .single();

  if (error && (String((error as any).message || "").includes("is_active") || (error as any).code === "42703")) {
    const fb = await admin
      .from("products")
      .select("id, stock, title")
      .eq("slug", slug)
      .single();
    return (fb.data as any) ?? null;
  }
  return (data as any) ?? null;
}

export async function addItem(prevState: any, formData: FormData) {
  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) {
    return { error: "Server misconfiguration." };
  }
  const validatedFields = addItemSchema.safeParse({
    productId: Number(formData.get("productId")),
    quantity: Number(formData.get("quantity")),
    productSlug: (() => {
      const v = formData.get("productSlug");
      return typeof v === "string" && v.trim().length > 0 ? v : undefined;
    })(),
  });

  if (!validatedFields.success) {
    return { error: "Invalid input." };
  }

  let { productId, quantity, productSlug } = validatedFields.data;
  const selected = parseSelectedOption(formData); // e.g., { name: "Size", value: "L" }
  const allOptions = parseAllSelectedOptions(formData); // All options: Color, Size, etc.
  const selectedOptionMap = buildSelectedOptionMap(allOptions);
  const selectedOptionSignature = buildOptionSignature(selectedOptionMap);
  const variantName = buildVariantName(allOptions); // e.g., "Star blue-XL"
  
  // Extract color and size separately for robust display
  const selectedColor = allOptions.find(o => o.name.toLowerCase() === 'color')?.value || null;
  const selectedSize = allOptions.find(o => o.name.toLowerCase() === 'size')?.value || null;

  try {
    // 1. Fetch product and optional variant
    let product = await getProductById(supabaseAdmin, productId);
    if (!product && productSlug) {
      const bySlug = await getProductBySlug(supabaseAdmin, productSlug);
      if (bySlug) {
        product = bySlug;
        productId = bySlug.id as number; // normalize id for subsequent operations
      }
    }

    if (!product) {
      return { error: "Product not found." };
    }
    if (Object.prototype.hasOwnProperty.call(product, "is_active") && (product as any).is_active === false) {
      return { error: `This product is no longer available.` };
    }

    console.log(`[addItem] Product ${productId}, options: ${JSON.stringify(allOptions)}, variantName: "${variantName}"`);

    // Try resolve variant_id with dynamic signature first, then legacy option-name/value fallback
    let variantRow: any = null;
    if (selectedOptionSignature) {
      const { data: bySignature } = await supabaseAdmin
        .from("product_variants")
        .select("*")
        .eq("product_id", productId)
        .eq("option_signature", selectedOptionSignature)
        .maybeSingle();
      variantRow = bySignature ?? null;

      if (!variantRow) {
        const { data: variantsForProduct } = await supabaseAdmin
          .from("product_variants")
          .select("*")
          .eq("product_id", productId);

        const list = Array.isArray(variantsForProduct) ? variantsForProduct : [];
        variantRow =
          list.find((row) => {
            const map = extractVariantOptionMapFromRow(row);
            if (Object.keys(map).length === 0) return false;
            if (optionsMatchByNormalizedNameAndValue(map, selectedOptionMap)) return true;
            const rowSignature = buildOptionSignature(map);
            return rowSignature.length > 0 && rowSignature === selectedOptionSignature;
          }) || null;
      }
    }

    if (!variantRow && selected) {
      const { data: legacyRow } = await supabaseAdmin
        .from("product_variants")
        .select("*")
        .eq("product_id", productId)
        .eq("option_name", selected.name)
        .eq("option_value", selected.value)
        .maybeSingle();
      variantRow = legacyRow ?? null;
    }

    const cart = await getOrCreateCart();

    // Detect which columns exist in cart_items table
    const cols = await detectCartItemsColumns(supabaseAdmin);

    // Check if item already exists in cart
    // Find existing item by product_id AND variant_name (so different variants are separate cart items)
    let existingItem: any = null;
    
    // Build query to find matching cart item
    const selectCols = cols.hasVariantId
      ? "id, quantity, variant_name, variant_id"
      : "id, quantity, variant_name";
    let query = supabaseAdmin
      .from("cart_items")
      .select(selectCols)
      .eq("session_id", cart.id)
      .eq("product_id", productId);
    
    // Prefer exact variant_id match when available
    if (cols.hasVariantId && variantRow?.id) {
      query = query.eq("variant_id", variantRow.id);
    } else if (variantName) {
      // Match by variant_name if provided
      query = query.eq("variant_name", variantName);
    } else {
      query = query.is("variant_name", null);
    }
    
    const { data: existingItems, error: findError } = await query;
    
    if (!findError && existingItems && existingItems.length > 0) {
      existingItem = existingItems[0];
    }

    if (existingItem) {
      // Update quantity for matching variant
      const newQuantity = existingItem.quantity + quantity;

      // Stock check: only block if stock is EXPLICITLY > 0 and quantity exceeds it
      if (variantRow && typeof variantRow.stock === 'number' && variantRow.stock > 0) {
        if (newQuantity > variantRow.stock) {
          return { error: `الكمية المطلوبة غير متوفرة للمقاس ${variantRow.option_value}. المتبقي ${variantRow.stock}.` };
        }
      } else if (typeof product.stock === 'number' && product.stock > 0 && newQuantity > product.stock) {
        return { error: `Not enough stock for ${product.title}. Only ${product.stock} left.` };
      }

      // Build update payload based on detected columns
      const updatePayload: any = { quantity: newQuantity };
      if (cols.hasVariantName) updatePayload.variant_name = variantName || existingItem.variant_name || null;
      if (cols.hasSelectedColor) updatePayload.selected_color = selectedColor;
      if (cols.hasSelectedSize) updatePayload.selected_size = selectedSize;
      
      const { error } = await supabaseAdmin
        .from("cart_items")
        .update(updatePayload)
        .eq("id", existingItem.id);
      
      if (error) throw error;
      
      console.log(`[addItem] Updated cart item ${existingItem.id}, variant_name: "${variantName}", color: "${selectedColor}", size: "${selectedSize}", new qty: ${newQuantity}`);
    } else {
      // Insert new cart item with variant_name
      // Stock check: only block if stock is EXPLICITLY > 0 and quantity exceeds it
      if (variantRow && typeof variantRow.stock === 'number' && variantRow.stock > 0) {
        if (quantity > variantRow.stock) {
          return { error: `الكمية المطلوبة غير متوفرة للمقاس ${variantRow.option_value}. المتبقي ${variantRow.stock}.` };
        }
      } else if (typeof product.stock === 'number' && product.stock > 0 && quantity > product.stock) {
        return { error: `Not enough stock for ${product.title}. Only ${product.stock} left.` };
      }

      // Build insert payload based on detected columns
      const insertPayload: any = { 
        session_id: cart.id, 
        product_id: productId, 
        quantity,
      };
      
      if (cols.hasVariantName) insertPayload.variant_name = variantName || null;
      if (cols.hasSelectedColor) insertPayload.selected_color = selectedColor;
      if (cols.hasSelectedSize) insertPayload.selected_size = selectedSize;
      if (cols.hasVariantId && variantRow && variantRow.id) {
        insertPayload.variant_id = variantRow.id;
      }
      
      const { error: insertError } = await supabaseAdmin
        .from("cart_items")
        .insert(insertPayload);
      
      if (insertError) {
        // Reset cache and retry with fresh column detection
        cartItemsColumnsCache.checked = false;
        const freshCols = await detectCartItemsColumns(supabaseAdmin);
        
        const retryPayload: any = { 
          session_id: cart.id, 
          product_id: productId, 
          quantity,
        };
        if (freshCols.hasVariantName) retryPayload.variant_name = variantName || null;
        if (freshCols.hasSelectedColor) retryPayload.selected_color = selectedColor;
        if (freshCols.hasSelectedSize) retryPayload.selected_size = selectedSize;
        if (freshCols.hasVariantId && variantRow && variantRow.id) {
          retryPayload.variant_id = variantRow.id;
        }
        
        const { error: retryError } = await supabaseAdmin
          .from("cart_items")
          .insert(retryPayload);
        if (retryError) throw retryError;
      }
      
      console.log(`[addItem] Created cart item, variant_name: "${variantName}", color: "${selectedColor}", size: "${selectedSize}", qty: ${quantity}`);
    }

    revalidatePath("/cart");
    revalidatePath("/");

    const count = await getCartItemCount();
    return { success: "Item added to cart.", count };
  } catch (e) {
    console.error(e);
    return { error: "An unexpected error occurred." };
  }
}

export async function clearCart() {
  const cartId = cookies().get("cart_id")?.value;

  if (!cartId) return { success: true };

  try {
    const supabaseAdmin = getSupabaseAdmin();
    if (!supabaseAdmin) {
      return { success: false };
    }
    const { error } = await supabaseAdmin
      .from("cart_items")
      .delete()
      .eq("session_id", cartId);
    if (error) throw error;
    revalidatePath("/cart");
    return { success: true };
  } catch (e) {
    console.error(e);
    return { error: "An unexpected error occurred." };
  }
}

const updateItemSchema = z.object({
  itemId: z.number(),
  quantity: z.number().min(0),
});

export async function updateItemQuantity(prevState: any, formData: FormData) {
  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) {
    return { error: "Server misconfiguration." };
  }
  const validatedFields = updateItemSchema.safeParse({
    itemId: Number(formData.get("itemId")),
    quantity: Number(formData.get("quantity")),
  });

  if (!validatedFields.success) {
    return { error: "Invalid input." };
  }

  const { itemId, quantity } = validatedFields.data;
  const cartId = cookies().get("cart_id")?.value;

  if (!cartId) return { error: "Cart not found." };

  try {
    if (quantity === 0) {
      // Remove item if quantity is 0
      const { error } = await supabaseAdmin
        .from("cart_items")
        .delete()
        .eq("id", itemId)
        .eq("session_id", cartId);
      if (error) throw error;
    } else {
      // Validate stock before updating quantity
      const { data: itemRow, error: itemErr } = await supabaseAdmin
        .from("cart_items")
        .select("id, product_id, variant_id")
        .eq("id", itemId)
        .eq("session_id", cartId)
        .single();
      if (itemErr || !itemRow) {
        return { error: "Cart item not found." };
      }

      const product = await getProductById(supabaseAdmin, itemRow.product_id as number);
      if (!product) {
        return { error: "Product not found." };
      }
      if (Object.prototype.hasOwnProperty.call(product, "is_active") && (product as any).is_active === false) {
        return { error: `This product is no longer available.` };
      }
      // Stock check: only block if stock is EXPLICITLY > 0 and quantity exceeds it
      // stock = 0, null, undefined all mean "unknown availability" - allow purchase
      if (typeof itemRow.variant_id === 'number') {
        const { data: vrow } = await supabaseAdmin
          .from("product_variants")
          .select("stock, option_value")
          .eq("id", itemRow.variant_id)
          .single();
        const vstock = (vrow as any)?.stock;
        // Only check if stock is explicitly > 0
        if (typeof vstock === 'number' && vstock > 0 && quantity > vstock) {
          return { error: `الكمية المطلوبة غير متوفرة للمقاس ${(vrow as any)?.option_value ?? ''}. المتبقي ${vstock}.` };
        }
      } else if (typeof product.stock === 'number' && product.stock > 0 && quantity > product.stock) {
        return { error: `Not enough stock for ${product.title}. Only ${product.stock} left.` };
      }
      // If stock is 0, null, or undefined, allow - CJ will validate at fulfillment

      // Update quantity
      const { error } = await supabaseAdmin
        .from("cart_items")
        .update({ quantity })
        .eq("id", itemId)
        .eq("session_id", cartId);
      if (error) throw error;
    }

    revalidatePath("/cart");
    const count = await getCartItemCount();
    return { success: "Cart updated.", count };
  } catch (e) {
    console.error(e);
    return { error: "An unexpected error occurred." };
  }
}

const removeItemSchema = z.object({
  itemId: z.number(),
});

const moveToFavoritesSchema = z.object({
  itemId: z.number(),
});

export async function moveToFavorites(prevState: any, formData: FormData) {
  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) {
    return { error: "Server misconfiguration." };
  }
  
  const validatedFields = moveToFavoritesSchema.safeParse({
    itemId: Number(formData.get("itemId")),
  });

  if (!validatedFields.success) {
    return { error: "Invalid input." };
  }

  const { itemId } = validatedFields.data;
  const cartId = cookies().get("cart_id")?.value;

  if (!cartId) return { error: "Cart not found." };

  try {
    // Get the cart item details
    const { data: cartItem, error: fetchError } = await supabaseAdmin
      .from("cart_items")
      .select("product_id, variant_name")
      .eq("id", itemId)
      .eq("session_id", cartId)
      .single();

    if (fetchError || !cartItem) {
      return { error: "Cart item not found." };
    }

    // Get user if authenticated
    const supabaseAuth = createServerComponentClient({ cookies });
    const { data: { user } } = await supabaseAuth.auth.getUser();

    // Add to wishlist - normalize variant_name for consistent uniqueness
    const normalizedVariantName = cartItem.variant_name 
      ? String(cartItem.variant_name).trim() 
      : null;
    
    const wishlistPayload: any = {
      product_id: cartItem.product_id,
      variant_name: normalizedVariantName,
    };

    if (user) {
      wishlistPayload.user_id = user.id;
    } else {
      wishlistPayload.session_id = cartId;
    }

    // Insert into wishlist (use insert and handle duplicates)
    const { error: wishlistError } = await supabaseAdmin
      .from("wishlist_items")
      .insert(wishlistPayload);

    let alreadyInFavorites = false;
    if (wishlistError) {
      // If it's a duplicate key error, that's OK - item already in wishlist
      const errCode = (wishlistError as any).code;
      if (errCode === '23505') { // 23505 = unique_violation in PostgreSQL
        alreadyInFavorites = true;
        // Item already in wishlist, safe to remove from cart
      } else {
        console.error("Error adding to wishlist:", wishlistError);
        // Don't remove from cart if wishlist insert failed (not a duplicate)
        return { error: "Could not add to favorites. Please try again." };
      }
    }

    // Remove from cart (only if wishlist insert succeeded or item was already in wishlist)
    const { error: deleteError } = await supabaseAdmin
      .from("cart_items")
      .delete()
      .eq("id", itemId)
      .eq("session_id", cartId);

    if (deleteError) throw deleteError;

    revalidatePath("/cart");
    const count = await getCartItemCount();
    
    if (alreadyInFavorites) {
      return { success: "Item was already in favorites! Removed from cart.", count };
    }
    return { success: "Moved to favorites!", count };
  } catch (e) {
    console.error(e);
    return { error: "An unexpected error occurred." };
  }
}

export async function removeItem(prevState: any, formData: FormData) {
  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) {
    return { error: "Server misconfiguration." };
  }
  const validatedFields = removeItemSchema.safeParse({
    itemId: Number(formData.get("itemId")),
  });

  if (!validatedFields.success) {
    return { error: "Invalid input." };
  }

  const { itemId } = validatedFields.data;
  const cartId = cookies().get("cart_id")?.value;

  if (!cartId) return { error: "Cart not found." };

  try {
    const { error } = await supabaseAdmin
      .from("cart_items")
      .delete()
      .eq("id", itemId)
      .eq("session_id", cartId);

    if (error) throw error;

    revalidatePath("/cart");
    const count = await getCartItemCount();
    return { success: "Item removed.", count };
  } catch (e) {
    console.error(e);
    return { error: "An unexpected error occurred." };
  }
}

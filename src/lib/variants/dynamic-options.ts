export type DynamicVariantOptions = Record<string, string>;

export type DynamicAvailableOption = {
  name: string;
  values: string[];
  inStockValues: string[];
  source?: string;
};

type OptionPair = {
  name: string;
  value: string;
  source?: string;
};

type VariantStockLike = {
  stock?: unknown;
  totalStock?: unknown;
  cjStock?: unknown;
  factoryStock?: unknown;
  cj_stock?: unknown;
  factory_stock?: unknown;
};

function cleanText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function normalizeOptionName(name: unknown): string {
  return cleanText(name);
}

export function normalizeOptionNameKey(name: unknown): string {
  return normalizeOptionName(name).toLowerCase();
}

function normalizeValueKey(value: unknown): string {
  return cleanText(value).toLowerCase();
}

function pushPair(target: OptionPair[], name: unknown, value: unknown, source?: string) {
  const cleanName = normalizeOptionName(name);
  const cleanValue = cleanText(value);
  if (!cleanName || !cleanValue) return;
  target.push({ name: cleanName, value: cleanValue, source });
}

function readValueFromUnknown(raw: any): string {
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return cleanText(raw);
  }
  if (!raw || typeof raw !== "object") return "";

  const candidate =
    raw.propertyValueNameEn ??
    raw.propertyValueName ??
    raw.valueName ??
    raw.valueEn ??
    raw.optionValue ??
    raw.attributeValue ??
    raw.value ??
    raw.name;

  return cleanText(candidate);
}

function readNameFromUnknown(raw: any): string {
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return cleanText(raw);
  }
  if (!raw || typeof raw !== "object") return "";

  const candidate =
    raw.propertyNameEn ??
    raw.propertyName ??
    raw.attributeNameEn ??
    raw.attributeName ??
    raw.optionName ??
    raw.name ??
    raw.key;

  return cleanText(candidate);
}

export function extractNamedOptionPairsFromPropertyList(rawList: unknown, source?: string): OptionPair[] {
  const list = Array.isArray(rawList) ? rawList : [];
  const out: OptionPair[] = [];

  for (const item of list) {
    if (item == null) continue;

    if (typeof item === "object" && !Array.isArray(item)) {
      const optionName = readNameFromUnknown(item);
      const values =
        (item as any).propertyValueList ??
        (item as any).values ??
        (item as any).options ??
        (item as any).optionValues ??
        (item as any).valueList ??
        (item as any).attributeValueList;

      if (Array.isArray(values) && optionName) {
        for (const valueItem of values) {
          const value = readValueFromUnknown(valueItem);
          pushPair(out, optionName, value, source);
        }
        continue;
      }

      const directValue = readValueFromUnknown(item);
      if (optionName && directValue) {
        pushPair(out, optionName, directValue, source);
      }
      continue;
    }

    const direct = cleanText(item);
    if (direct) {
      pushPair(out, "Option", direct, source);
    }
  }

  return out;
}

export function extractVariantOptionsFromRawVariant(variant: any): DynamicVariantOptions {
  const pairs: OptionPair[] = [];

  const pushKnown = (name: string, value: unknown) => pushPair(pairs, name, value, "variant");

  pushKnown("Color", variant?.color ?? variant?.colour ?? variant?.colorNameEn ?? variant?.colorName);
  pushKnown("Size", variant?.size ?? variant?.sizeNameEn ?? variant?.sizeName);
  pushKnown("Model", variant?.model ?? variant?.modelNameEn ?? variant?.modelName);
  pushKnown("Style", variant?.style ?? variant?.styleNameEn ?? variant?.styleName);
  pushKnown("Format", variant?.format ?? variant?.formatNameEn ?? variant?.formatName);

  const dynamicSources: Array<{ list: unknown; source: string }> = [
    { list: variant?.variantPropertyList, source: "variantPropertyList" },
    { list: variant?.propertyList, source: "propertyList" },
    { list: variant?.properties, source: "properties" },
    { list: variant?.attributes, source: "attributes" },
    { list: variant?.attributeList, source: "attributeList" },
  ];

  for (const source of dynamicSources) {
    pairs.push(...extractNamedOptionPairsFromPropertyList(source.list, source.source));
  }

  if (pairs.length === 0) {
    const fallback = cleanText(variant?.variantKey ?? variant?.variantNameEn ?? variant?.variantName);
    if (fallback) {
      const parts = fallback.split(/[-/|_]+/).map((part) => cleanText(part)).filter(Boolean);
      if (parts.length >= 2) {
        pushPair(pairs, "Color", parts[0], "variantKey");
        pushPair(pairs, "Size", parts[parts.length - 1], "variantKey");
      } else if (parts.length === 1) {
        pushPair(pairs, "Option", parts[0], "variantKey");
      }
    }
  }

  const optionMap: DynamicVariantOptions = {};
  const seenByKey = new Set<string>();

  for (const pair of pairs) {
    const name = normalizeOptionName(pair.name);
    const value = cleanText(pair.value);
    if (!name || !value) continue;

    const dedupeKey = `${normalizeOptionNameKey(name)}::${normalizeValueKey(value)}`;
    if (seenByKey.has(dedupeKey)) continue;
    seenByKey.add(dedupeKey);

    if (!optionMap[name]) {
      optionMap[name] = value;
    }
  }

  return optionMap;
}

export function isVariantInStockStrict(stockLike: VariantStockLike | null | undefined): boolean {
  if (!stockLike || typeof stockLike !== "object") return false;

  const candidates = [
    stockLike.totalStock,
    stockLike.stock,
    stockLike.cjStock,
    stockLike.factoryStock,
    stockLike.cj_stock,
    stockLike.factory_stock,
  ]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));

  if (candidates.length === 0) return false;
  return candidates.some((value) => value > 0);
}

export function buildOptionSignature(options: DynamicVariantOptions | null | undefined): string {
  const entries = Object.entries(options || {})
    .map(([name, value]) => ({
      name: normalizeOptionName(name),
      value: cleanText(value),
      key: normalizeOptionNameKey(name),
      valueKey: normalizeValueKey(value),
    }))
    .filter((entry) => entry.name && entry.value)
    .sort((a, b) => a.key.localeCompare(b.key) || a.valueKey.localeCompare(b.valueKey));

  return entries.map((entry) => `${entry.key}=${entry.valueKey}`).join("|");
}

export function deriveAvailableOptionsFromVariants(
  variants: Array<{
    variantOptions?: DynamicVariantOptions | null;
    variant_options?: DynamicVariantOptions | null;
    stock?: unknown;
    totalStock?: unknown;
    cjStock?: unknown;
    factoryStock?: unknown;
    cj_stock?: unknown;
    factory_stock?: unknown;
    color?: unknown;
    size?: unknown;
    model?: unknown;
  }> | null | undefined,
  opts?: { includeOutOfStockDimensions?: boolean }
): DynamicAvailableOption[] {
  const list = Array.isArray(variants) ? variants : [];
  const includeOutOfStockDimensions = Boolean(opts?.includeOutOfStockDimensions);

  const order: string[] = [];
  const labels = new Map<string, string>();
  const allValuesByName = new Map<string, string[]>();
  const inStockValuesByName = new Map<string, string[]>();
  const allValueKeys = new Map<string, Set<string>>();
  const inStockValueKeys = new Map<string, Set<string>>();

  const pushValue = (
    collection: Map<string, string[]>,
    keyMap: Map<string, Set<string>>,
    name: string,
    value: string
  ) => {
    const optionKey = normalizeOptionNameKey(name);
    const valueKey = normalizeValueKey(value);
    if (!optionKey || !valueKey) return;

    if (!labels.has(optionKey)) {
      labels.set(optionKey, name);
      order.push(optionKey);
    }

    if (!keyMap.has(optionKey)) keyMap.set(optionKey, new Set());
    const seen = keyMap.get(optionKey)!;
    if (seen.has(valueKey)) return;
    seen.add(valueKey);

    if (!collection.has(optionKey)) collection.set(optionKey, []);
    collection.get(optionKey)!.push(value);
  };

  for (const variant of list) {
    const fromVariant = variant?.variantOptions && typeof variant.variantOptions === "object"
      ? variant.variantOptions
      : (variant?.variant_options && typeof variant.variant_options === "object"
        ? variant.variant_options
        : null);

    const optionMap = fromVariant && Object.keys(fromVariant).length > 0
      ? fromVariant
      : extractVariantOptionsFromRawVariant(variant);

    const inStock = isVariantInStockStrict(variant);

    for (const [name, rawValue] of Object.entries(optionMap)) {
      const normalizedName = normalizeOptionName(name);
      const normalizedValue = cleanText(rawValue);
      if (!normalizedName || !normalizedValue) continue;

      pushValue(allValuesByName, allValueKeys, normalizedName, normalizedValue);
      if (inStock) {
        pushValue(inStockValuesByName, inStockValueKeys, normalizedName, normalizedValue);
      }
    }
  }

  const out: DynamicAvailableOption[] = [];

  for (const optionKey of order) {
    const name = labels.get(optionKey) || optionKey;
    const values = allValuesByName.get(optionKey) || [];
    const inStockValues = inStockValuesByName.get(optionKey) || [];

    if (!includeOutOfStockDimensions && inStockValues.length === 0) {
      continue;
    }

    out.push({
      name,
      values,
      inStockValues,
      source: "variants",
    });
  }

  return out;
}

export function deriveLegacyOptionArrays(availableOptions: DynamicAvailableOption[] | null | undefined): {
  availableColors: string[];
  availableSizes: string[];
  availableModels: string[];
} {
  const options = Array.isArray(availableOptions) ? availableOptions : [];

  const findValues = (matcher: RegExp): string[] => {
    for (const option of options) {
      const key = normalizeOptionNameKey(option.name);
      if (matcher.test(key)) {
        return option.inStockValues.length > 0 ? option.inStockValues : option.values;
      }
    }
    return [];
  };

  return {
    availableColors: findValues(/color|colour/),
    availableSizes: findValues(/size/),
    availableModels: findValues(/model|device|phone/),
  };
}

export function parseDynamicAvailableOptions(value: unknown): DynamicAvailableOption[] {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  if (!Array.isArray(parsed)) return [];

  const out: DynamicAvailableOption[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;

    const name = normalizeOptionName((item as any).name);
    if (!name) continue;

    const values = Array.isArray((item as any).values)
      ? (item as any).values.map((v: unknown) => cleanText(v)).filter(Boolean)
      : [];

    const inStockValues = Array.isArray((item as any).inStockValues)
      ? (item as any).inStockValues.map((v: unknown) => cleanText(v)).filter(Boolean)
      : [];

    if (values.length === 0 && inStockValues.length === 0) continue;

    out.push({
      name,
      values,
      inStockValues,
      source: cleanText((item as any).source) || undefined,
    });
  }

  return out;
}

export function parseDynamicVariantOptions(value: unknown): DynamicVariantOptions {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const out: DynamicVariantOptions = {};
  for (const [name, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
    const cleanName = normalizeOptionName(name);
    const cleanValue = cleanText(rawValue);
    if (!cleanName || !cleanValue) continue;
    out[cleanName] = cleanValue;
  }

  return out;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

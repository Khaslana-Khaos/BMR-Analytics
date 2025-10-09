import { randomUUID } from "crypto";
import { quantileSorted, mean, deviation } from "d3-array";
import { format, isValid, parseISO } from "date-fns";
import type { Db } from "mongodb";

type PriceTier = "Low" | "Mid" | "High" | "All";

type SessionEvent = {
  itemId: string;
  ts: Date;
  add?: number;
  remove?: number;
};

type Session = {
  sessionId: string;
  visitorId: string;
  country: string;
  ts: Date;
  nView: number;
  nCartAdd: number;
  nCartRemove: number;
  uniqueItems: Set<string>;
  views: SessionEvent[];
  carts: SessionEvent[];
  wish: SessionEvent[];
};

type ItemMeta = Record<
  string,
  {
    title: string;
    price: number;
    category: string;
    brand: string;
  }
>;

type TransitionEvent = {
  ts: Date;
  type:
    | "view"
    | "cart_add"
    | "cart_remove"
    | "wishlist_add"
    | "wishlist_remove";
  itemId: string;
  price: number;
};

export type AnalyticsResponse = {
  sessions: Array<{
    sessionId: string;
    visitorId: string;
    country: string;
    ts: string;
    nView: number;
    nCartAdd: number;
    nCartRemove: number;
  }>;
  leak: {
    overall: number;
    items: Array<{ item: string; adds: number; removes: number; leak: number }>;
  };
  recos: Record<string, Array<{ item: string; score: number }>>;
  frequentBundles: Array<{ items: [string, string]; support: number }>;
  priceMarkov: Record<
    PriceTier,
    { pViewToCart: number; pCartToCheckout: number }
  >;
  priceMarkovMeta: {
    tLow: number | null;
    tHigh: number | null;
    min: number;
    max: number;
  };
  priceBands: {
    bands: Array<{
      name: PriceTier | "All";
      min: number;
      max: number;
      viewToCart: number;
      wishToCart: number;
      nView: number;
      nWish: number;
    }>;
  };
  priceRangeData: {
    viewFromPrices: number[];
    viewToCartFromPrices: number[];
    cartAddPrices: number[];
    cartRemovePrices: number[];
  };
  categoryInteractions: Array<{
    category: string;
    views: number;
    carts: number;
    wish: number;
    total: number;
  }>;
  transitions: { states: string[]; counts: number[][]; probs: number[][] };
  sankey: {
    nodes: string[];
    links: Array<{ source: number; target: number; value: number }>;
  };
  daily: {
    series: Array<{ date: string; views: number; carts: number }>;
    anomaly: {
      hasThresholds: boolean;
      lower: number;
      upper: number;
      outliers: string[];
    };
  };
  geoInsights: Array<{ country: string; conversionRate: number }>;
  itemMeta: ItemMeta;
  __version: string;
};

type RawDoc = Record<string, any>;

type CategoryMap = Map<string, string>;

type MarkovSummary = {
  model: Record<PriceTier, { pViewToCart: number; pCartToCheckout: number }>;
  tLow: number | null;
  tHigh: number | null;
  min: number;
  max: number;
};

const VERSION = "v2025-10-02b: price-range+catmap+reset-month (Next.js)";

function clampValue(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

// function strId(value: unknown): string | null {
//     if (!value) return null;
//     if (typeof value === "string") return value;
//     if (typeof value === "object") {
//         if ("$oid" in (value as Record<string, unknown>)) {
//             const oid = (value as Record<string, unknown>)["$oid"];
//             if (typeof oid === "string") return oid;
//         }
//         if ("_id" in (value as Record<string, unknown>)) {
//             return strId((value as Record<string, unknown>)["_id"]);
//         }
//     }
//     return String(value);
// }

export function strId(value: unknown, seen = new WeakSet()): string | null {
  if (!value) return null;

  // Handle strings
  if (typeof value === "string") return value;

  // Handle ObjectId-like objects (MongoDB ObjectId or Mongoose ObjectId)
  if (value && typeof value === "object" && "toString" in value) {
    const str = value.toString();
    // Check if it looks like an ObjectId (24 hex characters)
    if (/^[0-9a-fA-F]{24}$/.test(str)) {
      return str;
    }
  }

  // Stop if we’ve already seen this object (avoid circular reference)
  if (typeof value === "object") {
    if (seen.has(value as object)) {
      console.warn("⚠️ Circular reference detected in strId:", value);
      return null;
    }
    seen.add(value as object);

    const obj = value as Record<string, unknown>;

    // Mongo-style $oid
    if (typeof obj["$oid"] === "string") {
      return obj["$oid"];
    }

    // Recursively check _id
    if ("_id" in obj) {
      return strId(obj["_id"], seen);
    }

    // If the object itself has a toString returning an ObjectId-like string
    if (
      typeof obj.toString === "function" &&
      obj.toString() !== "[object Object]"
    ) {
      return obj.toString();
    }
  }

  // Fallback
  return String(value);
}

function parseDate(input: unknown): Date | null {
  if (!input) return null;
  if (input instanceof Date) return isValid(input) ? input : null;
  if (typeof input === "number") {
    const d = new Date(input);
    return isValid(d) ? d : null;
  }
  if (typeof input === "string") {
    const iso = parseISO(input);
    if (isValid(iso)) return iso;
    const d = new Date(input);
    return isValid(d) ? d : null;
  }
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (obj.$date) {
      return parseDate(obj.$date);
    }
    if (obj.date) {
      return parseDate(obj.date);
    }
  }
  return null;
}

function safeGet<T>(obj: unknown, path: string): T | undefined {
  if (!obj) return undefined;
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj) as T | undefined;
}

function buildCategoryMap(categories: RawDoc[]): CategoryMap {
  const map = new Map<string, string>();
  for (const cat of categories ?? []) {
    const id = strId(cat?._id) ?? strId(cat?.id);
    const name = (cat?.name ?? "").toString().trim();
    if (id && name) {
      map.set(id, name);
    }
  }
  return map;
}

function buildItemMeta(listings: RawDoc[], categoryMap: CategoryMap): ItemMeta {
  const meta: ItemMeta = {};
  for (const listing of listings ?? []) {
    const id = strId(listing?._id);
    if (!id) continue;

    const title =
      safeGet<string>(listing, "productInfo.item_name.0.value") ??
      listing?.alias ??
      safeGet<string>(listing, "productInfo.sku") ??
      id;

    let price =
      safeGet<number>(listing, "prodPricing.retailPrice") ??
      safeGet<number>(
        listing,
        "prodPricing.listingWithoutStockVariations.0.retailPrice"
      ) ??
      0;
    if (typeof price !== "number" || Number.isNaN(price)) {
      price = Number(price) || 0;
    }

    let categoryId =
      safeGet<string>(listing, "productInfo.productCategory.$oid") ??
      safeGet<string>(listing, "productInfo.productCategory");
    const categoryIdStr = categoryId ? strId(categoryId) : null;
    categoryId = categoryIdStr || undefined;

    let category = categoryId ? categoryMap.get(categoryId) : undefined;
    if (!category) {
      category =
        safeGet<string>(listing, "prodTechInfo.type") ??
        safeGet<string>(listing, "productInfo.brand.0.value") ??
        "Other";
    }
    category = String(category || "Other").trim() || "Other";

    const brand = safeGet<string>(listing, "productInfo.brand.0.value") ?? "";

    meta[id] = {
      title: title.toString(),
      price: Number.isFinite(price) ? price : 0,
      category,
      brand: brand?.toString?.() ?? "",
    };
  }
  return meta;
}

function collectSessionEvents(doc: RawDoc): Session {
  const sessionId = strId(doc?._id) ?? randomUUID();
  const visitorId = (doc?.visitorId ?? "unknown").toString();
  const country =
    (safeGet<string>(doc, "geo.country") ?? "Unknown") || "Unknown";
  const ts = parseDate(safeGet(doc, "createdAt")) ?? new Date();

  const views: SessionEvent[] = [];
  const carts: SessionEvent[] = [];
  const wish: SessionEvent[] = [];

  for (const raw of doc?.viewItems ?? []) {
    const id = strId(raw?.item);
    if (!id) continue;
    const time = parseDate(raw?.createdAt ?? raw?.date) ?? ts;
    views.push({ itemId: id, ts: time });
  }

  for (const raw of doc?.cartItems ?? []) {
    const id = strId(raw?.item);
    if (!id) continue;
    const time = parseDate(raw?.createdAt) ?? ts;
    const removed = Boolean(raw?.deleted);
    carts.push({ itemId: id, ts: time, add: 1, remove: 0 });
    if (removed) {
      const rt = parseDate(raw?.updatedAt) ?? time;
      carts.push({ itemId: id, ts: rt, add: 0, remove: 1 });
    }
  }

  for (const raw of doc?.wishlistItems ?? []) {
    const id = strId(raw?.item);
    if (!id) continue;
    const time = parseDate(raw?.createdAt ?? raw?.date) ?? ts;
    const removed = Boolean(raw?.deleted);
    wish.push({ itemId: id, ts: time, add: 1, remove: 0 });
    if (removed) {
      const rt = parseDate(raw?.updatedAt) ?? time;
      wish.push({ itemId: id, ts: rt, add: 0, remove: 1 });
    }
  }

  const nView = views.length;
  const nCartAdd = carts.reduce((acc, evt) => acc + (evt.add ?? 0), 0);
  const nCartRemove = carts.reduce((acc, evt) => acc + (evt.remove ?? 0), 0);
  const uniqueItems = new Set<string>([
    ...views.map((evt) => evt.itemId),
    ...carts.map((evt) => evt.itemId),
    ...wish.map((evt) => evt.itemId),
  ]);

  return {
    sessionId,
    visitorId,
    country,
    ts,
    nView,
    nCartAdd,
    nCartRemove,
    uniqueItems,
    views,
    carts,
    wish,
  };
}

function leakAnalytics(
  sessions: Session[],
  itemMeta: ItemMeta
): {
  overall: number;
  items: Array<{ item: string; adds: number; removes: number; leak: number }>;
} {
  const adds = new Map<string, number>();
  const removes = new Map<string, number>();
  let tAdds = 0;
  let tRem = 0;

  for (const session of sessions) {
    for (const evt of session.carts) {
      const key = evt.itemId; // Use item ID as key, not category
      const add = evt.add ?? 0;
      const rem = evt.remove ?? 0;
      if (add) {
        adds.set(key, (adds.get(key) ?? 0) + add);
        tAdds += add;
      }
      if (rem) {
        removes.set(key, (removes.get(key) ?? 0) + rem);
        tRem += rem;
      }
    }
  }

  const rows: Array<{
    item: string;
    adds: number;
    removes: number;
    leak: number;
  }> = [];
  const keys = new Set([...adds.keys(), ...removes.keys()]);
  for (const key of keys) {
    const a = adds.get(key) ?? 0;
    const r = removes.get(key) ?? 0;
    const leak = a > 0 ? clampValue(r / a, 0, 1) : 0;
    rows.push({ item: key, adds: a, removes: r, leak });
  }

  rows.sort((a, b) => b.leak - a.leak || b.removes - a.removes);

  return {
    overall: tAdds > 0 ? clampValue(tRem / tAdds, 0, 1) : 0,
    items: rows,
  };
}

function cooccurrenceRecos(sessions: Session[]) {
  const pairs = new Map<string, number>();
  const freq = new Map<string, number>();

  for (const session of sessions) {
    const items = Array.from(session.uniqueItems);
    for (const id of items) {
      freq.set(id, (freq.get(id) ?? 0) + 1);
    }
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i];
        const b = items[j];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }

  const recos: Record<string, Array<{ item: string; score: number }>> = {};
  for (const [key, support] of pairs.entries()) {
    const [a, b] = key.split("|");
    const score = support / Math.sqrt((freq.get(a) ?? 1) * (freq.get(b) ?? 1));
    (recos[a] ??= []).push({ item: b, score });
    (recos[b] ??= []).push({ item: a, score });
  }

  for (const key of Object.keys(recos)) {
    recos[key].sort((x, y) => y.score - x.score);
    recos[key] = recos[key].slice(0, 10);
  }

  const bundles = [...pairs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([key, support]) => {
      const [i, j] = key.split("|");
      return { items: [i, j] as [string, string], support };
    });

  return { recos, bundles, itemFreq: freq };
}

function robustPriceSplits(prices: number[]) {
  const filtered = prices.filter(Number.isFinite);
  if (!filtered.length) {
    return { tLow: null, tHigh: null, dispMin: 0, dispMax: 0 };
  }
  const sorted = [...filtered].sort((a, b) => a - b);
  const p05 = quantileSorted(sorted, 0.05) ?? sorted[0];
  const p95 = quantileSorted(sorted, 0.95) ?? sorted[sorted.length - 1];
  const clipped = sorted.filter((value) => value >= p05 && value <= p95);
  const logValues = clipped
    .map((value) => Math.log1p(value))
    .sort((a, b) => a - b);
  const l33 = quantileSorted(logValues, 0.33);
  const l66 = quantileSorted(logValues, 0.66);
  const tLow = typeof l33 === "number" ? Math.expm1(l33) : null;
  const tHigh = typeof l66 === "number" ? Math.expm1(l66) : null;
  return { tLow, tHigh, dispMin: p05, dispMax: p95 };
}

function priceSegmentedMarkov(
  sessions: Session[],
  itemMeta: ItemMeta
): MarkovSummary {
  const prices = Object.values(itemMeta)
    .map((meta) => meta.price || 0)
    .filter(Number.isFinite);
  const { tLow, tHigh, dispMin, dispMax } = robustPriceSplits(prices);

  const tiers = new Map<
    PriceTier,
    {
      nViewSess: number;
      nViewThenCartSess: number;
      adds: number;
      removes: number;
    }
  >();

  const tierForItem = (id: string): PriceTier => {
    const price = itemMeta[id]?.price ?? 0;
    if (tLow == null || tHigh == null || tLow === tHigh) return "All";
    if (price <= tLow) return "Low";
    if (price <= tHigh) return "Mid";
    return "High";
  };

  const overall = { nViewSess: 0, nViewThenCartSess: 0, adds: 0, removes: 0 };

  for (const session of sessions) {
    const viewed = new Set<PriceTier>(
      session.views.map((evt) => tierForItem(evt.itemId))
    );
    const added = new Set<PriceTier>(
      session.carts
        .filter((evt) => evt.add)
        .map((evt) => tierForItem(evt.itemId))
    );

    if (session.views.length > 0) {
      overall.nViewSess += 1;
      if (session.carts.some((evt) => evt.add)) {
        overall.nViewThenCartSess += 1;
      }
    }

    for (const tier of viewed) {
      const state = tiers.get(tier) ?? {
        nViewSess: 0,
        nViewThenCartSess: 0,
        adds: 0,
        removes: 0,
      };
      state.nViewSess += 1;
      if (added.has(tier)) {
        state.nViewThenCartSess += 1;
      }
      tiers.set(tier, state);
    }

    for (const evt of session.carts) {
      const tier = tierForItem(evt.itemId);
      const state = tiers.get(tier) ?? {
        nViewSess: 0,
        nViewThenCartSess: 0,
        adds: 0,
        removes: 0,
      };
      state.adds += evt.add ?? 0;
      state.removes += evt.remove ?? 0;
      tiers.set(tier, state);
      overall.adds += evt.add ?? 0;
      overall.removes += evt.remove ?? 0;
    }
  }

  const model: Record<
    PriceTier,
    { pViewToCart: number; pCartToCheckout: number }
  > = {
    Low: { pViewToCart: 0, pCartToCheckout: 0 },
    Mid: { pViewToCart: 0, pCartToCheckout: 0 },
    High: { pViewToCart: 0, pCartToCheckout: 0 },
    All: { pViewToCart: 0, pCartToCheckout: 0 },
  };

  for (const [tier, state] of tiers.entries()) {
    const viewToCart =
      state.nViewSess > 0 ? state.nViewThenCartSess / state.nViewSess : 0;
    const denom = state.adds > 0 ? state.adds : 1;
    const cartToCheckout = clampValue(
      (state.adds - state.removes) / denom,
      0,
      1
    );
    model[tier] = { pViewToCart: viewToCart, pCartToCheckout: cartToCheckout };
  }

  if (!tiers.size) {
    const denom = overall.adds > 0 ? overall.adds : 1;
    model.All = {
      pViewToCart:
        overall.nViewSess > 0
          ? overall.nViewThenCartSess / overall.nViewSess
          : 0,
      pCartToCheckout: clampValue(
        (overall.adds - overall.removes) / denom,
        0,
        1
      ),
    };
    return { model, tLow, tHigh, min: dispMin, max: dispMax };
  }

  const denomAll = overall.adds > 0 ? overall.adds : 1;
  model.All = {
    pViewToCart:
      overall.nViewSess > 0 ? overall.nViewThenCartSess / overall.nViewSess : 0,
    pCartToCheckout: clampValue(
      (overall.adds - overall.removes) / denomAll,
      0,
      1
    ),
  };

  return { model, tLow, tHigh, min: dispMin, max: dispMax };
}

function buildEventStreamForSession(
  session: Session,
  itemMeta: ItemMeta
): TransitionEvent[] {
  const events: TransitionEvent[] = [];
  for (const view of session.views) {
    events.push({
      ts: view.ts,
      type: "view",
      itemId: view.itemId,
      price: itemMeta[view.itemId]?.price ?? 0,
    });
  }
  for (const cart of session.carts) {
    if (cart.add) {
      events.push({
        ts: cart.ts,
        type: "cart_add",
        itemId: cart.itemId,
        price: itemMeta[cart.itemId]?.price ?? 0,
      });
    }
    if (cart.remove) {
      events.push({
        ts: cart.ts,
        type: "cart_remove",
        itemId: cart.itemId,
        price: itemMeta[cart.itemId]?.price ?? 0,
      });
    }
  }
  for (const wish of session.wish) {
    if (wish.add) {
      events.push({
        ts: wish.ts,
        type: "wishlist_add",
        itemId: wish.itemId,
        price: itemMeta[wish.itemId]?.price ?? 0,
      });
    }
    if (wish.remove) {
      events.push({
        ts: wish.ts,
        type: "wishlist_remove",
        itemId: wish.itemId,
        price: itemMeta[wish.itemId]?.price ?? 0,
      });
    }
  }
  events.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  return events;
}

function transitionMatrixAndSankey(sessions: Session[], itemMeta: ItemMeta) {
  const states: TransitionEvent["type"][] = [
    "cart_add",
    "cart_remove",
    "view",
    "wishlist_add",
    "wishlist_remove",
  ];
  const index = Object.fromEntries(
    states.map((state, idx) => [state, idx] as const)
  );
  const n = states.length;
  const counts = Array.from({ length: n }, () => Array(n).fill(0));
  const transitions: Array<{ from: TransitionEvent; to: TransitionEvent }> = [];

  for (const session of sessions) {
    const events = buildEventStreamForSession(session, itemMeta);
    for (let i = 0; i < events.length - 1; i += 1) {
      const from = events[i];
      const to = events[i + 1];
      const ia = index[from.type];
      const ib = index[to.type];
      if (ia == null || ib == null) continue;
      counts[ia][ib] += 1;
      transitions.push({ from, to });
    }
  }

  const probs = counts.map((row) => {
    const sum = row.reduce((acc, value) => acc + value, 0);
    return sum ? row.map((value) => value / sum) : row.map(() => 0);
  });

  const links: Array<{ source: number; target: number; value: number }> = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const value = counts[i][j];
      if (value > 0) {
        links.push({ source: i, target: j, value });
      }
    }
  }

  return {
    states,
    counts,
    probs,
    sankey: { nodes: states, links },
    allTransitions: transitions,
  };
}

function priceBandsFromQuantiles(
  itemMeta: ItemMeta,
  transitions: Array<{ from: TransitionEvent; to: TransitionEvent }>
) {
  const prices = Object.values(itemMeta)
    .map((meta) => meta.price || 0)
    .filter(Number.isFinite);
  if (!prices.length) {
    return {
      bands: [
        {
          name: "All" as PriceTier | "All",
          min: 0,
          max: 0,
          viewToCart: 0,
          wishToCart: 0,
          nView: 0,
          nWish: 0,
        },
      ],
    };
  }

  const { tLow, tHigh, dispMin, dispMax } = robustPriceSplits(prices);
  if (!(tLow != null && tHigh != null && tLow < tHigh)) {
    return {
      bands: [
        {
          name: "All" as PriceTier | "All",
          min: dispMin,
          max: dispMax,
          viewToCart: 0,
          wishToCart: 0,
          nView: 0,
          nWish: 0,
        },
      ],
    };
  }

  const bands: Array<{
    name: PriceTier;
    min: number;
    max: number;
    viewToCart: number;
    wishToCart: number;
    nView: number;
    nWish: number;
  }> = [
    {
      name: "Low",
      min: dispMin,
      max: tLow,
      viewToCart: 0,
      wishToCart: 0,
      nView: 0,
      nWish: 0,
    },
    {
      name: "Mid",
      min: tLow,
      max: tHigh,
      viewToCart: 0,
      wishToCart: 0,
      nView: 0,
      nWish: 0,
    },
    {
      name: "High",
      min: tHigh,
      max: dispMax,
      viewToCart: 0,
      wishToCart: 0,
      nView: 0,
      nWish: 0,
    },
  ];

  const bandForPrice = (price: number): PriceTier => {
    if (price <= tLow) return "Low";
    if (price <= tHigh) return "Mid";
    return "High";
  };

  const totals: Record<PriceTier, { view: number; wish: number }> = {
    Low: { view: 0, wish: 0 },
    Mid: { view: 0, wish: 0 },
    High: { view: 0, wish: 0 },
    All: { view: 0, wish: 0 },
  };

  const hits: Record<PriceTier, { viewCart: number; wishCart: number }> = {
    Low: { viewCart: 0, wishCart: 0 },
    Mid: { viewCart: 0, wishCart: 0 },
    High: { viewCart: 0, wishCart: 0 },
    All: { viewCart: 0, wishCart: 0 },
  };

  for (const transition of transitions) {
    const price = transition.from.price ?? 0;
    const band = bandForPrice(price);
    if (transition.from.type === "view") {
      totals[band].view += 1;
      if (transition.to.type === "cart_add") {
        hits[band].viewCart += 1;
      }
    }
    if (transition.from.type === "wishlist_add") {
      totals[band].wish += 1;
      if (transition.to.type === "cart_add") {
        hits[band].wishCart += 1;
      }
    }
  }

  const alpha = 1;
  for (const band of bands) {
    const totalsForBand = totals[band.name];
    const hitsForBand = hits[band.name];
    band.nView = totalsForBand.view;
    band.nWish = totalsForBand.wish;
    band.viewToCart = totalsForBand.view
      ? (hitsForBand.viewCart + alpha) / (totalsForBand.view + 2 * alpha)
      : 0;
    band.wishToCart = totalsForBand.wish
      ? (hitsForBand.wishCart + alpha) / (totalsForBand.wish + 2 * alpha)
      : 0;
  }

  return { bands };
}

function buildPriceRangeData(
  sessions: Session[],
  itemMeta: ItemMeta,
  transitions: Array<{ from: TransitionEvent; to: TransitionEvent }>
) {
  const priceRangeData = {
    viewFromPrices: [] as number[],
    viewToCartFromPrices: [] as number[],
    cartAddPrices: [] as number[],
    cartRemovePrices: [] as number[],
  };

  for (const transition of transitions) {
    if (transition.from.type === "view") {
      const price = Number(transition.from.price) || 0;
      priceRangeData.viewFromPrices.push(price);
      if (transition.to.type === "cart_add") {
        priceRangeData.viewToCartFromPrices.push(price);
      }
    }
  }

  for (const session of sessions) {
    for (const cart of session.carts) {
      const price = Number(itemMeta[cart.itemId]?.price) || 0;
      if (cart.add) priceRangeData.cartAddPrices.push(price);
      if (cart.remove) priceRangeData.cartRemovePrices.push(price);
    }
  }

  return priceRangeData;
}

function geoBehavioralInsights(sessions: Session[]) {
  const byCountry = new Map<string, { n: number; converted: number }>();
  for (const session of sessions) {
    const key = session.country || "Unknown";
    const entry = byCountry.get(key) ?? { n: 0, converted: 0 };
    entry.n += 1;
    if (session.nCartAdd > 0) entry.converted += 1;
    byCountry.set(key, entry);
  }
  return [...byCountry.entries()]
    .map(([country, stats]) => ({
      country,
      conversionRate: stats.n ? stats.converted / stats.n : 0,
    }))
    .sort((a, b) => b.conversionRate - a.conversionRate)
    .slice(0, 20);
}

function categoryInteractions(sessions: Session[], itemMeta: ItemMeta) {
  const byCategory = new Map<
    string,
    {
      category: string;
      views: number;
      carts: number;
      wish: number;
      total: number;
    }
  >();
  const bump = (category: string, key: "views" | "carts" | "wish") => {
    const entry = byCategory.get(category) ?? {
      category,
      views: 0,
      carts: 0,
      wish: 0,
      total: 0,
    };
    entry[key] += 1;
    entry.total += 1;
    byCategory.set(category, entry);
  };

  for (const session of sessions) {
    for (const view of session.views) {
      bump(itemMeta[view.itemId]?.category ?? "Other", "views");
    }
    for (const cart of session.carts) {
      if (cart.add) {
        bump(itemMeta[cart.itemId]?.category ?? "Other", "carts");
      }
    }
    for (const wish of session.wish) {
      if (wish.add) {
        bump(itemMeta[wish.itemId]?.category ?? "Other", "wish");
      }
    }
  }

  return [...byCategory.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, 20);
}

function dailyTrends(sessions: Session[]) {
  const byDay = new Map<string, { views: number; carts: number }>();
  const dayKey = (date: Date | string | number | null | undefined) => {
    if (!date) return format(new Date(), "yyyy-MM-dd");
    const candidate =
      date instanceof Date ? date : parseDate(date) ?? new Date(date);
    const safeDate = candidate && isValid(candidate) ? candidate : new Date();
    return format(safeDate, "yyyy-MM-dd");
  };

  for (const session of sessions) {
    for (const view of session.views) {
      const key = dayKey(view.ts);
      const record = byDay.get(key) ?? { views: 0, carts: 0 };
      record.views += 1;
      byDay.set(key, record);
    }
    for (const cart of session.carts) {
      if (cart.add) {
        const key = dayKey(cart.ts);
        const record = byDay.get(key) ?? { views: 0, carts: 0 };
        record.carts += 1;
        byDay.set(key, record);
      }
    }
  }

  const series = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, record]) => ({
      date,
      views: record.views,
      carts: record.carts,
    }));

  const cartCounts = series.map((row) => row.carts);
  const avg = mean(cartCounts) ?? 0;
  const std = deviation(cartCounts) ?? 0;
  const lower = avg > 0 ? Math.max(0, avg - 2 * std) : 0;
  const upper = avg + 2 * std;
  const hasThresholds = cartCounts.length >= 3 && std > 0;
  const outliers = hasThresholds
    ? series
        .filter((row) => row.carts < lower || row.carts > upper)
        .map((row) => row.date)
    : [];

  return {
    series,
    anomaly: { hasThresholds, lower, upper, outliers },
  };
}

function computeAnalyticsFromDocs(
  trackingDocs: RawDoc[],
  listings: RawDoc[],
  productCategories: RawDoc[]
): AnalyticsResponse {
  const categoryMap = buildCategoryMap(productCategories);
  const itemMeta = buildItemMeta(listings, categoryMap);
  const sessions = (trackingDocs ?? []).map(collectSessionEvents);

  const leak = leakAnalytics(sessions, itemMeta);
  const { recos, bundles } = cooccurrenceRecos(sessions);
  const markov = priceSegmentedMarkov(sessions, itemMeta);
  const transitionInfo = transitionMatrixAndSankey(sessions, itemMeta);
  const priceBands = priceBandsFromQuantiles(
    itemMeta,
    transitionInfo.allTransitions
  );
  const daily = dailyTrends(sessions);
  const geoInsights = geoBehavioralInsights(sessions);
  const priceRangeData = buildPriceRangeData(
    sessions,
    itemMeta,
    transitionInfo.allTransitions
  );
  const catInteractions = categoryInteractions(sessions, itemMeta);

  return {
    sessions: sessions.map((session) => ({
      sessionId: session.sessionId,
      visitorId: session.visitorId,
      country: session.country,
      ts: session.ts.toISOString(),
      nView: session.nView,
      nCartAdd: session.nCartAdd,
      nCartRemove: session.nCartRemove,
    })),
    leak,
    recos,
    frequentBundles: bundles,
    priceMarkov: markov.model,
    priceMarkovMeta: {
      tLow: markov.tLow,
      tHigh: markov.tHigh,
      min: markov.min,
      max: markov.max,
    },
    priceBands,
    priceRangeData,
    categoryInteractions: catInteractions,
    transitions: {
      states: transitionInfo.states,
      counts: transitionInfo.counts,
      probs: transitionInfo.probs,
    },
    sankey: transitionInfo.sankey,
    daily,
    geoInsights,
    itemMeta,
    __version: VERSION,
  };
}

export async function computeAnalyticsFromMongo(
  db: Db
): Promise<AnalyticsResponse> {
  const LISTINGS_COLLECTION = "listings";
  const TRACKING_COLLECTION = "customervisits";
  const PRODUCT_CATEGORIES_COLLECTION = "productcategories";

  const [listings, tracking, categories] = await Promise.all([
    db.collection(LISTINGS_COLLECTION).find({}).limit(5000).toArray(),
    db.collection(TRACKING_COLLECTION).find({}).limit(20000).toArray(),
    db
      .collection(PRODUCT_CATEGORIES_COLLECTION)
      .find({})
      .limit(10000)
      .toArray(),
  ]);

  return computeAnalyticsFromDocs(
    tracking as RawDoc[],
    listings as RawDoc[],
    categories as RawDoc[]
  );
}

export type { ItemMeta };

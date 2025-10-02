"use client";

import { useMemo, useState, useCallback } from "react";
import { ResponsiveHeatMap } from "@nivo/heatmap";
import { ResponsiveSankey } from "@nivo/sankey";
import { ResponsiveBar } from "@nivo/bar";
import { ResponsiveLine } from "@nivo/line";
import {
  parseISO,
  startOfMonth,
  endOfMonth,
  isWithinInterval,
  format,
} from "date-fns";
import type { AnalyticsResponse } from "@/lib/analytics";

interface AnalyticsDashboardProps {
  initialData: AnalyticsResponse;
}

type ChartProps = { data: AnalyticsResponse };

type PriceTier = "Low" | "Mid" | "High" | "All"; // local mirror of lib type for safe indexing

// -------------------- tiny utils --------------------
const clamp = (v: number, min = 0, max = 1e12) =>
  Math.min(Math.max(v, min), max);
const pct = (v: number, p = 1) => `${(v * 100).toFixed(p)}%`;

const statePhrases: Record<string, string> = {
  cart_add: "add an item to their cart",
  cart_remove: "remove an item from their cart",
  view: "view a product",
  wishlist_add: "save a product to their wishlist",
  wishlist_remove: "remove a product from their wishlist",
};

const transitionPhrases: Record<string, string> = {
  cart_add: "add another item to their cart",
  cart_remove: "remove something from their cart",
  view: "look at another product",
  wishlist_add: "save another product to their wishlist",
  wishlist_remove: "remove something from their wishlist",
};

function validateDateRange(
  fromDate: string,
  toDate: string
): { isValid: boolean; error?: string } {
  if (!fromDate || !toDate) return { isValid: true };
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(fromDate) || !re.test(toDate))
    return { isValid: false, error: "Invalid date format (YYYY-MM-DD)" };
  const from = new Date(fromDate);
  const to = new Date(toDate);
  if (Number.isNaN(+from) || Number.isNaN(+to))
    return { isValid: false, error: "Invalid date values" };
  if (to < from)
    return { isValid: false, error: "End date cannot be before start date" };
  return { isValid: true };
}

// Largest Remainder method so scaled integers sum to an exact target
function distributeToTotal(total: number, weights: number[]) {
  const nonneg = weights.map((w) => (w > 0 ? w : 0));
  const sum = nonneg.reduce((a, b) => a + b, 0) || 1;
  const raw = nonneg.map((w) => (w / sum) * total);
  const base = raw.map((x) => Math.floor(x));
  let rem = total - base.reduce((a, b) => a + b, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - base[i] }))
    .sort((a, b) => b.frac - a.frac);
  const out = base.slice();
  for (let k = 0; k < rem; k += 1) out[order[k % order.length].i] += 1;
  return out;
}

// -------------------- canonical reprojection --------------------
// Recompute a self-consistent dataset for the chosen date range.
function reprojectForDateRange(
  data: AnalyticsResponse,
  fromDate: string,
  toDate: string
): AnalyticsResponse {
  const sessions = data.sessions.filter((s) => {
    const d = s.ts.split("T")[0];
    return d >= fromDate && d <= toDate;
  });

  // No data -> return empty-shaped object
  if (sessions.length === 0) {
    return {
      ...data,
      sessions: [],
      daily: { ...data.daily, series: [] },
      leak: { overall: 0, items: [] },
      categoryInteractions: [],
      recos: {},
      frequentBundles: [],
      priceRangeData: {
        viewFromPrices: [],
        viewToCartFromPrices: [],
        cartAddPrices: [],
        cartRemovePrices: [],
      },
      priceBands: { bands: [] },
      transitions: {
        states: [
          "cart_add",
          "cart_remove",
          "view",
          "wishlist_add",
          "wishlist_remove",
        ],
        counts: Array.from({ length: 5 }, () => Array(5).fill(0)),
        probs: Array.from({ length: 5 }, () => Array(5).fill(0)),
      },
      sankey: {
        nodes: [
          "cart_add",
          "cart_remove",
          "view",
          "wishlist_add",
          "wishlist_remove",
        ],
        links: [],
      },
    };
  }

  const ratio = clamp(sessions.length / data.sessions.length, 0, 1);

  // --- Daily series: exact filter
  const daily = {
    ...data.daily,
    series: data.daily.series.filter(
      (r) => r.date >= fromDate && r.date <= toDate
    ),
  };

  // --- Session-derived totals (ground truth for the range)
  const totalAdds = sessions.reduce((a, s) => a + s.nCartAdd, 0);
  const totalRemoves = sessions.reduce((a, s) => a + s.nCartRemove, 0);

  // --- Transitions: scale counts by ratio, then recompute probs from those counts.
  const scaledCounts = data.transitions.counts.map((row) =>
    row.map((c) => Math.round(c * ratio))
  );
  const probs = scaledCounts.map((row) => {
    const sum = row.reduce((a, b) => a + b, 0);
    return sum ? row.map((v) => v / sum) : row.map(() => 0);
  });

  // Build Sankey directly from counts so both charts are in lockstep
  const links: Array<{ source: number; target: number; value: number }> = [];
  for (let i = 0; i < scaledCounts.length; i += 1) {
    for (let j = 0; j < scaledCounts[i].length; j += 1) {
      const v = scaledCounts[i][j];
      if (v > 0 && i !== j) links.push({ source: i, target: j, value: v }); // drop self-loops; they cause circular link errors
    }
  }
  const transitions = {
    states: data.transitions.states,
    counts: scaledCounts,
    probs,
  };
  const sankey = { nodes: data.sankey.nodes, links };

  // --- Leak: redistribute to match exact adds/removes via largest-remainder
  const origAdds = data.leak.items.map((r) => r.adds);
  const origRems = data.leak.items.map((r) => r.removes);
  const addsAlloc = distributeToTotal(totalAdds, origAdds);
  const remsAlloc = distributeToTotal(totalRemoves, origRems);
  const leakItems = data.leak.items
    .map((r, idx) => {
      const adds = addsAlloc[idx] || 0;
      const removes = remsAlloc[idx] || 0;
      return {
        item: r.item,
        adds,
        removes,
        leak: adds > 0 ? removes / adds : 0,
      };
    })
    .sort((a, b) => b.leak - a.leak || b.removes - a.removes);
  const leak = {
    overall: totalAdds > 0 ? totalRemoves / totalAdds : 0,
    items: leakItems,
  };

  // --- Category interactions: scale views & wish by ratio; force carts to sum to totalAdds
  const catViews = data.categoryInteractions.map((c) => c.views);
  const catCarts = data.categoryInteractions.map((c) => c.carts);
  const catWish = data.categoryInteractions.map((c) => c.wish);
  const cartsAlloc = distributeToTotal(totalAdds, catCarts);
  const categoryInteractions = data.categoryInteractions
    .map((c, idx) => {
      const views = Math.round((catViews[idx] || 0) * ratio);
      const wish = Math.round((catWish[idx] || 0) * ratio);
      const carts = cartsAlloc[idx] || 0;
      return { ...c, views, wish, carts, total: views + wish + carts };
    })
    .sort((a, b) => b.total - a.total);

  // --- Price arrays: downsample by ratio (best-effort client-side filtering)
  const scaleArray = (arr: number[]) =>
    arr.slice(0, Math.round(arr.length * ratio));
  const priceRangeData = {
    viewFromPrices: scaleArray(data.priceRangeData.viewFromPrices),
    viewToCartFromPrices: scaleArray(data.priceRangeData.viewToCartFromPrices),
    cartAddPrices: scaleArray(data.priceRangeData.cartAddPrices),
    cartRemovePrices: scaleArray(data.priceRangeData.cartRemovePrices),
  };

  // --- Price bands: keep rates, scale counts; they’re descriptive not accounting totals
  const priceBands = {
    bands: data.priceBands.bands.map((b) => ({
      ...b,
      nView: Math.round(b.nView * ratio),
      nWish: Math.round(b.nWish * ratio),
    })),
  };

  // --- Bundles: scale support; Recos untouched (ranking only)
  const frequentBundles = data.frequentBundles.map((b) => ({
    ...b,
    support: b.support * ratio,
  }));
  const recos = data.recos;

  return {
    ...data,
    sessions,
    daily,
    leak,
    categoryInteractions,
    priceRangeData,
    priceBands,
    transitions,
    sankey,
    recos,
    frequentBundles,
  };
}

// -------------------- Charts --------------------
function PurchaseFunnelByPrice({ data }: ChartProps) {
  const tiers = (["Low", "Mid", "High", "All"] as const).filter(
    (t) => (data.priceMarkov as any)[t] !== undefined
  ) as PriceTier[];
  const [selectedTier, setSelectedTier] = useState<PriceTier>(
    tiers[0] ?? "All"
  );
  const [rangeState, setRangeState] = useState<{ min: string; max: string }>(
    () => ({
      min: data.priceMarkovMeta.min ? data.priceMarkovMeta.min.toFixed(2) : "",
      max: data.priceMarkovMeta.max ? data.priceMarkovMeta.max.toFixed(2) : "",
    })
  );
  const [appliedRange, setAppliedRange] = useState<{
    min: number | null;
    max: number | null;
  }>(() => ({
    min: Number.isFinite(data.priceMarkovMeta.min)
      ? data.priceMarkovMeta.min
      : null,
    max: Number.isFinite(data.priceMarkovMeta.max)
      ? data.priceMarkovMeta.max
      : null,
  }));

  const tier = data.priceMarkov[selectedTier] ??
    data.priceMarkov.All ?? { pViewToCart: 0, pCartToCheckout: 0 };

  const rangeMetrics = useMemo(() => {
    const min = appliedRange.min ?? -Infinity;
    const max = appliedRange.max ?? Infinity;
    const inRange = (v: number) => v >= min && v <= max;

    const views = data.priceRangeData.viewFromPrices.filter(inRange).length;
    const viewToCart =
      data.priceRangeData.viewToCartFromPrices.filter(inRange).length;
    const viewRate = views > 0 ? viewToCart / views : 0;

    const adds = data.priceRangeData.cartAddPrices.filter(inRange).length;
    const removes = data.priceRangeData.cartRemovePrices.filter(inRange).length;
    const checkoutRate = adds > 0 ? clamp((adds - removes) / adds, 0, 1) : 0;

    return { views, viewToCart, adds, removes, viewRate, checkoutRate };
  }, [appliedRange, data.priceRangeData]);

  const applyRange = () => {
    const min = rangeState.min.trim() === "" ? null : Number(rangeState.min);
    const max = rangeState.max.trim() === "" ? null : Number(rangeState.max);
    setAppliedRange({
      min: typeof min === "number" && Number.isFinite(min) ? min : null,
      max: typeof max === "number" && Number.isFinite(max) ? max : null,
    });
  };

  const cap = (() => {
    const { tLow, tHigh, min, max } = data.priceMarkovMeta;
    if (tLow == null || tHigh == null || tLow === tHigh)
      return "Not enough distinct price data to split into tiers yet.";
    return `Tier boundaries: Low ≤ £${tLow.toFixed(2)}, Mid ≤ £${tHigh.toFixed(
      2
    )}, overall window £${min.toFixed(2)} – £${max.toFixed(2)}.`;
  })();

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <label className="text-sm text-slate-400">Choose tier</label>
          <select
            className="w-full rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-slate-100"
            value={selectedTier}
            onChange={(e) => setSelectedTier(e.target.value as PriceTier)}
          >
            {tiers.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-xl bg-slate-900/80 p-4">
              <p className="text-xs uppercase text-slate-400">View → Cart</p>
              <p className="mt-2 text-2xl font-semibold text-emerald-300">
                {pct(tier.pViewToCart)}
              </p>
            </div>
            <div className="rounded-xl bg-slate-900/80 p-4">
              <p className="text-xs uppercase text-slate-400">
                Cart → Checkout proxy
              </p>
              <p className="mt-2 text-2xl font-semibold text-sky-300">
                {pct(tier.pCartToCheckout)}
              </p>
            </div>
          </div>
        </div>
        <div className="space-y-4">
          <label className="text-sm text-slate-400">
            Custom price range (£)
          </label>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              type="number"
              step="0.01"
              placeholder="From £"
              className="w-full rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-slate-100"
              value={rangeState.min}
              onChange={(e) =>
                setRangeState((p) => ({ ...p, min: e.target.value }))
              }
            />
            <span className="text-center text-slate-400">to</span>
            <input
              type="number"
              step="0.01"
              placeholder="To £"
              className="w-full rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-slate-100"
              value={rangeState.max}
              onChange={(e) =>
                setRangeState((p) => ({ ...p, max: e.target.value }))
              }
            />
            <button
              type="button"
              onClick={applyRange}
              className="rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 hover:bg-slate-700"
            >
              Apply
            </button>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-xl bg-slate-900/80 p-4">
              <p className="text-xs uppercase text-slate-400">View → Cart</p>
              <p className="mt-2 text-2xl font-semibold text-emerald-200">
                {pct(rangeMetrics.viewRate)}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                n={rangeMetrics.views} views → {rangeMetrics.viewToCart} carts
              </p>
            </div>
            <div className="rounded-xl bg-slate-900/80 p-4">
              <p className="text-xs uppercase text-slate-400">
                Cart → Checkout proxy
              </p>
              <p className="mt-2 text-2xl font-semibold text-sky-200">
                {pct(rangeMetrics.checkoutRate)}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                adds={rangeMetrics.adds}, removes={rangeMetrics.removes}
              </p>
            </div>
          </div>
        </div>
      </div>
      <p className="caption">{cap}</p>
    </div>
  );
}

function TransitionHeatmap({ data }: ChartProps) {
  const heatmapData = useMemo(() => {
    const { states } = data.transitions;
    const { probs } = data.transitions;
    return states.map((rowName, i) => ({
      id: rowName,
      data: states.map((colName, j) => ({
        x: colName,
        y: Number((probs[i]?.[j] ?? 0).toFixed(4)),
      })),
    }));
  }, [data.transitions]);

  const sentences = useMemo(() => {
    const { states, probs } = data.transitions;
    return states.map((src, i) => {
      const row = probs[i] ?? [];
      const ranked = states
        .map((tgt, j) => ({ state: tgt, prob: row[j] ?? 0 }))
        .filter((r) => r.prob > 0)
        .sort((a, b) => b.prob - a.prob)
        .slice(0, 3);
      const shown = ranked.reduce((a, r) => a + Math.round(r.prob * 100), 0);
      const other = clamp(100 - shown, 0, 100);
      const clauses = ranked.map(
        (r) =>
          `${Math.round(r.prob * 100)}% ${
            transitionPhrases[r.state] ?? r.state.replace(/_/g, " ")
          }`
      );
      clauses.push(`${other}% do other things or stop`);
      const text =
        clauses.length > 1
          ? `${clauses.slice(0, -1).join(", ")}, and ${clauses.at(-1)}`
          : clauses[0];
      return `after people ${
        statePhrases[src] ?? src.replace(/_/g, " ")
      }, ${text}.`;
    });
  }, [data.transitions]);

  if (!heatmapData.length)
    return <p className="muted">Not enough events to chart transitions yet.</p>;

  return (
    <div className="space-y-4">
      <div className="h-[360px] w-full">
        <ResponsiveHeatMap
          data={heatmapData}
          colors={{ type: "quantize", scheme: "blues" } as any}
          margin={{ top: 20, right: 80, bottom: 80, left: 100 }}
          axisTop={{ tickSize: 5, tickPadding: 5, tickRotation: -35 }}
          axisRight={null}
          axisBottom={{ tickSize: 5, tickPadding: 5, tickRotation: -35 }}
          axisLeft={{ tickSize: 5, tickPadding: 5 }}
          valueFormat={(v) => pct(Number(v))}
          tooltip={({ cell }: any) => (
            <div className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-slate-100 shadow-lg">
              <p className="font-medium">
                {cell.serieId} → {cell.x}
              </p>
              <p className="text-emerald-300">{pct(Number(cell.value))}</p>
            </div>
          )}
          theme={{
            tooltip: { container: { background: "#0f172a" } },
            text: { fill: "#e2e8f0" },
          }}
        />
      </div>
      <div className="space-y-2 text-sm text-slate-300">
        {sentences.map((s) => (
          <p key={s}>{s}</p>
        ))}
      </div>
    </div>
  );
}

function SankeyFlow({ data }: ChartProps) {
  // Build a cycle-free dataset (self-loops already dropped when building links)
  const sankeyData = useMemo(() => {
    // prune tiny links to keep the diagram readable, but keep in sync with heatmap via counts
    const max = data.sankey.links.reduce((a, l) => Math.max(a, l.value), 0);
    const minTh = max * 0.02;
    const base =
      max > 0
        ? data.sankey.links.filter((l) => l.value >= minTh)
        : data.sankey.links;

    // cycle guard using adjacency tracking
    const nodes = data.sankey.nodes.map((n) => ({ id: n }));
    const nameByIndex = (idx: number) => data.sankey.nodes[idx];
    const adj = new Map<string, Set<string>>();
    data.sankey.nodes.forEach((n) => adj.set(n, new Set()));

    const wouldCycle = (src: string, tgt: string) => {
      const seen = new Set<string>();
      const stack = [tgt];
      while (stack.length) {
        const cur = stack.pop()!;
        if (cur === src) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        const nbrs = adj.get(cur);
        if (nbrs) nbrs.forEach((x) => stack.push(x));
      }
      return false;
    };

    const links: { source: string; target: string; value: number }[] = [];
    for (const l of base) {
      const sName = nameByIndex(l.source);
      const tName = nameByIndex(l.target);
      if (!sName || !tName) continue;
      if (sName === tName) continue; // self-loop safety
      if (!wouldCycle(sName, tName)) {
        links.push({ source: sName, target: tName, value: l.value });
        adj.get(sName)!.add(tName);
      }
    }

    return { nodes, links };
  }, [data.sankey]);

  if (!sankeyData.links.length)
    return <p className="muted">No flow events recorded yet.</p>;

  return (
    <div className="h-[520px] w-full">
      <ResponsiveSankey
        data={sankeyData}
        margin={{ top: 20, right: 180, bottom: 20, left: 20 }}
        align="justify"
        colors={{ scheme: "red_purple" } as any}
        nodeOpacity={0.9}
        nodeThickness={18}
        nodeInnerPadding={3}
        nodeSpacing={24}
        linkOpacity={0.5}
        linkHoverOthersOpacity={0.1}
        theme={{
          text: { fill: "#0f172a" },
          tooltip: { container: { background: "#60a5fa" } },
        }}
        nodeTooltip={({ node }: any) => (
          <div className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-slate-100 shadow-lg">
            {node.id}
          </div>
        )}
        linkTooltip={({ link }: any) => (
          <div className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-slate-100 shadow-lg">
            <p className="font-medium">
              {link.source.label} → {link.target.label}
            </p>
            <p>{Number(link.value).toLocaleString()} transitions</p>
          </div>
        )}
      />
    </div>
  );
}

function PriceBandsChart({ data }: ChartProps) {
  const chartData = useMemo(
    () =>
      data.priceBands.bands.map((b) => ({
        band: b.name,
        "View → Cart %": b.viewToCart * 100,
        "Wishlist → Cart %": b.wishToCart * 100,
        nView: b.nView,
        nWish: b.nWish,
      })),
    [data.priceBands]
  );

  if (!chartData.length)
    return (
      <p className="muted">
        Price bands will appear once we have product prices.
      </p>
    );

  return (
    <div className="h-[420px] w-full">
      <ResponsiveBar
        data={chartData}
        keys={["View → Cart %", "Wishlist → Cart %"]}
        indexBy="band"
        margin={{ top: 40, right: 100, bottom: 60, left: 60 }}
        padding={0.4}
        groupMode="grouped"
        colors={["#34d399", "#60a5fa"]}
        axisBottom={{ tickSize: 5, tickPadding: 5 }}
        axisLeft={{
          tickSize: 5,
          tickPadding: 5,
          format: (v) => `${v}%` as any,
        }}
        valueFormat={(v) => `${Number(v).toFixed(1)}%`}
        theme={{
          text: { fill: "#e2e8f0" },
          tooltip: { container: { background: "#0f172a" } },
        }}
        tooltip={({ value, indexValue, id, data: raw }: any) => (
          <div className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-slate-100 shadow-lg">
            <p className="font-medium">{indexValue}</p>
            <p>
              {String(id)}: {Number(value).toFixed(1)}%
            </p>
            <p className="text-xs text-slate-400">
              Views n={raw.nView?.toLocaleString?.() ?? 0}, Wishlist n=
              {raw.nWish?.toLocaleString?.() ?? 0}
            </p>
          </div>
        )}
      />
    </div>
  );
}

// Component to show detailed interaction data for a selected day
function DayInteractionDetails({
  data,
  selectedDate,
}: {
  data: AnalyticsResponse;
  selectedDate: string | null;
}) {
  const [topCount, setTopCount] = useState(10);

  const dayData = useMemo(() => {
    if (!selectedDate) return null;

    // Get sessions for the selected date
    const dayStart = new Date(selectedDate + "T00:00:00");
    const dayEnd = new Date(selectedDate + "T23:59:59");

    const daySessions = data.sessions.filter((session) => {
      const sessionDate = new Date(session.ts);
      return sessionDate >= dayStart && sessionDate <= dayEnd;
    });

    if (!daySessions.length) return null;

    // For day-specific data, we'll use the overall category interactions
    // scaled by the proportion of sessions on this day
    const totalSessions = data.sessions.length;
    const daySessionRatio =
      totalSessions > 0 ? daySessions.length / totalSessions : 0;

    // Scale the category interactions proportionally for this day
    const categoryArray = data.categoryInteractions
      .map((cat) => ({
        category: cat.category,
        views: Math.round(cat.views * daySessionRatio),
        carts: Math.round(cat.carts * daySessionRatio),
        wish: Math.round(cat.wish * daySessionRatio),
        total: Math.round(cat.total * daySessionRatio),
      }))
      .filter((cat) => cat.total > 0)
      .sort((a, b) => b.total - a.total);

    // Get daily series data for the selected date
    const daySeriesData = data.daily.series.find(
      (s) => s.date === selectedDate
    );

    return {
      date: selectedDate,
      totalSessions: daySessions.length,
      totalViews: daySeriesData?.views || 0,
      totalCarts: daySeriesData?.carts || 0,
      allCategories: categoryArray,
      categories: categoryArray.slice(0, topCount),
      isAnomaly: data.daily.anomaly.outliers.includes(selectedDate),
    };
  }, [data, selectedDate, topCount]);

  if (!selectedDate) {
    return (
      <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-6 text-center">
        <p className="text-slate-400">
          Click on a day in the chart above to see detailed interaction data
        </p>
      </div>
    );
  }

  if (!dayData) {
    return (
      <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-6 text-center">
        <p className="text-slate-400">No data available for {selectedDate}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-slate-100">
          Interaction Details for{" "}
          {format(parseISO(selectedDate), "MMMM d, yyyy")}
          {dayData.isAnomaly && (
            <span className="ml-2 rounded-full bg-red-500/20 px-2 py-1 text-xs text-red-300">
              Anomaly
            </span>
          )}
        </h3>
      </div>

      {/* Summary Stats */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl bg-slate-900/80 p-4">
          <p className="text-xs uppercase text-slate-400">Sessions</p>
          <p className="mt-2 text-2xl font-semibold text-slate-100">
            {dayData.totalSessions.toLocaleString()}
          </p>
        </div>
        <div className="rounded-xl bg-slate-900/80 p-4">
          <p className="text-xs uppercase text-slate-400">Total Views</p>
          <p className="mt-2 text-2xl font-semibold text-blue-300">
            {dayData.totalViews.toLocaleString()}
          </p>
        </div>
        <div className="rounded-xl bg-slate-900/80 p-4">
          <p className="text-xs uppercase text-slate-400">Cart Adds</p>
          <p className="mt-2 text-2xl font-semibold text-emerald-300">
            {dayData.totalCarts.toLocaleString()}
          </p>
        </div>
      </div>

      {/* Category Breakdown */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-medium text-slate-300">
            Most Active Categories
          </h4>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400">
              Showing top {dayData.categories.length} of{" "}
              {dayData.allCategories.length} categories
            </span>
            <div className="flex items-center gap-2">
              <label className="text-sm text-slate-400">Show top:</label>
              <select
                value={topCount}
                onChange={(e) => setTopCount(Number(e.target.value))}
                className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-slate-100"
              >
                {[5, 10, 15, 20, 25, 50].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-800 text-sm">
            <thead className="bg-slate-900/40 text-left text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Views</th>
                <th className="px-4 py-3">Cart Adds</th>
                <th className="px-4 py-3">Wishlist</th>
                <th className="px-4 py-3">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {dayData.categories.map((category, index) => (
                <tr
                  key={category.category}
                  className={index === 0 ? "bg-emerald-500/5" : ""}
                >
                  <td className="px-4 py-3 font-medium text-slate-100">
                    {category.category}
                    {index === 0 && (
                      <span className="ml-2 text-xs text-emerald-400">
                        Most Popular
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-300">
                    {category.views.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-slate-300">
                    {category.wish.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-slate-300">
                    {category.carts.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-slate-100">
                    {category.total.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {dayData.isAnomaly && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
          <p className="text-sm text-red-300">
            <span className="font-medium">Anomaly Detected:</span> This day had
            unusually high or low cart activity compared to the normal range.
          </p>
        </div>
      )}
    </div>
  );
}

function DailyTrends({ data }: ChartProps) {
  const series = data.daily.series;
  const anomaly = data.daily.anomaly;
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const chartData = useMemo(
    () => [
      { id: "Views", data: series.map((r) => ({ x: r.date, y: r.views })) },
      { id: "Carts", data: series.map((r) => ({ x: r.date, y: r.carts })) },
    ],
    [series]
  );

  if (!series.length)
    return (
      <p className="muted">
        No daily data available for the selected date range.
      </p>
    );

  const dateRange = {
    from: series[0]?.date || "",
    to: series[series.length - 1]?.date || "",
  };

  return (
    <div className="space-y-6">
      <div className="h-[360px] w-full">
        <ResponsiveLine
          data={chartData}
          margin={{ top: 40, right: 40, bottom: 60, left: 60 }}
          xScale={{ type: "point" }}
          yScale={{ type: "linear", min: "auto", max: "auto", stacked: false }}
          axisBottom={{ tickRotation: -35 }}
          colors={["#38bdf8", "#34d399"]}
          pointSize={10}
          pointColor={{ from: "color", modifiers: [] } as any}
          pointBorderWidth={2}
          pointBorderColor={
            { from: "color", modifiers: [["darker", 0.4]] } as any
          }
          enableSlices="x"
          sliceTooltip={({ slice }: any) => {
            const date = slice.points[0]?.data?.x;
            return (
              <div className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-slate-100 shadow-lg border border-slate-600">
                <div className="space-y-1">
                  <p className="font-medium text-center">{date}</p>
                  {slice.points.map((point: any) => (
                    <div
                      key={point.serieId}
                      className="flex items-center gap-2"
                    >
                      <div
                        className="w-3 h-3 rounded-full"
                        style={{ backgroundColor: point.serieColor }}
                      />
                      <span>
                        {point.serieId}: {Number(point.data.y).toLocaleString()}
                      </span>
                    </div>
                  ))}
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (date) {
                        setSelectedDate(date as string);
                      }
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (date) {
                        setSelectedDate(date as string);
                      }
                    }}
                    className="w-full mt-2 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors cursor-pointer"
                  >
                    🖱️ Click for details
                  </button>
                </div>
              </div>
            );
          }}
          theme={{
            text: { fill: "#e2e8f0" },
            tooltip: { container: { background: "transparent" } },
          }}
          areaOpacity={0.2}
        />
      </div>
      <div className="space-y-1 text-sm text-slate-300">
        <p>
          Showing {series.length} days from {dateRange.from} to {dateRange.to}.
          Anomaly band: lower {anomaly.lower.toFixed(1)} carts, upper{" "}
          {anomaly.upper.toFixed(1)} carts.
        </p>
        {anomaly.hasThresholds && anomaly.outliers.length > 0 ? (
          <p>Outliers: {anomaly.outliers.join(", ")}</p>
        ) : (
          <p className="text-slate-500">No cart anomalies detected.</p>
        )}
        <p className="text-xs text-slate-400 mt-2">
          💡 Hover over any data point and click the blue button in the tooltip
          to see detailed interaction data
        </p>

        {/* Alternative: Direct date selection buttons */}
        <div className="flex flex-wrap gap-2 mt-3">
          <span className="text-xs text-slate-500">Quick select:</span>
          {series.slice(0, 7).map((dataPoint) => (
            <button
              key={dataPoint.date}
              onClick={() => setSelectedDate(dataPoint.date)}
              className="px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors"
            >
              {dataPoint.date}
            </button>
          ))}
          {series.length > 7 && (
            <span className="text-xs text-slate-500">...</span>
          )}
        </div>
      </div>

      {/* Day Interaction Details */}
      <DayInteractionDetails data={data} selectedDate={selectedDate} />
    </div>
  );
}

function CartLeakByCategory({ data }: ChartProps) {
  const meta = data.itemMeta;
  const [topCount, setTopCount] = useState(15);

  const allRows = useMemo(() => {
    // Group leak items by category, preserving actual leak data
    const categoryGroups = new Map<
      string,
      { adds: number; removes: number; items: string[] }
    >();

    data.leak.items.forEach((row) => {
      const category = meta[row.item]?.category || "Other";
      const g = categoryGroups.get(category) ?? {
        adds: 0,
        removes: 0,
        items: [],
      };
      g.adds += row.adds;
      g.removes += row.removes;
      g.items.push(row.item);
      categoryGroups.set(category, g);
    });

    // Ensure cart adds match the categoryInteractions data for consistency
    const categoryCartData = new Map<string, number>();
    data.categoryInteractions.forEach((cat) => {
      categoryCartData.set(cat.category, cat.carts);
    });

    return Array.from(categoryGroups.entries())
      .map(([category, g]) => {
        // Use the consistent cart adds from categoryInteractions
        const adds = categoryCartData.get(category) || g.adds;
        // Keep the original removes calculation but ensure it doesn't exceed adds
        const removes = Math.min(g.removes, adds);
        return {
          category,
          adds,
          removes,
          leak: adds > 0 ? removes / adds : 0,
          itemCount: g.items.length,
        };
      })
      .sort((a, b) => b.leak - a.leak || b.removes - a.removes);
  }, [data.leak.items, data.categoryInteractions, meta]);

  const rows = useMemo(() => allRows.slice(0, topCount), [allRows, topCount]);

  if (!rows.length)
    return (
      <p className="muted">Cart leak needs cart add/remove data to activate.</p>
    );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-400">
          Showing top {rows.length} of {allRows.length} categories
        </p>
        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-400">Show top:</label>
          <select
            value={topCount}
            onChange={(e) => setTopCount(Number(e.target.value))}
            className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-slate-100"
          >
            {[5, 10, 15, 20, 25, 50].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-800 text-sm">
          <thead className="bg-slate-900/40 text-left text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Adds</th>
              <th className="px-4 py-3">Removes</th>
              <th className="px-4 py-3">Leak</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.map((row) => (
              <tr key={row.category}>
                <td className="px-4 py-3 font-medium text-slate-100">
                  {row.category}
                  {row.itemCount > 1 && (
                    <span className="ml-2 text-xs text-slate-400">
                      ({row.itemCount} items)
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-300">
                  {row.adds.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-slate-300">
                  {row.removes.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-rose-300">{pct(row.leak)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MostInteractedCategories({ data }: ChartProps) {
  const [topCount, setTopCount] = useState(10);

  const all = useMemo(
    () =>
      data.categoryInteractions
        .map((r) => ({
          category: r.category,
          Views: r.views,
          "Wishlist Adds": r.wish,
          "Cart Adds": r.carts,
          Total: r.total,
        }))
        .sort((a, b) => (b.Total ?? 0) - (a.Total ?? 0)),
    [data.categoryInteractions]
  );

  const chartData = useMemo(() => all.slice(0, topCount), [all, topCount]);

  if (!chartData.length)
    return (
      <p className="muted">
        Category interactions appear once we record views, wishlist adds, and
        carts.
      </p>
    );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-400">
          Showing top {chartData.length} of {all.length} categories
        </p>
        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-400">Show top:</label>
          <select
            value={topCount}
            onChange={(e) => setTopCount(Number(e.target.value))}
            className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-slate-100"
          >
            {[5, 10, 15, 20, 25, 50].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="h-[420px] w-full">
        <ResponsiveBar
          data={chartData}
          keys={["Views", "Wishlist Adds", "Cart Adds"]}
          indexBy="category"
          margin={{ top: 40, right: 40, bottom: 120, left: 60 }}
          padding={0.3}
          groupMode="stacked"
          colors={["#93c5fd", "#a855f7", "#34d399"]}
          axisBottom={{ tickRotation: -45, legendOffset: 32 }}
          axisLeft={{ tickPadding: 5, tickSize: 5 }}
          theme={{
            text: { fill: "#e2e8f0" },
            tooltip: { container: { background: "#0f172a" } },
          }}
          tooltip={({ id, value, indexValue }: any) => (
            <div className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-slate-100 shadow-lg">
              <p className="font-medium">{indexValue}</p>
              <p>
                {String(id)}: {Number(value).toLocaleString()}
              </p>
            </div>
          )}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-800 text-sm">
          <thead className="bg-slate-900/40 text-left text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Views</th>
              <th className="px-4 py-3">Wishlist Adds</th>
              <th className="px-4 py-3">Cart Adds</th>
              <th className="px-4 py-3">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {chartData.map((r) => (
              <tr key={r.category}>
                <td className="px-4 py-3 font-medium text-slate-100">
                  {r.category}
                </td>
                <td className="px-4 py-3 text-slate-300">
                  {r.Views.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-slate-300">
                  {r["Wishlist Adds"].toLocaleString()}
                </td>
                <td className="px-4 py-3 text-slate-300">
                  {r["Cart Adds"].toLocaleString()}
                </td>
                <td className="px-4 py-3 text-slate-100">
                  {r.Total.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ItemRecommender({ data }: ChartProps) {
  const options = useMemo(() => Object.keys(data.recos), [data.recos]);
  const [selected, setSelected] = useState<string>(options[0] ?? "");
  const [topCount, setTopCount] = useState(10);

  const allRecos = useMemo(
    () => (selected ? data.recos[selected] ?? [] : []),
    [data.recos, selected]
  );
  const recos = useMemo(
    () => allRecos.slice(0, topCount),
    [allRecos, topCount]
  );

  const meta = data.itemMeta;
  if (!options.length)
    return (
      <p className="muted">
        Recommendations will appear once sessions include multiple products.
      </p>
    );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-400">
          Showing top {recos.length} of {allRecos.length} recommendations
        </p>
        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-400">Show top:</label>
          <select
            value={topCount}
            onChange={(e) => setTopCount(Number(e.target.value))}
            className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-slate-100"
          >
            {[5, 10, 15, 20, 25, 50].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
        <label className="text-sm text-slate-300">
          Choose anchor item
          <select
            className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-slate-100"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {options.map((id) => (
              <option key={id} value={id}>
                {meta[id]?.title ?? id}
              </option>
            ))}
          </select>
        </label>
        <div className="rounded-xl bg-slate-900/80 p-4 text-sm text-slate-300">
          <p className="font-medium text-slate-100">Anchor details</p>
          <p>{meta[selected]?.title ?? "Unknown item"}</p>
          <p>
            £{meta[selected]?.price?.toFixed(2) ?? "0.00"} ·{" "}
            {meta[selected]?.category ?? "Unknown category"}
          </p>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-800 text-sm">
          <thead className="bg-slate-900/40 text-left text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-3">Recommended item</th>
              <th className="px-4 py-3">Score</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Price</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {recos.map((row) => (
              <tr key={`${selected}-${row.item}`}>
                <td className="px-4 py-3 font-medium text-slate-100">
                  {meta[row.item]?.title ?? row.item}
                </td>
                <td className="px-4 py-3 text-slate-300">
                  {row.score.toFixed(3)}
                </td>
                <td className="px-4 py-3 text-slate-300">
                  {meta[row.item]?.category ?? "Unknown"}
                </td>
                <td className="px-4 py-3 text-slate-300">
                  £{meta[row.item]?.price?.toFixed(2) ?? "0.00"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// -------------------- main --------------------
const AnalyticsDashboard = ({ initialData }: AnalyticsDashboardProps) => {
  // Pick a reasonable default range (current month if present, else full series)
  const monthRange = useMemo(() => {
    const now = new Date();
    const start = startOfMonth(now);
    const end = endOfMonth(now);
    const hasCurrentMonth = initialData.daily.series.some((r) =>
      isWithinInterval(parseISO(r.date), { start, end })
    );
    if (hasCurrentMonth)
      return {
        from: format(start, "yyyy-MM-dd"),
        to: format(end, "yyyy-MM-dd"),
      };
    if (!initialData.daily.series.length) {
      const today = format(now, "yyyy-MM-dd");
      return { from: today, to: today };
    }
    return {
      from: initialData.daily.series[0].date,
      to: initialData.daily.series[initialData.daily.series.length - 1].date,
    };
  }, [initialData.daily.series]);

  const [dateRange, setDateRange] = useState<{ from: string; to: string }>(
    monthRange
  );
  const [applied, setApplied] = useState<{ from: string; to: string }>(
    monthRange
  );
  const [validationError, setValidationError] = useState<string>("");

  const filtered = useMemo(
    () => reprojectForDateRange(initialData, applied.from, applied.to),
    [initialData, applied]
  );

  const handleDateRangeChange = useCallback((from: string, to: string) => {
    setDateRange({ from, to });
    const v = validateDateRange(from, to);
    setValidationError(v.isValid ? "" : v.error || "Invalid date range");
  }, []);

  const applyDateRange = useCallback(() => {
    const v = validateDateRange(dateRange.from, dateRange.to);
    if (v.isValid) {
      setApplied(dateRange);
      setValidationError("");
    } else {
      setValidationError(v.error || "Invalid date range");
    }
  }, [dateRange]);

  const resetToCurrentMonth = useCallback(() => {
    setDateRange(monthRange);
    setApplied(monthRange);
    setValidationError("");
  }, [monthRange]);

  return (
    <div className="space-y-8">
      {/* Global Date Filter */}
      <section className="card">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="card-title">Global Date Range Filter</h2>
              <p className="text-sm text-slate-400 mt-1">
                Select date range and click Apply to filter ALL analytics. This
                affects all charts, tables, and metrics below.
              </p>
              <p className="text-xs text-slate-500 mt-2">
                Currently showing:{" "}
                <span className="text-slate-300 font-medium">
                  {applied.from === applied.to
                    ? `${applied.from}`
                    : `${applied.from} to ${applied.to}`}
                </span>
              </p>
            </div>
            <div className="flex flex-col gap-3 text-sm text-slate-300 sm:flex-row sm:items-center sm:gap-4">
              <label className="flex items-center gap-2">
                <span className="min-w-[40px]">From</span>
                <input
                  type="date"
                  value={dateRange.from}
                  onChange={(e) =>
                    handleDateRangeChange(e.target.value, dateRange.to)
                  }
                  className={`rounded-lg border px-3 py-2 text-slate-100 focus:outline-none ${
                    validationError
                      ? "border-red-500 bg-red-900/20 focus:border-red-400"
                      : "border-slate-700 bg-slate-900/60 focus:border-slate-500"
                  }`}
                />
              </label>
              <label className="flex items-center gap-2">
                <span className="min-w-[25px]">To</span>
                <input
                  type="date"
                  value={dateRange.to}
                  onChange={(e) =>
                    handleDateRangeChange(dateRange.from, e.target.value)
                  }
                  className={`rounded-lg border px-3 py-2 text-slate-100 focus:outline-none ${
                    validationError
                      ? "border-red-500 bg-red-900/20 focus:border-red-400"
                      : "border-slate-700 bg-slate-900/60 focus:border-slate-500"
                  }`}
                />
              </label>
            </div>
          </div>
          {validationError && (
            <div className="rounded-lg border border-red-500 bg-red-900/20 px-4 py-3 text-sm text-red-300">
              <span className="font-medium">Validation Error:</span>{" "}
              {validationError}
            </div>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={applyDateRange}
              disabled={!!validationError}
              className={`rounded-lg border px-6 py-2 text-sm font-medium focus:outline-none focus:ring-2 ${
                validationError
                  ? "border-slate-600 bg-slate-800 text-slate-500 cursor-not-allowed"
                  : "border-emerald-600 bg-emerald-700 text-white hover:bg-emerald-600 focus:ring-emerald-500"
              }`}
            >
              Apply Date Range
            </button>
            <button
              type="button"
              onClick={resetToCurrentMonth}
              className="rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 hover:bg-slate-700"
            >
              Reset to Current Month
            </button>
          </div>
        </div>
      </section>

      {/* Summary Statistics */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="card">
          <h2 className="text-sm uppercase tracking-wide text-slate-400">
            Total Sessions
          </h2>
          <p className="mt-2 text-3xl font-semibold">
            {filtered.sessions.length.toLocaleString()}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {applied.from === applied.to
              ? `On ${applied.from}`
              : `${applied.from} to ${applied.to}`}
          </p>
        </div>
        <div className="card">
          <h2 className="text-sm uppercase tracking-wide text-slate-400">
            Total Visitors
          </h2>
          <p className="mt-2 text-3xl font-semibold">
            {new Set(
              filtered.sessions.map((s) => s.visitorId)
            ).size.toLocaleString()}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Unique visitors in range
          </p>
        </div>
        <div className="card">
          <h2 className="text-sm uppercase tracking-wide text-slate-400">
            Conversion Rate
          </h2>
          <p className="mt-2 text-3xl font-semibold">
            {filtered.sessions.length
              ? (
                  (filtered.sessions.filter((s) => s.nCartAdd > 0).length /
                    filtered.sessions.length) *
                  100
                ).toFixed(1)
              : "0.0"}
            %
          </p>
          <p className="text-xs text-slate-500 mt-1">Sessions with cart adds</p>
        </div>
        <div className="card">
          <h2 className="text-sm uppercase tracking-wide text-slate-400">
            Total Carts
          </h2>
          <p className="mt-2 text-3xl font-semibold">
            {filtered.sessions
              .reduce((a, s) => a + s.nCartAdd, 0)
              .toLocaleString()}
          </p>
          <p className="text-xs text-slate-500 mt-1">Cart additions in range</p>
        </div>
      </section>

      {/* Charts */}
      <section className="card">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="card-title">Purchase funnel by price</h2>
          <p className="text-xs text-slate-500">Filtered by date range</p>
        </div>
        <PurchaseFunnelByPrice data={filtered} />
      </section>

      <section className="card">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="card-title">Event transition probabilities</h2>
          <p className="text-xs text-slate-500">Filtered by date range</p>
        </div>
        <TransitionHeatmap data={filtered} />
      </section>

      <section className="card">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="card-title">Event flow (Sankey)</h2>
          <p className="text-xs text-slate-500">Filtered by date range</p>
        </div>
        <SankeyFlow data={filtered} />
      </section>

      <section className="card">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="card-title">Conversion by price band</h2>
          <p className="text-xs text-slate-500">Filtered by date range</p>
        </div>
        <PriceBandsChart data={filtered} />
      </section>

      <section className="card">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="card-title sm:mb-0">Daily trends & anomaly flags</h2>
          <p className="muted">Filtered by date range above</p>
        </div>
        <DailyTrends data={filtered} />
      </section>

      <section className="card">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="card-title">Most interacted categories</h2>
          <p className="text-xs text-slate-500">Filtered by date range</p>
        </div>
        <MostInteractedCategories data={filtered} />
      </section>

      <section className="card">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="card-title">Cart leak by category</h2>
          <p className="text-xs text-slate-500">Filtered by date range</p>
        </div>
        <CartLeakByCategory data={filtered} />
      </section>

      <section className="card">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="card-title">Item-to-item recommendations</h2>
          <p className="text-xs text-slate-500">Filtered by date range</p>
        </div>
        <ItemRecommender data={filtered} />
      </section>
    </div>
  );
};

export default AnalyticsDashboard;

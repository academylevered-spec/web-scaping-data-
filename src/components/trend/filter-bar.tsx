"use client";

import { useState, type ReactNode } from "react";
import { Search, ShoppingBag, SlidersHorizontal, X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { FOCUS_RING, pill } from "@/lib/ui";
import { DAY_WINDOW_OPTIONS } from "@/lib/trend-utils";

export interface FilterState {
  country: string;
  category: string;
  duration: string;
  views: string;
  traffic: string;
  sort: string;
  search: string;
  shopOnly: boolean;
}

interface Props {
  filters: FilterState;
  onChange: (f: FilterState) => void;
  onReset: () => void;
  categories: Array<{ name: string; count: number }>;
  /** Atribusi harian aktif: "all" | "day:2".."day:7" (v3). */
  dayValue: string;
  /** Ganti atribusi harian — mengubah window aktif. */
  onDayChange: (v: string) => void;
  /** Jumlah video per hari (badge select) — dari meta.perDay. */
  dayCounts?: Record<string, number>;
}

/* ── SINGLE SOURCE opsi filter (dipakai varian mobile & desktop — nol duplikasi) ── */
interface Option {
  value: string;
  label: string;
}
const SORT_OPTIONS: Option[] = [
  { value: "sales", label: "Terjual terbanyak" },
  { value: "gmv", label: "GMV tertinggi" },
  { value: "views", label: "Views terbanyak" },
  { value: "likes", label: "Suka terbanyak" },
  { value: "trending", label: "Paling trending" },
  { value: "newest", label: "Terbaru" },
];
const DURATION_OPTIONS: Option[] = [
  { value: "all", label: "Semua durasi" },
  { value: "short", label: "0–15 detik" },
  { value: "medium", label: "15–30 detik" },
  { value: "long", label: "30 detik+" },
];
const VIEWS_OPTIONS: Option[] = [
  { value: "all", label: "Semua views" },
  { value: "10k", label: "10K+" },
  { value: "50k", label: "50K+" },
  { value: "100k", label: "100K+" },
  { value: "500k", label: "500K+" },
  { value: "1m", label: "1M+" },
];
const TRAFFIC_OPTIONS: Option[] = [
  { value: "all", label: "Semua traffic" },
  { value: "organic", label: "Organik" },
  { value: "ads", label: "Iklan komersial" },
];

/* ── Token kelas (design system) ── */
const DESKTOP_TRIGGER =
  "h-11 w-[136px] rounded-full border-zinc-200 bg-white/80 text-ui font-medium text-zinc-700 shadow-none backdrop-blur focus:ring-2 focus:ring-zinc-300 dark:border-zinc-700 dark:bg-zinc-900/80 dark:text-zinc-200 dark:focus:ring-zinc-600 sm:w-auto";
const DRAWER_TRIGGER =
  "h-11 w-full justify-between rounded-full border-zinc-200 bg-white text-ui font-medium text-zinc-700 shadow-none focus:ring-2 focus:ring-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:focus:ring-zinc-600 [&>span]:min-w-0 [&>span]:truncate";
const CONTENT = "rounded-2xl border-zinc-200 dark:border-zinc-700";
const ITEM = "rounded-xl";

/** Bar filter adaptif perangkat:
 *  - Mobile (<sm): pencarian selalu tampak + tombol "Filter" (badge jumlah aktif)
 *    yang membuka bottom-sheet berisi semua filter — grid video tak terdorong.
 *  - Desktop (≥sm): satu baris pill horizontal. Kedua varian memakai SATU
 *    renderer Select yang sama — opsi tidak pernah bisa saling beda. */
export function FilterBar({ filters, onChange, onReset, categories, dayValue, onDayChange, dayCounts }: Props) {
  const set = (patch: Partial<FilterState>) => onChange({ ...filters, ...patch });
  const [filterOpen, setFilterOpen] = useState(false);

  const checks = {
    day: dayValue !== "all",
    sort: filters.sort !== "sales",
    category: filters.category !== "all",
    duration: filters.duration !== "all",
    views: filters.views !== "all",
    traffic: filters.traffic !== "all",
    country: filters.country !== "all",
    shopOnly: filters.shopOnly,
    search: filters.search !== "",
  } as const;
  const hasActive = Object.values(checks).some(Boolean);
  const activeCount = Object.values(checks).filter(Boolean).length;

  const categoryOptions: Option[] = [
    { value: "all", label: "Semua kategori" },
    ...categories.map((c) => ({ value: c.name, label: c.name })),
  ];
  const dayOptions: Option[] = [
    { value: "all", label: "Semua hari" },
    ...DAY_WINDOW_OPTIONS.map((opt) => {
      const c = dayCounts?.[opt.key] ?? 0;
      return {
        value: opt.key,
        label: `${opt.label}${c > 0 ? ` (${c > 999 ? `${Math.floor(c / 1000)}K+` : c})` : ""}`,
      };
    }),
  ];

  return (
    <div className="flex flex-col gap-3">
      {/* ── MOBILE: search + tombol filter (drawer) ── */}
      <div className="flex flex-col gap-2.5 sm:hidden" role="group" aria-label="Filter video trending">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden />
          <Input
            type="search"
            value={filters.search}
            onChange={(e) => set({ search: e.target.value })}
            placeholder="Cari video, produk, @akun…"
            aria-label="Cari video trending"
            className="h-11 rounded-full border-zinc-200 bg-white/80 pl-10 pr-4 text-base shadow-none backdrop-blur focus-visible:ring-2 focus-visible:ring-zinc-300 dark:border-zinc-700 dark:bg-zinc-900/80 dark:focus-visible:ring-zinc-600 sm:text-ui"
          />
          {filters.search !== "" && (
            <button
              type="button"
              onClick={() => set({ search: "" })}
              className={`absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline-none dark:hover:bg-zinc-800 dark:hover:text-zinc-200 ${FOCUS_RING}`}
              aria-label="Hapus kata kunci pencarian"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Drawer open={filterOpen} onOpenChange={setFilterOpen}>
            <DrawerTrigger asChild>
              <button
                type="button"
                aria-label={`Buka panel filter${activeCount > 0 ? `, ${activeCount} filter aktif` : ""}`}
                className={`flex h-11 flex-1 items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors focus-visible:outline-none ${FOCUS_RING} ${
                  activeCount > 0
                    ? "bg-emerald-600 text-white shadow-md shadow-emerald-600/20 hover:bg-emerald-700"
                    : "bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                }`}
              >
                <SlidersHorizontal className="h-4 w-4" aria-hidden />
                Filter
                {activeCount > 0 && (
                  <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-white/25 px-1.5 text-2xs font-semibold tabular-nums">
                    {activeCount}
                  </span>
                )}
              </button>
            </DrawerTrigger>
            <DrawerContent className="max-h-[88dvh] rounded-t-3xl">
              <DrawerHeader className="pb-1 pt-1 text-left">
                <DrawerTitle className="text-base font-semibold tracking-tight">Filter video</DrawerTitle>
                <DrawerDescription className="text-ui">
                  Saring hasil berdasarkan waktu, kategori, dan performa. Perubahan langsung diterapkan.
                </DrawerDescription>
              </DrawerHeader>

              <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pb-2">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Hari posting">
                    <FilterSelect
                      value={dayValue}
                      onValueChange={onDayChange}
                      triggerClassName={DRAWER_TRIGGER}
                      contentClassName={`${CONTENT} custom-scrollbar`}
                      ariaLabel="Filter hari posting"
                      placeholder="Hari posting"
                      options={dayOptions}
                    />
                  </Field>

                  <Field label="Urutkan">
                    <FilterSelect
                      value={filters.sort}
                      onValueChange={(v) => set({ sort: v })}
                      triggerClassName={DRAWER_TRIGGER}
                      contentClassName={CONTENT}
                      ariaLabel="Urutkan hasil"
                      placeholder="Urutkan"
                      options={SORT_OPTIONS}
                    />
                  </Field>

                  <Field label="Kategori" className="col-span-2">
                    <FilterSelect
                      value={filters.category}
                      onValueChange={(v) => set({ category: v })}
                      triggerClassName={DRAWER_TRIGGER}
                      contentClassName={`${CONTENT} custom-scrollbar`}
                      ariaLabel="Filter kategori"
                      placeholder="Kategori"
                      options={categoryOptions}
                    />
                  </Field>

                  <Field label="Durasi">
                    <FilterSelect
                      value={filters.duration}
                      onValueChange={(v) => set({ duration: v })}
                      triggerClassName={DRAWER_TRIGGER}
                      contentClassName={CONTENT}
                      ariaLabel="Filter durasi video"
                      placeholder="Durasi"
                      options={DURATION_OPTIONS}
                    />
                  </Field>

                  <Field label="Views minimum">
                    <FilterSelect
                      value={filters.views}
                      onValueChange={(v) => set({ views: v })}
                      triggerClassName={DRAWER_TRIGGER}
                      contentClassName={CONTENT}
                      ariaLabel="Filter views minimum"
                      placeholder="Views"
                      options={VIEWS_OPTIONS}
                    />
                  </Field>

                  <Field label="Traffic">
                    <FilterSelect
                      value={filters.traffic}
                      onValueChange={(v) => set({ traffic: v })}
                      triggerClassName={DRAWER_TRIGGER}
                      contentClassName={CONTENT}
                      ariaLabel="Filter jenis traffic"
                      placeholder="Traffic"
                      options={TRAFFIC_OPTIONS}
                    />
                  </Field>

                  <div className="flex h-11 items-center justify-between rounded-full bg-white px-4 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-700">
                    <span className="flex min-w-0 items-center gap-2 text-ui font-medium text-zinc-700 dark:text-zinc-200">
                      <ShoppingBag className={`h-4 w-4 shrink-0 ${filters.shopOnly ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-400"}`} aria-hidden />
                      <span className="truncate">Shop only</span>
                    </span>
                    <Switch
                      checked={filters.shopOnly}
                      onCheckedChange={(v) => set({ shopOnly: v })}
                      aria-label="Hanya video dengan produk TikTok Shop"
                      className="data-[state=checked]:bg-emerald-600"
                    />
                  </div>
                </div>
              </div>

              <DrawerFooter className="flex-row gap-2.5 border-t border-zinc-200/70 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] dark:border-zinc-800">
                <Button
                  variant="outline"
                  onClick={onReset}
                  className={`h-11 flex-1 rounded-full text-sm font-medium ${FOCUS_RING}`}
                  aria-label="Reset semua filter"
                >
                  Reset
                </Button>
                <Button
                  onClick={() => setFilterOpen(false)}
                  className={`${pill.base} flex-1 ${pill.dark}`}
                >
                  Terapkan{activeCount > 0 ? ` (${activeCount})` : ""}
                </Button>
              </DrawerFooter>
            </DrawerContent>
          </Drawer>

          {hasActive && (
            <button
              type="button"
              onClick={onReset}
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-500 ring-1 ring-zinc-200 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none dark:text-zinc-400 dark:ring-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 ${FOCUS_RING}`}
              aria-label="Reset semua filter"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>
      </div>

      {/* ── DESKTOP: bar horizontal (≥sm) — renderer Select yang sama ── */}
      <div className="hidden flex-wrap items-center gap-2 sm:flex" role="group" aria-label="Filter video trending">
        <FilterSelect
          value={dayValue}
          onValueChange={onDayChange}
          triggerClassName={`${DESKTOP_TRIGGER} min-w-[150px] ${dayValue !== "all" ? "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300" : ""}`}
          contentClassName={`${CONTENT} custom-scrollbar`}
          ariaLabel="Filter hari posting"
          placeholder="Hari posting"
          options={dayOptions}
        />

        <FilterSelect
          value={filters.sort}
          onValueChange={(v) => set({ sort: v })}
          triggerClassName={`${DESKTOP_TRIGGER} min-w-[152px]`}
          contentClassName={CONTENT}
          ariaLabel="Urutkan hasil"
          placeholder="Urutkan"
          options={SORT_OPTIONS}
        />

        <FilterSelect
          value={filters.category}
          onValueChange={(v) => set({ category: v })}
          triggerClassName={`${DESKTOP_TRIGGER} min-w-[160px]`}
          contentClassName={`${CONTENT} custom-scrollbar`}
          ariaLabel="Filter kategori"
          placeholder="Kategori"
          options={categoryOptions}
        />

        <FilterSelect
          value={filters.duration}
          onValueChange={(v) => set({ duration: v })}
          triggerClassName={DESKTOP_TRIGGER}
          contentClassName={CONTENT}
          ariaLabel="Filter durasi video"
          placeholder="Durasi"
          options={DURATION_OPTIONS}
        />

        <FilterSelect
          value={filters.views}
          onValueChange={(v) => set({ views: v })}
          triggerClassName={DESKTOP_TRIGGER}
          contentClassName={CONTENT}
          ariaLabel="Filter views minimum"
          placeholder="Views"
          options={VIEWS_OPTIONS}
        />

        <FilterSelect
          value={filters.traffic}
          onValueChange={(v) => set({ traffic: v })}
          triggerClassName={DESKTOP_TRIGGER}
          contentClassName={CONTENT}
          ariaLabel="Filter jenis traffic"
          placeholder="Traffic"
          options={TRAFFIC_OPTIONS}
        />

        <label
          className={`flex h-11 cursor-pointer items-center gap-2.5 rounded-full px-4 text-ui font-medium ring-1 transition-colors ${
            filters.shopOnly
              ? "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:ring-emerald-900"
              : "bg-white/80 text-zinc-700 ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-900/80 dark:text-zinc-200 dark:ring-zinc-700 dark:hover:bg-zinc-800"
          }`}
        >
          <ShoppingBag className={`h-4 w-4 ${filters.shopOnly ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-400"}`} aria-hidden />
          <span>Shop only</span>
          <Switch
            checked={filters.shopOnly}
            onCheckedChange={(v) => set({ shopOnly: v })}
            aria-label="Hanya video dengan produk TikTok Shop"
            className="data-[state=checked]:bg-emerald-600"
          />
        </label>

        <div className="relative ml-auto w-full sm:w-60">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden />
          <Input
            type="search"
            value={filters.search}
            onChange={(e) => set({ search: e.target.value })}
            placeholder="Cari video, produk, @akun…"
            aria-label="Cari video trending"
            className="h-11 rounded-full border-zinc-200 bg-white/80 pl-10 pr-4 text-ui shadow-none backdrop-blur focus-visible:ring-2 focus-visible:ring-zinc-300 dark:border-zinc-700 dark:bg-zinc-900/80 dark:focus-visible:ring-zinc-600"
          />
        </div>

        {hasActive && (
          <button
            type="button"
            onClick={onReset}
            className={`flex h-11 shrink-0 items-center gap-1.5 rounded-full px-3 text-ui font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 ${FOCUS_RING}`}
            aria-label="Reset semua filter"
          >
            <X className="h-4 w-4" aria-hidden />
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

/** Select filter generik — SATU renderer untuk semua filter, dua varian layout. */
function FilterSelect({
  value,
  onValueChange,
  triggerClassName,
  contentClassName,
  ariaLabel,
  placeholder,
  options,
}: {
  value: string;
  onValueChange: (v: string) => void;
  triggerClassName: string;
  contentClassName?: string;
  ariaLabel: string;
  placeholder: string;
  options: Option[];
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className={triggerClassName} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value} className={ITEM}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Label kecil di atas kontrol drawer. */
function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={className}>
      <p className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</p>
      {children}
    </div>
  );
}

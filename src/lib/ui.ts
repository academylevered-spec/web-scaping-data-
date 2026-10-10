/**
 * Token UI bersama — single source of truth untuk pola visual yang berulang.
 * Melengkapi token CSS di globals.css (@theme): type scale, radius, shadow.
 *
 * Aturan ringkas:
 *  - Fokus keyboard  : FOCUS_RING (wajib pada semua <button>/<a> kustom non-shadcn-Button)
 *  - Tombol pill 44px: pill.base + salah satu varian warna
 *  - Chip di atas media: MEDIA_CHIP + padding/text sesuai kebutuhan
 *  - Teks meta light : text-zinc-500 (AA 4.7:1), dark: text-zinc-400 — larang zinc-400 di light
 *  - Z-scale         : 10 overlay klik · 20 chip media · 30 close · 40 navbar · 50 portal
 *  - Radius          : full=pill · 2xl=kartu · 3xl=sheet/dialog · xl=embed kecil
 */
import { cn } from "@/lib/utils";

/** Ring fokus aksesibel untuk elemen interaktif kustom (non-shadcn-Button). */
export const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-zinc-950";

/** Dasar tombol pill — tinggi sentuh 44px. Gabungkan dengan varian via cn(). */
export const pill = {
  base: "inline-flex h-11 items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
  /** Primer netral (gelap di light, terang di dark). */
  dark: "bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200",
  /** Primer brand — aksi bernilai shop/brand. */
  emerald: "bg-emerald-600 text-white hover:bg-emerald-700",
  /** Sekunder bergaris. */
  outline:
    "border border-zinc-200 bg-background text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-800",
} as const;

/** Chip mikro di atas media (gelap transparan + blur) — durasi, rank, negara, penjualan. */
export const MEDIA_CHIP =
  "rounded-full bg-black/45 font-medium text-white backdrop-blur-md tabular-nums";

/** Helper gabung token + kelas tambahan (shadow-passing ke twMerge). */
export function withTokens(...classes: Array<string | false | null | undefined>): string {
  return cn(...classes);
}

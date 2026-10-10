"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ExternalLink, Link2, Play, ShoppingCart, X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { gradientStyle } from "@/lib/cover";
import { MEDIA_CHIP, pill } from "@/lib/ui";
import { TikTokPlayer } from "./tiktok-player";
import {
  TrendVideo,
  COUNTRY_FLAGS,
  copyToClipboard,
  formatCompact,
  formatGmv,
  formatPrice,
  timeAgo,
} from "@/lib/trend-utils";
import { toast } from "sonner";

interface Props {
  video: TrendVideo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Bila true (dibuka via tombol Play kartu), video langsung diputar. */
  autoPlay?: boolean;
}

/** Dialog detail Apple-sheet: player, stats, produk, tombol salin link & buka TikTok/TikTok Shop. */
export function VideoDetailDialog({ video, open, onOpenChange, autoPlay = false }: Props) {
  const [copied, setCopied] = useState<"video" | "shop" | null>(null);
  const [playing, setPlaying] = useState(autoPlay);
  // autoPlay di-initialize per-mount — parent mengubah key saat (video, autoPlay)
  // berubah sehingga dialog selalu fresh (fix: tombol Play mati utk video sama).

  // Ambil data terbaru video dari API (fallback ke data baris grid)
  const { data: detail } = useQuery({
    queryKey: ["video-detail", video?.tiktokId],
    queryFn: async () => {
      const res = await fetch(`/api/videos/${video?.tiktokId}`, { cache: "no-store" });
      const json = await res.json();
      return json.ok ? (json.video as TrendVideo) : video;
    },
    enabled: open && !!video?.tiktokId,
    initialData: video ?? undefined,
    staleTime: 15_000,
  });

  const v = detail ?? video;

  if (!v) return null;

  const hideBrokenImg = (e: React.SyntheticEvent<HTMLImageElement>) => {
    e.currentTarget.style.display = "none";
  };

  const copyVideo = async () => {
    const ok = await copyToClipboard(v.videoUrl);
    if (ok) {
      setCopied("video");
      toast.success("Link video disalin", { description: v.videoUrl });
      setTimeout(() => setCopied((c) => (c === "video" ? null : c)), 1800);
    } else {
      toast.error("Gagal menyalin link video");
    }
  };

  const copyShop = async () => {
    if (!v.shopUrl) return;
    const ok = await copyToClipboard(v.shopUrl);
    if (ok) {
      setCopied("shop");
      toast.success("Link TikTok Shop disalin", { description: v.shopUrl });
      setTimeout(() => setCopied((c) => (c === "shop" ? null : c)), 1800);
    } else {
      toast.error("Gagal menyalin link TikTok Shop");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[calc(100vw-1.5rem)] gap-0 overflow-hidden rounded-3xl p-0 sm:max-w-3xl"
        showCloseButton={false}
      >
        {/* Tombol tutup kustom: mobile = glass di atas video (X bawaan tak terlihat di media gelap),
            desktop = netral di atas panel konten */}
        <DialogClose
          className="absolute right-3 top-3 z-30 flex h-9 w-9 items-center justify-center rounded-full bg-black/45 text-white ring-1 ring-white/25 backdrop-blur-md transition-all hover:bg-black/60 focus-visible:ring-2 focus-visible:ring-emerald-400 md:bg-zinc-100/90 md:text-zinc-600 md:ring-black/5 md:hover:bg-zinc-200 md:dark:bg-zinc-800/90 md:dark:text-zinc-300 md:dark:ring-white/10 md:dark:hover:bg-zinc-700"
          aria-label="Tutup detail video"
        >
          <X className="h-4 w-4" aria-hidden />
        </DialogClose>
        <DialogHeader className="sr-only">
          <DialogTitle>Detail video trending</DialogTitle>
          <DialogDescription>
            Statistik video dan tautan TikTok serta TikTok Shop
          </DialogDescription>
        </DialogHeader>

        {/* Mobile: video tinggi 45dvh (bukan 9:16 penuh) agar stats langsung terlihat &
            seluruh sheet bisa di-scroll; desktop: kolom kiri tinggi penuh. */}
        <div className="custom-scrollbar grid max-h-[92dvh] grid-cols-1 overflow-y-auto md:grid-cols-[minmax(0,330px)_1fr] md:overflow-hidden">
          {/* Kiri: player (bila diputar) / cover + tombol putar */}
          <div
            className="relative h-[45dvh] w-full md:h-full md:min-h-[560px]"
            style={playing ? undefined : gradientStyle(v.tiktokId)}
          >
            {playing ? (
              <TikTokPlayer tiktokId={v.tiktokId} caption={v.caption} />
            ) : (
              <>
                <img
                  key={v.tiktokId}
                  src={v.thumbnail}
                  alt={v.caption.slice(0, 80)}
                  onError={hideBrokenImg}
                  className="absolute inset-0 h-full w-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-black/20" aria-hidden />
                <button
                  type="button"
                  onClick={() => setPlaying(true)}
                  aria-label="Putar video"
                  className="absolute left-1/2 top-1/2 z-10 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/95 text-zinc-900 shadow-2xl ring-1 ring-black/5 transition-all duration-300 hover:scale-110 hover:bg-white focus-visible:ring-2 focus-visible:ring-emerald-400"
                >
                  <Play className="h-7 w-7 translate-x-[2px]" fill="currentColor" aria-hidden />
                </button>
                <span className="pointer-events-none absolute bottom-3 right-3 rounded-full bg-black/45 px-2.5 py-1 text-2xs font-medium text-white/90 backdrop-blur-md">
                  Putar di aplikasi
                </span>
              </>
            )}
            {!playing && (
              <span className={`${MEDIA_CHIP} absolute left-3 top-3 px-2.5 py-1 text-2xs`}>
                {v.duration}
              </span>
            )}
            <span className={`${MEDIA_CHIP} absolute right-14 top-3 px-2.5 py-1 text-2xs md:right-3`}>
              {COUNTRY_FLAGS[v.country] ?? "🌐"} {v.country}
            </span>
            {!playing && v.sales > 0 && (
              <span className={`${MEDIA_CHIP} absolute bottom-3 left-3 flex items-center gap-1.5 bg-emerald-500/95 px-2.5 py-1 text-2xs font-semibold shadow-lg shadow-emerald-500/25`}>
                <ShoppingCart className="h-3.5 w-3.5" aria-hidden />
                {formatCompact(v.sales)} terjual
              </span>
            )}
          </div>

          {/* Kanan: detail — padding-bottom menghormati safe-area iOS */}
          <div className="custom-scrollbar flex min-w-0 flex-col gap-4 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:p-6 sm:pb-6 md:overflow-y-auto">
            <div>
              <h3 className="text-lg font-semibold leading-snug tracking-tight text-zinc-900 dark:text-zinc-50">
                {v.caption}
              </h3>
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-ui text-zinc-500 dark:text-zinc-400">
                <a
                  href={`https://www.tiktok.com/@${v.authorHandle}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-zinc-700 underline-offset-2 hover:underline dark:text-zinc-300"
                  aria-label={`Buka profil TikTok @${v.authorHandle}`}
                >
                  @{v.authorHandle}
                </a>
                <span aria-hidden>·</span>
                <span>{v.category}</span>
                <span aria-hidden>·</span>
                <span>{v.trafficType === "ads" ? "Iklan" : "Organik"}</span>
              </div>
            </div>

            {/* Grid statistik */}
            <div className="grid grid-cols-2 gap-2.5">
              <Stat label="Views" value={formatCompact(v.views)} />
              <Stat label="Suka" value={formatCompact(v.likes)} />
              <Stat label="Terjual" value={v.sales > 0 ? formatCompact(v.sales) : "—"} accent={v.sales > 0} />
              <Stat label="GMV" value={v.gmv > 0 ? formatGmv(v.gmv) : "—"} accent={v.gmv > 0} />
            </div>

            {/* Kartu produk */}
            {v.isShopProduct && (
              <div className="flex items-center gap-3.5 rounded-2xl bg-zinc-50 p-3.5 ring-1 ring-black/5 dark:bg-zinc-900 dark:ring-white/10">
                <div
                  className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl"
                  style={gradientStyle(v.tiktokId + "p")}
                >
                  <img
                    key={v.tiktokId + "p"}
                    src={v.productImage ?? v.thumbnail}
                    alt={v.productTitle ?? "Produk TikTok Shop"}
                    onError={hideBrokenImg}
                    className="h-16 w-16 rounded-xl object-cover"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-ui font-medium leading-snug text-zinc-800 dark:text-zinc-200">
                    {v.productTitle || "TikTok Shop product"}
                  </p>
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-2.5 text-ui">
                    <span className="font-semibold text-zinc-900 dark:text-zinc-50">
                      {v.productPriceMin != null && v.productPriceMax != null
                        ? `${formatPrice(v.productPriceMin)} – ${formatPrice(v.productPriceMax)}`
                        : "—"}
                    </span>
                    {v.productSold != null && (
                      <span className="text-zinc-500 dark:text-zinc-400">{formatCompact(v.productSold)} terjual</span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Tautan (monospace, dapat diseleksi) */}
            <div className="flex flex-col gap-2">
              <LinkRow label="Link video" url={v.videoUrl} />
              {v.isShopProduct && v.shopUrl && <LinkRow label="Link TikTok Shop" url={v.shopUrl} />}
            </div>

            {/* Aksi: salin + buka */}
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <Button onClick={copyVideo} className={`${pill.base} ${pill.dark}`} aria-label="Salin link video">
                <Link2 className="h-4 w-4" aria-hidden />
                {copied === "video" ? "Tersalin!" : "Salin Link Video"}
              </Button>
              {v.isShopProduct && v.shopUrl ? (
                <Button onClick={copyShop} className={`${pill.base} ${pill.emerald}`} aria-label="Salin link TikTok Shop">
                  <ShoppingCart className="h-4 w-4" aria-hidden />
                  {copied === "shop" ? "Tersalin!" : "Salin Link TikTok Shop"}
                </Button>
              ) : (
                <Button asChild className={`${pill.base} ${pill.outline}`}>
                  <a
                    href={v.videoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Buka video di TikTok"
                  >
                    Buka di TikTok
                    <ExternalLink className="h-4 w-4" aria-hidden />
                  </a>
                </Button>
              )}
            </div>

            {/* Baris kedua hanya bila produk shop — mencegah "Buka di TikTok" ganda
                pada video non-shop (bug mobile: 2 tombol identik berurutan). */}
            {v.isShopProduct && v.shopUrl && (
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <Button asChild className={`${pill.base} ${pill.outline}`}>
                  <a href={v.videoUrl} target="_blank" rel="noopener noreferrer" aria-label="Buka video di TikTok">
                    <TikTokIcon />
                    Buka di TikTok
                  </a>
                </Button>
                <Button asChild className={`${pill.base} ${pill.emerald}`}>
                  <a href={v.shopUrl} target="_blank" rel="noopener noreferrer" aria-label="Buka produk di TikTok Shop">
                    <ShoppingCart className="h-4 w-4" aria-hidden />
                    Buka TikTok Shop
                  </a>
                </Button>
              </div>
            )}

            <Separator />
            <p className="text-2xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              Tautan dibuka di TikTok. Data real dari bot scraper, diperbarui otomatis tiap jam. Terakhir
              diperbarui {timeAgo(v.updatedAt)}.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-2xl bg-zinc-50 px-4 py-3 ring-1 ring-black/5 dark:bg-zinc-900 dark:ring-white/10">
      <p className="text-2xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</p>
      <p
        className={`mt-0.5 text-lg font-semibold tabular-nums tracking-tight ${
          accent ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-900 dark:text-zinc-50"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function LinkRow({ label, url }: { label: string; url: string }) {
  return (
    <div className="rounded-xl bg-zinc-50 px-3.5 py-2.5 ring-1 ring-black/5 dark:bg-zinc-900 dark:ring-white/10">
      <p className="text-2xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">{label}</p>
      <code className="mt-0.5 block select-text break-all font-mono text-2xs leading-relaxed text-zinc-600 dark:text-zinc-300">
        {url}
      </code>
    </div>
  );
}

function TikTokIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M19.6 6.9a5.7 5.7 0 0 1-3.4-3.5c-.1-.4-.2-.8-.2-1.2h-3.4v13.4a2.9 2.9 0 1 1-2.9-3c.3 0 .6 0 .9.1V9.2a6.3 6.3 0 0 0-.9-.1 6.3 6.3 0 1 0 6.3 6.4V8.9a9 9 0 0 0 4.6 1.3V6.9c-.3 0-.7 0-1-.0Z" />
    </svg>
  );
}

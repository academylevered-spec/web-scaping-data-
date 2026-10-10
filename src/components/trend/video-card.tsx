"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Eye, Heart, Link2, Play, ShoppingCart, ShoppingBag } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { gradientStyle } from "@/lib/cover";
import { FOCUS_RING, MEDIA_CHIP } from "@/lib/ui";
import { TrendVideo, COUNTRY_FLAGS, copyToClipboard, formatCompact, formatGmv } from "@/lib/trend-utils";

interface VideoCardProps {
  video: TrendVideo;
  /** Peringkat 1-based = (page-1)*pageSize + index + 1 */
  rank: number;
  index: number;
  /** Buka detail; play=true → langsung memutar video (v3). */
  onOpen: (v: TrendVideo, play?: boolean) => void;
}

export function VideoCard({ video, rank, index, onOpen }: VideoCardProps) {
  const [thumbError, setThumbError] = useState(false);
  const [prodImgError, setProdImgError] = useState(false);

  const copyVideoLink = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyToClipboard(video.videoUrl);
    if (ok) toast.success("Link video disalin", { description: video.videoUrl });
    else toast.error("Gagal menyalin link video");
  };

  const copyShopLink = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!video.shopUrl) return;
    const ok = await copyToClipboard(video.shopUrl);
    if (ok) toast.success("Link TikTok Shop disalin", { description: video.shopUrl });
    else toast.error("Gagal menyalin link TikTok Shop");
  };

  const top3 = rank <= 3;

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.23, 1, 0.32, 1], delay: (index % 12) * 0.035 }}
      className="group relative"
    >
      <div className="relative overflow-hidden rounded-2xl bg-zinc-100 shadow-sm ring-1 ring-black/5 transition-all duration-300 ease-out group-hover:-translate-y-1 group-hover:shadow-xl group-hover:ring-black/10 dark:bg-zinc-800 dark:ring-white/10">
        <div className="relative aspect-[9/16] w-full overflow-hidden">
          {/* Fallback gradient + thumbnail real */}
          <div className="absolute inset-0" style={gradientStyle(video.tiktokId)} aria-hidden />
          {!thumbError && (
            <img
              src={video.thumbnail}
              alt={video.caption.slice(0, 80)}
              loading="lazy"
              onError={() => setThumbError(true)}
              className="relative h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.05]"
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-b from-black/35 via-transparent to-black/75" aria-hidden />

          {/* Tombol buka detail menutupi media */}
          <button
            type="button"
            onClick={() => onOpen(video)}
            aria-label={`Buka detail video: ${video.caption.slice(0, 60)}`}
            className="absolute inset-0 z-10 cursor-pointer rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          />

          {/* Tombol putar (v3): hover/fokus di desktop, selalu tampil di sentuh */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(video, true);
            }}
            aria-label={`Putar video: ${video.caption.slice(0, 50)}`}
            className={`absolute left-1/2 top-1/2 z-20 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-white ring-1 ring-white/30 backdrop-blur-md transition-all duration-300 hover:scale-110 hover:bg-emerald-500/95 hover:shadow-xl hover:shadow-emerald-500/30 focus-visible:outline-none sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 ${FOCUS_RING}`}
          >
            <Play className="h-6 w-6 translate-x-[1px]" fill="currentColor" aria-hidden />
          </button>

          {/* Nomor rank besar */}
          <div
            className={`pointer-events-none absolute left-2.5 top-2.5 z-20 flex h-8 min-w-8 items-center justify-center rounded-xl px-1.5 text-base font-bold leading-none tabular-nums backdrop-blur-md ${
              top3
                ? "bg-emerald-500/90 text-white shadow-lg shadow-emerald-500/30"
                : "bg-black/45 text-white"
            }`}
            aria-label={`Peringkat ${rank}`}
          >
            #{rank}
          </div>

          {/* Durasi + negara */}
          <div className="pointer-events-none absolute right-2.5 top-2.5 z-20 flex items-center gap-1.5">
            <span className={`${MEDIA_CHIP} px-2 py-0.5 text-2xs`}>
              {video.duration}
            </span>
            <span
              className={`${MEDIA_CHIP} px-1.5 py-0.5 text-xs leading-5`}
              title={video.country}
              aria-label={`Negara: ${video.country}`}
            >
              {COUNTRY_FLAGS[video.country] ?? "🌐"}
            </span>
          </div>

          {/* Copy cepat: link video + link shop (hover/fokus; selalu tampil di sentuh) */}
          <div
            className="absolute right-2.5 top-12 z-20 flex translate-y-0 flex-col gap-1.5 opacity-100 transition-all duration-300 sm:-translate-y-1 sm:opacity-0 sm:group-hover:translate-y-0 sm:group-hover:opacity-100 sm:group-focus-within:translate-y-0 sm:group-focus-within:opacity-100"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={copyVideoLink}
                  aria-label="Copy link video"
                  className={`flex h-10 w-10 items-center justify-center rounded-full bg-white/95 text-zinc-800 shadow-md ring-1 ring-black/5 backdrop-blur transition-all hover:bg-white hover:scale-105 active:scale-95 focus-visible:outline-none dark:bg-zinc-900/95 dark:text-zinc-100 dark:ring-white/10 ${FOCUS_RING}`}
                >
                  <Link2 className="h-4 w-4" aria-hidden />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">Copy link video</TooltipContent>
            </Tooltip>

            {video.isShopProduct && video.shopUrl && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={copyShopLink}
                    aria-label="Copy link TikTok Shop"
                    className={`flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/95 text-white shadow-md shadow-emerald-500/25 ring-1 ring-emerald-400/50 backdrop-blur transition-all hover:bg-emerald-500 hover:scale-105 active:scale-95 focus-visible:outline-none ${FOCUS_RING}`}
                  >
                    <ShoppingBag className="h-4 w-4" aria-hidden />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">Copy link TikTok Shop</TooltipContent>
              </Tooltip>
            )}
          </div>

          {/* Overlay bawah: produk, sales/GMV, views/likes */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 p-2.5">
            {video.isShopProduct ? (
              <div className="mb-2 flex items-center gap-2 rounded-xl bg-white/95 p-1.5 pr-2.5 shadow-sm ring-1 ring-black/5 dark:bg-zinc-900/95 dark:ring-white/10">
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg"
                  style={gradientStyle(video.tiktokId + "p")}
                >
                  {!prodImgError && video.productImage && (
                    <img
                      src={video.productImage}
                      alt=""
                      aria-hidden
                      loading="lazy"
                      onError={() => setProdImgError(true)}
                      className="h-full w-full object-cover"
                    />
                  )}
                </div>
                <div className="min-w-0 flex-1 leading-tight">
                  <p className="truncate text-2xs font-medium text-zinc-500 dark:text-zinc-400">
                    {video.productTitle || "TikTok Shop product"}
                  </p>
                  <p className="truncate text-2xs font-semibold text-zinc-900 tabular-nums dark:text-zinc-100">
                    {video.productPriceMin != null && video.productPriceMax != null
                      ? `$${video.productPriceMin.toFixed(0)}–$${video.productPriceMax.toFixed(0)}`
                      : "TikTok Shop"}
                  </p>
                </div>
              </div>
            ) : null}

            {video.sales > 0 && (
              <div className="mb-2 flex items-center gap-1.5">
                <span className={`${MEDIA_CHIP} flex items-center gap-1 bg-emerald-500/95 px-2 py-0.5 text-2xs font-semibold shadow-md shadow-emerald-500/25`}>
                  <ShoppingCart className="h-3 w-3" aria-hidden />
                  {formatCompact(video.sales)} terjual
                </span>
                {video.gmv > 0 && (
                  <span className={`${MEDIA_CHIP} px-2 py-0.5 text-2xs font-semibold`}>
                    {formatGmv(video.gmv)}
                  </span>
                )}
              </div>
            )}

            <div className="flex items-center gap-3 text-white">
              <span className="flex items-center gap-1 text-xs font-medium tabular-nums drop-shadow">
                <Eye className="h-3.5 w-3.5" aria-hidden /> {formatCompact(video.views)}
              </span>
              <span className="flex items-center gap-1 text-xs font-medium tabular-nums drop-shadow">
                <Heart className="h-3.5 w-3.5" aria-hidden /> {formatCompact(video.likes)}
              </span>
              <span className={`${MEDIA_CHIP} ml-auto px-2 py-0.5 text-2xs uppercase tracking-wide`}>
                {video.trafficType === "ads" ? "Ads" : "Organik"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Caption */}
      <div className="mt-2.5 px-0.5">
        <p className="line-clamp-2 text-ui leading-snug text-zinc-800 dark:text-zinc-200">{video.caption}</p>
        <div className="mt-1 flex items-center gap-1.5 text-2xs text-zinc-500 dark:text-zinc-500">
          <span className="truncate">@{video.authorHandle}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0 truncate">{video.category.split(" & ")[0]}</span>
        </div>
      </div>
    </motion.div>
  );
}

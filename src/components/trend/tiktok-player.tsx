"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Loader2, RotateCcw } from "lucide-react";

interface TikTokPlayerProps {
  /** ID video TikTok (tiktokId) — dipakai URL embed player resmi. */
  tiktokId: string;
  caption?: string;
}

const EMBED_TIMEOUT_MS = 8_000; // iframe tidak onLoad dalam 8 dtk → dianggap gagal

/**
 * Pemutar video TikTok in-app — iframe embed player resmi TikTok
 * (https://www.tiktok.com/player/v1/{id}).
 *
 * Strategi multi-tingkat (v8) — video TIDAK PERNAH mati total:
 *   T1  Embed resmi. Sandbox kini menyertakan `allow-same-origin` — tanpa ini
 *       iframe ber-origin opaque → localStorage/cookie player TikTok melempar
 *       error → pemutar gagal di banyak browser (akar bug "video tidak bisa play").
 *   T2  Deteksi cepat: onLoad ≤8 dtk. Bila tidak → panel fallback menonjol
 *       (Putar ulang embed / Buka di TikTok).
 *   T3  Escape hatch permanen: chip "Buka di TikTok" SELALU tampil di pojok
 *       player — menutupi semua kasus dalam-iframe yang tak terdeteksi
 *       (geo-block, video dihapus, login wall) karena konten iframe lintas
 *       origin tidak bisa dibaca.
 */
export function TikTokPlayer({ tiktokId, caption }: TikTokPlayerProps) {
  const [attempt, setAttempt] = useState(0); // kunci remount utk "Putar ulang"
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);

  // Timer deteksi gagal per attempt — timeout menandai slow (setState di callback,
  // bukan sinkron di body effect). Reset status dilakukan di handler retry.
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), EMBED_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [attempt]);

  const retry = () => {
    setLoaded(false);
    setSlow(false);
    setAttempt((a) => a + 1);
  };

  const src = `https://www.tiktok.com/player/v1/${tiktokId}?music_info=1&desc_info=1&rel=0&native_context_menu=0&autoplay=1`;

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <iframe
        key={attempt}
        src={src}
        title={caption ? `Putar video TikTok: ${caption.slice(0, 60)}` : "Pemutar video TikTok"}
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
        onLoad={() => setLoaded(true)}
        className="absolute inset-0 h-full w-full border-0"
      />

      {/* Overlay loading hingga iframe siap */}
      {!loaded && (
        <div
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-950/80"
          aria-hidden
        >
          <Loader2 className="h-8 w-8 animate-spin text-emerald-400" />
          <p className="text-ui font-medium text-zinc-300">Memuat pemutar video…</p>
        </div>
      )}

      {/* T2 — Fallback menonjol bila embed tidak selesai memuat dalam batas waktu */}
      {slow && (
        <div className="absolute inset-x-4 bottom-14 z-10 rounded-2xl bg-zinc-900/95 p-3 ring-1 ring-white/10">
          <p className="mb-2 text-xs leading-snug text-zinc-300">
            Pemutar tidak merespons di jaringan ini — coba muat ulang, atau buka langsung di TikTok.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={retry}
              className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full bg-white px-3 text-xs font-semibold text-zinc-900 transition-colors hover:bg-zinc-200"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              Putar ulang
            </button>
            <a
              href={`https://www.tiktok.com/@_/video/${tiktokId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full bg-emerald-500 px-3 text-xs font-semibold text-white transition-colors hover:bg-emerald-400"
            >
              Buka di TikTok
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          </div>
        </div>
      )}

      {/* T3 — Escape hatch permanen (selalu ada walau embed "sukses" onLoad) */}
      <a
        href={`https://www.tiktok.com/@_/video/${tiktokId}`}
        target="_blank"
        rel="noopener noreferrer"
        className="absolute bottom-3 right-3 z-20 flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1.5 text-2xs font-semibold text-white ring-1 ring-white/20 backdrop-blur-md transition-colors hover:bg-black/75"
        aria-label="Buka video ini di aplikasi/ situs TikTok"
      >
        Buka di TikTok
        <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
    </div>
  );
}

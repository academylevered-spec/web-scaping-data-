"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pill } from "@/lib/ui";

/** Error boundary route-level — app tidak pernah white-screen, selalu ada jalan keluar. */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-[70vh] flex-col items-center justify-center px-4 text-center">
      <span
        className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-100 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:ring-zinc-700"
        aria-hidden
      >
        <AlertTriangle className="h-7 w-7 text-amber-500" />
      </span>
      <h1 className="mt-4 text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        Terjadi kesalahan tak terduga
      </h1>
      <p className="mt-1 max-w-md text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
        Maaf, sesuatu gagal saat memuat halaman. Data Anda aman di database cloud —
        coba muat ulang bagian ini.
      </p>
      <Button onClick={reset} className={`mt-5 ${pill.base} ${pill.dark} px-6`}>
        Coba lagi
      </Button>
    </main>
  );
}

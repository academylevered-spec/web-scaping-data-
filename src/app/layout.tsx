import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { Providers } from "@/components/trend/providers";

export const metadata: Metadata = {
  title: "TrendPulse — Pelacak Video Trending TikTok Shop",
  description:
    "Video trending TikTok Shop dari 13 negara, dijamin min. 10 penjualan & 10K views, dengan link video + TikTok Shop langsung. Data real, disinkron otomatis setiap jam.",
  keywords: ["trending videos", "TikTok", "TikTok Shop", "global trends", "trending tracker", "produk trending"],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "TrendPulse — Trending. Terjual. Global.",
    description: "Video trending TikTok Shop per negara & kategori, data real per jam, link langsung.",
    siteName: "TrendPulse",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // viewportFit=cover: konten memperhitungkan safe-area (notch/round corner) iOS & Android
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground">
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange={false}>
          <Providers>
            {children}
            <Toaster position="bottom-center" richColors closeButton />
          </Providers>
        </ThemeProvider>
      </body>
    </html>
  );
}

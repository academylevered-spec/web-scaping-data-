# DEPRECATED — jangan dijalankan lagi

Service ini (port 4010) sudah **digantikan sepenuhnya** oleh bot Python
`mini-services/trend-scraper-python` (port 4020) sejak v2:

- Scheduler in-process Node → digantikan scheduler Python drift-proof per 1 jam
- Logika scraping simulasi → digantikan scraper real creatok.ai (12 worker paralel)
- `/api/sync` Next.js sekarang mem-proxy ke `:4020`, bukan ke sini

Folder ini dipertahankan hanya sebagai referensi historis.
Tidak ada kode di `src/` yang mereferensikannya (terverifikasi grep).

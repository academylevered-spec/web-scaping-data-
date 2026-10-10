/** Konfigurasi & konstanta trend-sync-service */

export const SYNC_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 jam
export const SERVICE_PORT = 4010;
export const BASE_URL = "https://www.creatok.ai";
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const EMAIL = process.env.CREATOK_EMAIL ?? "";
export const PASSWORD = process.env.CREATOK_PASSWORD ?? "";
export const DATABASE_URL =
  process.env.DATABASE_URL ?? "file:/home/z/my-project/db/custom.db";

/** Jendela data: 7 hari terakhir (mengikuti default situs) */
export const WINDOW_DAYS = 7;
/** Halaman maksimum per kombinasi region×kategori (pageSize 50) */
export const MAX_PAGES_PER_COMBO = 2;
export const PAGE_SIZE = 50;
/** Jeda antar request (ms) — politeness */
export const THROTTLE_MS = 550;
/** Retry utk 429/5xx */
export const MAX_RETRIES = 3;
/** Batch produk per request */
export const PRODUCT_BATCH = 20;
/** Batas lookup produk per siklus (hemat kuota) */
export const MAX_PRODUCT_LOOKUPS = 2500;

export const REGIONS = [
  "US", "ID", "TH", "PH", "MY", "VN", "GB", "MX", "SG", "BR", "ES", "DE", "JP",
] as const;

/** 29 kategori asli creatok.ai → product_category_id (captured dari UI) */
export const SOURCE_CATEGORIES: Array<{ name: string; id: string }> = [
  { name: "Automotive & Motorcycle", id: "605196" },
  { name: "Baby & Maternity", id: "602284" },
  { name: "Beauty & Personal Care", id: "601450" },
  { name: "Bookings & Vouchers", id: "2344592" },
  { name: "Books, Magazines & Audio", id: "801928" },
  { name: "Collectibles", id: "951432" },
  { name: "Computers & Office Equipment", id: "601755" },
  { name: "Fashion Accessories", id: "605248" },
  { name: "Food & Beverages", id: "700437" },
  { name: "Furniture", id: "604453" },
  { name: "Health", id: "700645" },
  { name: "Home Improvement", id: "604968" },
  { name: "Home Supplies", id: "600001" },
  { name: "Household Appliances", id: "600942" },
  { name: "Jewelry Accessories & Derivatives", id: "953224" },
  { name: "Kids' Fashion", id: "802184" },
  { name: "Kitchenware", id: "600024" },
  { name: "Luggage & Bags", id: "824584" },
  { name: "Menswear & Underwear", id: "824328" },
  { name: "Muslim Fashion", id: "601303" },
  { name: "Pet Supplies", id: "602118" },
  { name: "Phones & Electronics", id: "601739" },
  { name: "Shoes", id: "601352" },
  { name: "Sports & Outdoor", id: "603014" },
  { name: "Textiles & Soft Furnishings", id: "600154" },
  { name: "Tools & Hardware", id: "604579" },
  { name: "Toys & Hobbies", id: "604206" },
  { name: "Virtual Products", id: "834312" },
  { name: "Womenswear & Underwear", id: "601152" },
];

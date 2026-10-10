"""
TrendScraper v7 — konfigurasi pusat bot scraping creatok.ai (scope-command).

PERUBAHAN v7 (bukti: docs/scraping-v7/01-DIAGNOSIS.md):
- DIAGNOSIS: sumber gagal ~50% request SECARA ACAK (HTTP 500 body JSON) bahkan pada
  rate sopan — BUKAN rate-limit (0x 429 selamanya). Maka: retry cepat per-request
  (sukses ulang ~50% seketika), circuit breaker hanya OPEN saat collapse nyata.
- Freshness TTL per bucket — data segar dipakai ulang, hanya yang basi di-refresh.
- Prioritas job + preemption: klik scope UI (priority 0) mendahului job berjalan.
- WORKERS 16→12 (politeness; throughput naik karena retry cepat, bukan brute force).
"""
import os

SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))


def _load_dotenv() -> None:
    """Muat .env sederhana (KEY=VALUE per baris) tanpa dependensi python-dotenv.
    Nilai env yang SUDAH ada sebelumnya tidak ditimpa (setdefault)."""
    path = os.path.join(SERVICE_DIR, ".env")
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))
    except FileNotFoundError:
        pass


_load_dotenv()

# ── Kredensial & endpoint ────────────────────────────────────────────────
BASE_URL = "https://www.creatok.ai"
# KEAMANAN (v6): kredensial hanya dari environment/.env — tidak ada fallback
# hardcoded di source. Bila kosong → bot gagal cepat dengan pesan jelas.
EMAIL = os.environ.get("CREATOK_EMAIL", "")
PASSWORD = os.environ.get("CREATOK_PASSWORD", "")
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# ── Database Z.ai (SQLite WAL — dibagi dengan aplikasi Next.js) ──────────
DB_PATH = os.environ.get("SCRAPER_DB_PATH", "/home/z/my-project/db/custom.db")
STATUS_PATH = os.path.join(SERVICE_DIR, "status.json")
SESSION_PATH = os.path.join(SERVICE_DIR, "session.json")
DISCOVERY_PATH = os.path.join(SERVICE_DIR, "discovery.json")

# ── Strategi waktu ───────────────────────────────────────────────────────
INTERVAL_SECONDS = 3600          # jadwal global job per 1 jam (REAL-TIME)
SERVICE_PORT = 4020

# ── Filter kualitas minimal (aturan wajib dari pemilik) ──────────────────
MIN_SALES = 10                   # penjualan minimal 10 (>= 10, inklusif)
MIN_VIEWS = 10_000               # views HARUS LEBIH DARI 10.000 (strictly >)

# ── Parameter scraping ───────────────────────────────────────────────────
PAGE_SIZE = 100

# Adaptive throttle (self-tuning politeness)
#   Mulai THROTTLE_MS; streak sukses → turun 10% hingga THROTTLE_MIN_MS;
#   429 → naik 2x hingga THROTTLE_MAX_MS. 5xx TIDAK menaikkan throttle
#   (v7: 5xx sumber = flakiness acak, bukan tekanan — ditangani retry cepat).
THROTTLE_MS = 300                # dasar (ms)
THROTTLE_MIN_MS = 220            # batas bawah saat sumber bersih
THROTTLE_MAX_MS = 900            # batas atas saat sumber tegang
THROTTLE_EASE_STREAK = 60        # sukses beruntun sebelum turun satu tangga

WORKERS = 12                     # v7: 16→12 — politeness (retry cepat mengangkat goodput)
MAX_RETRIES = 5                  # retry dalam get_json per request HTTP (v7: 4→5)

# v7 — kurva retry cepat utk 5xx/invalid (detik). Sumber 500 acak ~50%; retry
# seketika ~50% sukses → 5 attempt ≈ 97% sukses per call tanpa menunggu lama.
RETRY_DELAY_5XX = [0.4, 0.8, 1.6, 3.2, 6.4]
RETRY_JITTER = 0.3               # ±30% jitter pada delay

# ── Job & slice (v7) ─────────────────────────────────────────────────────
MAX_REQUESTS_PER_CYCLE = 12000  # budget request sweep per job (safety ceiling)
SLICE_MAX_ATTEMPTS = 3           # percobaan scrape per slice per job (bad response)
SLICE_RETRY_DELAYS = [2, 6, 15]  # v7: lebih pendek — retry level request sudah menangani flakiness
SLICE_HARD_ATTEMPTS = 6          # slice mencapai attempts >= ini → 'dead' (butuh retry manual/UI)
JOB_SOFT_DEADLINE_MIN = 65       # bila tercapai → stop dequeue (in-flight selesai, sisa ready)
JOB_HARD_DEADLINE_MIN = 80       # safety net keras → batalkan antrean baru & mulai fase produk

# Circuit breaker v7 — HANYA utk COLLAPSE nyata (bukan flakiness kronis).
# Bukti diagnosis: p(500)≈0.5 konstan; ratio 0.6 membuat breaker OPEN terus-menerus
# (openCount=6 dlm 46 mnt) → bot lebih banyak menunggu daripada scrape.
CIRCUIT_WINDOW = 30              # ukuran window request untuk evaluasi
CIRCUIT_FAIL_RATIO = 0.90        # ≥90% gagal dalam window penuh → OPEN (collapse)
CIRCUIT_OPEN_SEC = 45            # durasi OPEN sebelum half-open probe
CIRCUIT_ALERT_COOLDOWN_SEC = 600 # minimal jeda antar alert "source under pressure"

# ── Job model v7 (scope-command) ─────────────────────────────────────────
INSTANCE_ID = "z7"               # owner tag — memisahkan row milik v7 dr proses zombie
JOB_PRIORITY = {"ui": 0, "retry": 5, "scheduled": 10}
# Preemption: job 'ready' dengan priority < priority job berjalan → preempt.
ADAPT_PENDING_AFTER_MS = 10 * 60_000   # adopsi slice 'pending' buatan zombie (≥10 mnt tak disentuh)
ADOPT_EVERY_SEC = 120                  # interval loop adopsi di scheduler
JOB_HEARTBEAT_STALE_MS = 3 * 60_000    # job running dgn heartbeat lebih tua → adopt (crash recovery)

# ── Freshness TTL per bucket (v7, RC4) ───────────────────────────────────
# Slice 'done' lebih tua dari TTL → ready lagi saat job scope-nya berjalan.
# Env override: SLICE_TTL_MS_JSON='{"1":5400000,...}'
SLICE_TTL_MS = {
    1: 90 * 60_000,        # 36jam (Kemarin) — paling cepat basi
    2: 4 * 3600_000,       # 7d
    3: 8 * 3600_000,       # 15d
    4: 12 * 3600_000,      # 30d
    10: 6 * 3600_000,      # day:2
    9: 6 * 3600_000,       # day:3
    8: 6 * 3600_000,       # day:4
    7: 6 * 3600_000,       # day:5
    6: 6 * 3600_000,       # day:6
    5: 6 * 3600_000,       # day:7
}


def _ttl_env_override():
    import json as _json
    raw = os.environ.get("SLICE_TTL_MS_JSON", "")
    if not raw:
        return
    try:
        for k, v in _json.loads(raw).items():
            SLICE_TTL_MS[int(k)] = int(v)
    except Exception:
        pass


_ttl_env_override()

# ── Early-stop cerdas (v4, dipertahankan) ────────────────────────────────
EARLY_STOP_KNOWN_RATIO = 0.70
EARLY_STOP_MIN_PAGE = 2
EARLY_STOP_SKIP_BUCKET_IDS = {1}  # bucket Kemarin selalu penuh (data paling segar)

# ── Bucket harian disjoint (precision pass H-2..H-7) ─────────────────────
# v6: urutan SEGAR-DULU (10→5) dipertahankan.
DAILY_BUCKETS = [
    {"id": 10, "label": "1.5-2d", "min_days": 1.5, "max_days": 2,     "max_pages": 2},
    {"id": 9,  "label": "2-3d",   "min_days": 2,   "max_days": 3,     "max_pages": 2},
    {"id": 8,  "label": "3-4d",   "min_days": 3,   "max_days": 4,     "max_pages": 2},
    {"id": 7,  "label": "4-5d",   "min_days": 4,   "max_days": 5,     "max_pages": 2},
    {"id": 6,  "label": "5-6d",   "min_days": 5,   "max_days": 6,     "max_pages": 2},
    {"id": 5,  "label": "6-7d",   "min_days": 6,   "max_days": 7,     "max_pages": 2},
]

# ── Bucket window utama (disjoint) ───────────────────────────────────────
BUCKETS = [
    {"id": 1, "label": "36jam", "min_days": 0, "max_days": 1.5, "max_pages": 10},
    {"id": 2, "label": "7d", "min_days": 1.5, "max_days": 7, "max_pages": 6},
    {"id": 3, "label": "15d", "min_days": 7, "max_days": 15, "max_pages": 4},
    {"id": 4, "label": "30d", "min_days": 15, "max_days": 30, "max_pages": 3},
]

# ── Default regions/categories (FALLBACK saja — v6 discovery dinamis) ────
# Sumber kebenaran = discovery.py (RSC payload + JS chunk). Cache: discovery.json.
FALLBACK_REGIONS = [
    "US", "ID", "TH", "PH", "MY", "VN", "GB", "MX", "SG", "BR", "ES", "DE", "JP",
]

# ── Blocklist region (permintaan pemilik) ────────────────────────────────
# Negara ini TIDAK boleh di-scrape lagi (data lama sudah dihapus dari DB).
# Diterapkan di scraper.run_job SETELAH discovery — apapun sumbernya
# (live RSC / cache / fallback), region ini selalu disaring keluar.
EXCLUDED_REGIONS = {"MX", "ES", "DE", "SA", "FR", "IT", "BR"}

# 29 kategori asli creatok.ai → product_category_id (fallback discovery)
FALLBACK_CATEGORIES = [
    ("Automotive & Motorcycle", "605196"),
    ("Baby & Maternity", "602284"),
    ("Beauty & Personal Care", "601450"),
    ("Bookings & Vouchers", "2344592"),
    ("Books, Magazines & Audio", "801928"),
    ("Collectibles", "951432"),
    ("Computers & Office Equipment", "601755"),
    ("Fashion Accessories", "605248"),
    ("Food & Beverages", "700437"),
    ("Furniture", "604453"),
    ("Health", "700645"),
    ("Home Improvement", "604968"),
    ("Home Supplies", "600001"),
    ("Household Appliances", "600942"),
    ("Jewelry Accessories & Derivatives", "953224"),
    ("Kids' Fashion", "802184"),
    ("Kitchenware", "600024"),
    ("Luggage & Bags", "824584"),
    ("Menswear & Underwear", "824328"),
    ("Muslim Fashion", "601303"),
    ("Pet Supplies", "602118"),
    ("Phones & Electronics", "601739"),
    ("Shoes", "601352"),
    ("Sports & Outdoor", "603014"),
    ("Textiles & Soft Furnishings", "600154"),
    ("Tools & Hardware", "604579"),
    ("Toys & Hobbies", "604206"),
    ("Virtual Products", "834312"),
    ("Womenswear & Underwear", "601152"),
]

# ── Discovery ────────────────────────────────────────────────────────────
DISCOVERY_TTL_MS = 6 * 3600 * 1000   # refresh daftar region/kategori tiap 6 jam

# ── Enrichment produk TikTok Shop ────────────────────────────────────────
PRODUCT_BATCH = 20
MAX_PRODUCT_LOOKUPS = 8400       # batas lookup produk per job (420 req × 20 batch)
PRODUCT_PHASE_MINUTES = 8        # budget waktu terpisah khusus fase produk
PRODUCT_MAX_REQUESTS = 420       # budget request KHUSUS fase produk (tidak digilas budget sweep)

# ── Session (v7) ─────────────────────────────────────────────────────────
SESSION_MAX_AGE_MS = 6 * 24 * 3600 * 1000  # refresh proaktif sebelum 7 hari
LOGIN_MAX_CONSECUTIVE_FAILS = 3            # → human_required (captcha/2FA/lock)
LOGIN_RETRY_BACKOFF_SEC = 300              # retry login saat human_required (5 mnt)

# ── Hygiene DB ───────────────────────────────────────────────────────────
PRUNE_DAYS = 35                  # buang video tidak terlihat > 35 hari


def slice_ttl_ms(bucket_id: int) -> int:
    """TTL kesegaran slice per bucket (default 6 jam bila bucket tak dikenal)."""
    return SLICE_TTL_MS.get(int(bucket_id), 6 * 3600_000)


def validate() -> list[str]:
    """Validasi konfigurasi saat boot — kembalikan daftar masalah fatal."""
    problems: list[str] = []
    if not EMAIL or not PASSWORD:
        problems.append(
            "CREATOK_EMAIL / CREATOK_PASSWORD kosong — isi file .env di folder service "
            "(kredensial tidak lagi hardcoded di source)."
        )
    return problems

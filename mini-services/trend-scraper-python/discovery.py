"""
Discovery v6.1 — daftar region & kategori DIDISCOVERY DINAMIS dari creatok.ai.

Sumber (terverifikasi probe live):
- Region   → RSC payload halaman /app/trending. Payload terkirim TER-ESCAPE di dalam
  `self.__next_f.push([1,"..."])` → harus didecode unicode_escape DULU, baru regex
  `"regions":{...}` (regex pada HTML mentah PASTI gagal — itu bug v6.0).
- Kategori → JS chunk build yang memuat dictionary product category
  (`604968:{category_id:604968,...,category_name:"...",parent_id:0,...}`), 29 top-level.

Strategi anti-rapuh:
- 2 attempt fetch; cache `discovery.json` selalu disimpan; bila parsing gagal →
  pakai cache terakhir; bila cache kosong → fallback config.FALLBACK_*.
- Perubahan daftar (region/kategori baru) → alert (via store) agar UI tahu.
- Discovery GAGAL tidak pernah menggagalkan job — scrape tetap jalan dengan daftar terakhir.
"""
import json
import os
import re
import time

import requests

import config


class DiscoveryResult(dict):
    @property
    def regions(self) -> list[str]:
        return list(self.get("regions", {}).keys())

    @property
    def categories(self) -> list[tuple[str, str]]:
        return [(c["id"], c["name"]) for c in self.get("categories", [])]

    @property
    def updated_at_ms(self) -> int:
        return int(self.get("updatedAtMs", 0))


_RSC_CHUNK_RE = re.compile(r'self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)')
_REGIONS_RE = re.compile(r'"regions"\s*:\s*\{([^{}]+)\}')
_REGION_ITEM_RE = re.compile(r'"([A-Z]{2})"\s*:\s*"([^"]+)"')
_CHUNK_SRC_RE = re.compile(r'src="(/_next/static/[^"]+\.js)"')
_CATEGORY_RE = re.compile(
    r'(\d{4,8}):\{category_id:\1,[^}]*?category_name:"([^"]+)"[^}]*?parent_id:(\d+)'
)


def load_cached() -> DiscoveryResult | None:
    try:
        with open(config.DISCOVERY_PATH, "r", encoding="utf-8") as f:
            return DiscoveryResult(json.load(f))
    except Exception:
        return None


def _fetch(session: requests.Session, url: str, timeout: int = 25) -> str | None:
    try:
        r = session.get(url, timeout=timeout)
        if r.status_code == 200:
            return r.text
        print(f"[discovery] GET {url[-60:]} → HTTP {r.status_code}")
    except Exception as e:
        print(f"[discovery] GET {url[-60:]} → {str(e)[:80]}")
    return None


def _decode_rsc(html: str) -> str:
    """Gabungkan seluruh chunk RSC `self.__next_f.push([1,"..."])` → payload ter-decode."""
    chunks = _RSC_CHUNK_RE.findall(html)
    out = []
    for c in chunks:
        try:
            out.append(c.encode().decode("unicode_escape", errors="ignore"))
        except Exception:
            continue
    return "".join(out)


def _parse_regions(payload_or_html: str) -> dict[str, str]:
    m = _REGIONS_RE.search(payload_or_html)
    if not m:
        return {}
    return {code: name for code, name in _REGION_ITEM_RE.findall(m.group(1))}


def _parse_categories(js: str) -> list[dict]:
    seen: dict[str, str] = {}
    for cat_id, name, parent in _CATEGORY_RE.findall(js):
        if parent == "0":  # hanya kategori level-1 (yang dipakai filter UI)
            seen[cat_id] = name
    return [{"id": cid, "name": name} for cid, name in sorted(seen.items(), key=lambda kv: kv[1])]


def refresh(client, store=None, force: bool = False) -> DiscoveryResult:
    """Refresh discovery (dengan TTL). SELALU mengembalikan hasil terbaik yang tersedia."""
    cached = load_cached()
    if (
        not force
        and cached
        and time.time() * 1000 - cached.updated_at_ms < config.DISCOVERY_TTL_MS
        and cached.get("regions")
        and cached.get("categories")
    ):
        return cached

    result: DiscoveryResult | None = None
    last_reason = "unknown"
    # 2 attempt (transient network / 500 sumber)
    for attempt in (1, 2):
        try:
            s = client.session_for_discovery() if client else requests.Session()
            html = _fetch(s, f"{config.BASE_URL}/app/trending")
            if not html:
                last_reason = f"attempt {attempt}: page fetch gagal"
                time.sleep(2)
                continue

            # ── Region: decode RSC payload dulu (HTML mentah ter-escape) ──
            payload = _decode_rsc(html)
            regions = _parse_regions(payload) or _parse_regions(html)

            # ── Kategori: cari chunk JS yang memuat dictionary category_id ──
            categories: list[dict] = []
            for src in _CHUNK_SRC_RE.findall(html):
                js = _fetch(s, f"{config.BASE_URL}{src}", timeout=20)
                if js and "category_id:" in js:
                    categories = _parse_categories(js)
                    if categories:
                        break

            if regions and categories:
                result = DiscoveryResult({
                    "regions": regions,
                    "categories": categories,
                    "updatedAtMs": int(time.time() * 1000),
                    "source": "live",
                })
                break
            last_reason = (f"attempt {attempt}: regions={len(regions)} "
                           f"categories={len(categories)}")
        except Exception as e:
            last_reason = f"attempt {attempt}: exc {str(e)[:120]}"
        time.sleep(2)

    if result is None:
        print(f"[discovery] gagal live ({last_reason}) — pakai cache/fallback")
        if cached and cached.get("regions") and cached.get("categories"):
            result = DiscoveryResult({**cached, "source": "cache"})
        else:
            result = DiscoveryResult({
                "regions": {r: r for r in config.FALLBACK_REGIONS},
                "categories": [{"id": cid, "name": name} for name, cid in config.FALLBACK_CATEGORIES],
                "updatedAtMs": int(time.time() * 1000),
                "source": "fallback",
            })

    # Bandingkan dengan cache lama → alert bila ada region/kategori baru
    if store is not None:
        try:
            old_regions = set((cached or {}).get("regions", {}).keys()) if cached else set()
            old_cats = {c["id"] for c in (cached or {}).get("categories", [])} if cached else set()
            new_regions = set(result.regions) - old_regions
            new_cats = {c["id"] for c in result.get("categories", [])} - old_cats
            if new_regions:
                store.insert_alert(
                    "info", "data",
                    f"Region baru terdeteksi di sumber: {', '.join(sorted(new_regions))} — "
                    "akan masuk jadwal scrape otomatis.",
                )
            if new_cats:
                store.insert_alert(
                    "info", "data",
                    f"{len(new_cats)} kategori baru terdeteksi di sumber — otomatis ditambahkan.",
                )
        except Exception:
            pass

    # Simpan cache (atomic)
    try:
        tmp = config.DISCOVERY_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False)
        os.replace(tmp, config.DISCOVERY_PATH)
    except Exception as e:
        print(f"[discovery] gagal menyimpan cache: {e}")

    print(f"[discovery] regions={len(result.regions)} "
          f"categories={len(result.get('categories', []))} source={result.get('source')}")
    return result

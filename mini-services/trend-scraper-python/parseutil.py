"""Utilitas parsing metrik creatok.ai ("4.1M" → 4100000, durasi, hashtags, skor)."""
import re

_HASHTAG_RE = re.compile(r"#[\w\u00C0-\u024F]+", re.UNICODE)
_VIDEO_ID_RE = re.compile(r"/video/(\d+)")


def parse_count(v) -> int:
    """Parse "4.1M" / "37.9K" / "1,234" / 123 → int."""
    if v is None:
        return 0
    if isinstance(v, (int, float)):
        return int(v)
    s = str(v).strip().replace(",", "")
    m = re.match(r"^([\d.]+)\s*([KMB])?$", s, re.IGNORECASE)
    if not m:
        return 0
    mult = {"k": 1_000, "m": 1_000_000, "b": 1_000_000_000}.get(
        (m.group(2) or "").lower(), 1
    )
    try:
        return int(float(m.group(1)) * mult)
    except ValueError:
        return 0


def video_id_from_url(url) -> str | None:
    """ID TikTok presisi penuh diekstrak dari video_url (hindari precision loss)."""
    if not url:
        return None
    m = _VIDEO_ID_RE.search(str(url))
    return m.group(1) if m else None


def duration_to_sec(d) -> int:
    """'01:01' → 61; 'HH:MM:SS' didukung."""
    if not d:
        return 0
    parts = str(d).split(":")
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return 0
    if len(nums) == 3:
        return nums[0] * 3600 + nums[1] * 60 + nums[2]
    if len(nums) == 2:
        return nums[0] * 60 + nums[1]
    return nums[0] if nums else 0


def extract_hashtags(caption: str) -> str:
    tags = _HASHTAG_RE.findall(caption or "")
    return ",".join(t.lstrip("#") for t in tags[:12])


def compute_score(views: int, likes: int, sales: int, gmv: float, duration_sec: int) -> float:
    """Skor trending komposit 0-100+ (log-scaled, sales & engagement weighted)."""
    lg = lambda n: __import__("math").log10(max(n, 10))
    return round(
        lg(views) * 30
        + lg(likes) * 25
        + lg(sales) * 20
        + lg(max(gmv, 1)) * 15
        + (10 if 0 < duration_sec <= 60 else 4),
        2,
    )

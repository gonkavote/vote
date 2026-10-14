"""Open Graph preview images for shared links.

A link to a community proposal or a governance proposal shows, in Telegram,
X and the like, a 1200x630 card with that proposal's own data instead of the
generic site picture: the shared background, the logo with a glow, "Gonka
Vote", and the proposal's key facts. The same look as the cards of the
Gonka VIP tracker (gonka.vip).

og.py points og:image of those pages at /api/og/<kind>/<id>.png. Only
crawlers fetch these, once per link, so each card is drawn once and kept in
memory for a while; Cloudflare caches the PNGs in front of that. Live
numbers (reactions, tallies) stay off an open proposal's card: a preview
keeps its picture for days, and they would go stale within hours.
"""

from __future__ import annotations

import asyncio
import io
import re
import time
from collections import OrderedDict
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import List, Optional, Tuple

from PIL import Image, ImageDraw, ImageFilter, ImageFont

_ASSETS = Path(__file__).parent / "og_assets"

W, H = 1200, 630
PAD = 64

WHITE = (241, 245, 249)
MUTED = (148, 163, 184)
DIM = (100, 116, 139)
ACCENT = (59, 130, 246)
GREEN = (52, 211, 153)
RED = (248, 113, 113)
AMBER = (251, 191, 36)


# ---------------------------------------------------------------- drawing


@lru_cache(maxsize=None)
def _font(weight: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(_ASSETS / f"Inter-{weight}.ttf"), size)


@lru_cache(maxsize=1)
def _bg() -> Image.Image:
    return Image.open(_ASSETS / "bg.jpg").convert("RGB").resize((W, H))


@lru_cache(maxsize=4)
def _logo(size: int) -> Image.Image:
    return Image.open(_ASSETS / "logo.png").convert("RGBA").resize((size, size), Image.LANCZOS)


def _glow(img: Image.Image, center: Tuple[int, int], radius: int,
          color: Tuple[int, int, int], alpha: int) -> None:
    """A soft radial light behind the logo, as on the site's original card."""
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = center
    d.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=color + (alpha,))
    layer = layer.filter(ImageFilter.GaussianBlur(radius * 0.45))
    img.alpha_composite(layer)


def _text_w(font: ImageFont.FreeTypeFont, text: str) -> int:
    return int(font.getlength(text))


def _brand(d: ImageDraw.ImageDraw, x: int, y: int, size: int) -> int:
    """'Gonka Vote' with Vote in the accent blue; returns the width."""
    f = _font("Bold", size)
    d.text((x, y), "Gonka ", font=f, fill=WHITE)
    x2 = x + _text_w(f, "Gonka ")
    d.text((x2, y), "Vote", font=f, fill=ACCENT)
    return x2 + _text_w(f, "Vote") - x


def _wrap(text: str, font: ImageFont.FreeTypeFont, width: int, max_lines: int) -> List[str]:
    words = text.split()
    lines: List[str] = []
    cur = ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if _text_w(font, trial) <= width:
            cur = trial
            continue
        if cur:
            lines.append(cur)
        cur = w
        while _text_w(font, cur) > width:  # a single over-long word
            cut = len(cur)
            while cut > 1 and _text_w(font, cur[:cut]) > width:
                cut -= 1
            lines.append(cur[:cut])
            cur = cur[cut:]
    if cur:
        lines.append(cur)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[-1]
        while last and _text_w(font, last + "…") > width:
            last = last[:-1].rstrip()
        lines[-1] = last + "…"
    return lines


def _fit_title(text: str, width: int, sizes=(64, 56, 48, 42), max_lines: int = 2):
    """Largest size at which the title fits in max_lines; else truncate."""
    for size in sizes:
        f = _font("Bold", size)
        lines = _wrap(text, f, width, 99)
        if len(lines) <= max_lines:
            return f, lines
    f = _font("Bold", sizes[-1])
    return f, _wrap(text, f, width, max_lines)


def _pill(d: ImageDraw.ImageDraw, x: int, y: int, text: str,
          color: Tuple[int, int, int], size: int = 24) -> int:
    f = _font("SemiBold", size)
    tw = _text_w(f, text)
    h = size + 20
    d.rounded_rectangle((x, y, x + tw + 36, y + h), radius=h // 2,
                        fill=tuple(int(c * 0.18) for c in color), outline=color, width=2)
    d.text((x + 18, y + h // 2), text, font=f, fill=color, anchor="lm")
    return tw + 36


def _base(kind_label: str, footer: str) -> Tuple[Image.Image, ImageDraw.ImageDraw]:
    img = _bg().copy().convert("RGBA")
    logo = 76
    _glow(img, (PAD + logo // 2, 52 + logo // 2), 78, (59, 130, 246), 80)
    img.alpha_composite(_logo(logo), (PAD, 52))
    d = ImageDraw.Draw(img)
    _brand(d, PAD + logo + 22, 52 + logo // 2 - 27, 44)
    f = _font("SemiBold", 24)
    d.text((W - PAD, 52 + logo // 2), kind_label.upper(), font=f, fill=MUTED, anchor="rm")
    d.text((PAD, H - 50), footer, font=_font("Medium", 24), fill=DIM, anchor="ls")
    return img, d


def _rows(d: ImageDraw.ImageDraw, y: int, rows: List[Tuple[str, str]],
          cols: int = 2, row_h: int = 78) -> None:
    col_w = (W - 2 * PAD) // cols
    kf, vf = _font("Medium", 22), _font("SemiBold", 32)
    for i, (k, v) in enumerate(rows):
        x = PAD + (i % cols) * col_w
        yy = y + (i // cols) * row_h
        d.text((x, yy), k, font=kf, fill=MUTED)
        val = v
        while val and _text_w(vf, val) > col_w - 24:
            val = val[:-2] + "…" if not val.endswith("…") else val[:-2] + "…"
        d.text((x, yy + 28), val, font=vf, fill=WHITE)


def _png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "PNG", optimize=True)
    return buf.getvalue()


def draw_card(kind_label: str, title: str, *, status: Optional[Tuple[str, tuple]] = None,
              subtitle: str = "", rows: List[Tuple[str, str]] = (), footer: str = "",
              tally: Optional[List[Tuple[str, float, tuple]]] = None,
              badges: List[str] = (), avatar: Optional[Image.Image] = None) -> bytes:
    img, d = _base(kind_label, footer)
    width = W - 2 * PAD
    tx = PAD
    if avatar is not None:
        # A member's picture, round, left of the name.
        size = 112
        av = avatar.convert("RGBA").resize((size, size), Image.LANCZOS)
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
        img.paste(av, (PAD, 172), mask)
        d.ellipse((PAD, 172, PAD + size - 1, 172 + size - 1), outline=(51, 65, 85), width=3)
        tx = PAD + size + 28
        width = W - PAD - tx
    tf, lines = _fit_title(title, width, max_lines=3 if tally or badges else 2)
    y = 168
    if avatar is not None and len(lines) == 1:
        y = 172 + 56 - int(tf.size * 0.6)  # centred on the picture
    for line in lines:
        d.text((tx, y), line, font=tf, fill=WHITE)
        y += int(tf.size * 1.18)
    if avatar is not None:
        y = max(y, 172 + 112 + 6)
    y += 14
    x = PAD
    if status:
        x += _pill(d, x, y, status[0], status[1]) + 18
    if subtitle:
        sf = _font("Medium", 28)
        sub = subtitle
        while sub and _text_w(sf, sub) > W - PAD - x:
            sub = sub[:-2] + "…"
        d.text((x, y + 22), sub, font=sf, fill=MUTED, anchor="lm")
    if status or subtitle:
        y += 66
    if tally is not None:
        _tally(d, max(y + 6, 400), tally)
    elif badges:
        _badges(d, y + 10, list(badges))
    elif rows:
        _rows(d, max(y + 8, 330), list(rows))
    return _png(img)


def _badges(d: ImageDraw.ImageDraw, y: int, labels: List[str]) -> None:
    """Message-type badges, as on the proposal page; wrap up to two lines."""
    f = _font("SemiBold", 22)
    h, gap, x = 42, 12, PAD
    for i, label in enumerate(labels):
        w = _text_w(f, label) + 32
        if x + w > W - PAD:
            if y > 470:  # no room for a third line
                rest = len(labels) - i
                d.text((x, y + h // 2), f"+{rest} MORE", font=f, fill=MUTED, anchor="lm")
                return
            x, y = PAD, y + h + gap
        d.rounded_rectangle((x, y, x + w, y + h), radius=8, fill=(30, 41, 59), outline=(51, 65, 85), width=2)
        d.text((x + 16, y + h // 2), label, font=f, fill=(203, 213, 225), anchor="lm")
        x += w + gap


def _tally(d: ImageDraw.ImageDraw, y: int, parts: List[Tuple[str, float, tuple]]) -> None:
    width = W - 2 * PAD
    total = sum(p for _, p, _ in parts)
    d.rounded_rectangle((PAD, y, PAD + width, y + 20), radius=10, fill=(30, 41, 59))
    if total > 0:
        x = PAD
        drawn = [(c, width * p / total) for _, p, c in parts if p > 0]
        for i, (c, w) in enumerate(drawn):
            x2 = PAD + width if i == len(drawn) - 1 else x + w
            if x2 - x >= 1:
                d.rounded_rectangle((x, y, x2, y + 20), radius=10 if len(drawn) == 1 else 4, fill=c)
            x = x2
    lf, vf = _font("Medium", 24), _font("SemiBold", 30)
    col_w = width // len(parts)
    for i, (label, p, c) in enumerate(parts):
        x = PAD + i * col_w
        d.ellipse((x, y + 48, x + 14, y + 62), fill=c)
        d.text((x + 24, y + 55), label, font=lf, fill=MUTED, anchor="lm")
        pct = f"{100 * p / total:.1f}%" if total > 0 else "—"
        d.text((x, y + 80), pct, font=vf, fill=WHITE)


async def _draw(*args, **kwargs) -> bytes:
    # Off the event loop: a card takes tens of milliseconds of CPU.
    return await asyncio.to_thread(draw_card, *args, **kwargs)


def draw_page(eyebrow: str, title: str, desc: str, chips: List[str], *,
              logo: int = 300, brand: int = 46, lx: int = 70,
              title_sizes: Tuple[int, ...] = (58, 52, 46, 40)) -> bytes:
    """A section's card (stats, explorer, ...): big logo left, the section right."""
    img = _bg().copy().convert("RGBA")
    ly = (H - (logo + 26 + brand)) // 2 - 8
    cx, cy = lx + logo // 2, ly + logo // 2
    _glow(img, (cx, cy), logo * 5 // 6, (44, 72, 120), 200)
    _glow(img, (cx, cy), logo * 8 // 15, (59, 130, 246), 95)
    img.alpha_composite(_logo(logo), (lx, ly))
    d = ImageDraw.Draw(img)
    bw = _text_w(_font("Bold", brand), "Gonka Vote")
    _brand(d, cx - bw // 2, ly + logo + 26, brand)

    x = lx + logo + 80
    width = W - x - 60
    ef, df, cf = _font("SemiBold", 24), _font("Medium", 26), _font("SemiBold", 21)
    tf, lines = _fit_title(title, width, sizes=title_sizes, max_lines=3)
    dlines = _wrap(desc, df, width, 3) if desc else []
    # Lay the chips out first so the whole block can be centred on the
    # logo column.
    h, gap = 40, 10
    rows_x: List[List[Tuple[str, int, int]]] = [[]]
    cxp = x
    for chip in chips:
        w = _text_w(cf, chip) + 30
        if cxp + w > W - 60 and rows_x[-1]:
            rows_x.append([])
            cxp = x
        rows_x[-1].append((chip, cxp, w))
        cxp += w + gap
    line_h = int(tf.size * 1.16)
    eyebrow_h = 42 if eyebrow else 0
    desc_h = 14 + len(dlines) * 36 + 26 if dlines else 30
    block_h = eyebrow_h + len(lines) * line_h + desc_h + len(rows_x) * (h + gap) - gap
    col_mid = (ly + ly + logo + 26 + brand) // 2
    y = col_mid - block_h // 2
    d.line((x - 40, y - 6, x - 40, y + block_h + 6), fill=(51, 65, 85), width=2)
    if eyebrow:
        d.text((x, y), eyebrow.upper(), font=ef, fill=ACCENT)
        y += eyebrow_h
    for line in lines:
        d.text((x, y), line, font=tf, fill=WHITE)
        y += line_h
    if dlines:
        y += 14
        for line in dlines:
            d.text((x, y), line, font=df, fill=MUTED)
            y += 36
        y += 26
    else:
        y += 30
    for row in rows_x:
        for chip, cxp, w in row:
            d.rounded_rectangle((cxp, y, cxp + w, y + h), radius=h // 2, fill=(30, 41, 59), outline=(51, 65, 85), width=2)
            d.text((cxp + 15, y + h // 2), chip, font=cf, fill=(203, 213, 225), anchor="lm")
        y += h + gap
    d.text((W - 60, H - 44), "gonka.vote", font=_font("SemiBold", 24), fill=DIM, anchor="rs")
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=92)
    return buf.getvalue()


def draw_home() -> bytes:
    """The site-wide card (home page and every page without its own)."""
    return draw_page(
        "",
        "Community proposals & on-chain governance",
        "",
        ["Proposals", "Discussion", "GNK-weighted polls", "Governance", "Translations"],
        title_sizes=(56, 52, 48),
    )


# ---------------------------------------------------------------- formatting


def _short(s: str, head: int = 10, tail: int = 6) -> str:
    return s if len(s) <= head + tail + 1 else f"{s[:head]}…{s[-tail:]}"


def _name(moniker: Optional[str]) -> Optional[str]:
    # Some validators carry their valoper address as the moniker; not a name.
    if not moniker or moniker.startswith("gonkavaloper1"):
        return None
    return moniker


def _gnk(ngonka: Optional[int]) -> str:
    if ngonka is None:
        return "—"
    g = ngonka / 1e9
    if g == 0:
        return "0 GNK"
    if abs(g) >= 1000:
        return f"{g:,.0f} GNK"
    if abs(g) >= 1:
        return f"{g:,.2f}".rstrip("0").rstrip(".") + " GNK"
    return f"{g:.9f}".rstrip("0").rstrip(".") + " GNK"


def _when(ts) -> str:
    """'Oct 8, 2026 23:34 UTC' from a datetime (naive = UTC) or an ISO string."""
    if not ts:
        return "—"
    try:
        if isinstance(ts, datetime):
            dt = ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
            dt = dt.astimezone(timezone.utc)
        else:
            dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00")).astimezone(timezone.utc)
        return dt.strftime("%b %-d, %Y %H:%M UTC")
    except ValueError:
        return str(ts)[:16]




def _utc(ts) -> Optional[datetime]:
    """A datetime (naive = UTC) or ISO string as an aware UTC datetime."""
    if isinstance(ts, str) and ts:
        try:
            ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(ts, datetime):
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


def _usd(n: int) -> str:
    return f"{n:,} USDT"


def _msg_badge(type_url: str) -> str:
    # As msgTypeShort in frontend/src/lib/msgTypes.ts: "PUT DEVSHARD APPROVED VERSION".
    tail = type_url.split(".")[-1] or type_url
    if tail.startswith("Msg"):
        tail = tail[3:]
    return re.sub(r"([A-Z])", r" \1", tail).strip().upper()


# ---------------------------------------------------------------- cards


def proposal_closed(row: dict) -> bool:
    """As the proposal page: closed, or open past its closing time (the
    indexer flips the status a few minutes later)."""
    if (row.get("status") or "") == "closed":
        return True
    closes = _utc(row.get("closes_at"))
    return bool(closes and closes <= datetime.now(timezone.utc))


async def card_proposal(row: dict) -> bytes:
    """A community proposal: what it asks for, by whom, until when; the
    GNK-weighted result only once it has closed."""
    closed = proposal_closed(row)
    status = ("Closed", MUTED) if closed else ("Open", ACCENT)
    closes = row.get("closes_at")
    if closes:
        sub = f"{'Closed' if closed else 'Closes'} {_when(closes)}"
    else:
        sub = f"Created {_when(row.get('created_at'))}"
    rows: List[Tuple[str, str]] = []
    usdt = int(row.get("requested_amount_usdt") or 0)
    gnk = int(row.get("requested_amount_gnk") or 0)
    if usdt or gnk:
        rows.append(("Requested", " + ".join(
            x for x in (_usd(usdt) if usdt else "", f"{gnk:,} GNK" if gnk else "") if x)))
    if row.get("creator_name"):
        rows.append(("Author", str(row["creator_name"])))
    if len(rows) < 2:
        rows.append(("Created", _when(row.get("created_at"))))
    tally = None
    if closed:
        yes = int(row.get("likes_weight") or 0)
        no = int(row.get("dislikes_weight") or 0)
        if yes + no > 0:
            tally = [("For", yes, (16, 185, 129)), ("Against", no, (239, 68, 68))]
    slug = row.get("short_id") or row.get("id")
    return await _draw("Community proposal", row.get("title") or "Untitled", status=status,
                       subtitle=sub, rows=rows, tally=tally,
                       footer=f"gonka.vote/proposal/{slug}")


_GOV_STATUS = {
    "passed": ("Passed", GREEN),
    "rejected": ("Rejected", RED),
    "failed": ("Failed", RED),
    "voting": ("Voting", ACCENT),
    "deposit": ("Deposit period", AMBER),
}


async def card_governance(row: dict) -> bytes:
    """An on-chain proposal, as on the tracker: while live, what it would
    execute; once decided, the final tally."""
    st = (row.get("status") or "").lower()
    status = _GOV_STATUS.get(st, (st.title() or "Unknown", MUTED))
    live = st in ("voting", "deposit")
    if st == "voting" and row.get("voting_end_time"):
        sub = f"Voting ends {_when(row['voting_end_time'])}"
    elif not live and row.get("voting_end_time"):
        sub = f"Voting ended {_when(row['voting_end_time'])}"
    else:
        sub = f"Submitted {_when(row.get('submit_time'))}"
    tally, badges = None, []
    if live:
        counts: dict = {}
        for t in row.get("msg_types") or []:
            counts[t] = counts.get(t, 0) + 1
        badges = [_msg_badge(t) + (f" ×{c}" if c > 1 else "") for t, c in counts.items()]
    else:
        tally = [("Yes", int(row.get("yes_count") or 0), (16, 185, 129)),
                 ("No", int(row.get("no_count") or 0), (239, 68, 68)),
                 ("Abstain", int(row.get("abstain_count") or 0), (245, 158, 11)),
                 ("Veto", int(row.get("veto_count") or 0), (236, 72, 153))]
    pid = int(row["proposal_id"])
    return await _draw(f"Proposal #{pid}", row.get("title") or "Untitled", status=status,
                       subtitle=sub, tally=tally, badges=badges,
                       footer=f"gonka.vote/governance/{pid}")


def _initial_avatar(name: str) -> Image.Image:
    """The member's initial on the accent gradient, when there is no picture."""
    size = 224
    im = Image.new("RGBA", (size, size))
    d = ImageDraw.Draw(im)
    for i in range(size):  # diagonal-ish gradient, top to bottom
        t = i / size
        c = tuple(int(a + (b - a) * t) for a, b in zip((59, 130, 246), (192, 132, 252)))
        d.line((0, i, size, i), fill=c + (255,))
    ch = (name.strip()[:1] or "?").upper()
    d.text((size // 2, size // 2), ch, font=_font("Bold", 120), fill=WHITE, anchor="mm")
    return im


async def card_member(profile: dict, picture: Optional[bytes]) -> bytes:
    """A member's profile: name and picture, proposals made, GNK weight
    behind their votes."""
    name = (profile.get("name") or "").strip() or "Gonka Vote member"
    avatar = None
    if picture:
        try:
            avatar = Image.open(io.BytesIO(picture))
            avatar.load()
        except Exception:
            avatar = None
    if avatar is None:
        avatar = _initial_avatar(name)
    rows: List[Tuple[str, str]] = []
    n = int(profile.get("proposals") or 0)
    rows.append(("Proposals", f"{n:,}"))
    rows.append(("Voting weight", _gnk(int(profile.get("weight") or 0))))
    wallet = profile.get("wallet_address") or ""
    return await _draw("Member", name, subtitle=_short(wallet, 12, 6) if wallet else "",
                       rows=rows, avatar=avatar,
                       footer=f"gonka.vote/u/{profile.get('uid', '')}")


# ---------------------------------------------------------------- cache

# Drawn cards by key, with the time drawn. A card is redrawn after its TTL:
# a live proposal's changes once (when it closes), so ten minutes is plenty.
_cache: "OrderedDict[str, Tuple[float, bytes]]" = OrderedDict()
_MAX = 300
TTL_LIVE = 600.0
TTL_FINAL = 86400.0
_locks: dict = {}


async def cached(key: str, ttl: float, make) -> bytes:
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        _cache.move_to_end(key)
        return hit[1]
    lock = _locks.setdefault(key, asyncio.Lock())
    async with lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        data = await make()
        _cache[key] = (time.time(), data)
        _cache.move_to_end(key)
        while len(_cache) > _MAX:
            _cache.popitem(last=False)
    _locks.pop(key, None)
    return data


# Cards for the site's own pages, served as static files from
# frontend/public/images/preview/ (redrawn by running this module).
PAGES = {
    "new-proposal": ("New proposal", "Propose an idea to the Gonka community",
                     "Describe it, request funding in USDT or GNK, and let GNK holders weigh in.",
                     ["Idea", "Funding request", "Discussion", "GNK-weighted poll"]),
    "governance": ("Governance", "Gonka on-chain governance",
                   "Every governance proposal, translated, with discussion and the votes cast.",
                   ["Upgrades", "Parameters", "Community spending", "Votes"]),
}


if __name__ == "__main__":
    import sys

    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for name, args in PAGES.items():
        (out / f"{name}.jpg").write_bytes(draw_page(*args))
        print(out / f"{name}.jpg")
    # gonka-vote.jpg: the home page card, also the site's prev.jpg.
    (out / "gonka-vote.jpg").write_bytes(draw_home())
    print(out / "gonka-vote.jpg")

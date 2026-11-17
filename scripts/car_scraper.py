"""Parse saved JaCars pages or fetch a bounded snapshot with Scrapling.

Needs: pip install -r requirements-scraper.txt, then `scrapling install` once for the browser.
  python scripts/car_scraper.py parse jacars saved_page.html            -> JSON list of listings
  python scripts/car_scraper.py fetch jacars --output data/cars.json    -> {items, fetched, source, pages}
fetch reads at most 5 pages per model, one at a time, 5+ seconds apart. A blocked run keeps the last snapshot.
"""
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlsplit
import argparse
import json
import math
import os
import random
import re
import sys
import tempfile
import time

from scrapling.parser import Selector

MODELS = {
    'civic': re.compile(r'\bhonda\s+civic\b|\bcivic\b', re.I),
    'gt86': re.compile(r'\b(?:toyota\s+)?(?:gt|ft)\s?-?86\b|\btoyota\s+86\b', re.I),
}
MULTI = re.compile(r'\b(hrv|hr-v|vezel|odyssey|spada|voxy|noah|stepwagon|step wagon|crv|cr-v|rav4|chr|c-hr|fit|accord|axio|'
                   r'fielder|biante|isis|premio|allion)\b', re.I)
PARTS = re.compile(r'\bparts?\b|\bengine\b|\bwrecking\b|\bbody kit\b', re.I)
LHD = re.compile(r'\b(left[\s-]*hand[\s-]*drive|lhd|left[\s-]*hand)\b', re.I)
YEAR = re.compile(r'\b(19[89]\d|20[0-3]\d)\b')
PRICE_RANGE = (200_000, 60_000_000)  # JMD; outside this a "price" is a deposit, a part or a typo
SEARCHES = {
    'civic': 'https://www.jacars.net/cars/honda/civic/',
    'gt86': 'https://www.jacars.net/cars/toyota/86/',
}


@dataclass(frozen=True)
class Listing:
    src: str
    id: str
    url: str
    title: str
    price: int | None  # JMD
    year: int | None
    where: str
    posted: str  # as the site words it, e.g. "3 days ago"
    model: str | None  # a key of MODELS
    lhd: bool
    promoted: bool  # paid placement, shown first whatever its age


def is_parts(text):
    return len(MULTI.findall(text)) >= 2 or bool(PARTS.search(text))


def model_of(text):
    return next((key for key, pattern in MODELS.items() if pattern.search(text)), None)


def jmd_price(digits, currency):
    if currency != 'JMD' or not str(digits or '').isdigit():
        return None
    value = int(digits)
    return value if PRICE_RANGE[0] <= value < PRICE_RANGE[1] else None


def listing_data(html):
    """A JaCars listing page carries its ads as JSON in the Next.js __NEXT_DATA__ script."""
    script = Selector(html).css('script#__NEXT_DATA__::text').get()
    if not script:
        raise ValueError('No __NEXT_DATA__ script in this page; it is not a JaCars listing page or its layout changed.')
    try:
        listing = json.loads(script)['props']['pageProps']['initialState']['adverts']['listing']
        adverts = listing['adverts']
    except (KeyError, TypeError, json.JSONDecodeError) as error:
        raise ValueError(f'__NEXT_DATA__ has no adverts list (missing {error}); the page layout changed.') from None
    if not isinstance(adverts, list) or any(not isinstance(ad, dict) or not ad.get('id') for ad in adverts):
        raise ValueError('__NEXT_DATA__ has an invalid adverts list; the page layout changed.')
    return listing


def parse_jacars(html, base_url='https://www.jacars.net/'):
    adverts = listing_data(html)['adverts']
    out = []
    for ad in adverts:
        title = (ad.get('title') or '').strip()
        text = f"{title} {ad.get('description') or ''}"
        if is_parts(text):
            continue
        out.append(Listing(
            src='JaCars', id=f"jc:{ad['id']}", url=urljoin(base_url, ad.get('url') or ''), title=title,
            price=jmd_price(ad.get('price_without_currency'), ad.get('currency')),
            year=int(m.group(1)) if (m := YEAR.search(title)) else None,
            where=ad.get('location') or '', posted=ad.get('published') or '', model=model_of(text),
            lhd=bool(LHD.search(text)), promoted=(ad.get('ad_type') or {}).get('type') == 'premium'))
    return out


PARSERS = {'jacars': parse_jacars}


def scrape_jacars(models=None, pages=2, delay=8.0, timeout=45000, real_chrome=False):
    """Reuse one hidden browser; stop on blocks or malformed pages, without publishing partial data."""
    models = list(dict.fromkeys(models if models is not None else SEARCHES))
    if not models or any(model not in SEARCHES for model in models):
        raise ValueError('Choose civic and/or gt86.')
    if not 1 <= pages <= 5:
        raise ValueError('pages must be between 1 and 5 per model.')
    if not math.isfinite(delay) or delay < 5:
        raise ValueError('delay must be at least 5 seconds.')
    if not 1000 <= timeout <= 120000:
        raise ValueError('timeout must be between 1000 and 120000 milliseconds.')
    try:
        from scrapling.fetchers import StealthySession
    except ImportError as error:
        raise RuntimeError('Install requirements-scraper.txt and run `scrapling install`.') from error

    items, seen, requested = [], set(), []
    # No parallel tabs, proxy rotation, or retry loops. Browser identity and cookies
    # remain consistent for the whole run. A residual challenge aborts the snapshot.
    with StealthySession(headless=True, real_chrome=real_chrome, max_pages=1,
                         timeout=timeout, retries=1, google_search=False,
                         solve_cloudflare=True) as session:
        for model in models:
            search = SEARCHES[model]
            previous_ids = set()
            for number in range(1, pages + 1):
                url = search if number == 1 else f'{search}?page={number}'
                if requested:
                    time.sleep(delay + random.uniform(0, 3))
                print(f'Fetching {model} page {number}/{pages}', file=sys.stderr)
                response = session.fetch(url)
                requested.append(url)
                if response.status != 200:
                    raise RuntimeError(f'JaCars returned HTTP {response.status}; stopping without replacing the snapshot.')
                final = urlsplit(response.url)
                if final.scheme != 'https' or final.hostname not in ('www.jacars.net', 'jacars.net') or final.path != urlsplit(search).path:
                    raise RuntimeError('JaCars redirected away from the requested search; stopping.')
                html = response.html_content
                listing = listing_data(html)
                ids = {str(ad['id']) for ad in listing['adverts']}
                if not ids or ids <= previous_ids:
                    break
                previous_ids.update(ids)
                for item in parse_jacars(html):
                    if item.model == model and item.id not in seen:
                        seen.add(item.id)
                        items.append(asdict(item))
                if 'next_page' in listing and listing['next_page'] in (None, False, ''):
                    break
    return {'items': items, 'fetched': datetime.now(timezone.utc).isoformat(),
            'source': 'JaCars', 'pages': requested}


def write_snapshot(path, snapshot):
    """Replace only after a complete scrape and a successful file write."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                         prefix=f'.{path.name}.', suffix='.tmp', delete=False) as out:
            temporary = Path(out.name)
            json.dump(snapshot, out, ensure_ascii=False, indent=2)
            out.write('\n')
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Parse saved car listings or fetch JaCars with Scrapling.')
    sub = parser.add_subparsers(dest='command', required=True)
    parse = sub.add_parser('parse')
    parse.add_argument('source', choices=sorted(PARSERS))
    parse.add_argument('path')
    fetch = sub.add_parser('fetch')
    fetch.add_argument('source', choices=['jacars'])
    fetch.add_argument('--model', action='append', choices=sorted(SEARCHES), help='Repeat to select models; default: both.')
    fetch.add_argument('--pages', type=int, default=2, help='Maximum pages per model (1-5).')
    fetch.add_argument('--delay', type=float, default=8, help='Seconds between pages, plus jitter (minimum 5).')
    fetch.add_argument('--timeout', type=int, default=45000, help='Browser timeout in milliseconds.')
    fetch.add_argument('--real-chrome', action='store_true', help='Use installed Google Chrome.')
    fetch.add_argument('--output', type=Path, help='Atomically write a snapshot; otherwise print JSON.')
    args = parser.parse_args(argv)
    try:
        if args.command == 'parse':
            with open(args.path, encoding='utf-8') as page:
                payload = [asdict(x) for x in PARSERS[args.source](page.read())]
        else:
            payload = scrape_jacars(args.model, args.pages, args.delay, args.timeout, args.real_chrome)
            if args.output:
                write_snapshot(args.output, payload)
                print(f"Saved {len(payload['items'])} listings to {args.output}", file=sys.stderr)
                return
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(1, f'{error}\n')
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=1)
    print()


if __name__ == '__main__':
    main()

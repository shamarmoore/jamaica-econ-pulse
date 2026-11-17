"""Car listings: parse saved listing pages into the same item shape the app's car list uses (www/js/cars.js).

Parsing only. Nothing in this file fetches a website; which source to read, and how, is still being decided.
Needs: pip install -r requirements-scraper.txt (Scrapling's HTML parser only, no browsers).
  python scripts/car_scraper.py parse jacars saved_page.html   -> JSON list of listings on stdout
"""
from dataclasses import asdict, dataclass
from urllib.parse import urljoin
import argparse
import json
import re
import sys

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


def parse_jacars(html, base_url='https://www.jacars.net/'):
    """A JaCars listing page carries its ads as JSON in the Next.js __NEXT_DATA__ script."""
    script = Selector(html).css('script#__NEXT_DATA__::text').get()
    if not script:
        raise ValueError('No __NEXT_DATA__ script in this page; it is not a JaCars listing page or its layout changed.')
    try:
        adverts = json.loads(script)['props']['pageProps']['initialState']['adverts']['listing']['adverts']
    except (KeyError, TypeError) as error:
        raise ValueError(f'__NEXT_DATA__ has no adverts list (missing {error}); the page layout changed.') from None
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


def main(argv=None):
    parser = argparse.ArgumentParser(description='Parse a saved car listing page.')
    sub = parser.add_subparsers(dest='command', required=True)
    parse = sub.add_parser('parse')
    parse.add_argument('source', choices=sorted(PARSERS))
    parse.add_argument('path')
    args = parser.parse_args(argv)
    with open(args.path, encoding='utf-8') as page:
        listings = PARSERS[args.source](page.read())
    json.dump([asdict(x) for x in listings], sys.stdout, ensure_ascii=False, indent=1)
    print()


if __name__ == '__main__':
    main()

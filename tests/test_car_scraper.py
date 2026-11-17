from pathlib import Path
from unittest import mock
import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import car_scraper as cs  # noqa: E402

PAGE = (ROOT / 'tests' / 'fixtures' / 'jacars_listing.html').read_text(encoding='utf-8')


class JaCarsParserTests(unittest.TestCase):
    def setUp(self):
        self.by_id = {x.id: x for x in cs.parse_jacars(PAGE)}

    def test_parts_ads_are_dropped_and_the_rest_kept_in_page_order(self):
        self.assertEqual(list(self.by_id), ['jc:1000001', 'jc:1000002', 'jc:1000004', 'jc:1000005'])

    def test_a_listing_becomes_the_app_car_item_shape(self):
        self.assertEqual(self.by_id['jc:1000001'], cs.Listing(
            src='JaCars', id='jc:1000001', url='https://www.jacars.net/adv/1000001_honda-civic-1-5l-2019/',
            title='Honda Civic 1,5L 2019', price=3_250_000, year=2019, where='Kingston', posted='2 hours ago',
            model='civic', lhd=False, promoted=True))

    def test_left_hand_drive_is_read_from_the_description(self):
        self.assertTrue(self.by_id['jc:1000002'].lhd)
        self.assertFalse(self.by_id['jc:1000002'].promoted)

    def test_missing_or_foreign_prices_are_none(self):
        self.assertIsNone(self.by_id['jc:1000004'].price)
        self.assertIsNone(self.by_id['jc:1000005'].price)
        self.assertEqual(self.by_id['jc:1000004'].model, 'gt86')

    def test_seller_details_never_reach_the_output(self):
        self.assertNotIn('Seller', json.dumps([vars(x) for x in self.by_id.values()]))

    def test_a_page_without_listing_data_says_so(self):
        with self.assertRaisesRegex(ValueError, 'No __NEXT_DATA__'):
            cs.parse_jacars('<html><body><p>Just a moment...</p></body></html>')
        with self.assertRaisesRegex(ValueError, 'no adverts list'):
            cs.parse_jacars('<script id="__NEXT_DATA__" type="application/json">{"props": {}}</script>')

    def test_command_line_prints_json(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            cs.main(['parse', 'jacars', str(ROOT / 'tests' / 'fixtures' / 'jacars_listing.html')])
        rows = json.loads(out.getvalue())
        self.assertEqual([r['id'] for r in rows], list(self.by_id))
        self.assertEqual(rows[0]['price'], 3_250_000)


def response(url, html, status=200):
    from scrapling.engines.toolbelt.custom import Response
    return Response(url, html, status, 'OK', {}, {}, {})


class FakeSession:
    pages = {}
    fetched = []

    def __init__(self, **options):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def fetch(self, url):
        FakeSession.fetched.append(url)
        return FakeSession.pages[url]


CIVIC = 'https://www.jacars.net/cars/honda/civic/'


class JaCarsFetchTests(unittest.TestCase):
    def setUp(self):
        FakeSession.fetched = []
        patches = [mock.patch('scrapling.fetchers.StealthySession', FakeSession), mock.patch.object(cs.time, 'sleep')]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.snapshot = Path(tempfile.mkdtemp()) / 'cars.json'
        self.addCleanup(shutil.rmtree, self.snapshot.parent)

    def run_fetch(self):
        cs.main(['fetch', 'jacars', '--model', 'civic', '--output', str(self.snapshot)])

    def test_pages_are_followed_until_the_last_and_only_the_searched_model_is_kept(self):
        FakeSession.pages = {
            CIVIC: response(CIVIC, PAGE.replace('"next_page":null', '"next_page":2')),
            CIVIC + '?page=2': response(CIVIC + '?page=2', PAGE.replace('10000', '20000')),
        }
        self.run_fetch()
        snapshot = json.loads(self.snapshot.read_text(encoding='utf-8'))
        self.assertEqual(FakeSession.fetched, [CIVIC, CIVIC + '?page=2'])
        self.assertEqual([x['id'] for x in snapshot['items']],
                         ['jc:1000001', 'jc:1000002', 'jc:1000005', 'jc:2000001', 'jc:2000002', 'jc:2000005'])
        self.assertEqual(snapshot['source'], 'JaCars')

    def test_a_blocked_or_challenged_run_keeps_the_last_snapshot(self):
        self.snapshot.write_text('previous', encoding='utf-8')
        for blocked in (response(CIVIC, 'Forbidden', status=403),
                        response(CIVIC, '<html><p>Just a moment...</p></html>'),
                        response('https://www.jacars.net/login/', PAGE)):
            FakeSession.pages = {CIVIC: blocked}
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                self.run_fetch()
            self.assertEqual(self.snapshot.read_text(encoding='utf-8'), 'previous')
        self.assertEqual(list(self.snapshot.parent.iterdir()), [self.snapshot])


if __name__ == '__main__':
    unittest.main()

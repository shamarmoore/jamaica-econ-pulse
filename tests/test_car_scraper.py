from pathlib import Path
import contextlib
import io
import json
import sys
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


if __name__ == '__main__':
    unittest.main()

import copy
import unittest
from draw_repeats import compare, reference, simulate_maxima, validate


class DrawRepeatTests(unittest.TestCase):
    def test_unordered_duplicates_and_known_partial_matches(self):
        rows = [
            {'draw_id': 10, 'numbers': list(range(1, 21))},
            {'draw_id': 11, 'numbers': list(range(20, 0, -1))},
            {'draw_id': 12, 'numbers': list(range(11, 31))},
            {'draw_id': 13, 'numbers': list(range(21, 41))},
        ]
        result = compare(validate(list(reversed(rows)), 4))
        counts = {r['sharedNumbers']: r['observedPairs'] for r in result['overlapHistogram']}
        self.assertEqual(result['pairCount'], 6)
        self.assertEqual((counts[0], counts[10], counts[20]), (2, 3, 1))
        self.assertEqual(result['duplicateCards'][0]['drawIds'], [10, 11])
        self.assertEqual(result['maximumExamples'][0]['matchingNumbers'], list(range(1, 21)))

    def test_corrupt_archive_cannot_look_like_a_repeat(self):
        rows = [{'draw_id': n, 'numbers': list(range(1, 21))} for n in range(1, 5)]
        bad = copy.deepcopy(rows)
        bad[1]['numbers'][0] = 2
        for raw in (rows + [rows[0]], bad, [rows[0], rows[2], rows[3]]):
            with self.assertRaises(ValueError):
                validate(raw, len(raw))
        with self.assertRaises(ValueError):
            validate(rows, 5)

    def test_reference_and_simulation_are_reproducible(self):
        probabilities = reference()
        self.assertAlmostEqual(sum(probabilities), 1.)
        self.assertAlmostEqual(sum(k * p for k, p in enumerate(probabilities)), 5.)
        a = simulate_maxima(15, 4)
        self.assertEqual(a, simulate_maxima(15, 4))
        self.assertEqual(sum(a.values()), 4)


if __name__ == '__main__':
    unittest.main()

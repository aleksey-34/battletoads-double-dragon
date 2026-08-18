import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { knobsForRecipeBook, recipeBooksWithKnobs } from './hamfiveRecipeKnobs';

const recipes = {
  sharedB3: { lot: 15, op: 12, ri: 50 },
};

describe('hamfive recipe book knobs', () => {
  it('uses shared B3 lot/op/ri, not leftover master-leg percents', () => {
    assert.deepEqual(
      knobsForRecipeBook(recipes, { key: 'b3', initial: 10000 }),
      { key: 'b3', lot: 15, op: 12, ri: 50, initial: 10000 },
    );
  });

  it('keeps ham/five/stocks lots as on the card (8/10/15 pattern)', () => {
    const books = recipeBooksWithKnobs(recipes, [
      { key: 'b3', initial: 10000 },
      { key: 'ham', lot: 10, op: 8, ri: 100, initial: 5000, universe: 'ham_zz_weex4' },
      { key: 'five', lot: 8, op: 6, ri: 100, initial: 5000, universe: 'five_weex4' },
      { key: 'stocks', lot: 15, op: 6, ri: 100, initial: 0, universe: 'stocks_zz_4h_l30' },
    ]);
    assert.deepEqual(books.map((b) => [b.key, b.lot, b.op, b.ri]), [
      ['b3', 15, 12, 50],
      ['ham', 10, 8, 100],
      ['five', 8, 6, 100],
      ['stocks', 15, 6, 100],
    ]);
  });
});

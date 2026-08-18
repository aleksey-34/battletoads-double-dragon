/** Per-book lot / OP / ri from the hamfive recipe — same knobs live copy paints. */

export type RecipeBookKnobs = {
  key: string;
  lot: number;
  op: number;
  ri: number;
  initial: number;
  universe?: string;
};

export const knobsForRecipeBook = (
  recipes: { sharedB3?: { lot?: number; op?: number; ri?: number } },
  book: { key?: string; lot?: number; op?: number; ri?: number; initial?: number; universe?: string },
): RecipeBookKnobs => {
  const key = String(book?.key || '').trim();
  if (key === 'b3') {
    return {
      key,
      lot: Number(recipes?.sharedB3?.lot || 0),
      op: Number(recipes?.sharedB3?.op || 0),
      ri: Number(recipes?.sharedB3?.ri || 0),
      initial: Number(book?.initial || 0),
    };
  }
  return {
    key,
    lot: Number(book?.lot || 0),
    op: Number(book?.op || 0),
    ri: Number(book?.ri || 0),
    initial: Number(book?.initial || 0),
    ...(book?.universe ? { universe: String(book.universe) } : {}),
  };
};

export const recipeBooksWithKnobs = (
  recipes: { sharedB3?: { lot?: number; op?: number; ri?: number } },
  books: Array<{ key?: string; lot?: number; op?: number; ri?: number; initial?: number; universe?: string }>,
): RecipeBookKnobs[] => (books || []).map((book) => knobsForRecipeBook(recipes, book));

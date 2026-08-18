/**
 * Progress model for the Saxo unblock checklist.
 *
 * Pure presentation logic: given the product-category checklist and the set of
 * categories the user has ticked off as "test completed at Saxo", work out
 * which blocked symbols are still waiting on a questionnaire and which are
 * ready to be un-blocked in the app.
 */

import type { SaxoChecklistItem } from "@/lib/saxo-product-categories";

export type UnblockCategoryProgress = SaxoChecklistItem & {
  /** User has ticked the Saxo questionnaire section as completed. */
  completed: boolean;
  /** Symbols still blocked in the app for this category. */
  symbolsWaiting: string[];
};

export type UnblockProgress = {
  categories: UnblockCategoryProgress[];
  totalCategories: number;
  completedCategories: number;
  /** 0-100, rounded. 100 when there is nothing left to do. */
  percent: number;
  /** Blocked symbols whose Saxo section has not been ticked yet. */
  symbolsWaiting: string[];
  /** Blocked symbols whose section is ticked — ready to unblock here. */
  symbolsReady: string[];
};

export function computeUnblockProgress(
  items: SaxoChecklistItem[],
  done: Record<string, boolean>,
): UnblockProgress {
  const categories: UnblockCategoryProgress[] = items.map((item) => ({
    ...item,
    completed: done[item.id] === true,
    symbolsWaiting: done[item.id] === true ? [] : [...item.symbols],
  }));

  const completedCategories = categories.filter((c) => c.completed).length;
  const totalCategories = categories.length;

  const symbolsWaiting = categories.flatMap((c) => c.symbolsWaiting);
  const symbolsReady = categories.filter((c) => c.completed).flatMap((c) => c.symbols);

  return {
    categories,
    totalCategories,
    completedCategories,
    percent:
      totalCategories === 0 ? 100 : Math.round((completedCategories / totalCategories) * 100),
    symbolsWaiting,
    symbolsReady,
  };
}

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A list with "Load older" whose first page is live (useLoad refetches it
 * quietly). A new first page must not throw away the older pages the
 * operator already loaded, nor jump the scroll: rows the new first page
 * covers come from it, and the older rows already on screen stay below it.
 * A row that is gone from the new first page and would sort inside it was
 * handled or removed elsewhere, so it goes.
 *
 * `comesBefore(a, b)` is the list order (newest first): true when `a` is
 * listed above `b`.
 */
export function mergeFirstPage<T>(opts: {
  prevRows: T[];
  prevMore: T[];
  prevCursor: string | null;
  first: T[];
  firstCursor: string | null;
  keyOf: (row: T) => string;
  comesBefore: (a: T, b: T) => boolean;
}): { more: T[]; cursor: string | null } {
  const { prevRows, prevMore, prevCursor, first, firstCursor, keyOf, comesBefore } = opts;
  if (prevMore.length === 0 || firstCursor === null) return { more: [], cursor: firstCursor };
  const boundary = first[first.length - 1];
  if (boundary === undefined) return { more: prevMore, cursor: prevCursor };
  const inFirst = new Set(first.map(keyOf));
  const seen = new Set<string>();
  const more = prevRows.filter((row) => {
    const key = keyOf(row);
    if (inFirst.has(key) || seen.has(key) || !comesBefore(boundary, row)) return false;
    seen.add(key);
    return true;
  });
  return more.length ? { more, cursor: prevCursor } : { more: [], cursor: firstCursor };
}

/** The hook around mergeFirstPage: `first` is undefined while (re)loading from scratch (a new filter). */
export function usePagedList<T>(
  first: T[] | undefined,
  firstCursor: string | null | undefined,
  keyOf: (row: T) => string,
  comesBefore: (a: T, b: T) => boolean,
): { rows: T[]; cursor: string | null; append: (rows: T[], cursor: string | null) => void } {
  const [state, setState] = useState<{ first: T[] | undefined; more: T[]; cursor: string | null }>({
    first: undefined,
    more: [],
    cursor: null,
  });
  const order = useRef({ keyOf, comesBefore });
  useEffect(() => {
    order.current = { keyOf, comesBefore };
  });

  // Worked out while rendering (not in an effect), so no frame ever shows the
  // first page without the older rows under it: that would jump the scroll.
  let current = state;
  if (state.first !== first) {
    if (first === undefined) current = { first: undefined, more: [], cursor: null };
    else if (state.first === undefined) current = { first, more: [], cursor: firstCursor ?? null };
    else {
      current = {
        first,
        ...mergeFirstPage({
          prevRows: [...state.first, ...state.more],
          prevMore: state.more,
          prevCursor: state.cursor,
          first,
          firstCursor: firstCursor ?? null,
          keyOf,
          comesBefore,
        }),
      };
    }
    setState(current);
  }

  const append = useCallback((rows: T[], cursor: string | null) => {
    setState((prev) => {
      const have = new Set([...(prev.first ?? []), ...prev.more].map(order.current.keyOf));
      return { ...prev, more: [...prev.more, ...rows.filter((r) => !have.has(order.current.keyOf(r)))], cursor };
    });
  }, []);

  return { rows: first === undefined ? [] : [...first, ...current.more], cursor: current.cursor, append };
}

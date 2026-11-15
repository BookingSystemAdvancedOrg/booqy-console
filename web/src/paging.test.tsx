import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mergeFirstPage, usePagedList } from "./paging";

type Row = { id: string };
const r = (id: string): Row => ({ id });
const keyOf = (x: Row) => x.id;
// newest first: larger id first (like report ids)
const comesBefore = (a: Row, b: Row) => a.id > b.id;

describe("mergeFirstPage", () => {
  it("keeps the older pages when a new report arrives on top", () => {
    const prevFirst = [r("09"), r("08"), r("07")];
    const prevMore = [r("06"), r("05"), r("04")];
    const out = mergeFirstPage({
      prevRows: [...prevFirst, ...prevMore], prevMore, prevCursor: "after-04",
      first: [r("10"), r("09"), r("08")], firstCursor: "after-08", keyOf, comesBefore,
    });
    // 07 fell off the first page but stays, right above the older ones
    expect(out.more.map(keyOf)).toEqual(["07", "06", "05", "04"]);
    expect(out.cursor).toBe("after-04");
  });

  it("drops a row handled elsewhere and the duplicates the new first page now covers", () => {
    const prevFirst = [r("09"), r("08"), r("07")];
    const prevMore = [r("06"), r("05")];
    const out = mergeFirstPage({
      prevRows: [...prevFirst, ...prevMore], prevMore, prevCursor: "after-05",
      first: [r("09"), r("07"), r("06")], firstCursor: "after-06", keyOf, comesBefore,
    });
    expect(out.more.map(keyOf)).toEqual(["05"]);
  });

  it("starts over when nothing older was loaded or the first page is everything", () => {
    const base = { prevRows: [r("2"), r("1")], prevCursor: "c", keyOf, comesBefore, first: [r("3")] };
    expect(mergeFirstPage({ ...base, prevMore: [], firstCursor: "x" })).toEqual({ more: [], cursor: "x" });
    expect(mergeFirstPage({ ...base, prevMore: [r("1")], firstCursor: null })).toEqual({ more: [], cursor: null });
  });
});

describe("usePagedList", () => {
  it("a quiet refetch keeps the loaded older page; a new filter (undefined first) starts over", () => {
    let first: Row[] | undefined = [r("9"), r("8")];
    let cursor: string | null = "after-8";
    const { result, rerender } = renderHook(() => usePagedList(first, cursor, keyOf, comesBefore));
    expect(result.current.cursor).toBe("after-8");
    act(() => result.current.append([r("7"), r("6")], "after-6"));
    expect(result.current.rows.map(keyOf)).toEqual(["9", "8", "7", "6"]);
    first = [r("10"), r("9")];
    cursor = "after-9";
    rerender();
    expect(result.current.rows.map(keyOf)).toEqual(["10", "9", "8", "7", "6"]);
    expect(result.current.cursor).toBe("after-6");
    first = undefined;
    rerender();
    expect(result.current.rows).toEqual([]);
    first = [r("5")];
    cursor = null;
    rerender();
    expect(result.current.rows.map(keyOf)).toEqual(["5"]);
    expect(result.current.cursor).toBeNull();
  });
});

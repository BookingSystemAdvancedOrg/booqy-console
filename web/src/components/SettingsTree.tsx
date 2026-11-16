import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, FocusEvent, KeyboardEvent } from "react";
import { Icon } from "./ds";
import { BRANCH_LABEL, searchLeaves, treeOf } from "../settingsTree";
import type { BranchId, Leaf, Tree, TreeId } from "../settingsTree";
import "./settingsTree.css";

/**
 * Settings as a field, trees and branches (settingsTree.ts), as in admin.
 * From 1100 px the tree sits on the left, always there. Smaller screens
 * drill down: field, tree, branch, with a back button.
 */

/** An apple: the important thing on a tree (live status); a press opens its branch. */
export interface Apple { text: string; branch: BranchId; warn?: boolean }

type NavItem =
  | { key: string; kind: "tree"; tree: Tree }
  | { key: string; kind: "branch"; branch: BranchId; tree: Tree }
  | { key: string; kind: "link"; tree: Tree };

const Chevron = ({ dir }: { dir: "left" | "right" | "down" }) => <Icon name="chevron-down" size={16} className={`stree-chev stree-chev--${dir}`} />;

/** The tree on the left: arrows move, Right opens and steps in, Left closes and steps out, Enter or Space opens. */
export function SettingsTreeNav({ trees, current, currentTree, onBranch, onLink }: {
  trees: Tree[]; current: BranchId | null; currentTree: TreeId | null;
  onBranch: (b: BranchId) => void; onLink: (to: string) => void;
}) {
  const [open, setOpen] = useState<Set<TreeId>>(() => new Set(currentTree ? [currentTree] : trees.map((t) => t.id)));
  useEffect(() => {
    if (currentTree) setOpen((s) => (s.has(currentTree) ? s : new Set(s).add(currentTree)));
  }, [currentTree]);
  const items = useMemo<NavItem[]>(() => trees.flatMap((tree) => [
    { key: tree.id, kind: "tree" as const, tree },
    ...(open.has(tree.id) ? [
      ...tree.branches.map((branch) => ({ key: branch, kind: "branch" as const, branch, tree })),
      ...(tree.link ? [{ key: `${tree.id}:link`, kind: "link" as const, tree }] : []),
    ] : []),
  ]), [trees, open]);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const tabKey = items.some((i) => i.key === focusKey) ? focusKey : (current ?? items[0]?.key ?? null);
  const refs = useRef(new Map<string, HTMLElement>());
  const focus = (key: string) => { setFocusKey(key); refs.current.get(key)?.focus(); };
  const toggle = (id: TreeId, to?: boolean) => setOpen((s) => {
    const next = new Set(s);
    if (to ?? !next.has(id)) next.add(id); else next.delete(id);
    return next;
  });
  const activate = (item: NavItem) => {
    if (item.kind === "tree") toggle(item.tree.id);
    else if (item.kind === "branch") onBranch(item.branch);
    else if (item.tree.link) onLink(item.tree.link.to);
  };
  function onKeyDown(e: KeyboardEvent<HTMLElement>, item: NavItem) {
    const i = items.indexOf(item);
    const key = e.key;
    if (key === "ArrowDown" && i < items.length - 1) focus(items[i + 1].key);
    else if (key === "ArrowUp" && i > 0) focus(items[i - 1].key);
    else if (key === "Home") focus(items[0].key);
    else if (key === "End") focus(items[items.length - 1].key);
    else if (key === "ArrowRight" && item.kind === "tree") {
      if (!open.has(item.tree.id)) toggle(item.tree.id, true);
      else if (items[i + 1] && items[i + 1].kind !== "tree") focus(items[i + 1].key);
    } else if (key === "ArrowLeft") {
      if (item.kind === "tree") toggle(item.tree.id, false); else focus(item.tree.id);
    } else if (key === "Enter" || key === " ") activate(item);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
  const props = (item: NavItem | undefined) => item ? ({
    ref: (el: HTMLElement | null) => { if (el) refs.current.set(item.key, el); else refs.current.delete(item.key); },
    tabIndex: item.key === tabKey ? 0 : -1,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => onKeyDown(e, item),
    onFocus: (e: FocusEvent<HTMLElement>) => { if (e.target === e.currentTarget) setFocusKey(item.key); },
  }) : {};

  return (
    <nav className="stree-nav" aria-label="Settings">
      <ul className="stree" role="tree" aria-label="Settings">
        {trees.map((tree) => {
          const expanded = open.has(tree.id);
          return (
            <li key={tree.id} role="none" className={tree.id === currentTree ? "stree-tree here" : "stree-tree"}>
              {/* The tree's row is the treeitem and owns its group (WAI navigation treeview), so its name is just the label. */}
              <div className="stree-row" role="treeitem" aria-expanded={expanded} aria-owns={`stree-group-${tree.id}`} aria-label={tree.label}
                   onClick={() => toggle(tree.id)} {...props(items.find((i) => i.key === tree.id))}>
                <span className="stree-icon" aria-hidden="true"><Icon name={tree.icon} size={17} /></span>
                <span className="stree-label">{tree.label}</span>
                <span className="stree-toggle" aria-hidden="true"><Chevron dir="down" /></span>
              </div>
              <ul role="group" className="stree-group" id={`stree-group-${tree.id}`}>
                {expanded && tree.branches.map((b) => (
                  <li key={b} role="treeitem" aria-selected={b === current} aria-current={b === current ? "page" : undefined}
                      className={b === current ? "stree-branch active" : "stree-branch"} data-help={`settings-branch:${b}`}
                      onClick={(e) => { e.stopPropagation(); onBranch(b); }} {...props(items.find((i) => i.key === b))}>
                    {BRANCH_LABEL[b]}
                  </li>
                ))}
                {expanded && tree.link && (
                  <li role="treeitem" className="stree-branch stree-link"
                      onClick={(e) => { e.stopPropagation(); onLink(tree.link!.to); }} {...props(items.find((i) => i.kind === "link" && i.tree.id === tree.id))}>
                    {tree.link.label} <Icon name="arrow-right" size={14} />
                  </li>
                )}
              </ul>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function Apples({ apples, onBranch }: { apples: Apple[]; onBranch: (b: BranchId) => void }) {
  if (!apples.length) return null;
  return (
    <ul className="stree-apples" aria-label="Status">
      {apples.map((a) => (
        <li key={`${a.branch}:${a.text}`}>
          <button type="button" className={a.warn ? "stree-apple warn" : "stree-apple"} onClick={() => onBranch(a.branch)} title={BRANCH_LABEL[a.branch]}>
            <span className="stree-apple-dot" aria-hidden="true" />{a.text}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The opening page: the search and one card per tree with its branches and apples. */
export function SettingsField({ trees, apples, visible, onTree, onBranch, onLeaf, onLink }: {
  trees: Tree[]; apples: Partial<Record<TreeId, Apple[]>>; visible: (b: BranchId) => boolean;
  onTree: (t: TreeId) => void; onBranch: (b: BranchId) => void; onLeaf: (leaf: Leaf) => void; onLink: (to: string) => void;
}) {
  return (
    <div className="stree-field">
      <LeafSearch visible={visible} onLeaf={onLeaf} />
      <div className="stree-grid">
        {trees.map((tree, i) => (
          <section key={tree.id} className="card stree-card" style={{ "--i": i } as CSSProperties} aria-labelledby={`stree-${tree.id}`}>
            <button type="button" className="stree-card-head" onClick={() => onTree(tree.id)}>
              <span className="stree-icon" aria-hidden="true"><Icon name={tree.icon} size={19} /></span>
              <h2 className="stree-card-title" id={`stree-${tree.id}`}>{tree.label}</h2>
              <span className="stree-card-go"><Chevron dir="right" /></span>
            </button>
            <Apples apples={apples[tree.id] ?? []} onBranch={onBranch} />
            <ul className="stree-card-branches">
              {tree.branches.map((b) => (
                <li key={b}><button type="button" className="stree-card-branch" onClick={() => onBranch(b)}>{BRANCH_LABEL[b]}</button></li>
              ))}
              {tree.link && (
                <li><button type="button" className="stree-card-branch" onClick={() => onLink(tree.link!.to)}>{tree.link.label} <Icon name="arrow-right" size={14} /></button></li>
              )}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/** One tree (smaller screens, or from a card's heading): its branches as rows. */
export function SettingsTreePage({ tree, apples, onField, onBranch, onLink }: {
  tree: Tree; apples: Apple[]; onField: () => void; onBranch: (b: BranchId) => void; onLink: (to: string) => void;
}) {
  return (
    <div className="stree-view">
      <div className="stree-head">
        <button type="button" className="stree-back" onClick={onField}><Chevron dir="left" /> Settings</button>
        <nav className="stree-crumbs" aria-label="You are here">
          <ol>
            <li><button type="button" onClick={onField}>Settings</button></li>
            <li aria-current="page">{tree.label}</li>
          </ol>
        </nav>
        <h2 className="stree-title">{tree.label}</h2>
      </div>
      <Apples apples={apples} onBranch={onBranch} />
      <ul className="stree-rows">
        {tree.branches.map((b) => (
          <li key={b}><button type="button" className="stree-rowbtn" onClick={() => onBranch(b)}><span>{BRANCH_LABEL[b]}</span><Chevron dir="right" /></button></li>
        ))}
        {tree.link && (
          <li><button type="button" className="stree-rowbtn" onClick={() => onLink(tree.link!.to)}><span>{tree.link.label}</span><Icon name="arrow-right" size={16} /></button></li>
        )}
      </ul>
    </div>
  );
}

/** Top of a branch: back (smaller screens), where you are, and the branch name. */
export function BranchHead({ branch, onField, onTree }: { branch: BranchId; onField: () => void; onTree: (t: TreeId) => void }) {
  const tree = treeOf(branch);
  return (
    <div className="stree-head">
      <button type="button" className="stree-back" onClick={() => onTree(tree.id)}><Chevron dir="left" /> {tree.label}</button>
      <nav className="stree-crumbs" aria-label="You are here">
        <ol>
          <li><button type="button" onClick={onField}>Settings</button></li>
          <li><button type="button" onClick={() => onTree(tree.id)}>{tree.label}</button></li>
          <li aria-current="page">{BRANCH_LABEL[branch]}</li>
        </ol>
      </nav>
      <h2 className="stree-title" data-help={`settings-branch:${branch}`}>{BRANCH_LABEL[branch]}</h2>
    </div>
  );
}

/** Bottom of a branch: the previous and next branch. */
export function BranchPager({ order, branch, onBranch }: { order: BranchId[]; branch: BranchId; onBranch: (b: BranchId) => void }) {
  const i = order.indexOf(branch);
  const prev = i > 0 ? order[i - 1] : null;
  const next = i >= 0 && i < order.length - 1 ? order[i + 1] : null;
  if (!prev && !next) return null;
  return (
    <nav className="stree-pager" aria-label="More settings">
      {prev ? <button type="button" className="stree-pager-link" onClick={() => onBranch(prev)}><Chevron dir="left" /><span>{BRANCH_LABEL[prev]}</span></button> : <span />}
      {next && <button type="button" className="stree-pager-link next" onClick={() => onBranch(next)}><span>{BRANCH_LABEL[next]}</span><Chevron dir="right" /></button>}
    </nav>
  );
}

/** The field's search: finds a setting and jumps to its branch. */
function LeafSearch({ visible, onLeaf }: { visible: (b: BranchId) => boolean; onLeaf: (leaf: Leaf) => void }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchLeaves(query, visible), [query, visible]);
  const current = Math.min(active, Math.max(results.length - 1, 0));
  const open = query.trim().length > 0;
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" && results.length) setActive((current + 1) % results.length);
    else if (e.key === "ArrowUp" && results.length) setActive((current - 1 + results.length) % results.length);
    else if (e.key === "Enter" && results[current]) onLeaf(results[current]);
    else if (e.key === "Escape" && query) setQuery("");
    else return;
    e.preventDefault();
  }
  return (
    <div className="stree-search">
      <label className="stree-search-box">
        <Icon name="search" size={17} />
        <span className="sr-only">Search settings</span>
        <input type="text" role="combobox" aria-expanded={open} aria-controls={`${id}-list`}
               aria-activedescendant={open && results.length ? `${id}-o${current}` : undefined}
               aria-autocomplete="list" autoComplete="off" spellCheck={false} placeholder="Search settings"
               value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} onKeyDown={onKeyDown} />
      </label>
      {open && (
        <div className="stree-results" id={`${id}-list`} role="listbox" aria-label="Settings">
          {results.length === 0 && <p className="stree-empty">No match for “{query.trim()}”.</p>}
          {results.map((leaf, i) => (
            <div key={`${leaf.branch}:${leaf.label}`} id={`${id}-o${i}`} role="option" aria-selected={i === current}
                 className="stree-result" onMouseMove={() => i !== current && setActive(i)} onClick={() => onLeaf(leaf)}>
              <span className="stree-result-label">{leaf.label}</span>
              <span className="stree-result-path">{treeOf(leaf.branch).label} › {BRANCH_LABEL[leaf.branch]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

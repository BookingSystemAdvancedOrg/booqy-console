import type { IconName } from "./components/ds";
import { isDesktopShell } from "./desktopDownloads";

/**
 * Settings as a field of trees (the owner's picture, same as admin): the
 * page opens on the field, the trees are the big areas, the branches are the
 * sections (one view at a time, each with its own #address) and the leaves
 * are the single settings. The apples (live status) are worked out in
 * SettingsPage. #desktop-app keeps working: it is a branch. Pages that
 * live elsewhere (Profile, the email brand template, Operators) are links on
 * their tree; their old addresses (#profile, #mail-brand) lead there (MOVED).
 * scripts/help-corpus.mjs reads BRANCH_LABEL and TREES: keep each tree on one line.
 */
export type BranchId = "appearance" | "desktop-app" | "meta-ads" | "phone-agent";
export type TreeId = "you" | "platform";

export const BRANCH_LABEL: Record<BranchId, string> = {
  appearance: "Appearance and sound",
  "desktop-app": "App",
  "meta-ads": "Meta ads limits",
  "phone-agent": "Phone agent limits",
};

export interface Tree {
  id: TreeId;
  label: string;
  icon: IconName;
  branches: BranchId[];
  /** Pages elsewhere that belong here (links in the tree, with an arrow). */
  links?: TreeLink[];
}

export interface TreeLink { to: string; label: string }

export const TREES: Tree[] = [
  { id: "you", label: "You", icon: "badge", branches: ["appearance", "desktop-app"], links: [{ to: "/profile", label: "Profile" }] },
  { id: "platform", label: "Platform", icon: "globe", branches: ["meta-ads", "phone-agent"], links: [{ to: "/mail?tab=brand-template", label: "Email brand template" }, { to: "/operators", label: "Operators" }] },
];

/** Branches that became links: their old #address leads to the page. */
export const MOVED: Record<string, string> = { profile: "/profile", "mail-brand": "/mail?tab=brand-template" };

export const BRANCHES: BranchId[] = TREES.flatMap((t) => t.branches);

export function isBranch(id: string): id is BranchId {
  return id in BRANCH_LABEL;
}
export function isTree(id: string): id is TreeId {
  return TREES.some((t) => t.id === id);
}
export function treeOf(branch: BranchId): Tree {
  return TREES.find((t) => t.branches.includes(branch)) as Tree;
}

/** The app branch is the download card, which the desktop app itself has no use for. */
export function branchVisible(branch: BranchId): boolean {
  return branch !== "desktop-app" || !isDesktopShell();
}

/**
 * What the search finds: the visible label, its branch (or `to`, a linked
 * page, and its tree), other words; `find` is the text lit up when it
 * differs (several split by |).
 */
export type Leaf = { label: string; find?: string; keywords?: string } &
  ({ branch: BranchId; to?: undefined; tree?: undefined } | { to: string; tree: TreeId; branch?: undefined });

export const LEAVES: Leaf[] = [
  { label: "Profile picture", to: "/profile", tree: "you", keywords: "avatar photo name email" },
  { label: "Light or dark", branch: "appearance", keywords: "theme dark mode light mode" },
  { label: "Background", branch: "appearance", keywords: "backdrop wallpaper colour image see-through" },
  { label: "Click sound", branch: "appearance", keywords: "sound mute" },
  { label: "Volume", branch: "appearance", keywords: "sound loud" },
  { label: "Desktop app", branch: "desktop-app", find: "Desktop app|App on your phone", keywords: "download install mac windows linux phone" },
  { label: "Meta ads monthly cap", branch: "meta-ads", find: "Max monthly cap", keywords: "ceiling budget facebook instagram" },
  { label: "Meta ads kill switch", branch: "meta-ads", find: "Turn kill switch", keywords: "pause all ads stop" },
  { label: "Phone agent minutes cap", branch: "phone-agent", find: "Max minutes", keywords: "ceiling calls voice" },
  { label: "Phone agent kill switch", branch: "phone-agent", find: "Turn kill switch", keywords: "pause calls stop" },
  { label: "Email brand template", to: "/mail?tab=brand-template", tree: "platform", keywords: "sender name reply-to accent colour logo signature footer mail" },
];

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
export { fold };

/** Where a leaf sits: its tree and its branch, or the linked page. */
export function leafPath(leaf: Leaf): [string, string] {
  if (leaf.branch) return [treeOf(leaf.branch).label, BRANCH_LABEL[leaf.branch]];
  const tree = TREES.find((t) => t.id === leaf.tree) as Tree;
  return [tree.label, tree.links?.find((l) => l.to === leaf.to)?.label ?? leaf.label];
}

/** Leaves matching the query (label, branch, tree, keywords), without accents, only in visible branches. */
export function searchLeaves(query: string, visible: (b: BranchId) => boolean = branchVisible): Leaf[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return LEAVES.filter((leaf) => {
    if (leaf.branch && !visible(leaf.branch)) return false;
    const hay = fold(`${leaf.label} ${leafPath(leaf).join(" ")} ${leaf.keywords ?? ""}`);
    return words.every((w) => hay.includes(w));
  })
    .sort((a, b) => Number(!fold(a.label).startsWith(words[0])) - Number(!fold(b.label).startsWith(words[0])))
    .slice(0, 8);
}

/**
 * An apple: the important thing on a tree (live status); a press opens its
 * branch. The tone says what the dot means: "ok" (green) only for something
 * running, "warn" for something that needs action, none for preferences.
 */
export interface Apple { text: string; branch: BranchId; tone?: "ok" | "warn" }

export interface AppleInput {
  theme: string;
  sound: boolean;
  meta: { killSwitch: boolean } | null;
  phone: { killSwitch: boolean; maxMinutesCap?: number } | null;
}

export function buildApples({ theme, sound, meta, phone }: AppleInput): Partial<Record<TreeId, Apple[]>> {
  return {
    you: [
      { text: theme === "dark" ? "Dark" : "Light", branch: "appearance" },
      { text: sound ? "Sound on" : "Sound off", branch: "appearance" },
    ],
    platform: [
      ...(meta ? [meta.killSwitch
        ? { text: "Meta ads paused by kill switch", branch: "meta-ads" as const, tone: "warn" as const }
        : { text: "Meta ads running", branch: "meta-ads" as const, tone: "ok" as const }] : []),
      // a partial answer (no cap number) draws no cap chip rather than "Phone cap undefined min"
      ...(phone ? (phone.killSwitch
        ? [{ text: "Phone agent paused", branch: "phone-agent" as const, tone: "warn" as const }]
        : typeof phone.maxMinutesCap === "number"
          ? [{ text: `Phone cap ${phone.maxMinutesCap} min`, branch: "phone-agent" as const, tone: "ok" as const }]
          : []) : []),
    ],
  };
}

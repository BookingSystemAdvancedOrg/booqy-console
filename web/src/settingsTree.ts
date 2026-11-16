import type { IconName } from "./components/ds";
import { isDesktopShell } from "./desktopDownloads";

/**
 * Settings as a field of trees (the owner's picture, same as admin): the
 * page opens on the field, the trees are the big areas, the branches are the
 * sections (one view at a time, each with its own #address) and the leaves
 * are the single settings. The apples (live status) are worked out in
 * SettingsPage. #desktop-app keeps working: it is a branch.
 * scripts/help-corpus.mjs reads BRANCH_LABEL and TREES: keep each tree on one line.
 */
export type BranchId = "profile" | "appearance" | "desktop-app" | "meta-ads" | "phone-agent" | "mail-brand";
export type TreeId = "you" | "platform";

export const BRANCH_LABEL: Record<BranchId, string> = {
  profile: "Profile",
  appearance: "Appearance and sound",
  "desktop-app": "App",
  "meta-ads": "Meta ads limits",
  "phone-agent": "Phone agent limits",
  "mail-brand": "Email brand template",
};

export interface Tree {
  id: TreeId;
  label: string;
  icon: IconName;
  branches: BranchId[];
  /** A page elsewhere that belongs here (shown as a link in the tree). */
  link?: { to: string; label: string };
}

export const TREES: Tree[] = [
  { id: "you", label: "You", icon: "badge", branches: ["profile", "appearance", "desktop-app"] },
  { id: "platform", label: "Platform", icon: "globe", branches: ["meta-ads", "phone-agent", "mail-brand"], link: { to: "/operators", label: "Operators" } },
];

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

/** What the search finds: the visible label, its branch, other words; `find` is the text lit up when it differs (several split by |). */
export interface Leaf { label: string; branch: BranchId; find?: string; keywords?: string }

export const LEAVES: Leaf[] = [
  { label: "Profile picture", branch: "profile", find: "Open my profile", keywords: "avatar photo name email" },
  { label: "Light or dark", branch: "appearance", keywords: "theme dark mode light mode" },
  { label: "Background", branch: "appearance", keywords: "backdrop wallpaper colour image see-through" },
  { label: "Click sound", branch: "appearance", keywords: "sound mute" },
  { label: "Volume", branch: "appearance", keywords: "sound loud" },
  { label: "Desktop app", branch: "desktop-app", find: "Desktop app|App on your phone", keywords: "download install mac windows linux phone" },
  { label: "Meta ads monthly cap", branch: "meta-ads", find: "Max monthly cap", keywords: "ceiling budget facebook instagram" },
  { label: "Meta ads kill switch", branch: "meta-ads", find: "Turn kill switch", keywords: "pause all ads stop" },
  { label: "Phone agent minutes cap", branch: "phone-agent", find: "Max minutes", keywords: "ceiling calls voice" },
  { label: "Phone agent kill switch", branch: "phone-agent", find: "Turn kill switch", keywords: "pause calls stop" },
  { label: "Email brand template", branch: "mail-brand", keywords: "sender name reply-to accent colour logo signature footer mail" },
];

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
export { fold };

/** Leaves matching the query (label, branch, tree, keywords), without accents, only in visible branches. */
export function searchLeaves(query: string, visible: (b: BranchId) => boolean = branchVisible): Leaf[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return LEAVES.filter((leaf) => {
    if (!visible(leaf.branch)) return false;
    const hay = fold(`${leaf.label} ${BRANCH_LABEL[leaf.branch]} ${treeOf(leaf.branch).label} ${leaf.keywords ?? ""}`);
    return words.every((w) => hay.includes(w));
  })
    .sort((a, b) => Number(!fold(a.label).startsWith(words[0])) - Number(!fold(b.label).startsWith(words[0])))
    .slice(0, 8);
}

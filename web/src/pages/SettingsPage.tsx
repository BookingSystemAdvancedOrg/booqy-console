import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { BackdropSetting } from "../components/BackdropSetting";
import { isDesktopShell } from "../desktopDownloads";
import { MyAvatar } from "../components/MyAvatar";
import { firstName } from "../avatar";
import { SoundToggle } from "../components/SoundToggle";
import { SoundVolume } from "../components/SoundVolume";
import { ThemeToggle } from "../components/ThemeToggle";
import { Slot } from "../slots";
import { DesktopAppCard } from "../components/DesktopAppCard";
import { InfoTip } from "../components/StepFlow";
import { BranchHead, BranchPager, SettingsField, SettingsTreeNav, SettingsTreePage, type Apple } from "../components/SettingsTree";
import { LEAVES, TREES, branchVisible, fold, isBranch, isTree, treeOf, type BranchId, type Leaf, type TreeId } from "../settingsTree";
import { useTheme } from "../theme";
import { useSound } from "../press";
import { confirmLeave } from "../components/save";
import { metaAdsApi } from "../features/meta-ads/api";
import { phoneAgentApi } from "../features/phone-agent/api";

/**
 * Settings as a field of trees (settingsTree.ts): the page opens on the
 * field (a card per tree with its branches and apples, plus a search), each
 * branch is its own view at #branch. You: profile, appearance and sound
 * (kept in this browser under the same keys as booqy.se and admin), the app.
 * Platform: the Meta ads and phone agent ceilings, the email brand template
 * (edited in Mail) and Operators.
 */
type View = { kind: "field" } | { kind: "tree"; tree: TreeId } | { kind: "branch"; branch: BranchId };

function viewFromHash(hash: string): View {
  const id = hash.replace(/^#/, "");
  if (isBranch(id)) return { kind: "branch", branch: id };
  if (isTree(id)) return { kind: "tree", tree: id };
  return { kind: "field" };
}

/** Branches drawn only while open; the platform cards stay (hidden) once opened so unsaved edits survive. */
const ONLY_WHILE_OPEN: BranchId[] = ["appearance", "desktop-app"];

export default function SettingsPage({ name, email }: { name?: string; email?: string }) {
  const navigate = useNavigate();
  const { hash, state: navState } = useLocation();
  const view = viewFromHash(hash);
  const branch = view.kind === "branch" ? view.branch : null;
  const go = useCallback((to: BranchId | TreeId | null) => {
    navigate(to ? { hash: `#${to}` } : { hash: "" });
    const top = document.querySelector(".settings-layout")?.getBoundingClientRect().top ?? 0;
    if (top < 0) window.scrollTo({ top: window.scrollY + top - 16, behavior: reducedMotion() ? "auto" : "smooth" });
  }, [navigate]);
  const leave = useCallback((to: string) => { if (confirmLeave()) navigate(to); }, [navigate]);
  // The app branch does not exist in the desktop app: back to the field.
  useEffect(() => { if (branch && !branchVisible(branch)) navigate({ hash: "" }, { replace: true }); }, [branch, navigate]);

  const opened = useRef(new Set<BranchId>());
  if (branch) opened.current.add(branch);
  const mounted = (b: BranchId) => opened.current.has(b) && (!ONLY_WHILE_OPEN.includes(b) || branch === b);

  // A leaf from the search (or the palette's state.leaf) lights up once its branch is drawn.
  const [pendingLeaf, setPendingLeaf] = useState<Leaf | null>(null);
  useEffect(() => {
    const want = (navState as { leaf?: unknown } | null)?.leaf;
    const leaf = typeof want === "string" ? LEAVES.find((l) => l.label === want && l.branch === branch) : undefined;
    if (leaf) setPendingLeaf(leaf);
  }, [navState, branch]);
  useEffect(() => {
    if (!pendingLeaf || branch !== pendingLeaf.branch) return;
    return highlightLeaf(pendingLeaf, () => setPendingLeaf(null));
  }, [pendingLeaf, branch]);

  const trees = TREES.map((t) => ({ ...t, branches: t.branches.filter(branchVisible) })).filter((t) => t.branches.length > 0);
  const order = trees.flatMap((t) => t.branches);
  const currentTree = branch ? treeOf(branch).id : view.kind === "tree" ? view.tree : null;
  const shownTree = view.kind === "tree" ? trees.find((t) => t.id === view.tree) : undefined;

  // Apples: theme and sound from this browser; the platform kill switches, read again whenever the field shows.
  const { theme } = useTheme();
  const [sound] = useSound();
  const [platform, setPlatform] = useState<{ meta: { killSwitch: boolean } | null; phone: { killSwitch: boolean; maxMinutesCap: number } | null }>({ meta: null, phone: null });
  const onField = view.kind !== "branch";
  useEffect(() => {
    if (!onField) return;
    let gone = false;
    Promise.all([metaAdsApi.settings().catch(() => null), phoneAgentApi.settings().catch(() => null)])
      .then(([meta, phone]) => { if (!gone) setPlatform({ meta, phone }); });
    return () => { gone = true; };
  }, [onField]);
  const apples: Partial<Record<TreeId, Apple[]>> = {
    you: [
      { text: theme === "dark" ? "Dark" : "Light", branch: "appearance" },
      { text: sound ? "Sound on" : "Sound off", branch: "appearance" },
    ],
    platform: [
      ...(platform.meta ? [platform.meta.killSwitch
        ? { text: "Meta ads paused by kill switch", branch: "meta-ads" as const, warn: true }
        : { text: "Meta ads running", branch: "meta-ads" as const }] : []),
      ...(platform.phone ? [platform.phone.killSwitch
        ? { text: "Phone agent paused", branch: "phone-agent" as const, warn: true }
        : { text: `Phone cap ${platform.phone.maxMinutesCap} min`, branch: "phone-agent" as const }] : []),
    ],
  };

  const pane = (b: BranchId) => ({ className: "settings-branch", "data-branch": b, hidden: branch !== b });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          {email && <p className="muted">{email}</p>}
        </div>
      </div>
      <div className="settings-layout" data-view={view.kind}>
        <SettingsTreeNav trees={trees} current={branch} currentTree={currentTree} onBranch={go} onLink={leave} />
        <div className="settings-body">
          {view.kind === "field" && (
            <SettingsField trees={trees} apples={apples} visible={branchVisible} onTree={go} onBranch={go}
              onLeaf={(leaf) => { setPendingLeaf(leaf); go(leaf.branch); }} onLink={leave} />
          )}
          {shownTree && <SettingsTreePage tree={shownTree} apples={apples[shownTree.id] ?? []} onField={() => go(null)} onBranch={go} onLink={leave} />}
          {branch && <BranchHead key={branch} branch={branch} onField={() => go(null)} onTree={go} />}

          {/* Branches are hidden, not removed: unsaved edits stay. */}
          {mounted("profile") && (
            <div {...pane("profile")}>
              <section className="card">
                <div className="card__head"><h2>Your profile</h2></div>
                <div className="card__body">
                  <div className="setting-row" data-help="settings:profile">
                    <div className="avatar-setting__who">
                      <MyAvatar name={name} email={email} />
                      <p className="strong">{firstName(name, email)}</p>
                    </div>
                    <Link to="/profile" className="btn btn--ghost">Open my profile</Link>
                  </div>
                </div>
              </section>
            </div>
          )}
          {mounted("appearance") && (
            <div {...pane("appearance")}>
              <section className="card">
                <div className="card__head"><h2>Appearance and sound</h2></div>
                <div className="card__body">
                  <div className="setting-row" data-help="settings:theme">
                    <div>
                      <p className="strong">Light or dark</p>
                    </div>
                    <ThemeToggle className="setting-toggle" label />
                  </div>
                  <div className="setting-row" data-help="settings:background">
                    <div>
                      <p className="strong">
                        Background{" "}
                        <InfoTip label="About the background">
                          {isDesktopShell()
                            ? "See-through shows whatever is behind the window. Colour puts the glass over a colour you pick, Your image over a picture you upload."
                            : "What sits behind the glass: a colour or your own picture. See-through, with your desktop showing through, is in the desktop app."}
                        </InfoTip>
                      </p>
                    </div>
                    <BackdropSetting />
                  </div>
                  <div className="setting-row" data-help="settings:sound">
                    <div>
                      <p className="strong">Click sound</p>
                    </div>
                    <SoundToggle className="setting-toggle" label />
                  </div>
                  <div className="setting-row" data-help="settings:volume">
                    <div>
                      <label className="strong" htmlFor="sound-volume">Volume</label>
                      <p className="muted small">40 % standard</p>
                    </div>
                    <SoundVolume id="sound-volume" />
                  </div>
                </div>
              </section>
            </div>
          )}
          {mounted("desktop-app") && (
            <div {...pane("desktop-app")}>
              <DesktopAppCard />
            </div>
          )}
          {mounted("meta-ads") && (
            <div {...pane("meta-ads")}>
              <Slot id="settings.metaAds" />
            </div>
          )}
          {mounted("phone-agent") && (
            <div {...pane("phone-agent")}>
              <Slot id="settings.phoneAgent" />
            </div>
          )}
          {mounted("mail-brand") && (
            <div {...pane("mail-brand")}>
              <section className="card">
                <div className="card__head">
                  <span className="card__title">
                    <h2>Email brand template</h2>
                    <InfoTip label="About the brand template">Sender name, reply-to, accent colour, logo, signature and footer line on every email to restaurant owners. It is edited in Mail.</InfoTip>
                  </span>
                </div>
                <div className="card__body">
                  <div className="setting-row" data-help="settings:mail-brand">
                    <div>
                      <p className="strong">Brand template</p>
                    </div>
                    <Link to="/mail?tab=brand-template" className="btn btn--ghost">Open in Mail</Link>
                  </div>
                </div>
              </section>
            </div>
          )}

          {branch && <BranchPager order={order} branch={branch} onBranch={go} />}
        </div>
      </div>
    </>
  );
}

function reducedMotion(): boolean {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

/** Lights up a leaf: waits for its branch to draw it (cards that load), scrolls there and rings the row a moment. */
function highlightLeaf(leaf: Leaf, done: () => void): () => void {
  const wants = (leaf.find ?? leaf.label).split("|").map(fold);
  const started = Date.now();
  let frame = 0;
  let timer = 0;
  const tick = () => {
    const root = document.querySelector(`.settings-branch[data-branch="${leaf.branch}"]`);
    const hit = root
      ? Array.from(root.querySelectorAll<HTMLElement>("h2, h3, label, p, span, button, a"))
        .find((el) => el.children.length < 3 && wants.some((w) => fold((el.textContent ?? "").replace(/\s+/g, " ").trim()).startsWith(w)))
      : undefined;
    if (!hit) {
      if (Date.now() - started < 4000) frame = window.requestAnimationFrame(tick);
      else done();
      return;
    }
    const card = hit.closest<HTMLElement>(".card");
    const row = hit.closest<HTMLElement>(".setting-row, .field") ?? (hit.matches("h2, h3") ? card : hit.parentElement) ?? hit;
    row.scrollIntoView?.({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
    row.classList.add("stree-leaf-flash");
    timer = window.setTimeout(() => { row.classList.remove("stree-leaf-flash"); done(); }, 2400);
  };
  frame = window.requestAnimationFrame(tick);
  return () => { window.cancelAnimationFrame(frame); window.clearTimeout(timer); };
}


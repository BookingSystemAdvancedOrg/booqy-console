import { SoundToggle } from "../components/SoundToggle";
import { ThemeToggle } from "../components/ThemeToggle";

/**
 * Settings: light or dark mode and the click sound. Both are kept in this
 * browser (localStorage, see src/storageRegistry.ts) under the same keys as
 * booqy.se and admin. Light and sound on are the defaults.
 */
export default function SettingsPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">How the console looks and sounds in this browser.</p>
        </div>
      </div>
      <section className="card">
        <div className="card__head"><h2>Appearance and sound</h2></div>
        <div className="card__body">
          <div className="setting-row">
            <div>
              <p className="strong">Dark mode</p>
              <p className="muted small">Dark surfaces instead of light. Light is the default.</p>
            </div>
            <ThemeToggle className="setting-toggle" label />
          </div>
          <div className="setting-row">
            <div>
              <p className="strong">Click sound</p>
              <p className="muted small">A soft click when you press buttons and links. On by default.</p>
            </div>
            <SoundToggle className="setting-toggle" label />
          </div>
        </div>
      </section>
    </>
  );
}

import { BackdropSetting } from "../components/BackdropSetting";
import { isDesktopShell } from "../desktopDownloads";
import { AvatarSetting } from "../components/AvatarSetting";
import { SoundToggle } from "../components/SoundToggle";
import { SoundVolume } from "../components/SoundVolume";
import { ThemeToggle } from "../components/ThemeToggle";
import { Slot } from "../slots";
import { DesktopAppCard } from "../components/DesktopAppCard";
import { InfoTip } from "../components/StepFlow";

/**
 * Settings: light or dark mode and the click sound. Both are kept in this
 * browser (localStorage, see src/storageRegistry.ts) under the same keys as
 * booqy.se and admin. Light and sound on are the defaults.
 */
export default function SettingsPage({ email }: { email?: string }) {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          {email && <p className="muted">{email}</p>}
        </div>
      </div>
      <section className="card">
        <div className="card__head"><h2>Your profile</h2></div>
        <div className="card__body">
          <AvatarSetting email={email} />
        </div>
      </section>
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
      <DesktopAppCard />
      <Slot id="settings.metaAds" />
      <Slot id="settings.phoneAgent" />
    </>
  );
}

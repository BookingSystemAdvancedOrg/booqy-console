import { MoonIcon, SunIcon } from "./ThemeIcons";
import { useTheme } from "../theme";

/**
 * The top-bar button that switches between light and dark mode. A toggle
 * button (aria-pressed): pressed = dark mode. The icon shows the mode in
 * effect (sun = light, moon = dark) and cross-fades to the other on a
 * switch; with reduced motion it just swaps. `label` shows the name next to
 * the icon (Settings). The console's copy is English, so the name is
 * "Dark mode" here (the other apps say "Mörkt läge").
 */
export function ThemeToggle({ className = "", label = false }: { className?: string; label?: boolean }) {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  return (
    <button
      type="button"
      className={`theme-toggle${className ? ` ${className}` : ""}`}
      aria-pressed={dark}
      aria-label={label ? undefined : "Dark mode"}
      title={label ? undefined : "Dark mode"}
      onClick={toggle}
    >
      <span className="theme-toggle-icon" aria-hidden="true">
        <SunIcon className="theme-toggle-sun" />
        <MoonIcon className="theme-toggle-moon" />
      </span>
      {label && <span className="theme-toggle-label">Dark mode</span>}
    </button>
  );
}

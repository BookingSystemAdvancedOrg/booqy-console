import { MoonIcon, SunIcon } from "./ThemeIcons";
import { useTheme } from "../theme";

/**
 * The button that switches between light and dark mode. It shows the mode in
 * effect: sun and "Light mode", or moon and "Dark mode"; the icon cross-fades
 * on a switch. Its name for screen readers and the tooltip also say what a
 * press does ("Light mode, switch to dark mode"). The switch sweeps over the
 * page from the button (switchTheme). `label` shows the text next to the icon.
 */
export function ThemeToggle({ className = "", label = false }: { className?: string; label?: boolean }) {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  const name = dark ? "Dark mode" : "Light mode";
  const action = `${name}, switch to ${dark ? "light" : "dark"} mode`;
  return (
    <button
      type="button"
      className={`theme-toggle${className ? ` ${className}` : ""}`}
      data-mode={dark ? "dark" : "light"}
      aria-label={action}
      title={action}
      onClick={(e) => {
        // the sweep starts from the middle of the button, also for a key press
        const r = e.currentTarget.getBoundingClientRect();
        toggle({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      }}
    >
      <span className="theme-toggle-icon" aria-hidden="true">
        <SunIcon className="theme-toggle-sun" />
        <MoonIcon className="theme-toggle-moon" />
      </span>
      {label && <span className="theme-toggle-label">{name}</span>}
    </button>
  );
}

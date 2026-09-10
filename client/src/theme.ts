export type AppTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "cove-theme";

let themeTransitionTimer: number | null = null;
type ViewTransitionLike = { finished: Promise<unknown> };
type ThemeDocument = Document & {
  startViewTransition?: (updateCallback: () => void) => ViewTransitionLike;
};

function commitTheme(root: HTMLElement, theme: AppTheme) {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

export function readTheme(): AppTheme {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark"
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(theme: AppTheme, updateUI?: () => void) {
  const root = document.documentElement;
  const commit = () => {
    commitTheme(root, theme);
    updateUI?.();
  };
  const previousTheme = root.dataset.theme;
  if (!previousTheme || previousTheme === theme) {
    commit();
    return;
  }

  if (themeTransitionTimer !== null) {
    window.clearTimeout(themeTransitionTimer);
    themeTransitionTimer = null;
  }

  const viewTransitionDocument = document as ThemeDocument;
  // A short opacity-only fade is retained under reduced motion; CSS shortens
  // it without introducing movement, zoom or layout interpolation.
  if (typeof viewTransitionDocument.startViewTransition === "function") {
    root.classList.remove("theme-transitioning");
    try {
      // View Transitions capture the current Cove surface, apply the new theme,
      // then cross-fade the two snapshots. This is reliable for gradients and
      // inherited CSS variables where a normal CSS transition can be skipped.
      const transition = viewTransitionDocument.startViewTransition(() => {
        commit();
      });
      void transition.finished.then(
        () => undefined,
        () => undefined,
      );
      return;
    } catch {
      // Older Chromium builds can expose the method but reject while another
      // view transition is running; fall through to the paint-only fallback.
    }
  }

  // Fallback for older runtimes: flush the old surface before changing the
  // theme so the temporary paint transition has two distinct frames. It does
  // not include transform/width/height, so window dragging stays geometric.
  root.classList.add("theme-transitioning");
  void root.offsetWidth;
  commit();
  themeTransitionTimer = window.setTimeout(() => {
    root.classList.remove("theme-transitioning");
    themeTransitionTimer = null;
  }, 560);
}

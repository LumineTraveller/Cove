export const flatDiagnosticsRule = '.cove-shell .diagnostics-v2{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}';
export const productDiagnosticsBackdrop = 'blur(18px) saturate(1.18)';

/** Fixed fixture CSS control: no timer, React update, media or geometry mutation. */
export function installFlatDiagnostics(enabled: boolean) {
  let style: HTMLStyleElement | null = null, disposed = false;
  if (enabled) {
    style = document.createElement('style');
    style.textContent = flatDiagnosticsRule;
    document.head.appendChild(style);
  }
  return {
    snapshot() {
      const overlays = disposed ? [] : [...document.querySelectorAll<HTMLElement>('.cove-shell .diagnostics-v2')];
      return { enabled, diagnosticOnly: enabled, disposed, styleMounted: Boolean(style?.isConnected),
        expectedBackdropFilter: enabled && !disposed ? 'none' : productDiagnosticsBackdrop,
        overlayCount: overlays.length,
        backdropFilters: overlays.map(node => getComputedStyle(node).backdropFilter),
        meaning: 'Fixed same-condition backdrop-filter-only fixture control; background, layout, sampling and media are unchanged.' };
    },
    dispose() { if (disposed) return; disposed = true; style?.remove(); style = null; },
  };
}

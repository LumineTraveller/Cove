export const meterTransitionRule = '.cove-shell .volume-live-level,.cove-shell .vertical-live-level{transition:none!important}';
export function meterTransitionPhase(index: number) {
  if (!Number.isInteger(index) || index < 0 || index > 24) throw Error('Invalid fixed meter diagnostic sample');
  return index < 8 ? 'normal-a' : index < 16 ? 'transition-none' : 'normal-a2';
}
/** No polling, React state or media mutation: only two fixture CSS boundaries. */
export function installMeterTransitionDiagnostic(enabled: boolean) {
  let phase = enabled ? 'normal-a' : 'disabled', sampleIndex: number | null = null;
  let style: HTMLStyleElement | null = null, disposed = false;
  return {
    setSampleIndex(index: number) {
      if (!enabled || disposed) throw Error('Meter transition diagnostic is unavailable');
      const next = meterTransitionPhase(index);
      if (next === 'transition-none' && !style) {
        style = document.createElement('style'); style.textContent = meterTransitionRule;
        document.head.appendChild(style);
      } else if (next !== 'transition-none' && style) { style.remove(); style = null; }
      phase = next; sampleIndex = index;
    },
    snapshot() {
      const types = enabled && !disposed ? ['volume-live-level', 'vertical-live-level'].map(name => {
        const nodes = [...document.querySelectorAll<HTMLElement>('.cove-shell .' + name)];
        return { type: name, mountedCount: nodes.length,
          cssVisibleCount: nodes.filter(node => node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
            node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0).length,
          transitionDuration: [...new Set(nodes.map(node => getComputedStyle(node).transitionDuration))],
          transitionProperty: [...new Set(nodes.map(node => getComputedStyle(node).transitionProperty))] };
      }) : [];
      return { enabled, diagnosticOnly: enabled, phase, sampleIndex, styleMounted: Boolean(style?.isConnected),
        hoveredShellElements: enabled && !disposed ? document.querySelectorAll('.cove-shell :hover').length : null,
        meters: types, disposed, meaning: 'CSS visibility only; no occlusion/physical-presentation claim. Mixed 24s summary is diagnostic, not a product improvement.' };
    },
    dispose() { style?.remove(); style = null; disposed = true; },
  };
}

/** Read existing inline percentages only; no layout, style computation or IDs. */
export function snapshotDomMeters() {
  const nodes = [...document.querySelectorAll<HTMLElement>('.vertical-volume')];
  const selected = nodes.slice(0, 16);
  const parsed = selected.map(node => Number.parseFloat(node.style.getPropertyValue('--volume-level')));
  const values = parsed.filter(Number.isFinite).sort((a, b) => a - b);
  return { mountedCount: nodes.length, sampledCount: selected.length, values,
    invalidCount: parsed.filter(value => !Number.isFinite(value) || value < 0 || value > 100).length,
    truncated: nodes.length > selected.length,
    speakingAvatarCount: document.querySelectorAll('.member-avatar .speaking').length,
    meaning: 'Anonymous inline meter percentages and speaking-class count; no physical presentation claim.' };
}

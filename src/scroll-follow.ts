export type ScrollFollowState = {
  previousScrollTop: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  following: boolean;
};

export function resolveScrollFollow(state: ScrollFollowState): boolean {
  const distanceFromBottom = Math.max(0, state.scrollHeight - state.scrollTop - state.clientHeight);
  // A collapsed work record can clamp scrollTop to the new bottom.
  if (distanceFromBottom <= 1) return true;
  if (state.scrollTop < state.previousScrollTop - 1) return false;
  if (distanceFromBottom <= 72) return true;
  return state.following;
}

/** Includes nested work records and late-loading media, not just message counts. */
export function observeMessageLayout(container: HTMLElement, follow: () => void): () => void {
  let frame = 0;
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; follow(); });
  };
  const resize = new ResizeObserver(schedule);
  const observed = new Set<Element>();
  const syncChildren = () => {
    for (const child of observed) if (child.parentElement !== container) { resize.unobserve(child); observed.delete(child); }
    for (const child of container.children) if (!observed.has(child)) { observed.add(child); resize.observe(child); }
    schedule();
  };
  resize.observe(container);
  const mutations = new MutationObserver(syncChildren);
  mutations.observe(container, { childList: true, subtree: true, characterData: true });
  syncChildren();
  return () => { cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect(); };
}

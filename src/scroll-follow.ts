export type ScrollFollowState = {
  previousScrollTop: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  following: boolean;
};

export function resolveScrollFollow(state: ScrollFollowState): boolean {
  if (state.scrollTop < state.previousScrollTop - 1) return false;
  const distanceFromBottom = Math.max(0, state.scrollHeight - state.scrollTop - state.clientHeight);
  if (distanceFromBottom <= 72) return true;
  return state.following;
}

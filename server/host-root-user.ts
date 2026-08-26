export const HOST_ROOT_USER_ID = "00000000-0000-4000-8000-000000000010";
export const HOST_ROOT_USERNAME = "owner";

export function isHostRootUser(userId: string): boolean {
  return userId === HOST_ROOT_USER_ID;
}

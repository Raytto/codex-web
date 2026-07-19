export type TenantIdentity = {
  userId: string;
  label: string;
  uid: number;
  gid: number;
};

export const WEB_IDENTITY = { uid: 10001, gid: 10001 } as const;

const TENANT_IDENTITIES: readonly TenantIdentity[] = [
  { userId: "00000000-0000-4000-8000-000000000001", label: "owner", uid: 11001, gid: 11001 },
];

export function listTenantIdentities(): readonly TenantIdentity[] {
  return TENANT_IDENTITIES;
}

export function tenantIdentityForUser(userId: string): TenantIdentity | undefined {
  return TENANT_IDENTITIES.find((identity) => identity.userId === userId);
}

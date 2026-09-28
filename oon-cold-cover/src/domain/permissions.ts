import { forbidden } from '../errors.js';
import type { Actor, Role } from './types.js';

export const PERMISSIONS = {
  'profile.own.write': ['OWNER_OPERATOR'],
  'owner_operator.read_all': ['QUALIFICATION_OFFICER', 'DISPATCHER', 'FINANCE', 'ADMIN', 'READ_ONLY_AUDITOR'],
  'owner_operator.create': ['ADMIN', 'QUALIFICATION_OFFICER'],
  // Verification of onboarding evidence (ASSET / TRUCK / POWER gates)
  'evidence.review': ['QUALIFICATION_OFFICER'],
  'gate.review': ['QUALIFICATION_OFFICER'],
  // SITE evidence verification is further restricted by policy.reviewRules.siteVerifierRoles
  'site.verify': ['DISPATCHER', 'QUALIFICATION_OFFICER'],
  'job.read_all': ['DISPATCHER', 'QUALIFICATION_OFFICER', 'FINANCE', 'ADMIN', 'READ_ONLY_AUDITOR'],
  'job.manage': ['DISPATCHER'],
  'job.dispatch': ['DISPATCHER'],
  'job.progress': ['DISPATCHER', 'OWNER_OPERATOR'],
  'vault.seal': ['DISPATCHER', 'QUALIFICATION_OFFICER'],
  'vault.correct': ['DISPATCHER', 'QUALIFICATION_OFFICER'],
  'vault.export': ['DISPATCHER', 'QUALIFICATION_OFFICER', 'ADMIN', 'READ_ONLY_AUDITOR'],
  'vault.verify': ['DISPATCHER', 'QUALIFICATION_OFFICER', 'FINANCE', 'ADMIN', 'READ_ONLY_AUDITOR'],
  'ledger.read_all': ['QUALIFICATION_OFFICER', 'DISPATCHER', 'ADMIN', 'READ_ONLY_AUDITOR'],
  'invoice.read_all': ['FINANCE', 'ADMIN', 'READ_ONLY_AUDITOR'],
  'invoice.manage': ['FINANCE'],
  'policy.manage': ['ADMIN'],
  'user.manage': ['ADMIN'],
  'retention.manage': ['ADMIN'],
  'message.post': ['DISPATCHER', 'QUALIFICATION_OFFICER', 'OWNER_OPERATOR'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(actor: Actor, perm: Permission): boolean {
  const allowed = PERMISSIONS[perm] as readonly Role[];
  return actor.roles.some((r) => allowed.includes(r));
}

export function requirePerm(actor: Actor, perm: Permission): void {
  if (!can(actor, perm)) throw forbidden(`Missing permission: ${perm}`);
}

export function hasRole(actor: Actor, role: Role): boolean {
  return actor.roles.includes(role);
}

/** Only owner-operator users (without a staff role) are tenant-restricted. */
export function isTenantRestricted(actor: Actor): boolean {
  return actor.roles.every((r) => r === 'OWNER_OPERATOR');
}

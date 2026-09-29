export const ROLES = [
  'OWNER_OPERATOR',
  'QUALIFICATION_OFFICER',
  'DISPATCHER',
  'FINANCE',
  'ADMIN',
  'READ_ONLY_AUDITOR',
] as const;
export type Role = (typeof ROLES)[number];

export const GATES = ['ASSET', 'TRUCK', 'POWER', 'SITE'] as const;
export type Gate = (typeof GATES)[number];

export const GATE_STATUSES = ['NOT_STARTED', 'PENDING_REVIEW', 'VERIFIED', 'FAILED', 'EXPIRED'] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

export const EVIDENCE_STATUSES = ['OPERATOR_ENTERED', 'PENDING', 'VERIFIED', 'UNCONFIRMED', 'REJECTED'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export type JobStatus = 'GREEN' | 'YELLOW' | 'RED';
export type Severity = 'RED' | 'YELLOW' | 'INFO';

export const JOB_STAGES = ['QUOTE', 'SPEC', 'SET', 'DISPATCHED', 'ARRIVED', 'DELIVERED', 'POD_RECORDED', 'SEALED', 'CANCELLED'] as const;
export type JobStage = (typeof JOB_STAGES)[number];

export type Phase = 'SINGLE' | 'THREE';

export interface Actor {
  id: string;
  displayName: string;
  email: string;
  roles: Role[];
  ownerOperatorId: string | null;
}

export interface Reason {
  code: string;
  severity: Severity;
  gate?: Gate | 'ASSIGNMENT' | 'JOB';
  message: string;
}

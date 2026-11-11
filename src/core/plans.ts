export type Plan = 'free' | 'pro' | 'agency';

export interface PlanLimits {
  plan: Plan;
  label: string;
  priceLabel: string;
  maxChecks: number;
  scheduleMode: boolean;
  activeWindows: boolean;
  volumeBaseline: boolean;
  payloadDrift: boolean;
  /** Slack, Discord and generic webhook channels. Email is on every plan. */
  extraChannels: boolean;
  /** Client folders and the weekly client health summary. */
  folders: boolean;
}

const paid = { scheduleMode: true, activeWindows: true, volumeBaseline: true, payloadDrift: true, extraChannels: true };

export const PLANS: Record<Plan, PlanLimits> = {
  free: {
    plan: 'free', label: 'Free', priceLabel: '$0', maxChecks: 3,
    scheduleMode: false, activeWindows: false, volumeBaseline: false, payloadDrift: false, extraChannels: false, folders: false,
  },
  pro: { plan: 'pro', label: 'Pro', priceLabel: '$15/month', maxChecks: 30, ...paid, folders: false },
  agency: { plan: 'agency', label: 'Agency', priceLabel: '$49/month', maxChecks: 150, ...paid, folders: true },
};

export function limitsFor(plan: string): PlanLimits {
  return PLANS[(plan as Plan) in PLANS ? (plan as Plan) : 'free'];
}

/** What a check uses that a plan may not include. Empty = allowed. */
export function featuresNotInPlan(
  check: { mode: string; activeWindow: unknown; driftEnabled: boolean; folderId?: string | null },
  limits: PlanLimits,
): string[] {
  const missing: string[] = [];
  if (check.mode === 'schedule' && !limits.scheduleMode) missing.push('schedule mode');
  if (check.mode === 'volume' && !limits.volumeBaseline) missing.push('volume baseline');
  if (check.activeWindow && !limits.activeWindows) missing.push('active windows');
  if (check.driftEnabled && !limits.payloadDrift) missing.push('payload drift');
  return missing;
}

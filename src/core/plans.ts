export type Plan = 'free' | 'pro' | 'agency';

export interface PlanLimits {
  label: string;
  maxChecks: number;
  scheduleMode: boolean;
  activeWindows: boolean;
}

export const PLANS: Record<Plan, PlanLimits> = {
  free: { label: 'Free', maxChecks: 3, scheduleMode: false, activeWindows: false },
  pro: { label: 'Pro', maxChecks: 30, scheduleMode: true, activeWindows: true },
  agency: { label: 'Agency', maxChecks: 150, scheduleMode: true, activeWindows: true },
};

export function limitsFor(plan: string): PlanLimits {
  return PLANS[(plan as Plan) in PLANS ? (plan as Plan) : 'free'];
}

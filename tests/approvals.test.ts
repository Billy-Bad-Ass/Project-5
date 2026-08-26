import { describe, expect, it } from 'vitest';
import { approvalMatches, type ApprovalRecord } from '../src/orchestrator/guardrails';

function record(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    status: 'approved',
    subject_type: 'budget_change',
    subject_id: 'cch_meta',
    decided_by: 'billy',
    decided_at: '2026-08-20T10:00:00Z',
    proposed: JSON.stringify({ daily_budget_cents: 1_500 }),
    ...overrides,
  };
}

const wantBudget = {
  subjectType: 'budget_change',
  subjectId: 'cch_meta',
  field: 'daily_budget_cents',
  value: 1_500,
};

describe('an approval authorises one change, not a channel forever', () => {
  it('clears the amount the person actually approved', () => {
    expect(approvalMatches(record(), wantBudget)).toBe(true);
  });

  // The bug this exists to stop: one approved rise on a channel used to clear
  // every later rise on it, including ones the code calls high risk.
  it('refuses a different amount on the same channel', () => {
    expect(approvalMatches(record(), { ...wantBudget, value: 200_000 })).toBe(false);
  });

  it('refuses a different channel', () => {
    expect(approvalMatches(record(), { ...wantBudget, subjectId: 'cch_tiktok' })).toBe(false);
  });

  it('refuses a different kind of subject', () => {
    expect(approvalMatches(record(), { ...wantBudget, subjectType: 'campaign' })).toBe(false);
  });

  it.each(['pending', 'rejected', 'expired'])('refuses a %s approval', (status) => {
    expect(approvalMatches(record({ status }), wantBudget)).toBe(false);
  });

  it('refuses when no approval was quoted at all', () => {
    expect(approvalMatches(null, wantBudget)).toBe(false);
  });

  it('refuses when the decision behind the approval is gone', () => {
    expect(approvalMatches(record({ proposed: null }), wantBudget)).toBe(false);
  });

  it('refuses unparseable proposed JSON rather than waving it through', () => {
    expect(approvalMatches(record({ proposed: 'not json' }), wantBudget)).toBe(false);
  });

  it('refuses when the approved amount is a string that merely looks right', () => {
    const row = record({ proposed: JSON.stringify({ daily_budget_cents: '1500' }) });
    expect(approvalMatches(row, wantBudget)).toBe(false);
  });

  it('checks only subject and status when no amount is named', () => {
    const row = record({ subject_type: 'campaign', proposed: null });
    const want = { subjectType: 'campaign', subjectId: 'cch_meta' };
    expect(approvalMatches(row, want)).toBe(true);
    expect(approvalMatches(record({ subject_type: 'campaign', status: 'rejected' }), want)).toBe(false);
  });
});

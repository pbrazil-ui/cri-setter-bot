// T12 / income statement: model extracts line items; code does the sums and cross-checks.
const r0 = (n) => Math.round(n);
const sum = (lines = []) => lines.reduce((a, l) => a + (Number(l.amount) || 0), 0);

export function summarizeFinancials(extracted) {
  if (!extracted?.income?.length && !extracted?.expenses?.length) return { available: false };
  const income = sum(extracted.income);
  const expenses = sum(extracted.expenses);
  const noi = income - expenses;
  const rep = extracted.reported || {};
  const mismatch = [];
  const check = (name, computed, reported) => {
    if (reported === undefined || reported === null) return;
    if (Math.abs(computed - reported) > Math.max(50, Math.abs(reported) * 0.01)) mismatch.push(`${name}: lines sum to ${r0(computed)} but statement shows ${r0(reported)}`);
  };
  check('total income', income, rep.total_income);
  check('total expenses', expenses, rep.total_expenses);
  check('NOI', noi, rep.noi);
  const months = Number(extracted.months) || 12;
  return {
    available: true,
    period: extracted.period || 'unknown period',
    months,
    total_income: r0(income), total_expenses: r0(expenses), noi: r0(noi),
    expense_ratio_pct: income ? Math.round((expenses / income) * 1000) / 10 : null,
    annualized: months !== 12 ? { total_income: r0((income / months) * 12), total_expenses: r0((expenses / months) * 12), noi: r0((noi / months) * 12) } : undefined,
    top_expenses: [...(extracted.expenses || [])].sort((a, b) => b.amount - a.amount).slice(0, 6).map((l) => ({ label: l.label, amount: r0(l.amount) })),
    income_lines: (extracted.income || []).map((l) => ({ label: l.label, amount: r0(l.amount) })),
    discrepancies: mismatch,
    notes: "Seller-provided figures, as reported. CRI hasn't audited them. Partial-year figures are annualized by straight-line.",
  };
}

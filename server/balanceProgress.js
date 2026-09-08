function round2(n) {
  return Math.round(n * 100) / 100;
}

// Pure, no I/O. The one real "sum selected account balances toward a
// target" computation in this app - extracted out of emergencyFund.js's
// computeEmergencyFundProgress (Phase 34, 2026-09-01) so goal progress
// (Phase 42, server/goalProgress.js) can reuse it verbatim instead of
// re-implementing the same account_ids/missing_account_ids/percent-
// complete logic a second time. Sums the current balance
// (available_balance ?? current_balance, same fallback Home's own
// bank-total math already uses) of whichever selected accounts still
// exist - a selected account that's since been unlinked/removed is
// silently excluded from the sum (not an error, not treated as $0
// "missing" money) but its id is still reported back via
// missing_account_ids so the caller can tell the truth about it rather
// than just quietly under-counting.
function computeBalanceProgress({ targetAmount, accountIds, accounts }) {
  const accountsById = new Map((accounts || []).map((a) => [a.id, a]));
  const selectedIds = accountIds || [];
  const missingAccountIds = selectedIds.filter((id) => !accountsById.has(id));
  const currentAmount = round2(
    selectedIds.reduce((sum, id) => {
      const a = accountsById.get(id);
      if (!a) return sum;
      const balance = a.available_balance ?? a.current_balance;
      return sum + (Number.isFinite(balance) ? balance : 0);
    }, 0)
  );

  const hasTarget = Number.isFinite(targetAmount) && targetAmount > 0;
  const percentComplete = hasTarget
    ? round2(Math.min(100, Math.max(0, (currentAmount / targetAmount) * 100)))
    : null;

  return {
    has_target: hasTarget,
    target_amount: hasTarget ? targetAmount : null,
    current_amount: currentAmount,
    percent_complete: percentComplete,
    account_ids: selectedIds,
    missing_account_ids: missingAccountIds,
  };
}

module.exports = { computeBalanceProgress };

// A receipt matches a transaction when the amount is exact (both are
// precise currency figures) and the dates are close — email receipt dates
// and bank posting dates commonly differ by a day or two.
function isLikelyMatch(receipt, transaction) {
  const amountMatches = Math.abs(receipt.total_amount - transaction.amount) < 0.01;
  if (!amountMatches) return false;

  const receiptDate = new Date(receipt.purchase_date).getTime();
  const txDate = new Date(transaction.date).getTime();
  const daysApart = Math.abs(receiptDate - txDate) / (1000 * 60 * 60 * 24);
  return daysApart <= 3;
}

// Matches each not-yet-matched receipt to a bank transaction, ensuring a
// transaction is only ever claimed by one receipt. Already-matched
// receipts are left alone so a match, once made, stays stable.
function matchReceiptsToTransactions(receipts, transactions) {
  const usedTransactionIds = new Set(
    receipts.filter((r) => r.matched_transaction_id).map((r) => r.matched_transaction_id)
  );
  const matches = [];

  for (const receipt of receipts) {
    if (receipt.matched_transaction_id) continue;

    const candidate = transactions.find(
      (t) => !usedTransactionIds.has(t.transaction_id) && isLikelyMatch(receipt, t)
    );
    if (candidate) {
      usedTransactionIds.add(candidate.transaction_id);
      matches.push({ receiptId: receipt.id, transactionId: candidate.transaction_id });
    }
  }

  return matches;
}

module.exports = { matchReceiptsToTransactions };

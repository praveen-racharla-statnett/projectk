// card-analytics.js
//
// Pure helpers for the card spending dashboard. Works in the browser
// (window.CardAnalytics) and in Node (module.exports) for testing.

(function (root) {
  const PROCESSOR_PREFIX = /^(trumfpay|vipps|paypal|klarna|zettle|sumup|izettle|iz|sq|google|apple)\s*[,*_]+\s*/i;
  const MASKED_CARD = /\d{4,}\*+\d{2,}/g;
  const TIMESTAMP = /\d{4}-\d{2}-\d{2}(?:\s+\d{2}[.:]\d{2}(?:[.:]\d{2})?)?/g;

  function titleCase(text) {
    return text
      .toLowerCase()
      .replace(/(^|[\s&-])(\p{L})/gu, (_, sep, letter) => sep + letter.toUpperCase());
  }

  // Normalises "TrumfPay, MENY CC Vest, 2026-08-11 18.13.03" and
  // "NOR KJOETT AS ,OSLO 469279******0909" into "Meny Cc" / "Nor Kjoett".
  function merchantName(description) {
    let text = String(description || "")
      .replace(MASKED_CARD, " ")
      .replace(TIMESTAMP, " ")
      .trim();

    let previous;
    do {
      previous = text;
      text = text.replace(PROCESSOR_PREFIX, "");
    } while (text !== previous);

    const firstPart = text.split(",").map(part => part.trim()).find(Boolean) || text;

    const words = firstPart
      .replace(/\.(com|no|co|net|org)\b/gi, "")
      .replace(/[^\p{L}\d&\s'-]/gu, " ")
      .split(/\s+/)
      .filter(word => word && !/\d/.test(word) && !/^(as|asa|ab|ltd|inc)$/i.test(word));

    if (!words.length) return titleCase(firstPart.trim() || "Unknown");

    return titleCase(words.slice(0, 2).join(" "));
  }

  function monthKey(isoDate) {
    return isoDate.slice(0, 7);
  }

  function isSpending(tx) {
    return !tx.excluded_from_spending;
  }

  function inPeriod(tx, { year, month }) {
    const txYear = Number(tx.transaction_date.slice(0, 4));
    const txMonth = Number(tx.transaction_date.slice(5, 7));
    return txYear === year && (!month || txMonth === month);
  }

  function previousPeriod({ year, month }) {
    if (!month) return { year: year - 1, month: null };
    return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  }

  function sum(transactions) {
    return transactions.reduce((total, tx) => total + Number(tx.amount), 0);
  }

  function kpis(transactions, period) {
    const spending = transactions.filter(isSpending);
    const current = spending.filter(tx => inPeriod(tx, period));
    const previous = spending.filter(tx => inPeriod(tx, previousPeriod(period)));
    const purchases = current.filter(tx => Number(tx.amount) > 0);

    const total = sum(current);
    const previousTotal = sum(previous);

    return {
      total,
      previousTotal,
      change: previousTotal ? (total - previousTotal) / Math.abs(previousTotal) : null,
      count: current.length,
      averagePurchase: purchases.length ? sum(purchases) / purchases.length : 0,
      foreignTotal: sum(current.filter(tx => tx.foreign_currency)),
      foreignCount: current.filter(tx => tx.foreign_currency).length
    };
  }

  // Spending per card per statement (billing) month for a year.
  function monthlyByCard(transactions, year) {
    const byCard = new Map();

    transactions
      .filter(tx => isSpending(tx) && tx.billing_year === year)
      .forEach(tx => {
        if (!byCard.has(tx.card_id)) {
          byCard.set(tx.card_id, { cardId: tx.card_id, cardName: tx.card_name, months: Array(12).fill(0) });
        }
        byCard.get(tx.card_id).months[tx.billing_month - 1] += Number(tx.amount);
      });

    return [...byCard.values()].sort((a, b) => a.cardName.localeCompare(b.cardName));
  }

  function groupTotals(transactions, keyFn) {
    const groups = new Map();

    transactions.forEach(tx => {
      const key = keyFn(tx);
      const group = groups.get(key) || { key, total: 0, count: 0, transactions: [] };
      group.total += Number(tx.amount);
      group.count += 1;
      group.transactions.push(tx);
      groups.set(key, group);
    });

    return [...groups.values()].sort((a, b) => b.total - a.total);
  }

  function topMerchants(transactions, limit = 10) {
    return groupTotals(transactions.filter(isSpending), tx => merchantName(tx.description))
      .filter(group => group.total > 0)
      .slice(0, limit);
  }

  function categoryTotals(transactions) {
    return groupTotals(transactions.filter(isSpending), tx => tx.category_name)
      .filter(group => group.total > 0)
      .map(group => ({ ...group, color: group.transactions[0].category_color }));
  }

  function dailyTotals(transactions, year) {
    const days = new Map();

    transactions
      .filter(tx => isSpending(tx) && Number(tx.transaction_date.slice(0, 4)) === year)
      .forEach(tx => {
        const day = days.get(tx.transaction_date) || { amount: 0, count: 0 };
        day.amount += Number(tx.amount);
        day.count += 1;
        days.set(tx.transaction_date, day);
      });

    return days;
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function monthIndex(key) {
    return Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1;
  }

  // A merchant is recurring when it charges a similar amount (±15%) roughly
  // once a month for at least `minMonths` months.
  function detectRecurring(transactions, { minMonths = 2, tolerance = 0.15 } = {}) {
    const groups = groupTotals(
      transactions.filter(tx => isSpending(tx) && Number(tx.amount) > 0),
      tx => `${tx.card_id}|${merchantName(tx.description)}`
    );

    return groups
      .map(group => {
        const months = [...new Set(group.transactions.map(tx => monthKey(tx.transaction_date)))].sort();
        if (months.length < minMonths) return null;

        // Groceries etc. are frequent; subscriptions are about once a month.
        if (group.count / months.length > 1.25) return null;

        const span = monthIndex(months[months.length - 1]) - monthIndex(months[0]);
        if (span / (months.length - 1) > 1.5) return null;

        const amounts = group.transactions.map(tx => Number(tx.amount));
        const typical = median(amounts);
        if (amounts.some(amount => Math.abs(amount - typical) > typical * tolerance)) return null;

        const sorted = [...group.transactions].sort((a, b) =>
          a.transaction_date.localeCompare(b.transaction_date)
        );
        const last = sorted[sorted.length - 1];

        return {
          merchant: group.key.split("|")[1],
          cardName: last.card_name,
          categoryName: last.category_name,
          categoryColor: last.category_color,
          typicalAmount: typical,
          months: months.length,
          lastDate: last.transaction_date,
          yearlyCost: typical * 12
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.yearlyCost - a.yearlyCost);
  }

  const api = {
    merchantName,
    isSpending,
    inPeriod,
    previousPeriod,
    kpis,
    monthlyByCard,
    topMerchants,
    categoryTotals,
    dailyTotals,
    detectRecurring
  };

  root.CardAnalytics = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

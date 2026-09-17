// Parser regression tests. Run with:  node tests/run-parser-tests.js
//
// No dependencies and no network: the parsers are loaded into a fake `window`
// exactly as the browser would, then run against text fixtures.
//
// The fixtures reproduce the layout of real statements as PDF.js extracts them,
// but contain placeholder identifiers. The Bank Norwegian merchants and amounts
// are invented on purpose. Never add a real statement PDF, or its raw
// extraction, to this directory.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

global.window = {};

[
  "parsers/parser-utils.js",
  "parsers/parser-registry.js",
  "parsers/trumf-parser.js",
  "parsers/bank-norwegian-parser.js"
].forEach(file => {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, file), "utf8"), { filename: file });
});

const fixture = name => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function parseWith(expectedId, text) {
  const detected = window.StatementParsers.detect(text);

  assert.ok(detected, "no parser matched the statement");
  assert.strictEqual(detected.parser.id, expectedId, "wrong parser detected");

  return detected.parser.parse(text);
}

// ---------------------------------------------------------------------------
// Trumf Kredittkort
// ---------------------------------------------------------------------------

const TRUMF_PURCHASES = [
  { transaction_date: "2026-08-31", raw_description: "TrumfPay, KIWI 331 Storgata 33",        normalized_merchant: "KIWI STORGATA",               amount_nok: 187.90 },
  { transaction_date: "2026-08-25", raw_description: "TrumfPay, Nærbutikken Etterstadsletta", normalized_merchant: "NÆRBUTIKKEN ETTERSTADSLETTA", amount_nok: 164.90 },
  { transaction_date: "2026-08-25", raw_description: "TrumfPay, MENY Oslo City",              normalized_merchant: "MENY OSLO CITY",              amount_nok: 293.39 },
  { transaction_date: "2026-08-11", raw_description: "TrumfPay, MENY CC Vest",                normalized_merchant: "MENY CC VEST",                amount_nok: 233.34 },
  { transaction_date: "2026-08-07", raw_description: "TrumfPay, Joker Vossestrand",           normalized_merchant: "JOKER VOSSESTRAND",           amount_nok: 89.90 }
];

const TRUMF_TOTAL = 969.43;
const TRUMF_PAYMENT = -1772.04;

function assertTrumf(result, label) {
  const purchases = result.transactions.filter(tx => tx.transaction_type === "purchase");

  assert.strictEqual(purchases.length, 5, `${label}: expected 5 purchases`);
  assert.strictEqual(result.totals.purchase_count, 5, `${label}: purchase_count`);

  TRUMF_PURCHASES.forEach((expected, index) => {
    const actual = purchases[index];

    assert.strictEqual(actual.transaction_date, expected.transaction_date, `${label}: date #${index + 1}`);
    assert.strictEqual(actual.raw_description, expected.raw_description, `${label}: description #${index + 1}`);
    assert.strictEqual(actual.normalized_merchant, expected.normalized_merchant, `${label}: merchant #${index + 1}`);
    assert.strictEqual(actual.amount_nok, expected.amount_nok, `${label}: amount_nok #${index + 1}`);
    assert.strictEqual(actual.original_amount, expected.amount_nok, `${label}: original_amount #${index + 1}`);
    assert.ok(actual.amount_nok > 0, `${label}: purchase #${index + 1} must be positive`);
  });

  assert.strictEqual(result.totals.purchase_total, TRUMF_TOTAL, `${label}: purchase total`);
  assert.strictEqual(result.totals.spending_total, TRUMF_TOTAL, `${label}: spending total`);

  assert.strictEqual(
    result.transactions.filter(tx => tx.transaction_type === "refund").length,
    0,
    `${label}: TrumfPay purchases must not become refunds`
  );

  const payments = result.transactions.filter(tx => tx.transaction_type === "payment");
  assert.strictEqual(payments.length, 1, `${label}: expected one Innbetaling payment`);
  assert.strictEqual(payments[0].amount_nok, TRUMF_PAYMENT, `${label}: payment must be negative`);

  assert.strictEqual(result.statement.total_amount, TRUMF_TOTAL, `${label}: statement total`);
  assert.notStrictEqual(result.statement.total_amount, 250, `${label}: minimum payment used as total`);

  assert.strictEqual(
    result.warnings.filter(warning => /reconcile/i.test(warning)).length,
    0,
    `${label}: unexpected reconciliation warning`
  );
}

test("Trumf: real layout yields 5 purchases totalling 969,43", () => {
  assertTrumf(parseWith("trumf", fixture("trumf-2026-08.txt")), "trumf");
});

test("Trumf: flipped signs produce identical normalised output", () => {
  assertTrumf(parseWith("trumf", fixture("trumf-2026-08-positive-signs.txt")), "trumf flipped");
});

test("Trumf: trailing TrumfPay timestamps are stripped from descriptions", () => {
  const result = parseWith("trumf", fixture("trumf-2026-08.txt"));

  result.transactions.forEach(tx => {
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(tx.raw_description), "ISO date must be stripped");
    assert.ok(!/\d{2}\.\d{2}\.\d{2}$/.test(tx.raw_description), "clock time must be stripped");
  });
});

test("Trumf: Innbetaling is a payment and never counts as spending", () => {
  const result = parseWith("trumf", fixture("trumf-2026-08.txt"));
  const spending = result.transactions
    .filter(tx => tx.transaction_type !== "payment")
    .reduce((sum, tx) => sum + tx.amount_nok, 0);

  assert.strictEqual(Math.round(spending * 100) / 100, TRUMF_TOTAL);
  assert.strictEqual(result.totals.payment_count, 1);
  assert.strictEqual(result.transactions.length, 6, "5 purchases plus 1 payment");
});

test("Trumf: 250,00 minimum payment is never used as the statement total", () => {
  const result = parseWith("trumf", fixture("trumf-2026-08.txt"));

  assert.strictEqual(result.statement.total_amount, TRUMF_TOTAL);
  assert.strictEqual(result.derived.minimum_payment, 250);
});

test("Trumf: the previous period balance is not a transaction", () => {
  const result = parseWith("trumf", fixture("trumf-2026-08.txt"));

  assert.ok(
    result.transactions.every(tx => Math.abs(tx.amount_nok) !== 1772.04 || tx.transaction_type === "payment"),
    "'Totalt skyldig beløp forrige periode' must not become a transaction"
  );
});

test("Trumf: invoice and due dates come from their own labels", () => {
  const result = parseWith("trumf", fixture("trumf-2026-08.txt"));

  assert.strictEqual(result.statement.invoice_date, "2026-08-31");
  assert.strictEqual(result.statement.due_date, "2026-09-15");
});

test("Trumf: period is not fabricated from transaction dates", () => {
  const result = parseWith("trumf", fixture("trumf-2026-08.txt"));

  assert.strictEqual(result.statement.period_start, null);
  assert.strictEqual(result.statement.period_end, null);
  assert.strictEqual(result.derived.period_is_derived, true);
  assert.strictEqual(result.derived.period_start, "2026-08-03");
  assert.strictEqual(result.derived.period_end, "2026-08-31");
  assert.ok(result.warnings.some(warning => /period/i.test(warning)));
});

test("Trumf: a mismatched statement total raises a reconciliation warning", () => {
  const text = fixture("trumf-2026-08.txt").replace("Totalt skyldig beløp 969,43", "Totalt skyldig beløp 1.200,00");

  assert.ok(parseWith("trumf", text).warnings.some(warning => /reconcile/i.test(warning)));
});

// ---------------------------------------------------------------------------
// Bank Norwegian
// ---------------------------------------------------------------------------

const BN_SPENDING = 23064.79;
const BN_PAYMENT = -6831.49;

test("Bank Norwegian: all rows parse and reconcile with the statement", () => {
  const result = parseWith("bank_norwegian", fixture("bank-norwegian-2026-08.txt"));

  assert.strictEqual(result.totals.purchase_count, 10, "expected 10 purchases");
  assert.strictEqual(result.totals.spending_total, BN_SPENDING, "spending total");
  assert.strictEqual(result.totals.payment_count, 1, "expected one payment");
  assert.strictEqual(result.totals.payment_total, BN_PAYMENT, "payment must be negative");
  assert.strictEqual(result.statement.total_amount, BN_SPENDING, "statement total");
  assert.strictEqual(result.derived.transactions_total, BN_SPENDING, "sum transaksjoner");
  assert.strictEqual(result.derived.minimum_payment, 807.27, "minimum payment");

  assert.strictEqual(
    result.warnings.filter(warning => /reconcile/i.test(warning)).length,
    0,
    "unexpected reconciliation warning"
  );
});

test("Bank Norwegian: purchases stay positive and the payment stays negative", () => {
  const result = parseWith("bank_norwegian", fixture("bank-norwegian-2026-08.txt"));

  result.transactions.forEach(tx => {
    if (tx.transaction_type === "payment") assert.ok(tx.amount_nok < 0, "payment must be negative");
    else assert.ok(tx.amount_nok > 0, `${tx.raw_description} must be positive`);
  });

  assert.strictEqual(result.transactions.filter(tx => tx.transaction_type === "refund").length, 0);
});

test("Bank Norwegian: explicit period is read from the statement", () => {
  const result = parseWith("bank_norwegian", fixture("bank-norwegian-2026-08.txt"));

  assert.strictEqual(result.statement.period_start, "2026-08-01");
  assert.strictEqual(result.statement.period_end, "2026-08-31");
  assert.strictEqual(result.derived.period_is_derived, false);
  assert.strictEqual(result.statement.invoice_date, "2026-09-01");
  assert.strictEqual(result.statement.due_date, "2026-09-15");
});

test("Bank Norwegian: foreign rows keep local amount, currency and rate", () => {
  const result = parseWith("bank_norwegian", fixture("bank-norwegian-2026-08.txt"));
  const foreign = result.transactions.find(tx => /KLESBUTIKK/.test(tx.raw_description));

  assert.ok(foreign, "foreign row must parse");
  assert.strictEqual(foreign.original_currency, "EUR");
  assert.strictEqual(foreign.original_amount, 44.5);
  assert.strictEqual(foreign.exchange_rate, 11.1899);
  assert.strictEqual(foreign.amount_nok, 497.95);
  assert.strictEqual(foreign.merchant_location, "KIEL");
});

test("Bank Norwegian: merchant and place split on the last comma", () => {
  const result = parseWith("bank_norwegian", fixture("bank-norwegian-2026-08.txt"));
  const byMerchant = name => result.transactions.find(tx => tx.raw_description.includes(name));

  assert.strictEqual(byMerchant("KAFE SENTRUM").merchant_location, "OSLO");
  assert.strictEqual(byMerchant("Inflight Services").merchant_location, "Kista", "handles a missing space before the comma");
  assert.strictEqual(byMerchant("Inflight Services").normalized_merchant, "INFLIGHT SERVICES SELSKAP");
  assert.strictEqual(byMerchant("LODGING").merchant_location, "800-000-0000");
});

test("Bank Norwegian: ticket detail lines are never stored", () => {
  const result = parseWith("bank_norwegian", fixture("bank-norwegian-2026-08.txt"));
  const serialized = JSON.stringify(result.transactions);

  assert.ok(!/passasjer|bilettnummer|reiserute|flyselskap:/i.test(serialized), "passenger details must be ignored");
  assert.strictEqual(result.transactions.length, 11, "10 purchases plus 1 payment, no detail rows");
});

test("Bank Norwegian: no part of the card number is kept", () => {
  const result = parseWith("bank_norwegian", fixture("bank-norwegian-2026-08.txt"));
  const serialized = JSON.stringify({ statement: result.statement, transactions: result.transactions });

  assert.ok(!/\*{2,}/.test(serialized), "masked card numbers must be stripped");
  assert.ok(!/\d{8,}/.test(serialized), "no long digit runs may be stored");
  assert.strictEqual(result.statement.statement_number, null, "the invoice reference is tied to the KID");
});

test("Bank Norwegian: identical rows get deterministic duplicate sequences", () => {
  const text = fixture("bank-norwegian-2026-08.txt");
  const first = parseWith("bank_norwegian", text).transactions.filter(tx => /SPILL OMBORD/.test(tx.raw_description));
  const second = parseWith("bank_norwegian", text).transactions.filter(tx => /SPILL OMBORD/.test(tx.raw_description));

  assert.deepStrictEqual(first.map(tx => tx.duplicate_sequence), [1, 2]);
  assert.deepStrictEqual(
    first.map(tx => tx.duplicate_sequence),
    second.map(tx => tx.duplicate_sequence),
    "re-parsing must reproduce the sequences"
  );
});

test("Bank Norwegian: a mismatched transaction total raises a reconciliation warning", () => {
  const text = fixture("bank-norwegian-2026-08.txt")
    .replace("Sum transaksjoner denne perioden kr 23.064,79", "Sum transaksjoner denne perioden kr 30.000,00");

  assert.ok(parseWith("bank_norwegian", text).warnings.some(warning => /reconcile/i.test(warning)));
});

// ---------------------------------------------------------------------------
// Cross-provider
// ---------------------------------------------------------------------------

test("Provider detection keeps the two formats apart", () => {
  const trumf = window.StatementParsers.rank(fixture("trumf-2026-08.txt"));
  const bn = window.StatementParsers.rank(fixture("bank-norwegian-2026-08.txt"));

  assert.strictEqual(trumf[0].parser.id, "trumf");
  assert.ok(trumf[0].score - trumf[1].score > 0.3, "Trumf must win clearly");
  assert.strictEqual(bn[0].parser.id, "bank_norwegian");
  assert.ok(bn[0].score - bn[1].score > 0.3, "Bank Norwegian must win clearly");
});

let failed = 0;

tests.forEach(({ name, fn }) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
});

console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);

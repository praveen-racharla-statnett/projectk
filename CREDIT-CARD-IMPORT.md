# Credit card statement import

The **Cards** section (`#cards`) lets you pick a card (e.g. Trumf Visa), upload its PDF
statement, review the parsed transactions in a popup and save them to Supabase.

## Flow

1. Choose a card and a statement PDF, then click **Preview transactions**.
2. The PDF is read in the browser with pdf.js (`credit-card-parser.js`); nothing is uploaded yet.
3. Review the popup: untick rows, or edit date, description or amount. Payments and balance
   lines (`Innbetaling`, `Saldo`, …) are unticked by default.
4. **Approve & save** calls the `import_credit_card_statement` RPC, which stores the
   statement and its transactions in one database transaction.

Re-uploading the same PDF is rejected, and transactions already imported from an
overlapping statement are skipped.

## Database

Schema: `supabase/migrations/20261122190000_credit_card_import.sql`

- `credit_cards` – selectable cards (seeded with Trumf Visa and Bank Norwegian).
  Add a card with `insert into credit_cards (name, issuer) values ('…', '…');`
- `credit_card_statements` – one row per imported PDF.
- `credit_card_transactions` – parsed transactions (amount in NOK; purchases positive,
  refunds/payments negative).

Row level security restricts statements and transactions to the logged-in user.

Some issuers print purchases as negative amounts. `credit_cards.amount_sign` (`-1` for Trumf Visa)
is applied during import so purchases are always stored as positive amounts.

## Card spending dashboard

The **Spending** section (`#card-spending`, `card-dashboard.js` + `card-analytics.js`) shows, for the
selected card / year / month:

- Summary cards: spending, change vs previous period, average purchase, foreign-currency spend.
- Monthly spend per card vs the card's budget category (by statement month).
- Spend by category (click a slice to filter the table) and top merchants.
- Daily spending calendar heatmap.
- Recurring payments: same merchant, similar amount (±15%), about once a month.
- Transaction table with search, category filter, sorting and per-transaction category changes.

### Categories

`transaction_categories` holds the categories. A transaction's category is, in order:

1. its manual override (`credit_card_transactions.category_id`, set from the table),
2. the first matching `merchant_rules` pattern (your own rules before built-in ones),
3. `Other`.

Rules are case-insensitive regexes on the description. After changing a category in the table you
can create a rule for similar transactions. The `Payments` category is excluded from spending.
`credit_card_transactions_enriched` is the view the dashboard reads.

### Budget actuals

`refresh_card_actuals()` writes each card's spending into `budget_entries.actual_amount` for the
card's `budget_category_id`. Spending is assigned to the **statement month**: the statement's
due date (read from the PDF, editable in the review popup), or the month after its last
transaction. It runs after every import and category change.

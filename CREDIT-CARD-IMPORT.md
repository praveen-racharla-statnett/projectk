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

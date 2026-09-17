// Bank Norwegian (NOBA Bank Group) statement parser.
//
// Written against the real PDF.js extraction, which looks like:
//
//   Bruksdato Brukersted - varegruppe Kortnr Lokal Valuta Valuta Valutakurs Beløp kr
//   03.08.2026 Innbetaling fra 12345678901 - -6.831,49
//   31.07.2026 REMA 1000 ETTERSTAD ,OSLO 492530******0909 222,31 NOK 222,31
//   14.08.2026 PRIMARK KIEL ,KIEL 492530******0909 44,50 EUR 11.1899 497,95
//
// Notes on this format:
//   1. Every row is one line; the "Kortnr" column holds a masked card number
//      that is stripped and never stored.
//   2. Purchases are printed positive and the payment negative, the opposite of
//      Trumf, so the sign convention is derived rather than assumed.
//   3. Merchant and place are separated by the last comma.
//   4. Air ticket rows are followed by passenger/ticket detail lines. Those
//      never start with a date, so they are ignored and never stored.
//   5. Exchange rates use a dot decimal separator ("11.1899") while amounts use
//      a comma.

(() => {
  const U = window.ParserUtils;

  const DETECT_STRONG = /bank\s*norwegian|norwegian\s*finans|noba\s*bank/i;
  const DETECT_SUPPORT = /(cashpoints|norwegian\s*reward|banknorwegian\.no)/i;

  const AMOUNT = "-?\\d{1,3}(?:[.\\s]\\d{3})*,\\d{2}";

  const ROW_START = /^(\d{1,2}\.\d{1,2}\.\d{2,4})\s+(.+)$/;

  // "(?:^|\s)" stops an amount from starting inside a digit run such as a card
  // number, because "\s\d{3}" is also a valid thousands separator.
  const TX_TAIL = new RegExp(
    `(?:^|\\s)(${AMOUNT})\\s+([A-Z]{3})\\s+(?:(\\d+[.,]\\d+)\\s+)?(${AMOUNT})\\s*$`
  );

  // Rows without a currency column, such as the incoming payment.
  const TX_TAIL_SIMPLE = new RegExp(`(?:^|\\s)(${AMOUNT})\\s*$`);

  const CARD_TOKEN = /\b\d{2,6}[*xX]{2,}\d{2,4}\b/g;
  const TABLE_MARKER = /bruksdato/i;
  const MAX_CONTINUATION_LINES = 2;

  const TOTAL_LABEL = /totalt\s+skyldig\s+bel[oø]p/i;
  const TRANSACTIONS_TOTAL_LABEL = /sum\s+transaksjoner/i;
  const MINIMUM_LABEL = /minimum\s+[aå]\s+betale/i;

  function detect(text) {
    let score = 0;

    if (DETECT_STRONG.test(text)) score += 0.75;
    if (DETECT_SUPPORT.test(text)) score += 0.2;
    if (/kontoutskrift|kredittkort|faktura/i.test(text)) score += 0.05;

    if (/trumf|norgesgruppen/i.test(text)) score -= 0.6;

    return score;
  }

  function findFirstDate(lines, labels) {
    for (const line of lines) {
      for (const label of labels) {
        const re = new RegExp(`${label}[^\\d]{0,20}(\\d{1,2}[.\\-/]\\d{1,2}[.\\-/]\\d{2,4})`, "i");
        const match = line.match(re);

        if (match) {
          const iso = U.parseDate(match[1]);
          if (iso) return iso;
        }
      }
    }

    return null;
  }

  function findPeriod(lines) {
    for (const line of lines) {
      const match = line.match(
        /(?:periode|fakturaperiode)\D{0,20}(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})\s*(?:-|–|til)\s*(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})/i
      );

      if (match) {
        const start = U.parseDate(match[1]);
        const end = U.parseDate(match[2]);

        if (start && end) return { start, end };
      }
    }

    return null;
  }

  function splitMerchantAndLocation(text) {
    const index = text.lastIndexOf(",");

    if (index === -1) return { merchant: text, location: null };

    const merchant = U.cleanWhitespace(text.slice(0, index));
    const location = U.cleanWhitespace(text.slice(index + 1));

    return { merchant: merchant || text, location: location || null };
  }

  // Returns null while the row is still missing its amount columns.
  function finishRow(open) {
    // The card number goes first: it must never be stored, and its digits would
    // otherwise be mistaken for the leading part of an amount.
    const buffer = U.cleanWhitespace(open.buffer.replace(CARD_TOKEN, " "));

    let currency = "NOK";
    let rate = null;
    let printedOriginal = null;
    let printedNok = null;
    let description;

    const tail = buffer.match(TX_TAIL);

    if (tail) {
      printedOriginal = U.parseAmount(tail[1]);
      currency = tail[2];
      rate = tail[3] ? U.parseAmount(tail[3]) : null;
      printedNok = U.parseAmount(tail[4]);
      description = buffer.slice(0, tail.index);
    } else {
      const simple = buffer.match(TX_TAIL_SIMPLE);
      if (!simple) return null;

      printedNok = U.parseAmount(simple[1]);
      printedOriginal = printedNok;
      description = buffer.slice(0, simple.index);
    }

    if (printedNok == null) return null;

    description = U.cleanWhitespace(description.replace(/\s+-\s*$/, ""));

    const transactionDate = U.parseDate(open.date);
    if (!transactionDate || !description) return null;

    const rawDescription = U.redactSensitive(description);
    const parts = splitMerchantAndLocation(rawDescription);

    return {
      transaction_date: transactionDate,
      // The statement prints only "Bruksdato".
      posting_date: null,
      raw_description: rawDescription,
      normalized_merchant: U.normalizeMerchant(parts.merchant),
      merchant_location: parts.location,
      merchant_country: null,
      original_currency: currency,
      exchange_rate: rate,
      external_ref: null,
      printed_amount: printedNok,
      printed_original_amount: printedOriginal
    };
  }

  function collectRows(lines) {
    const rows = [];
    const warnings = [];
    let open = null;

    const abandon = () => {
      if (!open) return;
      warnings.push(`Skipped an unreadable transaction line: ${open.buffer.slice(0, 60)}`);
      open = null;
    };

    lines.forEach(line => {
      const start = line.match(ROW_START);

      if (start) {
        abandon();
        open = { date: start[1], buffer: start[2], continuations: 0 };
      } else if (open) {
        open.continuations += 1;
        open.buffer += ` ${line}`;

        if (open.continuations > MAX_CONTINUATION_LINES) {
          abandon();
          return;
        }
      } else {
        return;
      }

      const finished = finishRow(open);

      if (finished) {
        rows.push(finished);
        open = null;
      }
    });

    abandon();

    return { rows, warnings };
  }

  function applyConvention(rows) {
    const sign = U.detectSignConvention(rows);

    rows.forEach(row => {
      const resolved = U.resolveTypeAndAmount(row.raw_description, row.printed_amount * sign);

      row.transaction_type = resolved.type;
      row.amount_nok = resolved.amount;

      if (row.original_currency !== "NOK" && row.printed_original_amount != null) {
        const magnitude = Math.abs(row.printed_original_amount);
        row.original_amount = U.round2(resolved.amount < 0 ? -magnitude : magnitude);
      } else {
        row.original_amount = row.amount_nok;
        row.original_currency = "NOK";
        row.exchange_rate = null;
      }

      delete row.printed_amount;
      delete row.printed_original_amount;
    });
  }

  function summarize(rows) {
    const purchases = rows.filter(row => row.transaction_type === "purchase");
    const payments = rows.filter(row => row.transaction_type === "payment");
    const spending = rows.filter(row => row.transaction_type !== "payment");

    const sum = list => U.round2(list.reduce((total, row) => total + row.amount_nok, 0));

    return {
      purchase_count: purchases.length,
      purchase_total: sum(purchases),
      spending_total: sum(spending),
      payment_count: payments.length,
      payment_total: sum(payments)
    };
  }

  function parse(text) {
    const allLines = text.split("\n").map(U.cleanWhitespace).filter(Boolean);

    const tableStart = allLines.findIndex(line => TABLE_MARKER.test(line));
    const tableLines = tableStart === -1 ? allLines : allLines.slice(tableStart + 1);

    const { rows, warnings } = collectRows(tableLines);

    applyConvention(rows);
    U.assignDuplicateSequences(rows);

    const totals = summarize(rows);
    const period = findPeriod(allLines);
    const totalAmount = U.findLastAmountOnLabelLine(allLines, TOTAL_LABEL);
    const transactionsTotal = U.findLastAmountOnLabelLine(allLines, TRANSACTIONS_TOTAL_LABEL);
    const minimumPayment = U.findLastAmountOnLabelLine(allLines, MINIMUM_LABEL);

    const dates = rows.map(row => row.transaction_date).filter(Boolean).sort();
    const derivedPeriod = dates.length
      ? { start: dates[0], end: dates[dates.length - 1] }
      : null;

    if (!period) {
      warnings.push(
        derivedPeriod
          ? `No statement period printed in this PDF. Transactions run ${derivedPeriod.start} to ${derivedPeriod.end}; confirm the period before importing.`
          : "No statement period printed in this PDF."
      );
    }

    // "Sum transaksjoner denne perioden" excludes payments, so it is the exact
    // counterpart of spending_total; the invoice total also carries any balance
    // carried over and is only used as a fallback.
    const anchor = transactionsTotal == null ? totalAmount : transactionsTotal;
    const anchorLabel = transactionsTotal == null ? "statement total" : "transaction total";

    if (anchor == null) {
      warnings.push("Statement total not found, so spending could not be reconciled.");
    } else if (Math.abs(totals.spending_total - Math.abs(anchor)) > 0.01) {
      warnings.push(
        `Spending does not reconcile: parsed lines total ${totals.spending_total.toFixed(2)} NOK ` +
        `but the ${anchorLabel} is ${Math.abs(anchor).toFixed(2)} NOK ` +
        `(payments of ${Math.abs(totals.payment_total).toFixed(2)} NOK are excluded from spending).`
      );
    }

    return {
      statement: {
        provider_code: "bank_norwegian",
        // The invoice reference is tied to the KID, so it is never stored.
        statement_number: null,
        period_start: period ? period.start : null,
        period_end: period ? period.end : null,
        invoice_date: findFirstDate(allLines, ["fakturadato"]),
        due_date: findFirstDate(allLines, ["forfallsdato", "betalingsfrist"]),
        total_amount: totalAmount == null ? null : U.round2(Math.abs(totalAmount)),
        currency: "NOK",
        source_format: "bank-norwegian-pdf-v1"
      },
      derived: {
        period_is_derived: !period,
        period_start: derivedPeriod ? derivedPeriod.start : null,
        period_end: derivedPeriod ? derivedPeriod.end : null,
        minimum_payment: minimumPayment == null ? null : U.round2(Math.abs(minimumPayment)),
        transactions_total: transactionsTotal == null ? null : U.round2(transactionsTotal)
      },
      totals,
      transactions: rows,
      warnings
    };
  }

  window.StatementParsers.register({
    id: "bank_norwegian",
    providerCode: "bank_norwegian",
    label: "Bank Norwegian",
    detect,
    parse
  });
})();

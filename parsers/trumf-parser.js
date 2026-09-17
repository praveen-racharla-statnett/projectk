// Trumf Kredittkort (NorgesGruppen Finans) statement parser.
//
// Written against the real PDF.js extraction, which looks like:
//
//   Bokf. dato Kjøpsdato Spesifikasjon Kurs Valuta Beløp Beløp i NOK
//   31.08.26 31.08.26 TrumfPay, KIWI 331 Storgata 33, 2026-08-31
//   18.53.15
//   NOK -187,90 -187,90
//
// Four things about this format need care:
//   1. A row can wrap over three lines; the amounts often land on a later line.
//   2. The first date is the posting date, the second is the purchase date.
//   3. Purchases are printed negative and the payment positive. The sign is
//      normalised against the statement's own payment line, never assumed to
//      mean "refund".
//   4. The invoice prints "Minstebeløp å betale" next to "Totalt skyldig
//      beløp", and repeats the latter for the previous period. Only the
//      current total may become total_amount.

(() => {
  const U = window.ParserUtils;

  const DETECT_STRONG = /trumf\s*(kredittkort|visa)?/i;
  const DETECT_SUPPORT = /(norgesgruppen|trumf\s*bonus|trumfpoeng|trumfpay)/i;

  const AMOUNT = "-?\\d{1,3}(?:[.\\s]\\d{3})*,\\d{2}";

  const ROW_START =
    /^(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})(?:\s+(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}))?\s+(.+)$/;

  // "[Kurs] Valuta Beløp Beløp-i-NOK". The leading "(?:^|\s)" stops an amount
  // from starting inside a longer digit run, because "\s\d{3}" is also a valid
  // thousands separator.
  const TX_TAIL = new RegExp(
    `(?:^|\\s)(?:(\\d+,\\d+)\\s+)?([A-Z]{3})\\s+(${AMOUNT})\\s+(${AMOUNT})\\s*$`
  );

  // Rows without a currency column, such as "Innbetaling 1.772,04".
  const TX_TAIL_SIMPLE = new RegExp(`(?:^|\\s)(${AMOUNT})\\s*$`);

  // TrumfPay appends "<merchant>, 2026-08-31 18.53.15" to the description. The
  // clock part is often extracted onto its own line, so the date may stand alone.
  const TIMESTAMP_TAIL = /[,\s]*\d{4}-\d{2}-\d{2}(?:[\s,]*\d{2}[.:]\d{2}[.:]\d{2})?\s*$/;

  const TABLE_MARKER = /transaksjonsoversikt/i;
  const WALLET_PREFIX = /^(trumfpay|trumf\s*pay|vipps|apple\s*pay|google\s*pay|klarna)\b[\s:,-]*/i;
  const COUNTRY = /\b([A-Z]{2})\s*$/;

  const MAX_CONTINUATION_LINES = 4;

  const TOTAL_LABELS = [
    "totalt\\s+skyldig\\s+bel[oø]p",
    "nytt\\s+skyldig\\s+bel[oø]p",
    "totalt\\s+[aå]\\s+betale",
    "sum\\s+[aå]\\s+betale",
    "bel[oø]p\\s+[aå]\\s+betale",
    "fakturabel[oø]p"
  ];

  // "forrige periode" is last month's balance; "eksempel/utsette" belong to the
  // instalment-cost table further down the invoice.
  const TOTAL_EXCLUSIONS = /(minimum|minste|min\.|delbetal|forrige|periode|eksempel|utsette)/i;

  const MINIMUM_LABELS = [
    "minstebel[oø]p\\s+[aå]\\s+betale",
    "minimum\\s+[aå]\\s+betale",
    "minstebel[oø]p",
    "minimumsbel[oø]p",
    "minste\\s+innbetaling"
  ];

  function detect(text) {
    let score = 0;

    if (DETECT_STRONG.test(text)) score += 0.7;
    if (DETECT_SUPPORT.test(text)) score += 0.25;
    if (/kredittkort/i.test(text)) score += 0.05;

    // Bank Norwegian statements also mention Visa, so stay exclusive.
    if (/bank\s*norwegian|norwegian\s*finans/i.test(text)) score -= 0.6;

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
        /(?:periode|fakturaperiode|kontoutskrift\s*for)\D{0,20}(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})\s*(?:-|–|til)\s*(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})/i
      );

      if (match) {
        const start = U.parseDate(match[1]);
        const end = U.parseDate(match[2]);

        if (start && end) return { start, end };
      }
    }

    return null;
  }

  // Returns null while the row is still missing its amount columns.
  function finishRow(open) {
    const buffer = U.cleanWhitespace(open.buffer);

    let currency = "NOK";
    let rate = null;
    let printedOriginal = null;
    let printedNok = null;
    let description;

    const tail = buffer.match(TX_TAIL);

    if (tail) {
      rate = tail[1] ? U.parseAmount(tail[1]) : null;
      currency = tail[2];
      printedOriginal = U.parseAmount(tail[3]);
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

    description = U.cleanWhitespace(description.replace(TIMESTAMP_TAIL, "")).replace(/[,;]+$/, "");
    if (!description) return null;

    // Column order is "Bokf. dato" then "Kjøpsdato".
    const postingDate = open.date2 ? U.parseDate(open.date1) : null;
    const transactionDate = U.parseDate(open.date2 || open.date1);

    if (!transactionDate) return null;

    const rawDescription = U.redactSensitive(description);
    const merchantSource = rawDescription.replace(WALLET_PREFIX, "");
    const countryMatch = merchantSource.match(COUNTRY);
    const place = U.extractLocation(merchantSource, countryMatch ? countryMatch[1] : null);

    return {
      transaction_date: transactionDate,
      posting_date: postingDate,
      raw_description: rawDescription,
      normalized_merchant: U.normalizeMerchant(merchantSource),
      merchant_location: place.location,
      merchant_country: place.country,
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
      warnings.push(
        `Skipped an unreadable transaction line: ${open.buffer.slice(0, 60)}`
      );
      open = null;
    };

    lines.forEach(line => {
      const start = line.match(ROW_START);

      if (start) {
        abandon();
        open = { date1: start[1], date2: start[2] || null, buffer: start[3], continuations: 0 };
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

    // Page 1 carries the address block and payment slip; only the transaction
    // table may produce rows.
    const tableStart = allLines.findIndex(line => TABLE_MARKER.test(line));
    const tableLines = tableStart === -1 ? allLines : allLines.slice(tableStart + 1);

    const { rows, warnings } = collectRows(tableLines);

    applyConvention(rows);
    U.assignDuplicateSequences(rows);

    const totals = summarize(rows);
    const period = findPeriod(allLines);
    const rawTotal = U.findAmountByLabel(allLines, TOTAL_LABELS, TOTAL_EXCLUSIONS);
    const minimumPayment = U.findAmountByLabel(allLines, MINIMUM_LABELS);

    // The invoice prints the amount owed as both 969,43 and -969,43 depending
    // on the block, so the magnitude is what carries meaning.
    const totalAmount = rawTotal == null ? null : U.round2(Math.abs(rawTotal));

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

    if (totalAmount == null) {
      warnings.push("Statement total not found, so spending could not be reconciled.");
    } else if (Math.abs(totals.spending_total - totalAmount) > 0.01) {
      warnings.push(
        `Spending does not reconcile: parsed lines total ${totals.spending_total.toFixed(2)} NOK ` +
        `but the statement total is ${totalAmount.toFixed(2)} NOK ` +
        `(payments of ${Math.abs(totals.payment_total).toFixed(2)} NOK are excluded from spending).`
      );
    }

    return {
      statement: {
        provider_code: "trumf",
        // Fakturanummer contains the KID as a prefix, so it is never stored.
        statement_number: null,
        period_start: period ? period.start : null,
        period_end: period ? period.end : null,
        invoice_date: findFirstDate(allLines, ["fakturadato"]),
        due_date: findFirstDate(allLines, ["forfallsdato", "betalingsfrist"]),
        total_amount: totalAmount,
        currency: "NOK",
        source_format: "trumf-pdf-v1"
      },
      derived: {
        period_is_derived: !period,
        period_start: derivedPeriod ? derivedPeriod.start : null,
        period_end: derivedPeriod ? derivedPeriod.end : null,
        minimum_payment: minimumPayment == null ? null : U.round2(Math.abs(minimumPayment))
      },
      totals,
      transactions: rows,
      warnings
    };
  }

  window.StatementParsers.register({
    id: "trumf",
    providerCode: "trumf",
    label: "Trumf Kredittkort",
    detect,
    parse
  });
})();

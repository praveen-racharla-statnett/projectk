// Shared, provider-agnostic helpers for credit card statement parsers.
//
// Nothing here talks to Supabase or to the DOM, so parsers stay pure functions
// of the extracted PDF text. Everything runs in the browser; no text is ever
// sent anywhere.

window.ParserUtils = (() => {

  const NORWEGIAN_CITIES = new Set([
    "OSLO", "BERGEN", "TRONDHEIM", "STAVANGER", "DRAMMEN", "FREDRIKSTAD",
    "SANDNES", "KRISTIANSAND", "TROMSO", "TROMSØ", "SARPSBORG", "SKIEN",
    "BODO", "BODØ", "ALESUND", "ÅLESUND", "SANDEFJORD", "HAUGESUND",
    "TONSBERG", "TØNSBERG", "MOSS", "PORSGRUNN", "ARENDAL", "HAMAR",
    "LILLESTROM", "LILLESTRØM", "ASKER", "BAERUM", "BÆRUM", "LORENSKOG",
    "LØRENSKOG", "SKI", "JESSHEIM", "GARDERMOEN", "LYSAKER", "NESBRU"
  ]);

  const TYPE_KEYWORDS = [
    { type: "payment",         re: /\b(innbetal|betaling motta|takk for innbetal|nettbank|avtalegiro)/i },
    { type: "interest",        re: /\b(rente|kredittrente|nominell rente)/i },
    { type: "fee",             re: /\b(gebyr|purregebyr|fakturagebyr|termingebyr|varsel|omkostning|arsavgift|årsavgift|valutap[aå]slag)/i },
    { type: "cash_withdrawal", re: /\b(kontantuttak|minibank|uttak|atm|cash advance)/i },
    { type: "refund",          re: /\b(refusjon|kreditnota|kreditering|retur|tilbakebetal)/i }
  ];

  // Digit runs long enough to be a card number, account number or KID, plus
  // masked PAN shapes such as "492530******0909". Applied to every description
  // before it can be stored.
  const SENSITIVE_PATTERNS = [
    /\b\d{2,6}[*xX•]{2,}\d{2,4}\b/g,
    /(?:[*xX•]{2,}[\s-]*){2,}\d{3,4}/g,
    /\b\d{4}[\s-]?\d{2}[\s-]?[*xX]{2}[\s-]?[*xX]{4}\b/g,
    /\b\d{8,}\b/g,
    /\b\d{4}[\s.]\d{2}[\s.]\d{5}\b/g
  ];

  function cleanWhitespace(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  // Removes anything that could be a card number, account number or KID.
  function redactSensitive(value) {
    let out = cleanWhitespace(value);

    SENSITIVE_PATTERNS.forEach(pattern => {
      out = out.replace(pattern, "[redacted]");
    });

    return cleanWhitespace(out);
  }

  // Handles "1 234,56", "1.234,56", "-249,00", "249,00-", "249.00" and "1,234.56".
  function parseAmount(raw) {
    if (raw == null) return null;

    let text = cleanWhitespace(raw).replace(/\u00a0/g, "");
    if (!text) return null;

    let negative = false;

    if (/^\(.*\)$/.test(text)) {
      negative = true;
      text = text.slice(1, -1);
    }

    if (text.endsWith("-")) {
      negative = true;
      text = text.slice(0, -1);
    }

    if (text.startsWith("-")) {
      negative = true;
      text = text.slice(1);
    }

    text = text.replace(/[^\d.,]/g, "");
    if (!text) return null;

    const lastComma = text.lastIndexOf(",");
    const lastDot = text.lastIndexOf(".");

    if (lastComma > lastDot) {
      text = text.replace(/\./g, "").replace(",", ".");
    } else if (lastDot > lastComma) {
      text = text.replace(/,/g, "");
    } else {
      text = text.replace(/[.,]/g, "");
    }

    const value = Number(text);
    if (!Number.isFinite(value)) return null;

    return negative ? -value : value;
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  // Accepts dd.mm.yyyy, dd.mm.yy, dd/mm-yy and bare dd.mm (needs periodYear).
  function parseDate(raw, periodYear) {
    const text = cleanWhitespace(raw);
    if (!text) return null;

    const match = text.match(/^(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2}|\d{4}))?$/);
    if (!match) return null;

    const day = Number(match[1]);
    const month = Number(match[2]);
    let year = match[3] ? Number(match[3]) : Number(periodYear);

    if (!Number.isFinite(year)) return null;
    if (match[3] && match[3].length === 2) year += year < 70 ? 2000 : 1900;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;

    const date = new Date(Date.UTC(year, month - 1, day));

    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      return null;
    }

    return `${date.getUTCFullYear()}-${pad2(month)}-${pad2(day)}`;
  }

  // A statement that ends in January may contain December transactions.
  function resolveYearForPeriod(isoDate, periodStart, periodEnd) {
    if (!isoDate || !periodStart || !periodEnd) return isoDate;
    if (isoDate >= periodStart && isoDate <= periodEnd) return isoDate;

    const shifted = `${Number(isoDate.slice(0, 4)) - 1}${isoDate.slice(4)}`;

    return shifted >= periodStart && shifted <= periodEnd ? shifted : isoDate;
  }

  function normalizeMerchant(rawDescription) {
    let text = redactSensitive(rawDescription).toUpperCase();

    text = text
      .replace(/\[REDACTED\]/g, " ")
      .replace(/\b(NOK|KR)\b/g, " ")
      .replace(/[*#/\\|]+/g, " ")
      .replace(/\b\d{1,7}\b/g, " ")
      .replace(/[^A-ZÆØÅ0-9&.\- ]/g, " ");

    const words = cleanWhitespace(text).split(" ").filter(Boolean);

    while (words.length > 1 && NORWEGIAN_CITIES.has(words[words.length - 1])) {
      words.pop();
    }

    const normalized = words.join(" ").replace(/[.\-]+$/, "").trim();

    return normalized || null;
  }

  // Conservative: only returns a value when the trailing token is a known city
  // or an explicit country code, otherwise null.
  function extractLocation(rawDescription, countryCode) {
    const words = redactSensitive(rawDescription).toUpperCase().split(/\s+/).filter(Boolean);
    const last = words[words.length - 1];

    if (last && NORWEGIAN_CITIES.has(last)) {
      return { location: last, country: countryCode || "NO" };
    }

    if (countryCode && countryCode !== "NO" && words.length > 1) {
      return { location: last || null, country: countryCode };
    }

    return { location: null, country: countryCode || null };
  }

  function classifyType(rawDescription, amount) {
    const text = cleanWhitespace(rawDescription);

    for (const entry of TYPE_KEYWORDS) {
      if (entry.re.test(text)) return entry.type;
    }

    if (typeof amount === "number" && amount < 0) return "refund";

    return "purchase";
  }

  // Keyword-only classification: never infers a refund from a negative sign.
  function classifyKeywordType(rawDescription) {
    const text = cleanWhitespace(rawDescription);

    for (const entry of TYPE_KEYWORDS) {
      if (entry.re.test(text)) return entry.type;
    }

    return null;
  }

  // Issuers disagree on sign: some print purchases negative (money leaving the
  // card), some positive. Payments are the anchor - a payment is always money
  // coming in - so their printed sign reveals the document's convention.
  // Returns a multiplier that maps printed amounts onto "spending positive".
  function detectSignConvention(rows) {
    const printed = rows
      .map(row => ({
        amount: Number(row.printed_amount),
        type: classifyKeywordType(row.raw_description)
      }))
      .filter(row => Number.isFinite(row.amount) && row.amount !== 0);

    if (!printed.length) return 1;

    const payments = printed.filter(row => row.type === "payment");

    if (payments.length) {
      const positive = payments.filter(row => row.amount > 0).length;
      return positive > payments.length / 2 ? -1 : 1;
    }

    const negative = printed.filter(row => row.amount < 0).length;

    return negative > printed.length * 0.6 ? -1 : 1;
  }

  // Applies the ProjectK convention once the type is known: spending positive,
  // money back negative. The sign never decides the type on its own.
  function resolveTypeAndAmount(rawDescription, normalizedAmount) {
    let type = classifyKeywordType(rawDescription);

    if (!type) {
      type = normalizedAmount < 0 ? "refund" : "purchase";
    }

    const magnitude = Math.abs(Number(normalizedAmount) || 0);
    const isCredit = type === "payment" || type === "refund";

    return { type, amount: round2(isCredit ? -magnitude : magnitude) };
  }

  // Finds the amount that follows a label, trying labels in priority order and
  // ignoring matches whose surrounding words disqualify them (for example
  // "Minimum" before, or "forrige periode" between label and number).
  function findAmountByLabel(lines, labels, excludeContext) {
    for (const label of labels) {
      const re = new RegExp(`(?:${label})([^\\d-]{0,20})(-?\\d[\\d\\s.]*,\\d{2}-?)`, "gi");

      for (const line of lines) {
        let match;
        re.lastIndex = 0;

        while ((match = re.exec(line)) !== null) {
          const context = line.slice(Math.max(0, match.index - 24), match.index) + match[1];

          if (excludeContext && excludeContext.test(context)) continue;

          const value = parseAmount(match[2]);
          if (value != null) return value;
        }
      }
    }

    return null;
  }

  // duplicate_sequence contract (mirrors the SQL migration): the ordinal of a
  // line among identical lines in the same statement, counted in PDF order.
  // Pure function of the parsed rows, so re-parsing the same PDF reproduces it.
  function assignDuplicateSequences(transactions) {
    const seen = new Map();

    transactions.forEach(tx => {
      const key = [
        tx.transaction_date,
        cleanWhitespace(tx.raw_description).toLowerCase(),
        tx.original_amount,
        tx.original_currency,
        tx.amount_nok,
        tx.transaction_type
      ].join("|");

      const next = (seen.get(key) || 0) + 1;

      seen.set(key, next);
      tx.duplicate_sequence = next;
    });

    return transactions;
  }

  function round2(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }

  // For labels that put other text between themselves and the amount, such as
  // "Totalt skyldig beløp per 01.09.2026 kr 36.723,57". labelRegex must not be
  // global. Takes the last amount on the line, which is the column value.
  function findLastAmountOnLabelLine(lines, labelRegex) {
    for (const line of lines) {
      if (!labelRegex.test(line)) continue;

      const amounts = line.match(/-?\d{1,3}(?:[.\s]\d{3})*,\d{2}/g);
      if (!amounts || !amounts.length) continue;

      const value = parseAmount(amounts[amounts.length - 1]);
      if (value != null) return value;
    }

    return null;
  }

  return {
    cleanWhitespace,
    redactSensitive,
    parseAmount,
    parseDate,
    resolveYearForPeriod,
    normalizeMerchant,
    extractLocation,
    classifyType,
    classifyKeywordType,
    detectSignConvention,
    resolveTypeAndAmount,
    findAmountByLabel,
    findLastAmountOnLabelLine,
    assignDuplicateSequences,
    round2
  };
})();

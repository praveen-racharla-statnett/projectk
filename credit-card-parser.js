// credit-card-parser.js
//
// Turns the text of a credit card statement PDF (e.g. Trumf Visa / Entercard,
// Bank Norwegian) into transaction rows. Works in the browser
// (window.CreditCardParser) and in Node (module.exports) for testing.

(function (root) {
  const DATE_PREFIX = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{4}|\d{2}))?(?=\s|$)/;
  const AMOUNT =
    /^(-\s?)?(\d{1,3}(?:[ \u00a0.]\d{3})+|\d+)([,.]\d{2})(\s?-)?$/;
  const CURRENCY = /^[A-Z]{3}$/;
  const FOREIGN = /^([A-Z]{3})\s+(.+)$/;
  const UNCHECKED_BY_DEFAULT =
    /saldo|innbetal|betaling mottatt|payment|totalt|^sum\b|overført|minste ?beløp|renter? ?belast/i;

  function parseAmount(text) {
    const match = String(text).trim().match(AMOUNT);
    if (!match) return null;

    const integerPart = match[2].replace(/[ \u00a0.]/g, "");
    const value = Number(`${integerPart}.${match[3].slice(1)}`);
    const negative = Boolean(match[1] || match[4]);

    return negative ? -value : value;
  }

  function toIsoDate(day, month, year) {
    const d = Number(day);
    const m = Number(month);
    const y = Number(year);
    const date = new Date(Date.UTC(y, m - 1, d));

    if (
      date.getUTCFullYear() !== y ||
      date.getUTCMonth() !== m - 1 ||
      date.getUTCDate() !== d
    ) {
      return null;
    }

    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  function resolveDate(match, referenceDate) {
    const [, day, month, rawYear] = match;
    let year;

    if (rawYear) {
      year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
    } else {
      // Statements often omit the year: use the statement year and roll back
      // a year for December purchases on a January statement.
      year = referenceDate.year;
      if (Number(month) > referenceDate.month) year -= 1;
    }

    return toIsoDate(day, month, year);
  }

  // The latest full date in the document approximates the statement date.
  function findReferenceDate(rows) {
    let latest = null;

    rows.forEach(cells => {
      cells.join(" ").replace(
        /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g,
        (_, d, m, y) => {
          const iso = toIsoDate(d, m, y);
          if (iso && (!latest || iso > latest)) latest = iso;
          return _;
        }
      );
    });

    const now = new Date();
    const fallback = { year: now.getFullYear(), month: now.getMonth() + 1 };

    if (!latest) return fallback;

    return { year: Number(latest.slice(0, 4)), month: Number(latest.slice(5, 7)) };
  }

  function parseRow(rawCells, referenceDate) {
    const cells = rawCells.map(c => String(c).replace(/\s+/g, " ").trim()).filter(Boolean);
    if (!cells.length) return null;

    const dates = [];
    while (dates.length < 2 && cells.length) {
      const match = cells[0].match(DATE_PREFIX);
      if (!match) break;

      const iso = resolveDate(match, referenceDate);
      if (!iso) break;

      dates.push(iso);
      const rest = cells[0].slice(match[0].length).trim();
      if (rest) cells[0] = rest;
      else cells.shift();
    }

    if (!dates.length || !cells.length) return null;

    // The amount column is the right-most cell. Fall back to splitting it off
    // the end of the last cell when the PDF merged it with the description.
    let amount = parseAmount(cells[cells.length - 1]);
    if (amount !== null) {
      cells.pop();
    } else {
      const last = cells[cells.length - 1];
      const tail = last.match(/\s(-?\s?\d{1,3}(?:[ \u00a0.]\d{3})*[,.]\d{2}-?)$/);
      if (!tail) return null;

      amount = parseAmount(tail[1]);
      if (amount === null) return null;
      cells[cells.length - 1] = last.slice(0, tail.index).trim();
      if (!cells[cells.length - 1]) cells.pop();
    }

    let foreignAmount = null;
    let foreignCurrency = null;
    const descriptionParts = [];

    cells.forEach((cell, index) => {
      const foreign = cell.match(FOREIGN);
      if (foreign && parseAmount(foreign[2]) !== null && index > 0) {
        foreignCurrency = foreign[1];
        foreignAmount = parseAmount(foreign[2]);
        return;
      }

      if (CURRENCY.test(cell) && index > 0) {
        foreignCurrency = cell;
        return;
      }

      // Extra numeric columns (foreign amount, exchange rate) are not part of
      // the description.
      const numeric = parseAmount(cell);
      if (numeric !== null || /^\d+(?:[,.]\d+)?$/.test(cell)) {
        if (foreignCurrency && foreignAmount === null) foreignAmount = numeric;
        return;
      }

      descriptionParts.push(cell);
    });

    const description = descriptionParts.join(" ").trim();
    if (!/\p{L}/u.test(description)) return null;

    if (foreignCurrency === "NOK") {
      foreignCurrency = null;
      foreignAmount = null;
    }

    return {
      transaction_date: dates[0],
      posting_date: dates[1] || null,
      description,
      amount,
      foreign_amount: foreignCurrency ? foreignAmount : null,
      foreign_currency: foreignCurrency,
      include: !UNCHECKED_BY_DEFAULT.test(description)
    };
  }

  function parseRows(rows) {
    const referenceDate = findReferenceDate(rows);

    return rows
      .map(cells => parseRow(cells, referenceDate))
      .filter(Boolean);
  }

  // Groups pdf.js text items into visual rows of cells. Large horizontal gaps
  // separate cells (columns); small gaps are word spaces inside a cell.
  function itemsToRows(items) {
    const textItems = items
      .filter(item => item.str && item.str.trim())
      .map(item => ({
        text: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width,
        size: Math.abs(item.transform[3]) || item.height || 10
      }))
      .sort((a, b) => b.y - a.y || a.x - b.x);

    const lines = [];
    textItems.forEach(item => {
      const line = lines.find(l => Math.abs(l.y - item.y) <= Math.max(2, item.size * 0.4));
      if (line) line.items.push(item);
      else lines.push({ y: item.y, items: [item] });
    });

    return lines.map(line => {
      const sorted = line.items.sort((a, b) => a.x - b.x);
      const cells = [];
      let current = null;

      sorted.forEach(item => {
        if (!current) {
          current = { text: item.text, end: item.x + item.width };
          return;
        }

        const gap = item.x - current.end;
        if (gap > item.size * 1.2) {
          cells.push(current.text);
          current = { text: item.text, end: item.x + item.width };
        } else {
          const separator = gap > item.size * 0.15 ? " " : "";
          current.text += separator + item.text;
          current.end = Math.max(current.end, item.x + item.width);
        }
      });

      if (current) cells.push(current.text);
      return cells.map(c => c.replace(/\s+/g, " ").trim()).filter(Boolean);
    });
  }

  async function extractRowsFromPdf(pdfjsLib, data, password) {
    const pdf = await pdfjsLib.getDocument({ data, password }).promise;
    const rows = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      rows.push(...itemsToRows(content.items));
    }

    await pdf.destroy();
    return rows;
  }

  async function parsePdf(pdfjsLib, data, password) {
    const rows = await extractRowsFromPdf(pdfjsLib, data, password);
    return { rows, transactions: parseRows(rows) };
  }

  const api = { parseAmount, parseRow, parseRows, itemsToRows, extractRowsFromPdf, parsePdf };

  root.CreditCardParser = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

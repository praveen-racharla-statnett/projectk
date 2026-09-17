// Credit card statement import: PDF.js text extraction, preview and the
// explicit Confirm Import write.
//
// Everything runs in the browser. The PDF is never uploaded, never stored and
// never sent to any API or AI service. The only network calls are the PDF.js
// CDN bundle and the existing authenticated Supabase client, which is subject
// to RLS. The service-role key is not used anywhere.

(() => {
  const PDFJS_VERSION = "3.11.174";
  const PDFJS_SRC = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.js`;
  const PDFJS_WORKER = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.js`;

  const MAX_PREVIEW_ROWS = 400;
  const INSERT_CHUNK_SIZE = 200;

  const money = new Intl.NumberFormat("nb-NO", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  const state = {
    file: null,
    fileHash: null,
    parsed: null,
    parserId: null,
    categories: [],
    rules: [],
    rowCategories: new Map(),
    existingStatement: null
  };

  let pdfJsPromise = null;

  // Loaded on first use so the dashboard is not slowed down by the CDN bundle.
  function loadPdfJs() {
    if (window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return Promise.resolve(window.pdfjsLib);
    }

    if (pdfJsPromise) return pdfJsPromise;

    pdfJsPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");

      script.src = PDFJS_SRC;
      script.crossOrigin = "anonymous";
      script.referrerPolicy = "no-referrer";
      script.onload = () => {
        if (!window.pdfjsLib) {
          reject(new Error("PDF.js loaded but pdfjsLib is missing"));
          return;
        }

        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        resolve(window.pdfjsLib);
      };
      script.onerror = () => reject(new Error("Unable to load PDF.js from CDN"));

      document.head.appendChild(script);
    });

    return pdfJsPromise;
  }

  // Rebuilds visual lines: PDF.js returns positioned fragments, not lines.
  function itemsToLines(items) {
    const rows = new Map();

    items.forEach(item => {
      if (!item.str || !item.str.trim()) return;

      const y = Math.round(item.transform[5]);
      const bucket = Math.round(y / 3) * 3;

      if (!rows.has(bucket)) rows.set(bucket, []);
      rows.get(bucket).push({ x: item.transform[4], text: item.str });
    });

    return Array.from(rows.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([, fragments]) =>
        fragments
          .sort((a, b) => a.x - b.x)
          .map(fragment => fragment.text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
      )
      .filter(Boolean);
  }

  async function extractText(file) {
    const pdfjsLib = await loadPdfJs();
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    const pages = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();

      pages.push(itemsToLines(content.items).join("\n"));
    }

    await pdf.destroy();

    return pages.join("\n");
  }

  async function sha256Hex(file) {
    if (!window.crypto?.subtle) return null;

    const digest = await window.crypto.subtle.digest("SHA-256", await file.arrayBuffer());

    return Array.from(new Uint8Array(digest))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function el(id) {
    return document.getElementById(id);
  }

  function setStatus(message, tone = "info") {
    const node = el("importStatus");
    if (!node) return;

    node.textContent = message || "";
    node.dataset.tone = tone;
  }

  function formatAmount(value) {
    return value == null ? "—" : `${money.format(value)} kr`;
  }

  // Fallback for parsers that do not report their own totals.
  function computeTotals(transactions) {
    const sum = list =>
      Math.round(list.reduce((total, tx) => total + Number(tx.amount_nok || 0), 0) * 100) / 100;

    const purchases = transactions.filter(tx => tx.transaction_type === "purchase");
    const payments = transactions.filter(tx => tx.transaction_type === "payment");

    return {
      purchase_count: purchases.length,
      purchase_total: sum(purchases),
      spending_total: sum(transactions.filter(tx => tx.transaction_type !== "payment")),
      payment_count: payments.length,
      payment_total: sum(payments)
    };
  }

  async function loadCategories() {
    const { data, error } = await supabaseClient
      .from("budget_categories")
      .select("id, name, sort_order, budget_parent_categories ( name, sort_order )")
      .order("sort_order", { ascending: true });

    if (error) {
      console.warn("Unable to load budget categories", error.message);
      return [];
    }

    return (data || []).map(row => ({
      id: row.id,
      name: row.name,
      parent: row.budget_parent_categories?.name || "OTHER"
    }));
  }

  async function loadRules() {
    const { data, error } = await supabaseClient
      .from("merchant_category_rules")
      .select("match_type, match_value, budget_category_id, priority, is_active")
      .eq("is_active", true)
      .order("priority", { ascending: true });

    if (error) {
      console.warn("Merchant rules unavailable (migration applied?)", error.message);
      return [];
    }

    return data || [];
  }

  function matchRule(transaction) {
    const haystack = `${transaction.normalized_merchant || ""} ${transaction.raw_description}`.toLowerCase();

    for (const rule of state.rules) {
      if (rule.budget_category_id == null) continue;

      const needle = String(rule.match_value || "").toLowerCase();
      if (!needle) continue;

      let hit = false;

      if (rule.match_type === "exact") hit = haystack.trim() === needle;
      else if (rule.match_type === "prefix") hit = haystack.trim().startsWith(needle);
      else if (rule.match_type === "contains") hit = haystack.includes(needle);
      else if (rule.match_type === "regex") {
        try {
          hit = new RegExp(rule.match_value, "i").test(haystack);
        } catch (error) {
          console.warn("Invalid merchant rule regex", error.message);
        }
      }

      if (hit) return rule.budget_category_id;
    }

    return null;
  }

  function categoryOptionsHtml(selectedId) {
    const grouped = new Map();

    state.categories.forEach(category => {
      if (!grouped.has(category.parent)) grouped.set(category.parent, []);
      grouped.get(category.parent).push(category);
    });

    let html = '<option value="">Uncategorized</option>';

    grouped.forEach((categories, parent) => {
      html += `<optgroup label="${escapeHtml(parent)}">`;

      categories.forEach(category => {
        const selected = String(category.id) === String(selectedId) ? " selected" : "";
        html += `<option value="${escapeHtml(category.id)}"${selected}>${escapeHtml(category.name)}</option>`;
      });

      html += "</optgroup>";
    });

    return html;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // The period is never invented by a parser: when the PDF does not print one,
  // the derived transaction range is offered here for the user to confirm.
  function prefillPeriod(statement, derived) {
    const startInput = el("importPeriodStart");
    const endInput = el("importPeriodEnd");
    const hint = el("importPeriodHint");

    startInput.value = statement.period_start || derived.period_start || "";
    endInput.value = statement.period_end || derived.period_end || "";

    hint.textContent = statement.period_start
      ? "Read from the statement."
      : "Not printed in this PDF - derived from transaction dates. Confirm before importing.";
    hint.dataset.derived = statement.period_start ? "false" : "true";
  }

  function renderPreview() {
    const parsed = state.parsed;
    const summary = el("importSummary");
    const tableBody = el("importPreviewBody");
    const warnings = el("importWarnings");

    if (!parsed) {
      summary.innerHTML = "";
      tableBody.innerHTML = "";
      warnings.innerHTML = "";
      el("importPaymentsBody").innerHTML = "";
      el("importPaymentsWrap").hidden = true;
      el("importPreviewNote").textContent = "";
      return;
    }

    const statement = parsed.statement;
    const totals = parsed.totals || computeTotals(parsed.transactions);
    const derived = parsed.derived || {};
    const hasExplicitPeriod = Boolean(statement.period_start && statement.period_end);

    const periodLabel = hasExplicitPeriod
      ? `${statement.period_start} → ${statement.period_end}`
      : derived.period_start
        ? `${derived.period_start} → ${derived.period_end}`
        : "—";

    summary.innerHTML = `
      <div class="import-summary-item"><span>Provider</span><strong>${escapeHtml(state.parserLabel)}</strong></div>
      <div class="import-summary-item"><span>${hasExplicitPeriod ? "Statement period" : "Transaction range (derived)"}</span><strong>${escapeHtml(periodLabel)}</strong></div>
      <div class="import-summary-item"><span>Invoice date</span><strong>${escapeHtml(statement.invoice_date || "—")}</strong></div>
      <div class="import-summary-item"><span>Due date</span><strong>${escapeHtml(statement.due_date || "—")}</strong></div>
      <div class="import-summary-item"><span>Statement total</span><strong>${formatAmount(statement.total_amount)}</strong></div>
      <div class="import-summary-item"><span>Minimum payment</span><strong>${formatAmount(derived.minimum_payment ?? null)}</strong></div>
      <div class="import-summary-item"><span>Purchases</span><strong>${totals.purchase_count} · ${formatAmount(totals.purchase_total)}</strong></div>
      <div class="import-summary-item"><span>Spending total</span><strong>${formatAmount(totals.spending_total)}</strong></div>
      <div class="import-summary-item"><span>Payments (not spending)</span><strong>${totals.payment_count} · ${formatAmount(totals.payment_total)}</strong></div>
    `;

    prefillPeriod(statement, derived);

    const messages = parsed.warnings.slice();

    if (
      !parsed.totals &&
      statement.total_amount != null &&
      Math.abs(totals.spending_total - statement.total_amount) > 0.01
    ) {
      messages.push(
        `Spending does not reconcile: parsed lines total ${formatAmount(totals.spending_total)} ` +
        `but the statement total is ${formatAmount(statement.total_amount)}. ` +
        "Payments are excluded from spending."
      );
    }

    if (state.existingStatement) {
      messages.push(
        "This statement already exists in ProjectK. Importing again will reuse it and skip transactions that are already stored."
      );
    }

    warnings.innerHTML = messages.length
      ? `<ul>${messages.map(message => `<li>${escapeHtml(message)}</li>`).join("")}</ul>`
      : "";

    const indexed = parsed.transactions.map((tx, index) => ({ tx, index }));
    const spending = indexed.filter(row => row.tx.transaction_type !== "payment");
    const payments = indexed.filter(row => row.tx.transaction_type === "payment");
    const rows = spending.slice(0, MAX_PREVIEW_ROWS);

    tableBody.innerHTML = rows
      .map(({ tx, index }) => `
        <tr>
          <td>${escapeHtml(tx.transaction_date)}</td>
          <td>${escapeHtml(tx.posting_date || "—")}</td>
          <td>
            <span class="import-merchant">${escapeHtml(tx.normalized_merchant || "—")}</span>
            <span class="import-raw">${escapeHtml(tx.raw_description)}</span>
          </td>
          <td>${escapeHtml(tx.merchant_location || "—")}</td>
          <td class="import-num">${escapeHtml(tx.original_currency)} ${money.format(tx.original_amount)}</td>
          <td class="import-num">${tx.exchange_rate == null ? "—" : escapeHtml(tx.exchange_rate)}</td>
          <td class="import-num">${formatAmount(tx.amount_nok)}</td>
          <td>${escapeHtml(tx.transaction_type)}</td>
          <td class="import-num">${escapeHtml(tx.duplicate_sequence)}</td>
          <td>
            <select class="budget-select import-category" data-row="${index}">
              ${categoryOptionsHtml(state.rowCategories.get(index))}
            </select>
          </td>
        </tr>
      `)
      .join("");

    // Payments are card repayments, never spending, so they are listed apart
    // and carry no budget category.
    const paymentsWrap = el("importPaymentsWrap");

    el("importPaymentsBody").innerHTML = payments
      .map(({ tx }) => `
        <tr>
          <td>${escapeHtml(tx.transaction_date)}</td>
          <td>${escapeHtml(tx.raw_description)}</td>
          <td>${escapeHtml(tx.transaction_type)}</td>
          <td class="import-num">${formatAmount(tx.amount_nok)}</td>
        </tr>
      `)
      .join("");

    paymentsWrap.hidden = payments.length === 0;

    el("importPreviewNote").textContent =
      spending.length > MAX_PREVIEW_ROWS
        ? `Showing the first ${MAX_PREVIEW_ROWS} of ${spending.length} spending lines. All lines will be imported.`
        : "";

    tableBody.querySelectorAll(".import-category").forEach(select => {
      select.addEventListener("change", event => {
        const row = Number(event.currentTarget.dataset.row);
        const value = event.currentTarget.value;

        if (value) state.rowCategories.set(row, value);
        else state.rowCategories.delete(row);
      });
    });
  }

  async function findExistingStatement(statement) {
    const filters = supabaseClient
      .from("credit_card_statements")
      .select("id, period_start, period_end, source_file_hash")
      .eq("provider_code", statement.provider_code);

    const { data, error } = await filters;

    if (error) {
      console.warn("Unable to check for existing statements", error.message);
      return null;
    }

    const byHash = (data || []).find(row => state.fileHash && row.source_file_hash === state.fileHash);
    if (byHash) return byHash;

    return (data || []).find(row =>
      row.period_start === statement.period_start && row.period_end === statement.period_end
    ) || null;
  }

  async function handleParse() {
    const file = el("importFile").files?.[0];

    if (!file) {
      setStatus("Choose a PDF statement first.", "error");
      return;
    }

    if (file.type && file.type !== "application/pdf") {
      setStatus("Only PDF statements are supported.", "error");
      return;
    }

    const parseButton = el("importParseButton");

    parseButton.disabled = true;
    el("importConfirmButton").disabled = true;
    setStatus("Reading PDF in your browser...");

    try {
      state.file = file;
      state.fileHash = await sha256Hex(file);

      const text = await extractText(file);

      if (!text.trim()) {
        setStatus("No text found in this PDF. Scanned statements are not supported.", "error");
        return;
      }

      const override = el("importProvider").value;
      let parser = override ? window.StatementParsers.get(override) : null;
      let score = override ? 1 : 0;

      if (!parser) {
        const detected = window.StatementParsers.detect(text);

        if (!detected) {
          setStatus("Could not recognise this statement. Pick the provider manually and parse again.", "error");
          return;
        }

        parser = detected.parser;
        score = detected.score;
      }

      state.parserId = parser.id;
      state.parserLabel = parser.label;

      const parsed = parser.parse(text);

      if (!parsed.transactions.length) {
        setStatus(`${parser.label} parser found no transactions in this PDF.`, "error");
        state.parsed = null;
        renderPreview();
        return;
      }

      state.parsed = parsed;
      state.rowCategories = new Map();

      if (!state.categories.length) state.categories = await loadCategories();
      state.rules = await loadRules();

      parsed.transactions.forEach((tx, index) => {
        const categoryId = matchRule(tx);
        if (categoryId != null) state.rowCategories.set(index, categoryId);
      });

      state.existingStatement = await findExistingStatement(parsed.statement);

      renderPreview();

      el("importConfirmButton").disabled = false;
      setStatus(
        `Parsed ${parsed.transactions.length} transactions with the ${parser.label} parser` +
        `${override ? " (manual override)" : ` (confidence ${Math.round(score * 100)}%)`}. ` +
        "Nothing has been saved yet.",
        "success"
      );
    } catch (error) {
      console.error("Statement parsing failed", error);
      setStatus(`Parsing failed: ${error.message}`, "error");
    } finally {
      parseButton.disabled = false;
    }
  }

  async function handleConfirmImport() {
    if (!state.parsed) {
      setStatus("Parse a statement before importing.", "error");
      return;
    }

    const confirmButton = el("importConfirmButton");
    const statement = state.parsed.statement;
    const cardAlias = window.ParserUtils.cleanWhitespace(el("importAlias").value) || null;
    const periodStart = el("importPeriodStart").value || null;
    const periodEnd = el("importPeriodEnd").value || null;

    if (!periodStart || !periodEnd) {
      setStatus("Set the statement period before importing.", "error");
      return;
    }

    if (periodEnd < periodStart) {
      setStatus("The statement period ends before it starts.", "error");
      return;
    }

    confirmButton.disabled = true;
    setStatus("Saving to Supabase...");

    try {
      const { data: userData, error: userError } = await supabaseClient.auth.getUser();

      if (userError || !userData?.user) {
        setStatus("Your session expired. Sign in again.", "error");
        return;
      }

      const userId = userData.user.id;
      let statementId = state.existingStatement?.id || null;

      if (!statementId) {
        const { data: inserted, error: statementError } = await supabaseClient
          .from("credit_card_statements")
          .insert({
            user_id: userId,
            provider_code: statement.provider_code,
            card_alias: cardAlias,
            statement_number: statement.statement_number,
            period_start: periodStart,
            period_end: periodEnd,
            invoice_date: statement.invoice_date,
            due_date: statement.due_date,
            total_amount: statement.total_amount,
            currency: statement.currency,
            source_format: statement.source_format,
            source_file_name: state.file?.name || null,
            source_file_hash: state.fileHash,
            parser_version: state.parserId
          })
          .select("id")
          .single();

        if (statementError) throw statementError;

        statementId = inserted.id;
      }

      const rows = state.parsed.transactions.map((tx, index) => ({
        user_id: userId,
        statement_id: statementId,
        provider_code: statement.provider_code,
        card_alias: cardAlias,
        transaction_date: tx.transaction_date,
        posting_date: tx.posting_date,
        raw_description: tx.raw_description,
        normalized_merchant: tx.normalized_merchant,
        merchant_location: tx.merchant_location,
        merchant_country: tx.merchant_country,
        original_amount: tx.original_amount,
        original_currency: tx.original_currency,
        exchange_rate: tx.exchange_rate,
        amount_nok: tx.amount_nok,
        transaction_type: tx.transaction_type,
        external_ref: tx.external_ref,
        duplicate_sequence: tx.duplicate_sequence,
        budget_category_id: state.rowCategories.get(index) ?? null,
        category_source: state.rowCategories.has(index) ? "rule" : "uncategorized"
      }));

      let insertedCount = 0;

      for (let start = 0; start < rows.length; start += INSERT_CHUNK_SIZE) {
        const chunk = rows.slice(start, start + INSERT_CHUNK_SIZE);

        const { data, error } = await supabaseClient
          .from("credit_card_transactions")
          .upsert(chunk, { onConflict: "user_id,dedupe_key", ignoreDuplicates: true })
          .select("id");

        if (error) throw error;

        insertedCount += (data || []).length;
      }

      const skipped = rows.length - insertedCount;

      setStatus(
        `Imported ${insertedCount} transactions. ${skipped} already existed and were skipped.`,
        "success"
      );

      state.existingStatement = { id: statementId };
    } catch (error) {
      console.error("Import failed", error);
      setStatus(`Import failed: ${error.message}`, "error");
      confirmButton.disabled = false;
    }
  }

  function populateProviderSelect() {
    const select = el("importProvider");
    if (!select) return;

    select.innerHTML =
      '<option value="">Auto-detect</option>' +
      window.StatementParsers
        .list()
        .map(parser => `<option value="${escapeHtml(parser.id)}">${escapeHtml(parser.label)}</option>`)
        .join("");
  }

  function init() {
    if (!el("importFile")) return;

    populateProviderSelect();

    el("importParseButton").addEventListener("click", handleParse);
    el("importConfirmButton").addEventListener("click", handleConfirmImport);

    el("importFile").addEventListener("change", () => {
      state.parsed = null;
      state.existingStatement = null;
      el("importConfirmButton").disabled = true;
      renderPreview();
      setStatus("");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

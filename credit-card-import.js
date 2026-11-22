// credit-card-import.js
//
// Credit card PDF upload: choose a card, parse the statement PDF in the
// browser, review the transactions in a popup and commit them to Supabase.

(() => {
  const PDFJS_VERSION = "4.10.38";
  const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build`;

  const cardSelect = document.getElementById("cardSelect");
  const fileInput = document.getElementById("statementFile");
  const form = document.getElementById("cardUploadForm");
  const previewButton = document.getElementById("cardPreviewButton");
  const status = document.getElementById("cardUploadStatus");

  const dialog = document.getElementById("cardReviewDialog");
  const dialogTitle = document.getElementById("cardReviewTitle");
  const dialogSubtitle = document.getElementById("cardReviewSubtitle");
  const dueDateInput = document.getElementById("cardReviewDueDate");
  const tableBody = document.getElementById("cardReviewRows");
  const selectAll = document.getElementById("cardReviewSelectAll");
  const summary = document.getElementById("cardReviewSummary");
  const dialogError = document.getElementById("cardReviewError");
  const approveButton = document.getElementById("cardReviewApprove");
  const cancelButtons = dialog.querySelectorAll("[data-close-dialog]");

  const currency = new Intl.NumberFormat("nb-NO", {
    style: "currency",
    currency: "NOK"
  });

  let pdfjsPromise = null;
  let pending = null;

  function setStatus(message, type = "") {
    status.textContent = message;
    status.className = `card-upload-status ${type}`.trim();
  }

  function loadPdfJs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(`${PDFJS_BASE}/pdf.min.mjs`).then(lib => {
        lib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.mjs`;
        return lib;
      });
      pdfjsPromise.catch(() => {
        pdfjsPromise = null;
      });
    }
    return pdfjsPromise;
  }

  async function sha256Hex(buffer) {
    const hash = await crypto.subtle.digest("SHA-256", buffer);
    return [...new Uint8Array(hash)]
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  async function loadCards() {
    const { data, error } = await supabaseClient
      .from("credit_cards")
      .select("id, name, issuer, amount_sign")
      .eq("active", true)
      .order("sort_order", { ascending: true });

    cardSelect.innerHTML = "";

    if (error || !data?.length) {
      console.error("Unable to load credit cards:", error);
      cardSelect.append(new Option("No cards available", ""));
      cardSelect.disabled = true;
      setStatus("Unable to load credit cards.", "error");
      return;
    }

    data.forEach(card => {
      const option = new Option(card.name, card.id);
      option.dataset.amountSign = card.amount_sign ?? 1;
      cardSelect.append(option);
    });
    cardSelect.disabled = false;
    updatePreviewButton();
  }

  function updatePreviewButton() {
    previewButton.disabled = !cardSelect.value || !fileInput.files.length;
  }

  async function readPdf(data) {
    const pdfjsLib = await loadPdfJs();

    try {
      return await CreditCardParser.parsePdf(pdfjsLib, data);
    } catch (error) {
      if (error?.name === "PasswordException") {
        const password = window.prompt("This PDF is password protected. Enter the password:");
        if (!password) throw new Error("A password is required to read this PDF.");
        return CreditCardParser.parsePdf(pdfjsLib, data, password);
      }
      throw error;
    }
  }

  async function handlePreview(event) {
    event.preventDefault();

    const file = fileInput.files[0];
    const cardId = Number(cardSelect.value);
    if (!file || !cardId) return;

    if (file.type && file.type !== "application/pdf") {
      setStatus("Please choose a PDF file.", "error");
      return;
    }

    previewButton.disabled = true;
    setStatus("Reading PDF…");

    try {
      const buffer = await file.arrayBuffer();
      const fileHash = await sha256Hex(buffer);
      // pdf.js transfers (detaches) the buffer it is given, so pass a copy.
      const { rows, transactions, dueDate } = await readPdf(new Uint8Array(buffer.slice(0)));

      if (!rows.length) {
        setStatus("No text found in the PDF. Scanned statements are not supported.", "error");
        return;
      }

      if (!transactions.length) {
        setStatus("No transactions were recognised in this PDF.", "error");
        console.info("Extracted PDF rows:", rows);
        return;
      }

      // Issuers that print purchases as negative amounts have amount_sign -1.
      const amountSign = Number(cardSelect.selectedOptions[0].dataset.amountSign) || 1;
      transactions.forEach(tx => {
        tx.amount = Math.round(tx.amount * amountSign * 100) / 100;
      });

      pending = {
        cardId,
        cardName: cardSelect.selectedOptions[0].textContent,
        fileName: file.name,
        fileHash,
        dueDate,
        transactions
      };

      setStatus("");
      openReview();
    } catch (error) {
      console.error("Unable to read statement PDF:", error);
      setStatus(error.message || "Unable to read the PDF.", "error");
    } finally {
      updatePreviewButton();
    }
  }

  function createInput(type, value, attributes = {}) {
    const input = document.createElement("input");
    input.type = type;
    input.value = value ?? "";
    Object.entries(attributes).forEach(([key, val]) => input.setAttribute(key, val));
    return input;
  }

  function renderRows() {
    tableBody.innerHTML = "";

    pending.transactions.forEach((tx, index) => {
      const row = document.createElement("tr");
      row.dataset.index = index;
      if (!tx.include) row.classList.add("excluded");

      const include = createInput("checkbox", "", { "aria-label": "Include transaction" });
      include.checked = tx.include;
      include.dataset.field = "include";

      const date = createInput("date", tx.transaction_date, {
        required: "",
        "aria-label": "Transaction date"
      });
      date.dataset.field = "transaction_date";

      const description = createInput("text", tx.description, {
        required: "",
        "aria-label": "Description"
      });
      description.dataset.field = "description";

      const amount = createInput("number", tx.amount.toFixed(2), {
        step: "0.01",
        required: "",
        "aria-label": "Amount (NOK)"
      });
      amount.dataset.field = "amount";
      amount.classList.add("amount-input");

      const foreign = document.createElement("span");
      foreign.className = "foreign-amount";
      foreign.textContent = tx.foreign_currency
        ? `${tx.foreign_currency} ${tx.foreign_amount ?? ""}`.trim()
        : "";

      [include, date, description, foreign, amount].forEach(control => {
        const cell = document.createElement("td");
        cell.append(control);
        row.append(cell);
      });

      tableBody.append(row);
    });

    updateSummary();
  }

  function updateSummary() {
    const selected = pending.transactions.filter(tx => tx.include);
    const total = selected.reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);

    summary.textContent =
      `${selected.length} of ${pending.transactions.length} selected · Total ${currency.format(total)}`;

    approveButton.disabled = selected.length === 0;
    approveButton.textContent = `Approve & save (${selected.length})`;

    selectAll.checked = selected.length === pending.transactions.length;
    selectAll.indeterminate =
      selected.length > 0 && selected.length < pending.transactions.length;
  }

  function openReview() {
    dialogTitle.textContent = `${pending.cardName} transactions`;
    dialogSubtitle.textContent = pending.fileName;
    dueDateInput.value = pending.dueDate || "";
    dialogError.textContent = "";
    renderRows();
    dialog.showModal();
  }

  function closeReview() {
    if (dialog.open) dialog.close();
    pending = null;
    tableBody.innerHTML = "";
  }

  function handleRowInput(event) {
    const field = event.target.dataset.field;
    const row = event.target.closest("tr");
    if (!field || !row || !pending) return;

    const tx = pending.transactions[Number(row.dataset.index)];

    if (field === "include") {
      tx.include = event.target.checked;
      row.classList.toggle("excluded", !tx.include);
    } else if (field === "amount") {
      tx.amount = event.target.value === "" ? NaN : Number(event.target.value);
    } else {
      tx[field] = event.target.value;
    }

    updateSummary();
  }

  function validSelection() {
    const selected = pending.transactions.filter(tx => tx.include);
    const invalid = selected.find(
      tx =>
        !/^\d{4}-\d{2}-\d{2}$/.test(tx.transaction_date) ||
        !String(tx.description).trim() ||
        !Number.isFinite(tx.amount)
    );

    if (invalid) {
      dialogError.textContent =
        "Every selected transaction needs a date, description and amount.";
      return null;
    }

    return selected.map(tx => ({
      transaction_date: tx.transaction_date,
      posting_date: tx.posting_date,
      description: String(tx.description).trim(),
      amount: Math.round(tx.amount * 100) / 100,
      foreign_amount: tx.foreign_amount,
      foreign_currency: tx.foreign_currency
    }));
  }

  async function handleApprove() {
    if (!pending) return;

    const transactions = validSelection();
    if (!transactions) return;

    approveButton.disabled = true;
    approveButton.textContent = "Saving…";
    dialogError.textContent = "";

    const { data, error } = await supabaseClient.rpc("import_credit_card_statement", {
      p_card_id: pending.cardId,
      p_file_name: pending.fileName,
      p_file_sha256: pending.fileHash,
      p_transactions: transactions,
      p_due_date: dueDateInput.value || null
    });

    if (error) {
      console.error("Unable to save transactions:", error);
      dialogError.textContent = error.message || "Unable to save transactions.";
      updateSummary();
      return;
    }

    const cardName = pending.cardName;
    closeReview();
    form.reset();
    updatePreviewButton();

    const skipped = data.skipped
      ? ` ${data.skipped} already imported transaction(s) were skipped.`
      : "";
    setStatus(
      `Saved ${data.inserted} ${cardName} transaction(s).${skipped}`,
      "success"
    );
    document.dispatchEvent(new CustomEvent("card-transactions-changed"));
  }

  form.addEventListener("submit", handlePreview);
  cardSelect.addEventListener("change", updatePreviewButton);
  fileInput.addEventListener("change", () => {
    setStatus("");
    updatePreviewButton();
  });

  tableBody.addEventListener("input", handleRowInput);
  tableBody.addEventListener("change", handleRowInput);

  selectAll.addEventListener("change", () => {
    if (!pending) return;
    pending.transactions.forEach(tx => {
      tx.include = selectAll.checked;
    });
    renderRows();
  });

  approveButton.addEventListener("click", handleApprove);
  cancelButtons.forEach(button => button.addEventListener("click", closeReview));
  dialog.addEventListener("close", () => {
    pending = null;
  });

  loadCards();
})();

// card-dashboard.js
//
// Card spending dashboard: KPIs, monthly spend vs budget, categories, top
// merchants, daily heatmap, recurring payments and a transaction table.

(() => {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const CARD_COLORS = ["#2563eb", "#f97316", "#10b981", "#a855f7", "#ef4444", "#eab308"];
  const PAGE_SIZE = 50;

  const $ = id => document.getElementById(id);
  const els = {
    content: $("cardDashContent"),
    status: $("cardDashStatus"),
    cardFilter: $("cardDashCard"),
    yearFilter: $("cardDashYear"),
    monthFilter: $("cardDashMonth"),
    kpiTotal: $("cardKpiTotal"),
    kpiTotalCaption: $("cardKpiTotalCaption"),
    kpiChange: $("cardKpiChange"),
    kpiChangeCaption: $("cardKpiChangeCaption"),
    kpiAverage: $("cardKpiAverage"),
    kpiAverageCaption: $("cardKpiAverageCaption"),
    kpiForeign: $("cardKpiForeign"),
    kpiForeignCaption: $("cardKpiForeignCaption"),
    heatmap: $("cardHeatmap"),
    heatmapYear: $("cardHeatmapYear"),
    recurringBody: $("cardRecurringRows"),
    recurringEmpty: $("cardRecurringEmpty"),
    search: $("cardTxSearch"),
    categoryFilter: $("cardTxCategory"),
    txHead: $("cardTxHead"),
    txBody: $("cardTxRows"),
    txSummary: $("cardTxSummary"),
    txMore: $("cardTxMore"),
    rulePrompt: $("cardRulePrompt"),
    ruleText: $("cardRuleText"),
    rulePattern: $("cardRulePattern"),
    ruleCreate: $("cardRuleCreate"),
    ruleDismiss: $("cardRuleDismiss")
  };

  const nok = new Intl.NumberFormat("nb-NO", { style: "currency", currency: "NOK", maximumFractionDigits: 0 });
  const nokExact = new Intl.NumberFormat("nb-NO", { style: "currency", currency: "NOK" });
  const percent = new Intl.NumberFormat("nb-NO", { style: "percent", maximumFractionDigits: 0, signDisplay: "exceptZero" });

  const state = {
    transactions: [],
    cards: [],
    categories: [],
    budgets: [],
    charts: {},
    table: { search: "", category: "", sortKey: "transaction_date", sortDir: -1, limit: PAGE_SIZE }
  };

  function setStatus(message, type = "") {
    els.status.textContent = message;
    els.status.className = `card-upload-status ${type}`.trim();
  }

  // PostgREST returns at most 1000 rows per request.
  async function fetchAll(buildQuery) {
    const rows = [];
    const size = 1000;

    for (let from = 0; ; from += size) {
      const { data, error } = await buildQuery().range(from, from + size - 1);
      if (error) throw error;
      rows.push(...data);
      if (data.length < size) return rows;
    }
  }

  async function loadData() {
    const [transactions, cardsResult, categoriesResult] = await Promise.all([
      fetchAll(() =>
        supabaseClient
          .from("credit_card_transactions_enriched")
          .select("*")
          .order("transaction_date", { ascending: false })
          .order("id", { ascending: false })
      ),
      supabaseClient.from("credit_cards").select("id, name, budget_category_id").order("sort_order"),
      supabaseClient.from("transaction_categories").select("id, name, color").order("sort_order")
    ]);

    if (cardsResult.error) throw cardsResult.error;
    if (categoriesResult.error) throw categoriesResult.error;

    const budgetCategoryIds = cardsResult.data.map(card => card.budget_category_id).filter(Boolean);
    let budgets = [];

    if (budgetCategoryIds.length) {
      const { data, error } = await supabaseClient
        .from("budget_entries")
        .select("category_id, year, month, budget_amount")
        .in("category_id", budgetCategoryIds);
      if (error) throw error;
      budgets = data;
    }

    state.transactions = transactions.map(tx => ({ ...tx, amount: Number(tx.amount) }));
    state.cards = cardsResult.data;
    state.categories = categoriesResult.data;
    state.budgets = budgets;
  }

  function cardColor(cardId) {
    const index = state.cards.findIndex(card => card.id === cardId);
    return CARD_COLORS[(index < 0 ? 0 : index) % CARD_COLORS.length];
  }

  function fillSelect(select, options, selected) {
    select.innerHTML = "";
    options.forEach(([value, label]) => select.append(new Option(label, value)));
    select.value = String(selected);
  }

  function setupFilters() {
    const previous = {
      card: els.cardFilter.value,
      year: Number(els.yearFilter.value),
      month: els.monthFilter.value
    };

    const years = [
      ...new Set(
        state.transactions.flatMap(tx => [Number(tx.transaction_date.slice(0, 4)), tx.billing_year])
      )
    ].sort((a, b) => b - a);

    const latestYear = Number(state.transactions[0]?.transaction_date.slice(0, 4)) || years[0];

    fillSelect(
      els.cardFilter,
      [["", "All cards"], ...state.cards.map(card => [card.id, card.name])],
      previous.card || ""
    );
    fillSelect(
      els.yearFilter,
      years.map(year => [year, year]),
      years.includes(previous.year) ? previous.year : latestYear
    );
    fillSelect(
      els.monthFilter,
      [["0", "All months"], ...MONTHS.map((name, i) => [i + 1, name])],
      previous.month || "0"
    );
    fillSelect(
      els.categoryFilter,
      [["", "All categories"], ...state.categories.map(cat => [cat.name, cat.name])],
      state.table.category
    );
  }

  function filters() {
    return {
      cardId: Number(els.cardFilter.value) || null,
      year: Number(els.yearFilter.value),
      month: Number(els.monthFilter.value) || null
    };
  }

  function cardTransactions() {
    const { cardId } = filters();
    return cardId ? state.transactions.filter(tx => tx.card_id === cardId) : state.transactions;
  }

  function periodLabel({ year, month }) {
    return month ? `${MONTHS[month - 1]} ${year}` : String(year);
  }

  // ---------------------------------------------------------------- KPIs

  function renderKpis(transactions, period) {
    const data = CardAnalytics.kpis(transactions, period);
    const previous = CardAnalytics.previousPeriod(period);

    els.kpiTotal.textContent = nok.format(data.total);
    els.kpiTotalCaption.textContent = `${periodLabel(period)} · ${data.count} transactions`;

    els.kpiChange.textContent = data.change === null ? "—" : percent.format(data.change);
    els.kpiChange.classList.toggle("negative", data.change > 0);
    els.kpiChange.classList.toggle("positive", data.change < 0);
    els.kpiChangeCaption.textContent = `vs ${periodLabel(previous)} (${nok.format(data.previousTotal)})`;

    els.kpiAverage.textContent = nok.format(data.averagePurchase);
    els.kpiAverageCaption.textContent = "Per purchase";

    els.kpiForeign.textContent = nok.format(data.foreignTotal);
    els.kpiForeignCaption.textContent = `${data.foreignCount} foreign currency transactions`;
  }

  // ---------------------------------------------------------------- Charts

  function replaceChart(key, canvasId, config) {
    state.charts[key]?.destroy();
    state.charts[key] = new Chart($(canvasId), config);
  }

  function renderMonthly(transactions, { year, cardId }) {
    const series = CardAnalytics.monthlyByCard(transactions, year);

    const budgetCategories = new Set(
      state.cards
        .filter(card => card.budget_category_id && (!cardId || card.id === cardId))
        .map(card => card.budget_category_id)
    );
    const budget = Array(12).fill(null);
    state.budgets
      .filter(row => row.year === year && budgetCategories.has(row.category_id))
      .forEach(row => {
        budget[row.month - 1] = (budget[row.month - 1] ?? 0) + Number(row.budget_amount || 0);
      });

    replaceChart("monthly", "cardMonthlyChart", {
      data: {
        labels: MONTHS,
        datasets: [
          ...series.map(card => ({
            type: "bar",
            label: card.cardName,
            data: card.months,
            backgroundColor: cardColor(card.cardId),
            borderRadius: 6,
            stack: "spend",
            order: 2
          })),
          {
            type: "line",
            label: "Budget",
            data: budget,
            borderColor: "#171717",
            backgroundColor: "#171717",
            borderDash: [6, 4],
            pointRadius: 3,
            tension: 0,
            spanGaps: false,
            order: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          tooltip: {
            callbacks: {
              label: context => `${context.dataset.label}: ${nokExact.format(context.parsed.y)}`
            }
          },
          legend: { position: "bottom" }
        },
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { stacked: true, ticks: { callback: value => nok.format(value) } }
        }
      }
    });
  }

  function renderCategories(periodTransactions) {
    const totals = CardAnalytics.categoryTotals(periodTransactions);

    replaceChart("categories", "cardCategoryChart", {
      type: "doughnut",
      data: {
        labels: totals.map(group => group.key),
        datasets: [{
          data: totals.map(group => group.total),
          backgroundColor: totals.map(group => group.color),
          borderWidth: 2,
          borderColor: "#ffffff"
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "62%",
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 12 } },
          tooltip: {
            callbacks: {
              label: context => {
                const total = context.dataset.data.reduce((a, b) => a + b, 0);
                const share = total ? context.parsed / total : 0;
                return `${context.label}: ${nokExact.format(context.parsed)} (${percent.format(share).replace("+", "")})`;
              }
            }
          }
        },
        onClick: (_, elements) => {
          if (!elements.length) return;
          state.table.category = totals[elements[0].index].key;
          els.categoryFilter.value = state.table.category;
          state.table.limit = PAGE_SIZE;
          renderTable();
          $("cardTxCard").scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
    });
  }

  function renderMerchants(periodTransactions) {
    const merchants = CardAnalytics.topMerchants(periodTransactions, 10);

    replaceChart("merchants", "cardMerchantChart", {
      type: "bar",
      data: {
        labels: merchants.map(group => group.key),
        datasets: [{
          label: "Spend",
          data: merchants.map(group => group.total),
          backgroundColor: "#2563eb",
          borderRadius: 6
        }]
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: context => {
                const group = merchants[context.dataIndex];
                return `${nokExact.format(group.total)} · ${group.count} transaction${group.count === 1 ? "" : "s"}`;
              }
            }
          }
        },
        scales: {
          x: { ticks: { callback: value => nok.format(value) } },
          y: { grid: { display: false } }
        }
      }
    });
  }

  // ---------------------------------------------------------------- Heatmap

  function isoDate(date) {
    return date.toISOString().slice(0, 10);
  }

  function renderHeatmap(transactions, year) {
    const days = CardAnalytics.dailyTotals(transactions, year);
    const amounts = [...days.values()].map(day => day.amount).filter(amount => amount > 0).sort((a, b) => a - b);
    const quantile = q => amounts[Math.min(amounts.length - 1, Math.floor(q * amounts.length))] ?? 0;
    const thresholds = [quantile(0.25), quantile(0.5), quantile(0.75)];

    const level = amount => {
      if (amount <= 0) return 0;
      if (amount <= thresholds[0]) return 1;
      if (amount <= thresholds[1]) return 2;
      if (amount <= thresholds[2]) return 3;
      return 4;
    };

    els.heatmapYear.textContent = year;
    els.heatmap.innerHTML = "";

    const start = new Date(Date.UTC(year, 0, 1));
    const offset = (start.getUTCDay() + 6) % 7; // Monday-first weeks
    start.setUTCDate(start.getUTCDate() - offset);
    const end = new Date(Date.UTC(year, 11, 31));

    const monthsRow = document.createElement("div");
    monthsRow.className = "heatmap-months";
    const grid = document.createElement("div");
    grid.className = "heatmap-grid";

    let week = 0;
    for (const date = new Date(start); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
      const iso = isoDate(date);
      const inYear = date.getUTCFullYear() === year;
      const day = days.get(iso);
      const cell = document.createElement("span");

      cell.className = "heatmap-cell";
      if (!inYear) {
        cell.classList.add("outside");
      } else {
        cell.dataset.level = level(day?.amount ?? 0);
        cell.title = day
          ? `${iso}: ${nokExact.format(day.amount)} (${day.count} transaction${day.count === 1 ? "" : "s"})`
          : `${iso}: no spending`;

        if (date.getUTCDate() === 1) {
          const label = document.createElement("span");
          label.textContent = MONTHS[date.getUTCMonth()];
          label.style.gridColumn = String(week + 1);
          monthsRow.append(label);
        }
      }

      grid.append(cell);
      if ((date.getUTCDay() + 6) % 7 === 6) week += 1;
    }

    const weeks = week + 1;
    monthsRow.style.gridTemplateColumns = `repeat(${weeks}, var(--heatmap-cell))`;
    grid.style.gridTemplateColumns = `repeat(${weeks}, var(--heatmap-cell))`;

    els.heatmap.append(monthsRow, grid);
  }

  // ---------------------------------------------------------------- Recurring

  function categoryChip(name, color) {
    const chip = document.createElement("span");
    chip.className = "category-chip";
    chip.style.setProperty("--chip-color", color || "#9ca3af");
    chip.textContent = name;
    return chip;
  }

  function cell(content, className) {
    const td = document.createElement("td");
    if (className) td.className = className;
    if (content instanceof Node) td.append(content);
    else td.textContent = content;
    return td;
  }

  function renderRecurring(transactions) {
    const recurring = CardAnalytics.detectRecurring(transactions);
    els.recurringBody.innerHTML = "";
    els.recurringEmpty.hidden = recurring.length > 0;

    recurring.forEach(item => {
      const row = document.createElement("tr");
      row.append(
        cell(item.merchant),
        cell(item.cardName),
        cell(categoryChip(item.categoryName, item.categoryColor)),
        cell(nokExact.format(item.typicalAmount), "num"),
        cell(String(item.months), "num"),
        cell(item.lastDate),
        cell(nok.format(item.yearlyCost), "num")
      );
      els.recurringBody.append(row);
    });
  }

  // ---------------------------------------------------------------- Table

  function tableRows() {
    const period = filters();
    const search = state.table.search.toLowerCase();
    const { sortKey, sortDir } = state.table;

    return cardTransactions()
      .filter(tx => CardAnalytics.inPeriod(tx, period))
      .filter(tx => !state.table.category || tx.category_name === state.table.category)
      .filter(tx => !search || tx.description.toLowerCase().includes(search))
      .sort((a, b) => {
        const x = a[sortKey];
        const y = b[sortKey];
        const result = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
        return result * sortDir || (b.id - a.id);
      });
  }

  function categorySelect(tx) {
    const select = document.createElement("select");
    select.className = "category-select";
    select.setAttribute("aria-label", `Category for ${tx.description}`);
    select.style.setProperty("--chip-color", tx.category_color);

    state.categories.forEach(cat => select.append(new Option(cat.name, cat.id)));
    if (tx.category_override_id) select.append(new Option("↺ Automatic (rules)", "auto"));
    select.value = String(tx.category_id);

    select.addEventListener("change", () => changeCategory(tx, select.value));
    return select;
  }

  function renderTable() {
    const rows = tableRows();
    const visible = rows.slice(0, state.table.limit);

    els.txBody.innerHTML = "";
    visible.forEach(tx => {
      const row = document.createElement("tr");
      if (tx.excluded_from_spending) row.classList.add("excluded");

      const description = document.createElement("span");
      description.textContent = CardAnalytics.merchantName(tx.description);
      description.title = tx.description;
      const raw = document.createElement("small");
      raw.textContent = tx.description;
      const descriptionCell = document.createElement("div");
      descriptionCell.className = "tx-description";
      descriptionCell.append(description, raw);

      const amountText = tx.foreign_currency && tx.foreign_amount !== null
        ? `${nokExact.format(tx.amount)} (${tx.foreign_currency} ${tx.foreign_amount})`
        : nokExact.format(tx.amount);

      row.append(
        cell(tx.transaction_date),
        cell(tx.card_name),
        cell(descriptionCell),
        cell(categorySelect(tx)),
        cell(amountText, `num ${tx.amount < 0 ? "credit" : ""}`.trim())
      );
      els.txBody.append(row);
    });

    const total = rows.filter(CardAnalytics.isSpending).reduce((sum, tx) => sum + tx.amount, 0);
    els.txSummary.textContent =
      `${rows.length} transaction${rows.length === 1 ? "" : "s"} · Spending ${nokExact.format(total)}`;
    els.txMore.hidden = rows.length <= visible.length;
    els.txMore.textContent = `Show more (${rows.length - visible.length} remaining)`;

    els.txHead.querySelectorAll("[data-sort]").forEach(th => {
      const active = th.dataset.sort === state.table.sortKey;
      th.setAttribute("aria-sort", active ? (state.table.sortDir > 0 ? "ascending" : "descending") : "none");
    });
  }

  function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Payments are excluded from budget actuals, so categories affect them.
  async function refreshActualsAndReload() {
    const { error } = await supabaseClient.rpc("refresh_card_actuals");
    if (error) console.error("Unable to refresh budget actuals:", error);
    await reload();
  }

  function hideRulePrompt() {
    els.rulePrompt.hidden = true;
    state.pendingRule = null;
  }

  function showRulePrompt(tx, category) {
    state.pendingRule = { categoryId: category.id, categoryName: category.name };
    els.ruleText.textContent =
      `Also use "${category.name}" for all transactions whose description contains:`;
    els.rulePattern.value = CardAnalytics.merchantName(tx.description).split(" ")[0];
    els.rulePrompt.hidden = false;
  }

  async function changeCategory(tx, value) {
    const categoryId = value === "auto" ? null : Number(value);
    const category = state.categories.find(cat => cat.id === categoryId);

    hideRulePrompt();
    setStatus("Saving category…");

    const { error } = await supabaseClient
      .from("credit_card_transactions")
      .update({ category_id: categoryId })
      .eq("id", tx.id);

    if (error) {
      console.error("Unable to update category:", error);
      setStatus(error.message || "Unable to update category.", "error");
      renderTable();
      return;
    }

    await refreshActualsAndReload();
    setStatus("Category saved.", "success");
    if (category) showRulePrompt(tx, category);
  }

  async function createRule() {
    const text = els.rulePattern.value.trim();
    const rule = state.pendingRule;
    if (!text || !rule) return;

    els.ruleCreate.disabled = true;
    const { error } = await supabaseClient.from("merchant_rules").insert({
      pattern: `\\m${escapeRegex(text)}`,
      category_id: rule.categoryId,
      priority: 0
    });
    els.ruleCreate.disabled = false;

    if (error) {
      console.error("Unable to create rule:", error);
      setStatus(error.message || "Unable to create rule.", "error");
      return;
    }

    hideRulePrompt();
    await refreshActualsAndReload();
    setStatus(`Rule created: "${text}" → ${rule.categoryName}.`, "success");
  }

  // ---------------------------------------------------------------- Main

  function render() {
    const period = filters();
    const transactions = cardTransactions();
    const periodTransactions = transactions.filter(tx => CardAnalytics.inPeriod(tx, period));

    renderKpis(transactions, period);
    renderMonthly(transactions, period);
    renderCategories(periodTransactions);
    renderMerchants(periodTransactions);
    renderHeatmap(transactions, period.year);
    renderRecurring(transactions);
    renderTable();
  }

  async function reload() {
    try {
      await loadData();
    } catch (error) {
      console.error("Unable to load card transactions:", error);
      setStatus("Unable to load card transactions.", "error");
      return;
    }

    if (!state.transactions.length) {
      els.content.hidden = true;
      setStatus("No card transactions yet. Upload a statement above to get started.");
      return;
    }

    els.content.hidden = false;
    setStatus("");
    setupFilters();
    render();
  }

  [els.cardFilter, els.yearFilter, els.monthFilter].forEach(select =>
    select.addEventListener("change", () => {
      state.table.limit = PAGE_SIZE;
      render();
    })
  );

  els.search.addEventListener("input", () => {
    state.table.search = els.search.value.trim();
    state.table.limit = PAGE_SIZE;
    renderTable();
  });

  els.categoryFilter.addEventListener("change", () => {
    state.table.category = els.categoryFilter.value;
    state.table.limit = PAGE_SIZE;
    renderTable();
  });

  els.txHead.addEventListener("click", event => {
    const th = event.target.closest("[data-sort]");
    if (!th) return;
    const key = th.dataset.sort;
    state.table.sortDir = state.table.sortKey === key ? -state.table.sortDir : (key === "transaction_date" || key === "amount" ? -1 : 1);
    state.table.sortKey = key;
    renderTable();
  });

  els.txMore.addEventListener("click", () => {
    state.table.limit += PAGE_SIZE;
    renderTable();
  });

  els.ruleCreate.addEventListener("click", createRule);
  els.ruleDismiss.addEventListener("click", hideRulePrompt);
  els.rulePattern.addEventListener("keydown", event => {
    if (event.key === "Enter") createRule();
  });

  document.addEventListener("card-transactions-changed", reload);

  reload();
})();

// supadata.js
//
// Loads ProjectK budget data from Supabase and converts it
// into the same window.BUDGET_DATA format that budget-chart.js
// already understands.

(async () => {
  const MONTH_NAMES = [
    "",
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"
  ];

  try {
    console.log("Loading budget data from Supabase...");

    // --------------------------------------------------
    // 1. Load budget entries with category relationships
    // --------------------------------------------------

    const { data: entries, error: entriesError } =
      await supabaseClient
        .from("budget_entries")
        .select(`
          year,
          month,
          budget_amount,
          actual_amount,
          budget_categories (
            id,
            name,
            sort_order,
            budget_parent_categories (
              id,
              name,
              sort_order
            )
          )
        `)
        .order("year", { ascending: true })
        .order("month", { ascending: true });

    if (entriesError) {
      throw entriesError;
    }

    // --------------------------------------------------
    // 2. Load monthly income
    // --------------------------------------------------

    const { data: incomes, error: incomeError } =
      await supabaseClient
        .from("budget_income")
        .select(`
          year,
          month,
          amount
        `)
        .order("year", { ascending: true })
        .order("month", { ascending: true });

    if (incomeError) {
      throw incomeError;
    }

    // --------------------------------------------------
    // 3. Build income lookup
    //
    // Example:
    // {
    //   "2026-1": 790501.17
    // }
    // --------------------------------------------------

    const incomeMap = new Map();

    (incomes || []).forEach(row => {
      incomeMap.set(
        `${row.year}-${row.month}`,
        Number(row.amount || 0)
      );
    });

    // --------------------------------------------------
    // 4. Convert database data to BUDGET_DATA
    // --------------------------------------------------

    const budgetData = {};

    (entries || []).forEach(row => {
      const year = String(row.year);
      const month = MONTH_NAMES[Number(row.month)];

      if (!month) {
        console.warn("Invalid month:", row.month);
        return;
      }

      const category = row.budget_categories;
      const parent = category?.budget_parent_categories;

      if (!category) {
        console.warn("Missing category for budget row:", row);
        return;
      }

      if (!budgetData[year]) {
        budgetData[year] = {};
      }

      if (!budgetData[year][month]) {
        budgetData[year][month] = {
          income:
            incomeMap.get(`${row.year}-${row.month}`) || 0,

          categories: []
        };
      }

      budgetData[year][month].categories.push({
        parent: parent?.name || "OTHER",
        name: category.name,

        // For now the chart displays budget_amount.
        amount: Number(row.budget_amount || 0),

        // Keep actual available for future functionality.
        actualAmount:
          row.actual_amount === null
            ? null
            : Number(row.actual_amount)
      });
    });

    // --------------------------------------------------
    // 5. Also create months that have income but no entries
    // --------------------------------------------------

    (incomes || []).forEach(row => {
      const year = String(row.year);
      const month = MONTH_NAMES[Number(row.month)];

      if (!month) return;

      if (!budgetData[year]) {
        budgetData[year] = {};
      }

      if (!budgetData[year][month]) {
        budgetData[year][month] = {
          income: Number(row.amount || 0),
          categories: []
        };
      }
    });

    // --------------------------------------------------
    // 6. Sort categories according to DB sort_order
    // --------------------------------------------------

    Object.values(budgetData).forEach(yearData => {
      Object.values(yearData).forEach(monthData => {
        monthData.categories.sort((a, b) => {
          const entryA = entries.find(
            row =>
              row.budget_categories?.name === a.name &&
              row.budget_categories
                ?.budget_parent_categories?.name === a.parent
          );

          const entryB = entries.find(
            row =>
              row.budget_categories?.name === b.name &&
              row.budget_categories
                ?.budget_parent_categories?.name === b.parent
          );

          const parentSortA =
            entryA?.budget_categories
              ?.budget_parent_categories?.sort_order ?? 999;

          const parentSortB =
            entryB?.budget_categories
              ?.budget_parent_categories?.sort_order ?? 999;

          if (parentSortA !== parentSortB) {
            return parentSortA - parentSortB;
          }

          const categorySortA =
            entryA?.budget_categories?.sort_order ?? 999;

          const categorySortB =
            entryB?.budget_categories?.sort_order ?? 999;

          return categorySortA - categorySortB;
        });
      });
    });

    // --------------------------------------------------
    // 7. Expose data for existing budget-chart.js
    // --------------------------------------------------

    window.BUDGET_DATA = budgetData;

    console.log(
      "Supabase budget data loaded:",
      window.BUDGET_DATA
    );

    // --------------------------------------------------
    // 8. Load chart only AFTER Supabase finishes
    // --------------------------------------------------

    const script = document.createElement("script");
    script.src = "budget-chart.js";
    script.defer = true;

    document.body.appendChild(script);

  } catch (error) {
    console.error(
      "Unable to load budget data from Supabase:",
      error
    );

    const periodLabel =
      document.getElementById("chartPeriodLabel");

    if (periodLabel) {
      periodLabel.textContent =
        "Unable to load budget data";
    }
  }
})();

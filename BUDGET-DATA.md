# Budget chart data and filters

The chart is displayed below the filters.

## Filters

- **Month**: select a month and year.
- **Year**: aggregates every available month in the selected year.

## Chart structure

- Inner ring = parent categories such as FIXED, SAVINGS, ESSENTIALS, DISCRETIONARY.
- Outer ring = individual categories such as Rente, Principal, Felleskost, Morrow, Trumf, etc.

## Current data location

The data is in:

```text
budget-data.js
```

Structure:

```javascript
window.BUDGET_DATA = {
  "2026": {
    "Jan": {
      income: 790501.17,
      categories: [
        { parent: "FIXED", name: "Rente", amount: 165353.97 }
      ]
    }
  }
};
```

When you select **Year**, `budget-chart.js` adds all available months for that year automatically.

Later this same shape can be loaded from Supabase instead of `budget-data.js`.


## Enhanced layout

The current layout now shows:
- Total budget centered above the chart
- Category legend to the left on desktop
- Sub-category legend to the right on desktop
- Category + sub-category amount and percentage
- Month / Year filters at the top
- Mobile layout stacks the chart and legends vertically

The chart still reads from `budget-data.js`.

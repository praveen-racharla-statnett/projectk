// Budget data source.
// Parent categories become the INNER ring.
// Individual categories become the OUTER ring.
// Add more years/months here later, or replace this file with Supabase data.

window.BUDGET_DATA = {
  "2026": {
    "Jan": {
      income: 790501.17,
      categories: [
        { parent: "FIXED", name: "Rente", amount: 165353.97 },
        { parent: "FIXED", name: "Principal", amount: 86065.49 },
        { parent: "FIXED", name: "Felleskost", amount: 45540 },
        { parent: "FIXED", name: "Strøm", amount: 9332.69 },
        { parent: "FIXED", name: "Garasje", amount: 6000 },
        { parent: "FIXED", name: "Bil forsikring", amount: 15260.88 },
        { parent: "FIXED", name: "Autopass", amount: 5079.56 },

        { parent: "SAVINGS", name: "Annualsave", amount: 99996 },
        { parent: "SAVINGS", name: "Sanvith II", amount: 24100 },
        { parent: "SAVINGS", name: "Sanvith", amount: 24100 },

        { parent: "ESSENTIALS", name: "Morrow", amount: 69119.85 },
        { parent: "ESSENTIALS", name: "Trumf", amount: 24337.46 },

        { parent: "DISCRETIONARY", name: "Misc", amount: 64035.83 },
        { parent: "DISCRETIONARY", name: "Planned", amount: 45581.20 },
        { parent: "DISCRETIONARY", name: "Debt", amount: 24700 }
      ]
    },

    "Feb": {
      income: 810000,
      categories: [
        { parent: "FIXED", name: "Rente", amount: 164900 },
        { parent: "FIXED", name: "Principal", amount: 86200 },
        { parent: "FIXED", name: "Felleskost", amount: 45540 },
        { parent: "FIXED", name: "Strøm", amount: 8200 },
        { parent: "FIXED", name: "Garasje", amount: 6000 },
        { parent: "FIXED", name: "Bil forsikring", amount: 15260 },

        { parent: "SAVINGS", name: "Annualsave", amount: 100000 },
        { parent: "SAVINGS", name: "Sanvith", amount: 25000 },

        { parent: "ESSENTIALS", name: "Morrow", amount: 62000 },
        { parent: "ESSENTIALS", name: "Trumf", amount: 21000 },

        { parent: "DISCRETIONARY", name: "Misc", amount: 52000 },
        { parent: "DISCRETIONARY", name: "Planned", amount: 42000 }
      ]
    },

    "Mar": {
      income: 805000,
      categories: [
        { parent: "FIXED", name: "Rente", amount: 164200 },
        { parent: "FIXED", name: "Principal", amount: 87000 },
        { parent: "FIXED", name: "Felleskost", amount: 45540 },
        { parent: "FIXED", name: "Strøm", amount: 7800 },
        { parent: "FIXED", name: "Garasje", amount: 6000 },
        { parent: "FIXED", name: "Bil forsikring", amount: 15260 },

        { parent: "SAVINGS", name: "Annualsave", amount: 100000 },
        { parent: "SAVINGS", name: "Sanvith", amount: 25000 },

        { parent: "ESSENTIALS", name: "Morrow", amount: 65000 },
        { parent: "ESSENTIALS", name: "Trumf", amount: 22000 },

        { parent: "DISCRETIONARY", name: "Misc", amount: 55000 },
        { parent: "DISCRETIONARY", name: "Planned", amount: 40000 }
      ]
    }
  },

  "2025": {
    "Dec": {
      income: 780000,
      categories: [
        { parent: "FIXED", name: "Rente", amount: 168000 },
        { parent: "FIXED", name: "Principal", amount: 83000 },
        { parent: "FIXED", name: "Felleskost", amount: 44000 },
        { parent: "SAVINGS", name: "Annualsave", amount: 95000 },
        { parent: "ESSENTIALS", name: "Morrow", amount: 60000 },
        { parent: "DISCRETIONARY", name: "Misc", amount: 50000 }
      ]
    }
  }
};

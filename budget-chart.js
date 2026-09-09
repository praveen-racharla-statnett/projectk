(() => {
  const canvas = document.getElementById("budgetDonut");
  if (!canvas || !window.BUDGET_DATA || typeof Chart === "undefined") return;

  const monthFilter = document.getElementById("monthFilter");
  const yearFilter = document.getElementById("yearFilter");
  const viewButtons = [...document.querySelectorAll(".filter-toggle-btn")];
  const periodLabel = document.getElementById("chartPeriodLabel");

  const kr = new Intl.NumberFormat("nb-NO", {
    style: "currency",
    currency: "NOK",
    maximumFractionDigits: 0
  });

  const parentColors = {
    FIXED: "#5d8de6",
    SAVINGS: "#79bf67",
    ESSENTIALS: "#f5c35a",
    DISCRETIONARY: "#f28b55",
    OTHER: "#9a9a9a"
  };

  const outerPalette = {
    FIXED: ["#5d8de6","#6e9bea","#7ba5ed","#88afef","#95b8f1","#a2c1f3","#afcaf5","#bcd3f7","#c9dcf9","#d6e5fb"],
    SAVINGS: ["#79bf67","#88c777","#97cf87","#a6d797","#b5dfa7","#c4e7b7"],
    ESSENTIALS: ["#f5c35a","#f7cb72","#f8d38a","#f9dba2","#fbe3ba"],
    DISCRETIONARY: ["#f28b55","#f49a69","#f6a97d","#f8b891","#fac7a5","#fbd6b9"],
    OTHER: ["#999999","#aaaaaa","#bbbbbb","#cccccc"]
  };

  let chart;
  let currentView = "month";

  const years = Object.keys(window.BUDGET_DATA)
    .sort((a, b) => Number(b) - Number(a));

  years.forEach(year => yearFilter.add(new Option(year, year)));

  function populateMonths() {
    monthFilter.innerHTML = "";

    const months = Object.keys(
      window.BUDGET_DATA[yearFilter.value] || {}
    );

    months.forEach(month =>
      monthFilter.add(new Option(month, month))
    );

    const currentMonth = new Date().toLocaleString("en-US", {
      month: "long"
    });

    if (months.includes(currentMonth)) {
      monthFilter.value = currentMonth;
    } else if (months.length) {
      monthFilter.value = months[0];
    }
  }  

  const currentYear = String(new Date().getFullYear());

  yearFilter.value = years.includes(currentYear)
    ? currentYear
    : years[0];

  populateMonths();

  function aggregateForYear(year) {
    const months = Object.values(window.BUDGET_DATA[year] || {});
    const categoryMap = new Map();
    let income = 0;

    months.forEach(month => {
      income += Number(month.income || 0);

      (month.categories || []).forEach(item => {
        const key = `${item.parent}__${item.name}`;
        const existing = categoryMap.get(key) || {
          parent: item.parent,
          name: item.name,
          amount: 0
        };
        existing.amount += Number(item.amount || 0);
        categoryMap.set(key, existing);
      });
    });

    return {
      income,
      categories: [...categoryMap.values()]
    };
  }

  function selectedData() {
    const year = yearFilter.value;
    if (currentView === "year") return aggregateForYear(year);

    return window.BUDGET_DATA[year]?.[monthFilter.value] || {
      income: 0,
      categories: []
    };
  }

  function buildParentData(categories) {
    const totals = new Map();

    categories.forEach(item => {
      totals.set(
        item.parent,
        (totals.get(item.parent) || 0) + Number(item.amount || 0)
      );
    });

    return [...totals.entries()].map(([name, amount]) => ({ name, amount }));
  }

  function pct(amount, total) {
    return total ? (Number(amount) / total) * 100 : 0;
  }

  const centerTotalPlugin = {
  id: "centerTotal",

  afterDatasetsDraw(chart) {
    const { ctx } = chart;

    const total = chart.$budgetTotal || 0;
    const formatter = chart.$currencyFormatter;

    // Inner category dataset
    const meta = chart.getDatasetMeta(0);

    if (!meta?.data?.length) {
      return;
    }

    // Get exact center of donut
    const firstArc = meta.data[0];

    const centerX = firstArc.x;
    const centerY = firstArc.y;

    const compact = chart.width < 700;

    const titleSize = compact ? 10 : 13;
    const amountSize = compact ? 22 : 34;

    ctx.save();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // TOTAL BUDGET
    ctx.fillStyle = "#667085";

    ctx.font =
      `700 ${titleSize}px "Inter", Arial, sans-serif`;

    ctx.fillText(
      "TOTAL BUDGET",
      centerX,
      centerY - 22
    );

    // 790 501 kr
    ctx.fillStyle = "#111111";

    ctx.font =
      `700 ${amountSize}px "Inter", Arial, sans-serif`;

    ctx.fillText(
      formatter(total),
      centerX,
      centerY + 10
    );

    ctx.restore();
  }
};

  const innerRingLabelsPlugin = {
    id: "innerRingLabels",

    afterDatasetsDraw(chart) {
      const parentsForLabels = chart.$parentCategoryData || [];
      const formatter = chart.$currencyFormatter;
      const meta = chart.getDatasetMeta(0);
      const values = chart.data.datasets[0]?.data || [];
      const total = values.reduce((sum, value) => sum + Number(value || 0), 0);

      if (!parentsForLabels.length || !meta?.data?.length) return;

      const { ctx } = chart;
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      meta.data.forEach((arc, index) => {
        const value = Number(values[index] || 0);
        const percentage = total ? (value / total) * 100 : 0;

        if (percentage < 7) return;

        const props = arc.getProps(
          ["x","y","startAngle","endAngle","innerRadius","outerRadius"],
          true
        );

        const angle = (props.startAngle + props.endAngle) / 2;
        const radius =
          props.innerRadius +
          (props.outerRadius - props.innerRadius) * 0.52;

        const x = props.x + Math.cos(angle) * radius;
        const y = props.y + Math.sin(angle) * radius;
        const item = parentsForLabels[index];

        if (!item) return;

        const compact = chart.width < 700;
        const titleSize = compact ? 11 : 14;
        const amountSize = compact ? 10 : 12;
        const percentageSize = compact ? 10 : 11;

        ctx.fillStyle = "#151515";

        ctx.font = `700 ${titleSize}px "Inter", Arial, sans-serif`;
        ctx.fillText(item.name, x, y - 18);

        ctx.font = `600 ${amountSize}px "Inter", Arial, sans-serif`;
        ctx.fillText(formatter(item.amount), x, y);

        ctx.font = `500 ${percentageSize}px "Inter", Arial, sans-serif`;
        ctx.fillText(`${percentage.toFixed(0)}%`, x, y + 17);
      });

      ctx.restore();
    }
  };


  const outerRingCalloutsPlugin = {
    id: "outerRingCallouts",

    afterDatasetsDraw(chart) {
      const categories = chart.$subCategoryData || [];
      const formatter = chart.$currencyFormatter;
      const expenseTotal = chart.$expenseTotal || 0;

      if (!categories.length) return;

      const meta = chart.getDatasetMeta(1);
      if (!meta?.data?.length) return;

      const { ctx, chartArea } = chart;
      const centerX = (chartArea.left + chartArea.right) / 2;

      const parentColorMap = chart.$parentColors || {};
      const fontFamily = '"Inter", Arial, sans-serif';

      const leftLabels = [];
      const rightLabels = [];

      meta.data.forEach((arc, index) => {
        const item = categories[index];
        if (!item) return;

        const props = arc.getProps(
          ["x", "y", "startAngle", "endAngle", "outerRadius"],
          true
        );

        const angle = (props.startAngle + props.endAngle) / 2;
        const edgeX = props.x + Math.cos(angle) * props.outerRadius;
        const edgeY = props.y + Math.sin(angle) * props.outerRadius;

        const side = edgeX >= centerX ? "right" : "left";

        const label = {
          index,
          item,
          angle,
          edgeX,
          edgeY,
          side,
          y: edgeY
        };

        (side === "right" ? rightLabels : leftLabels).push(label);
      });

      function resolveOverlaps(labels, minGap, minY, maxY) {
        labels.sort((a, b) => a.y - b.y);

        for (let i = 1; i < labels.length; i++) {
          if (labels[i].y - labels[i - 1].y < minGap) {
            labels[i].y = labels[i - 1].y + minGap;
          }
        }

        if (labels.length && labels[labels.length - 1].y > maxY) {
          const overflow = labels[labels.length - 1].y - maxY;
          for (const label of labels) label.y -= overflow;
        }

        if (labels.length && labels[0].y < minY) {
          const underflow = minY - labels[0].y;
          for (const label of labels) label.y += underflow;
        }
      }

      const minY = chartArea.top + 18;
      const maxY = chartArea.bottom - 18;
      const minGap = chart.width < 800 ? 27 : 32;

      resolveOverlaps(leftLabels, minGap, minY, maxY);
      resolveOverlaps(rightLabels, minGap, minY, maxY);

      ctx.save();
      ctx.lineWidth = 1.4;
      ctx.textBaseline = "middle";

      const isCompact = chart.width < 800;
      const nameSize = isCompact ? 10 : 12;
      const detailSize = isCompact ? 9 : 11;
      const elbow = isCompact ? 22 : 34;
      const textGap = isCompact ? 8 : 10;

      [...leftLabels, ...rightLabels].forEach(label => {
        const { item, side, edgeX, edgeY, y } = label;
        const color = parentColorMap[item.parent] || "#666666";
        const dir = side === "right" ? 1 : -1;

        const lineStartX = edgeX;
        const lineStartY = edgeY;

        const elbowX = lineStartX + dir * elbow;
        const textX = elbowX + dir * (isCompact ? 70 : 105);
        const lineEndX = textX - dir * textGap;

        ctx.strokeStyle = color;
        ctx.fillStyle = color;

        // leader line
        ctx.beginPath();
        ctx.moveTo(lineStartX, lineStartY);
        ctx.lineTo(elbowX, y);
        ctx.lineTo(lineEndX, y);
        ctx.stroke();

        // small dot where line starts
        ctx.beginPath();
        ctx.arc(lineStartX, lineStartY, 2.2, 0, Math.PI * 2);
        ctx.fill();

        // arrow head pointing toward the donut
        const arrowBaseX = lineStartX + dir * 7;
        ctx.beginPath();
        ctx.moveTo(lineStartX, lineStartY);
        ctx.lineTo(arrowBaseX, lineStartY - 4);
        ctx.lineTo(arrowBaseX, lineStartY + 4);
        ctx.closePath();
        ctx.fill();

        ctx.textAlign = side === "right" ? "left" : "right";

        ctx.font = `700 ${nameSize}px ${fontFamily}`;
        ctx.fillText(item.name, textX, y - 8);

        const percentage = expenseTotal
          ? (Number(item.amount || 0) / expenseTotal) * 100
          : 0;

        ctx.fillStyle = "#3f4650";
        ctx.font = `500 ${detailSize}px ${fontFamily}`;
        ctx.fillText(
          `${formatter(item.amount)} (${percentage.toFixed(0)}%)`,
          textX,
          y + 9
        );
      });

      ctx.restore();
    }
  };

  function render() {
    const data = selectedData();
    const categories = data.categories || [];
    const parents = buildParentData(categories);

    const expenseTotal = categories.reduce(
      (sum, item) => sum + Number(item.amount || 0),
      0
    );

    periodLabel.textContent =
      currentView === "year"
        ? `Yearly view · ${yearFilter.value}`
        : `Monthly view · ${monthFilter.value} ${yearFilter.value}`;

    const parentCounters = {};

    const outerColors = categories.map(item => {
      const parent = item.parent || "OTHER";
      parentCounters[parent] = parentCounters[parent] || 0;

      const palette = outerPalette[parent] || outerPalette.OTHER;
      const color = palette[parentCounters[parent] % palette.length];
      parentCounters[parent]++;

      return color;
    });

    if (chart) chart.destroy();

    chart = new Chart(canvas, {
      type: "doughnut",
      plugins: [innerRingLabelsPlugin, outerRingCalloutsPlugin, centerTotalPlugin],

      data: {
        labels: categories.map(item => item.name),
        datasets: [
          {
            label: "Categories",
            data: parents.map(item => item.amount),
            backgroundColor: parents.map(
              item => parentColors[item.name] || parentColors.OTHER
            ),
            borderColor: "#ffffff",
            borderWidth: 2,

            radius: "64%",
            cutout: "5%"
          },
          {
            label: "Sub-categories",
            data: categories.map(item => item.amount),
            backgroundColor: outerColors,
            borderColor: "#ffffff",
            borderWidth: 2,

            radius: "85%",
            cutout: "63%"
          }
        ]
      },

      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 500 },

        plugins: {
          legend: { display: false },

          tooltip: {
            callbacks: {
              label(context) {
                if (context.datasetIndex === 0) {
                  const item = parents[context.dataIndex];
                  return `${item.name}: ${kr.format(item.amount)} (${pct(item.amount, expenseTotal).toFixed(1)}%)`;
                }

                const item = categories[context.dataIndex];
                return `${item.name}: ${kr.format(item.amount)} (${pct(item.amount, expenseTotal).toFixed(1)}%)`;
              }
            }
          }
        }
      }
    });

    chart.$parentCategoryData = parents;
    chart.$subCategoryData = categories;
    chart.$expenseTotal = expenseTotal;
    chart.$parentColors = parentColors;
    chart.$budgetTotal = expenseTotal;
    chart.$currencyFormatter = amount => kr.format(amount);
    chart.update();
  }

  viewButtons.forEach(button => {
    button.addEventListener("click", () => {
      currentView = button.dataset.view;

      viewButtons.forEach(btn => {
        btn.classList.toggle("active", btn === button);
      });

      monthFilter.hidden = currentView === "year";
      render();
    });
  });

  yearFilter.addEventListener("change", () => {
    populateMonths();
    render();
  });

  monthFilter.addEventListener("change", render);

  if (document.fonts) {
    document.fonts.ready.then(render);
  } else {
    render();
  }
})();

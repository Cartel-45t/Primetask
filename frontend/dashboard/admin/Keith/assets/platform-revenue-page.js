"use strict";

(() => {
  if (document.body.dataset.adminPage !== "platform-revenue") return;

  const status = document.querySelector("#na-status");
  const sections = document.querySelector("#na-sections");
  const API_BASE = String(
    window.PTW_API_BASE ||
    document.body.dataset.apiBase ||
    "http://127.0.0.1:5001/api"
  ).replace(/\/+$/, "");

  document.body.classList.add("ptw-admin-page");
  sections.replaceChildren();
  status.textContent = "Preparing revenue report…";

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function setStatus(text, kind = "info") {
    status.textContent = text;
    status.dataset.kind = kind;
  }

  function usd(value) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD"
    }).format(Number(value || 0));
  }

  function dateString(date) {
    return date.toISOString().slice(0, 10);
  }

  async function request(from, to) {
    const query = new URLSearchParams({ from, to });
    const response = await fetch(`${API_BASE}/admin/revenue?${query}`, {
      credentials: "include",
      headers: { Accept: "application/json" }
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
      if (response.status === 401) {
        throw new Error("Your admin session is missing or expired. Sign in again.");
      }
      if (response.status === 403) {
        throw new Error("Administrator access is required for this page.");
      }
      throw new Error(payload.message || `Request failed (${response.status}).`);
    }
    if (!payload.data || payload.data.currency !== "USD") {
      throw new Error("The revenue API returned an unexpected currency or response.");
    }
    return payload.data;
  }

  function metric(label, value) {
    const box = el("div", null, "ptw-admin-metric");
    box.append(
      el("span", label, "ptw-admin-metric-label"),
      el("strong", value, "ptw-admin-metric-value")
    );
    return box;
  }

  function commissionTable(data) {
    const wrap = el("div", null, "ptw-admin-table-wrap");
    const table = el("table", null, "ptw-admin-table");
    const thead = el("thead");
    const header = el("tr");
    ["Commission status", "Total (USD)", "Records"].forEach(label => {
      header.append(el("th", label));
    });
    thead.append(header);

    const tbody = el("tbody");
    [
      ["Pending obligations", data.commissions.pending],
      ["Paid commissions", data.commissions.paid],
      ["Reversed commissions", data.commissions.reversed]
    ].forEach(([label, item]) => {
      const row = el("tr");
      row.append(
        el("td", label),
        el("td", usd(item.amount)),
        el("td", String(item.count))
      );
      tbody.append(row);
    });

    table.append(thead, tbody);
    wrap.append(table);
    return wrap;
  }

  function render(data) {
    const report = sections.querySelector("#ptw-revenue-report");
    if (!report) return;
    report.replaceChildren();

    const metrics = el("section", null, "ptw-admin-grid");
    metrics.append(
      metric("Verified membership sales", usd(data.verifiedMembershipSales)),
      metric("Verified purchases", String(data.verifiedPurchaseCount)),
      metric("Sales less paid commissions", usd(data.salesLessPaidCommissions))
    );

    const commissions = el("section", null, "ptw-admin-card");
    commissions.append(
      el("h2", "Commission accounting"),
      el(
        "p",
        "Commission states are separated to avoid counting pending obligations as paid costs. Reversed entries are shown for transparency.",
        "ptw-admin-muted"
      ),
      commissionTable(data)
    );

    const explanation = el("section", null, "ptw-admin-card");
    explanation.append(
      el("h3", "How to read this report"),
      el("p", data.accountingNote, "ptw-admin-muted"),
      el(
        "p",
        `Reporting period: ${data.from} through ${data.to}, inclusive.`,
        "ptw-admin-muted"
      )
    );

    report.append(metrics, commissions, explanation);
  }

  function renderFilters() {
    const card = el("section", null, "ptw-admin-card");
    card.append(
      el("h2", "Revenue reporting period"),
      el("p", "Filter by the verified payment date. Reports use USD and do not treat wallet deposits as revenue.", "ptw-admin-muted")
    );

    const form = el("form");
    const grid = el("div", null, "ptw-admin-grid");
    const now = new Date();
    const fromDefault = new Date(now);
    fromDefault.setUTCDate(fromDefault.getUTCDate() - 29);

    const fromWrap = el("div", null, "ptw-admin-field");
    fromWrap.append(el("label", "From date"));
    const from = el("input");
    from.type = "date";
    from.name = "from";
    from.required = true;
    from.value = dateString(fromDefault);
    fromWrap.append(from);

    const toWrap = el("div", null, "ptw-admin-field");
    toWrap.append(el("label", "To date"));
    const to = el("input");
    to.type = "date";
    to.name = "to";
    to.required = true;
    to.value = dateString(now);
    toWrap.append(to);

    const actions = el("div", null, "ptw-admin-actions");
    const run = el("button", "Generate report", "ptw-admin-button ptw-admin-button-primary");
    run.type = "submit";
    const today = el("button", "Today", "ptw-admin-button");
    today.type = "button";
    today.addEventListener("click", () => {
      const value = dateString(new Date());
      from.value = value;
      to.value = value;
    });

    actions.append(run, today);
    grid.append(fromWrap, toWrap);
    form.append(grid, actions);
    card.append(form);
    sections.append(card);

    const report = el("div");
    report.id = "ptw-revenue-report";
    sections.append(report);

    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (!from.value || !to.value || from.value > to.value) {
        setStatus("Choose valid dates. The start date cannot be after the end date.", "error");
        return;
      }

      run.disabled = true;
      setStatus("Generating report…");
      try {
        const data = await request(from.value, to.value);
        render(data);
        setStatus("Revenue report loaded successfully.");
      } catch (error) {
        setStatus(error.message, "error");
      } finally {
        run.disabled = false;
      }
    });

    form.requestSubmit = form.requestSubmit || (() => form.dispatchEvent(new Event("submit", { cancelable: true })));
    form.dispatchEvent(new Event("submit", { cancelable: true }));
  }

  renderFilters();
})();

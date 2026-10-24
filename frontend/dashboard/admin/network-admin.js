"use strict";

(() => {
  const page = document.body.dataset.adminPage;
  const API_BASE = (window.PTW_API_BASE || document.body.dataset.apiBase || "").replace(/\/+$/, "");

  const configs = {
    memberships: {
      title: "Membership operations",
      endpoints: [
        { title: "Membership plans", url: "/admin/membership-plans", arrayKey: "plans" },
        { title: "Purchases awaiting payment review", url: "/admin/membership-reconciliation", arrayKey: "data" },
        { title: "Verified purchases awaiting activation", url: "/admin/membership-fulfilment", arrayKey: "purchases" }
      ]
    },

    commissions: {
      title: "Commission ledger",
      url: "/admin/reports/commissions",
      columns: ["beneficiary", "purchaser", "level", "amountUsd", "currency", "status", "createdAt", "paidAt"],
      filters: {
        status: ["pending", "paid", "reversed"],
        level: ["1", "2", "3", "4"]
      }
    },

    referrals: {
      title: "Referral network",
      url: "/admin/reports/referrals",
      columns: ["username", "firstName", "lastName", "status", "sponsor", "directReferrals", "joinedAt"],
      filters: { status: ["active", "suspended"] }
    },

    transactions: {
      title: "Wallet transactions",
      url: "/admin/reports/transactions",
      columns: ["user", "relatedUser", "type", "amountUsd", "currency", "status", "reference", "description", "createdAt"],
      filters: {
        status: ["pending", "completed", "failed", "reversed"],
        type: ["deposit", "withdrawal", "transfer_in", "transfer_out", "earning", "commission", "adjustment"]
      }
    },

    deposits: {
      title: "Deposit records",
      url: "/admin/reports/deposits",
      columns: ["requestId", "user", "amountUsd", "currency", "expectedAmountKes", "paymentMode", "status", "phoneNumber", "mpesaReceipt", "walletTransactionId", "createdAt", "completedAt"],
      filters: { status: ["pending", "completed", "failed", "cancelled"] }
    },

    withdrawals: {
      title: "Withdrawal records",
      url: "/admin/reports/withdrawals",
      columns: [
        "requestId", "user", "amountUsd", "currency",
        "exchangeRateKesPerUsd", "payoutAmountKes", "status",
        "phoneNumber", "b2cInitiationState", "mpesaReceipt",
        "b2cResultDescription", "reviewedBy", "adminNote", "createdAt"
      ],
      filters: {
        status: [
          "pending_review", "approved", "processing",
          "reconciliation_required", "paid", "rejected"
        ]
      }
    },

    "audit-logs": {
      title: "Administrative audit trail",
      url: "/admin/reports/audit-logs",
      columns: ["admin", "targetUser", "action", "reason", "ipAddress", "createdAt"],
      filters: {}
    },

    "platform-revenue": {
      unavailable: true,
      title: "Platform revenue",
      description: "Revenue reporting needs a verified accounting definition and payment-source reconciliation before totals can be shown. Wallet deposits and commission payouts are not automatically platform revenue."
    },

    settings: {
      unavailable: true,
      title: "Administrative settings",
      description: "No settings API is currently connected. This page will not offer pretend controls that change nothing."
    }
  };

  const status = document.querySelector("#na-status");
  const sections = document.querySelector("#na-sections");

  function message(text, kind = "info") {
    if (!status) return;
    status.textContent = text;
    status.dataset.kind = kind;
  }

  function make(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined && text !== null) el.textContent = String(text);
    if (className) el.className = className;
    return el;
  }

  function userLabel(value) {
    if (!value || typeof value !== "object") return value;
    const name = [value.firstName, value.lastName].filter(Boolean).join(" ");
    return value.username || name || value.email || value._id || value.id || "—";
  }

  function formatValue(key, value) {
    if (value === null || value === undefined || value === "") return "—";

    if (["beneficiary", "purchaser", "sponsor", "user", "relatedUser", "reviewedBy", "admin", "targetUser"].includes(key)) {
      return userLabel(value);
    }

    if (key === "amountUsd") {
      const amount = Number(value);
      return Number.isFinite(amount)
        ? "USD " + amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : String(value);
    }

    if (key === "expectedAmountKes") {
      const amount = Number(value);
      return Number.isFinite(amount)
        ? "KES " + amount.toLocaleString("en-KE", { maximumFractionDigits: 2 })
        : String(value);
    }

    if (/(At|Date|Timestamp)$/.test(key)) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date.toLocaleString();
    }

    if (typeof value === "object") {
      return value.username || value.email || value._id || value.id || JSON.stringify(value);
    }

    return String(value);
  }

  function rowsFrom(payload, key) {
    if (key && Array.isArray(payload?.[key])) return payload[key];
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload)) return payload;
    return [];
  }

  function renderTable(container, rows, configuredColumns, onWithdrawalAction) {
    container.replaceChildren();

    const columns = configuredColumns?.length
      ? configuredColumns
      : [...new Set(rows.flatMap(row =>
          row && typeof row === "object" ? Object.keys(row) : []
        ))].slice(0, 10);

    if (!rows.length && !(page === "withdrawals" && columns.length)) {
      container.append(make("div", "No records found for these filters.", "na-empty"));
      return;
    }

    const withWithdrawalActions =
      page === "withdrawals" && typeof onWithdrawalAction === "function";

    const wrap = make("div", undefined, "na-table-wrap");
    const table = make("table", undefined, "na-table");
    const thead = make("thead");
    const header = make("tr");

    columns.forEach(column => {
      const th = make("th", column.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase()));
      header.append(th);
    });

    if (withWithdrawalActions) {
      const actionsTemplate = document.getElementById("withdrawal-actions-column");
      const actionsHeader = actionsTemplate
        ? actionsTemplate.content.firstElementChild.cloneNode(true)
        : make("th", "Actions");
      actionsHeader.className = "na-actions-column";
      header.append(actionsHeader);
    }

    thead.append(header);
    const tbody = make("tbody");

    rows.forEach(row => {
      const tr = make("tr");

      columns.forEach(column => {
        const td = make("td", formatValue(column, row?.[column]));
        td.title = td.textContent;
        tr.append(td);
      });

      if (withWithdrawalActions) {
        const cell = make("td");
        cell.className = "na-actions-column";
        const actions = make("div", undefined, "na-withdrawal-actions");
        const requestId = String(row?.requestId || "").trim();
        let choices = [];

        if (row?.status === "pending_review") {
          choices = [["approve", "Approve"], ["reject", "Reject"]];
        } else if (
          row?.status === "approved" &&
          (!row?.b2cInitiationState || row.b2cInitiationState === "not_started")
        ) {
          choices = [["initiate-b2c", "Initiate B2C"]];
        }

        if (!choices.length) {
          cell.append(make("span", "No action required."));
        } else {
          choices.forEach(([action, label]) => {
            const button = make("button", label, "na-button");
            button.type = "button";
            button.disabled = !requestId;
            button.title = requestId
              ? label + " withdrawal " + requestId
              : "Missing withdrawal request ID";

            button.addEventListener("click", () => {
              onWithdrawalAction(action, row, button);
            });

            actions.append(button);
          });

          cell.append(actions);
        }

        tr.append(cell);
      }

      tbody.append(tr);
    });

    table.append(thead, tbody);
    wrap.append(table);
    container.append(wrap);
  }

  function addSelect(parent, labelText, name, options) {
    const label = make("label", undefined, "na-filter");
    label.append(make("span", labelText));

    const select = make("select");
    select.name = name;
    select.append(new Option("All", ""));

    options.forEach(value => select.append(new Option(value, value)));
    label.append(select);
    parent.append(label);

    return select;
  }

  function addSearch(parent) {
    const label = make("label", undefined, "na-filter na-search");
    label.append(make("span", "Search members"));

    const input = make("input");
    input.type = "search";
    input.name = "search";
    input.placeholder = "Username, name or email";
    input.maxLength = 100;
    label.append(input);
    parent.append(label);

    return input;
  }

  async function request(url) {
    const response = await fetch(API_BASE + url, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" }
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok || payload.success === false) {
      if (response.status === 401) {
        throw new Error("Your session is missing or expired. Sign in with an administrator account.");
      }

      if (response.status === 403) {
        throw new Error("Administrator access is required for this page.");
      }

      throw new Error(payload.message || `Request failed (${response.status})`);
    }

    return payload;
  }

  async function postRequest(url, body) {
    const response = await fetch(API_BASE + url, {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body || {})
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok || payload.success === false) {
      if (response.status === 401) {
        throw new Error(
          "Your session is missing or expired. Sign in with an administrator account."
        );
      }

      if (response.status === 403) {
        throw new Error("Administrator access is required for this action.");
      }

      throw new Error(payload.message || `Action failed (${response.status})`);
    }

    return payload;
  }

  async function loadSimpleSection(config) {
    const section = make("section", undefined, "na-section");
    section.append(make("h2", config.title));
    section.append(make("p", "Records from the protected PrimeTask admin API.", "na-help"));

    const content = make("div", "Loading records…", "na-empty");
    section.append(content);
    sections.append(section);

    try {
      const payload = await request(config.url);
      const holder = make("div");
      renderTable(holder, rowsFrom(payload, config.arrayKey), config.columns);
      content.replaceWith(holder);
      return true;
    } catch (error) {
      content.textContent = error.message || "Could not load records.";
      return false;
    }
  }

  async function loadReport(config) {
    const section = make("section", undefined, "na-section");
    section.append(make("h2", config.title));
    section.append(make("p", "Search and filters are applied by the server. Amounts use the platform USD denomination unless explicitly marked KES.", "na-help"));

    const toolbar = make("div", undefined, "na-toolbar");
    const search = addSearch(toolbar);
    const filterControls = {};

    Object.entries(config.filters || {}).forEach(([name, options]) => {
      const label = name === "level" ? "Referral level" : name[0].toUpperCase() + name.slice(1);
      filterControls[name] = addSelect(toolbar, label, name, options);
    });

    const refresh = make("button", "Apply filters");
    refresh.type = "button";
    refresh.className = "na-button";
    toolbar.append(refresh);

    section.append(toolbar);

    const content = make("div", "Loading records…", "na-empty");
    section.append(content);

    const paginationBar = make("div", undefined, "na-pagination");
    const summary = make("span", "Waiting for records…");
    const previous = make("button", "Previous");
    const next = make("button", "Next");
    previous.type = "button";
    next.type = "button";
    previous.className = next.className = "na-button";
    paginationBar.append(previous, summary, next);
    section.append(paginationBar);
    sections.append(section);

    let currentPage = 1;
    let lastPage = 1;
    let busy = false;

    async function handleWithdrawalAction(action, row, button) {
      const requestId = String(row?.requestId || "").trim();

      if (!requestId) {
        message("Withdrawal request ID is missing.", "error");
        return;
      }

      const amount = Number(row?.amountUsd);
      const amountLabel = Number.isFinite(amount)
        ? "USD " + amount.toFixed(2)
        : "this amount";

      let body = {};

      if (action === "approve") {
        if (!window.confirm(
          `Approve withdrawal ${requestId} for ${amountLabel}? ` +
          "This records approval only. It does not send money."
        )) return;

      } else if (action === "reject") {
        const reason = window.prompt(
          "Enter the rejection reason (3 to 300 characters):"
        );

        if (reason === null) return;

        body.reason = reason.trim();

        if (body.reason.length < 3 || body.reason.length > 300) {
          message("Rejection reason must contain 3 to 300 characters.", "error");
          return;
        }

        if (!window.confirm(
          `Reject withdrawal ${requestId} and release its reserved wallet balance?`
        )) return;

      } else if (action === "initiate-b2c") {
        if (!window.confirm(
          `Initiate one B2C payout attempt for withdrawal ${requestId}? ` +
          `Saved payout amount: KSh ${row?.payoutAmountKes ?? "unknown"}. ` +
          "This sends a payment request to Safaricom. If the outcome is unclear, " +
          "the request must be reconciled and must not be retried automatically."
        )) return;

      } else if (action === "paid") {
        message(
          "Manual completion is not available in this interface. Use verified B2C callbacks and reconciliation.",
          "error"
        );
        return;

      } else {
        message("Unsupported withdrawal action.", "error");
        return;
      }

      button.disabled = true;

      try {
        const payload = await postRequest(
          "/wallet/withdrawals/" +
            encodeURIComponent(requestId) + "/" + action,
          body
        );

        message(payload.message || "Withdrawal action completed.", "ok");
        await load();

      } catch (error) {
        message(error.message || "Withdrawal action failed.", "error");
        button.disabled = false;
      }
    }

    async function load() {
      if (busy) return;
      busy = true;
      refresh.disabled = true;
      previous.disabled = true;
      next.disabled = true;
      content.replaceChildren(make("div", "Loading records…", "na-empty"));

      const params = new URLSearchParams({
        page: String(currentPage),
        limit: "25"
      });

      const term = search.value.trim();
      if (term) params.set("search", term);

      Object.entries(filterControls).forEach(([name, control]) => {
        if (control.value) params.set(name, control.value);
      });

      try {
        const payload = await request(config.url + "?" + params.toString());
        const rows = rowsFrom(payload);
        renderTable(
          content,
          rows,
          config.columns,
          config.url === "/admin/reports/withdrawals"
            ? handleWithdrawalAction
            : null
        );

        const meta = payload.pagination || {};
        lastPage = Math.max(1, Number(meta.pages) || 1);
        currentPage = Math.min(currentPage, lastPage);

        const total = Number(meta.total) || 0;
        summary.textContent = `Page ${currentPage} of ${lastPage} · ${total.toLocaleString()} record(s)`;
        previous.disabled = currentPage <= 1;
        next.disabled = currentPage >= lastPage;
        message("Connected to the protected admin reporting API.", "ok");
      } catch (error) {
        content.replaceChildren(make("div", error.message || "Could not load records.", "na-empty"));
        summary.textContent = "Records unavailable";
        message(error.message || "Could not load records.", "error");
      } finally {
        busy = false;
        refresh.disabled = false;
        previous.disabled = currentPage <= 1;
        next.disabled = currentPage >= lastPage;
      }
    }

    refresh.addEventListener("click", () => {
      currentPage = 1;
      load();
    });

    Object.values(filterControls).forEach(control => {
      control.addEventListener("change", () => {
        currentPage = 1;
        load();
      });
    });

    search.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        currentPage = 1;
        load();
      }
    });

    previous.addEventListener("click", () => {
      if (currentPage > 1) {
        currentPage -= 1;
        load();
      }
    });

    next.addEventListener("click", () => {
      if (currentPage < lastPage) {
        currentPage += 1;
        load();
      }
    });

    await load();
  }

  async function init() {
    if (!status || !sections) return;

    const config = configs[page];

    if (!config) {
      message("This page has no configuration.", "error");
      return;
    }

    if (config.unavailable) {
      message("This page is not connected to a backend endpoint.", "error");
      const section = make("section", undefined, "na-section");
      section.append(make("h2", config.title));
      section.append(make("p", config.description, "na-help"));
      sections.append(section);
      return;
    }

    sections.replaceChildren();
    message("Connecting to PrimeTask admin APIs…");

    let success = true;

    if (config.endpoints) {
      for (const endpoint of config.endpoints) {
        if (!await loadSimpleSection(endpoint)) success = false;
      }
    } else {
      await loadReport(config);
    }

    if (!success) {
      message("One or more membership sections failed to load. Check the displayed error and administrator session.", "error");
    }
  }

  init();
})();

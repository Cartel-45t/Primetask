"use strict";

(() => {
  if (document.body.dataset.adminPage !== "settings") return;

  const status = document.querySelector("#na-status");
  const sections = document.querySelector("#na-sections");
  const API_BASE = String(
    window.PTW_API_BASE ||
    document.body.dataset.apiBase ||
    "http://127.0.0.1:5001/api"
  ).replace(/\/+$/, "");

  document.body.classList.add("ptw-admin-page");
  sections.replaceChildren();
  status.textContent = "Loading saved platform settings…";

  function setStatus(text, kind = "info") {
    status.textContent = text;
    status.dataset.kind = kind;
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  async function request(path, options = {}) {
    const response = await fetch(API_BASE + path, {
      method: options.method || "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {})
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {})
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
    return payload;
  }

  function toggleRow(key, title, description, checked) {
    const row = element("label", null, "ptw-admin-toggle");
    const input = element("input");
    input.type = "checkbox";
    input.name = key;
    input.checked = checked;

    const copy = element("span");
    copy.append(
      element("strong", title),
      element("span", description, "ptw-admin-muted")
    );
    row.append(input, copy);
    return { row, input };
  }

  function render(data) {
    sections.replaceChildren();

    const card = element("section", null, "ptw-admin-card");
    card.append(
      element("h2", "Registration and availability"),
      element(
        "p",
        "These settings are saved on the server. Registration changes are enforced by the API, not just by the interface.",
        "ptw-admin-muted"
      )
    );

    const registration = toggleRow(
      "registrationEnabled",
      "Allow new registrations",
      "When disabled, the registration endpoint rejects new account creation.",
      data.registrationEnabled
    );

    const maintenance = toggleRow(
      "maintenanceMode",
      "Maintenance mode",
      "Currently this also blocks new registrations. It does not yet disable existing services or sign users out.",
      data.maintenanceMode
    );

    const rateLabel = element("label", "KES per USD", "ptw-admin-field");
    const rateHelp = element(
      "span",
      "Used to calculate the M-Pesa payout for new withdrawal requests. Existing requests keep their original rate.",
      "ptw-admin-muted"
    );
    const rateInput = element("input");
    rateInput.type = "number";
    rateInput.name = "exchangeRateKesPerUsd";
    rateInput.min = "1";
    rateInput.max = "1000";
    rateInput.step = "0.0001";
    rateInput.inputMode = "decimal";
    rateInput.placeholder = "e.g. 130";
    rateInput.value = data.exchangeRateKesPerUsd == null
      ? ""
      : String(data.exchangeRateKesPerUsd);
    rateInput.autocomplete = "off";
    rateLabel.append(rateInput, rateHelp);

    const actions = element("div", null, "ptw-admin-actions");
    const save = element("button", "Save settings", "ptw-admin-button ptw-admin-button-primary");
    save.type = "button";

    const reload = element("button", "Reload saved values", "ptw-admin-button");
    reload.type = "button";

    const originalRate = data.exchangeRateKesPerUsd == null
      ? ""
      : String(data.exchangeRateKesPerUsd);

    const changed = () =>
      registration.input.checked !== data.registrationEnabled ||
      maintenance.input.checked !== data.maintenanceMode ||
      rateInput.value.trim() !== originalRate;

    function updateSaveState() {
      save.disabled = !changed();
    }

    registration.input.addEventListener("change", updateSaveState);
    maintenance.input.addEventListener("change", updateSaveState);
    rateInput.addEventListener("input", updateSaveState);

    reload.addEventListener("click", load);

    save.addEventListener("click", async () => {
      save.disabled = true;
      reload.disabled = true;
      setStatus("Saving settings…");

      try {
        const rawRate = rateInput.value.trim();
        const rate = rawRate === "" ? null : Number(rawRate);

        if (
          rawRate === "" ||
          !Number.isFinite(rate) ||
          rate < 1 ||
          rate > 1000 ||
          Math.round(rate * 10000) !== rate * 10000
        ) {
          throw new Error(
            "Enter an exchange rate from 1 to 1000 KES per USD, with up to four decimal places."
          );
        }

        const body = {};
        if (registration.input.checked !== data.registrationEnabled) {
          body.registrationEnabled = registration.input.checked;
        }
        if (maintenance.input.checked !== data.maintenanceMode) {
          body.maintenanceMode = maintenance.input.checked;
        }
        if (rate !== data.exchangeRateKesPerUsd) {
          body.exchangeRateKesPerUsd = rate;
        }

        const result = await request("/admin/settings", {
          method: "PUT",
          body
        });
        render(result.data);
        setStatus(result.message || "Settings saved.", "success");
      } catch (error) {
        setStatus(error.message, "error");
        updateSaveState();
      } finally {
        reload.disabled = false;
      }
    });

    actions.append(save, reload);
    card.append(registration.row, maintenance.row, rateLabel, actions);

    if (data.updatedAt) {
      card.append(element(
        "p",
        `Last updated: ${new Date(data.updatedAt).toLocaleString()}`,
        "ptw-admin-muted"
      ));
    }

    const note = element("section", null, "ptw-admin-card");
    note.append(
      element("h3", "Security and audit"),
      element(
        "p",
        "Only authenticated admin and founder accounts can read or update these settings. Changes are recorded in the administrative audit log.",
        "ptw-admin-muted"
      )
    );

    sections.append(card, note);
  }

  async function load() {
    setStatus("Loading saved platform settings…");
    try {
      const result = await request("/admin/settings");
      if (!result.data ||
          typeof result.data.registrationEnabled !== "boolean" ||
          typeof result.data.maintenanceMode !== "boolean") {
        throw new Error("The settings API returned an unexpected response.");
      }
      render(result.data);
      setStatus("Settings loaded from the backend.");
    } catch (error) {
      sections.replaceChildren();
      setStatus(error.message, "error");
    }
  }

  load();
})();

(() => {
  const base = String(window.PTW_API_BASE || "").replace(/\/+$/, "");
  const root = document.getElementById("minutePackages");
  const select = document.getElementById("minutePackage");
  const form = document.getElementById("minutePurchaseForm");
  const notice = document.getElementById("minuteNotice");
  const history = document.getElementById("minutePurchaseHistory");
  const button = document.getElementById("minutePurchaseButton");
  const summary = document.getElementById("minuteSelectedSummary");
  const phone = document.getElementById("minutePhone");

  let packages = [];
  let latestCreatedPurchaseId = null;

  if (!root || !select || !form || !notice || !history || !button || !summary || !phone) return;

  function message(text, error = false) {
    notice.textContent = text;
    notice.setAttribute("role", error ? "alert" : "status");
  }

  function usd(value) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD"
    }).format(Number(value) || 0);
  }

  async function api(path, options = {}) {
    if (!base) throw new Error("API is not configured for this website.");

    const response = await fetch(`${base}${path}`, {
      credentials: "include",
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      }
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      throw new Error(data.message || `Request failed (${response.status}).`);
    }
    return data;
  }

  function add(parent, tag, text) {
    const el = document.createElement(tag);
    el.textContent = text;
    parent.appendChild(el);
    return el;
  }

  function updateSummary() {
    const pkg = packages.find(p => p.id === select.value);
    summary.textContent = pkg
      ? `${pkg.name}: ${pkg.minutes} minutes, ${usd(pkg.price)}. M-Pesa amount: KSh ${Number(pkg.priceKes).toLocaleString()}.`
      : "Select a package to review its price.";
  }

  async function loadPackages() {
    try {
      const data = await api("/transcription/minute-purchases/packages");
      packages = Array.isArray(data.packages) ? data.packages : [];

      root.replaceChildren();
      select.replaceChildren();

      const placeholder = add(
        select,
        "option",
        packages.length ? "Choose a package" : "No packages available"
      );
      placeholder.value = "";

      for (const pkg of packages) {
        const card = document.createElement("article");
        card.className = "card";
        add(card, "h3", pkg.name);
        add(card, "p", `${Number(pkg.minutes).toLocaleString()} minutes`);
        add(card, "p", usd(pkg.price));
        add(card, "p", `M-Pesa amount: KSh ${Number(pkg.priceKes).toLocaleString()}`);
        root.appendChild(card);

        const option = document.createElement("option");
        option.value = pkg.id;
        option.textContent = `${pkg.name} · ${pkg.minutes} minutes · ${usd(pkg.price)}`;
        select.appendChild(option);
      }

      button.disabled = packages.length === 0;
      updateSummary();
      message(packages.length
        ? "Minute packages loaded."
        : "No active minute packages are available.");
    } catch (error) {
      message(error.message, true);
      root.textContent = "Could not load packages.";
      button.disabled = true;
    }
  }

  async function initiatePayment(purchaseId, initiateButton) {
    if (!purchaseId || initiateButton.disabled) return;

    initiateButton.disabled = true;
    initiateButton.textContent = "Requesting M-Pesa prompt…";
    message("Requesting the M-Pesa prompt. Do not submit another payment request.");

    try {
      const data = await api(
        `/transcription/minute-purchases/${encodeURIComponent(purchaseId)}/initiate`,
        {
          method: "POST",
          body: JSON.stringify({})
        }
      );

      latestCreatedPurchaseId = null;
      message(
        `${data.message || "M-Pesa request submitted."} This is not confirmation of payment.`
      );
    } catch (error) {
      message(
        `${error.message} Check purchase history before attempting anything else.`,
        true
      );
    } finally {
      await loadHistory();
    }
  }

  async function loadHistory() {
    history.textContent = "Loading purchase history…";

    try {
      const data = await api("/transcription/minute-purchases");
      history.replaceChildren();

      const purchases = Array.isArray(data.purchases) ? data.purchases : [];
      if (!purchases.length) {
        add(history, "p", "No minute purchases recorded yet.");
        return;
      }

      for (const p of purchases) {
        const card = document.createElement("article");
        card.className = "card";

        add(card, "h3", p.packageName || "Minute purchase");
        add(card, "p", `${Number(p.minutes).toLocaleString()} minutes · ${usd(p.price)}`);

        const status = String(p.paymentStatus || "unknown");
        add(card, "p", `Status: ${status.replaceAll("_", " ")}`);
        add(card, "p", `Reference: ${p.purchaseReference || "Unavailable"}`);
        add(card, "p", `M-Pesa amount: KSh ${Number(p.expectedAmountKes || 0).toLocaleString()}`);

        if (p.checkoutRequestId) {
          add(card, "p", "M-Pesa prompt request recorded. Payment still requires verification.");
        }

        if (p.mpesaReceipt) {
          add(card, "p", `Verified receipt: ${p.mpesaReceipt}`);
        }

        const purchaseId = String(p.id || p._id || "");

        if (status === "verification_required") {
          add(
            card,
            "p",
            "This purchase is locked for reconciliation. Do not retry the payment prompt."
          );
        } else if (
          purchaseId &&
          purchaseId === latestCreatedPurchaseId &&
          status === "pending" &&
          !p.checkoutRequestId &&
          !p.merchantRequestId
        ) {
          const initiateButton = add(card, "button", "Initiate M-Pesa prompt");
          initiateButton.type = "button";
          initiateButton.addEventListener("click", () => {
            initiatePayment(purchaseId, initiateButton);
          });
        } else if (status === "verified") {
          add(card, "p", "Payment verified by the backend reconciliation process.");
        }

        history.appendChild(card);
      }
    } catch (error) {
      history.textContent = error.message;
    }
  }

  select.addEventListener("change", updateSummary);

  form.addEventListener("submit", async event => {
    event.preventDefault();

    if (!select.value || !phone.value.trim()) {
      message("Choose a package and enter your M-Pesa phone number.", true);
      return;
    }

    button.disabled = true;
    button.textContent = "Creating purchase…";

    try {
      const key = `minute-${crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`}`;

      const data = await api("/transcription/minute-purchases", {
        method: "POST",
        body: JSON.stringify({
          packageId: select.value,
          phoneNumber: phone.value.trim(),
          idempotencyKey: key
        })
      });

      const purchase = data.purchase || data.data?.purchase || null;
      const id = purchase?.id || purchase?._id || null;
      latestCreatedPurchaseId = id ? String(id) : null;

      message(
        latestCreatedPurchaseId
          ? `${data.message || "Purchase record created."} Use the button on this purchase to request an M-Pesa prompt. Payment is not confirmed until verified.`
          : `${data.message || "Purchase record created."} The API did not return a purchase ID, so the prompt button cannot be shown. Do not send money manually.`
      );

      await loadHistory();
    } catch (error) {
      message(error.message, true);
    } finally {
      button.disabled = packages.length === 0;
      button.textContent = "Create purchase record";
    }
  });

  document.getElementById("refreshMinutePurchases")?.addEventListener("click", loadHistory);

  loadPackages();
  loadHistory();
})();

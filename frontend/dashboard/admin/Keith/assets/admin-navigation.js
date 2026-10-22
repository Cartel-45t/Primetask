"use strict";

(() => {
  if (document.querySelector(".ptw-nav-trigger")) return;

  const base = "/dashboard/admin/Keith/";
  const items = [
    ["keith.html", "Overview", "⌂"],
    ["users.html", "Users / Members", "♙"],
    ["memberships.html", "Memberships", "✦"],
    ["deposits.html", "Deposits", "↙"],
    ["withdrawals.html", "Withdrawals", "↗"],
    ["transactions.html", "Transactions", "⇄"],
    ["commissions.html", "Commissions", "◇"],
    ["referrals.html", "Referrals", "♧"],
    ["platform-revenue.html", "Platform Revenue", "$"],
    ["audit-logs.html", "Audit Logs", "≡"],
    ["settings.html", "Settings", "⚙"],
    ["transcription-overview.html", "Transcription Overview", "▦"],
    ["transcription.html", "Transcription Admin", "▤"],
    ["transcription-job-posting.html", "Post Transcription Jobs", "+"],
    ["transcription-jobs.html", "Transcription Jobs", "▦"],
    ["transcription-audio-library.html", "Audio Library", "♫"],
    ["transcription-document-review.html", "Document Review", "✓"],
    ["transcription-reports.html", "Transcription Reports", "▥"],
  ];

  const currentPath = window.location.pathname.replace(/\/+$/, "");
  const currentFile = currentPath.split("/").pop() || "keith.html";

  document.body.classList.add("ptw-nav-standardized");

  const button = document.createElement("button");
  button.type = "button";
  button.className = "ptw-nav-trigger";
  button.setAttribute("aria-controls", "ptw-admin-navigation");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", "Open admin navigation");
  button.innerHTML =
    '<span class="ptw-nav-symbol" aria-hidden="true">☰</span>' +
    '<span>Admin navigation</span>';

  const backdrop = document.createElement("div");
  backdrop.className = "ptw-nav-backdrop";
  backdrop.setAttribute("aria-hidden", "true");

  const panel = document.createElement("nav");
  panel.id = "ptw-admin-navigation";
  panel.className = "ptw-nav-panel";
  panel.setAttribute("aria-label", "PrimeTask administrator pages");
  panel.setAttribute("aria-hidden", "true");

  const heading = document.createElement("div");
  heading.className = "ptw-nav-heading";

  const title = document.createElement("strong");
  title.textContent = "PrimeTask Workspace";

  const subtitle = document.createElement("span");
  subtitle.textContent = "Administration control panel";

  heading.append(title, subtitle);

  const links = document.createElement("div");
  links.className = "ptw-nav-links";

  items.forEach(([file, label, symbol]) => {
    const link = document.createElement("a");
    link.href = base + file;

    const icon = document.createElement("span");
    icon.className = "ptw-nav-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = symbol;

    const text = document.createElement("span");
    text.textContent = label;

    link.append(icon, text);

    if (file === currentFile) {
      link.setAttribute("aria-current", "page");
    }

    links.append(link);
  });

  const footer = document.createElement("div");
  footer.className = "ptw-nav-footer";
  footer.textContent = "Restricted administrator area";

  panel.append(heading, links, footer);
  document.body.append(button, backdrop, panel);

  function setOpen(open) {
    document.body.classList.toggle("ptw-nav-open", open);
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute(
      "aria-label",
      open ? "Close admin navigation" : "Open admin navigation"
    );

    button.querySelector(".ptw-nav-symbol").textContent = open ? "×" : "☰";
    panel.setAttribute("aria-hidden", String(!open));

    if (open) {
      const active = panel.querySelector('[aria-current="page"]');
      if (active) active.focus({ preventScroll: true });
    } else {
      button.focus({ preventScroll: true });
    }
  }

  button.addEventListener("click", () => {
    setOpen(button.getAttribute("aria-expanded") !== "true");
  });

  backdrop.addEventListener("click", () => setOpen(false));

  links.addEventListener("click", event => {
    if (event.target.closest("a")) setOpen(false);
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") setOpen(false);
  });
})();

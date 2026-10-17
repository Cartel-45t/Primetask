(() => {
  const toggle = document.querySelector(".menu-toggle");
  const panel = document.querySelector(".menu-panel");
  if (!toggle || !panel) return;

  function closeMenu() {
    panel.classList.remove("open");
    toggle.setAttribute("aria-expanded", "false");
  }

  toggle.addEventListener("click", () => {
    const open = panel.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
  });

  document.addEventListener("click", event => {
    if (!event.target.closest(".menu-wrap")) closeMenu();
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      closeMenu();
      toggle.focus();
    }
  });

  panel.querySelectorAll("a").forEach(link => {
    link.addEventListener("click", closeMenu);
  });
})();

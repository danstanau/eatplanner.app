{
  const key = "eatplanner.app:theme";
  const root = document.documentElement;
  const colors = [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => [meta, meta.content]);

  function apply(theme) {
    if (theme === "light" || theme === "dark") root.dataset.theme = theme;
    else delete root.dataset.theme;
    const color = colors.find(([meta]) => meta.media === `(prefers-color-scheme: ${theme})`)?.[1];
    for (const [meta, original] of colors) meta.content = color ?? original;
  }

  try { apply(localStorage.getItem(key)); }
  catch (error) { console.error("Appearance preference could not be loaded:", error); }

  document.addEventListener("DOMContentLoaded", () => {
    const picker = document.querySelector("#theme-picker");
    picker.value = root.dataset.theme ?? "system";
    picker.closest("label").hidden = false;
    picker.addEventListener("change", () => {
      apply(picker.value);
      try {
        if (picker.value === "system") localStorage.removeItem(key);
        else localStorage.setItem(key, picker.value);
      } catch (error) { console.error("Appearance preference could not be saved:", error); }
    });
  });
}

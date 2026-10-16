const STORAGE_KEY = 'zenvora-theme';

function applyTheme(theme, toggle) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  if (toggle) {
    toggle.setAttribute('aria-checked', String(dark));
    toggle.setAttribute('aria-label', dark ? 'Dark mode is on. Switch to light mode' : 'Dark mode is off. Switch to dark mode');
    toggle.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    const glyph = toggle.querySelector('.theme-toggle__glyph');
    if (glyph) glyph.textContent = dark ? '☀' : '☾';
  }
}

export function initThemeToggle() {
  const toggle = document.getElementById('theme-toggle');
  let saved = 'light';
  try {
    saved = localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    // Theme still works for this page if storage is unavailable.
  }
  applyTheme(saved, toggle);
  if (!toggle) return;
  toggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next, toggle);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Keep the selected theme active for the current session.
    }
  });
}

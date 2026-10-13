// Coordinates the first-load brand moment with real app rendering, with a hard timeout fallback.
export function initLoadingScreen() {
  const screen = document.getElementById('boot-screen');
  const app = document.getElementById('app');
  if (!screen || !app) return;

  document.body.classList.add('is-booting');
  const startedAt = performance.now();
  let finished = false;
  let fallbackTimer;

  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(fallbackTimer);
    observer?.disconnect();
    const elapsed = performance.now() - startedAt;
    // Keep the logo moment intentional without making slow devices wait on a fixed long splash.
    window.setTimeout(() => {
      screen.classList.add('is-leaving');
      document.body.classList.remove('is-booting');
      window.setTimeout(() => screen.remove(), 520);
    }, Math.max(0, 720 - elapsed));
  };

  const observer = new MutationObserver(() => {
    if (app.childElementCount > 0 || app.textContent.trim()) finish();
  });
  observer.observe(app, { childList: true, subtree: true, characterData: true });
  fallbackTimer = window.setTimeout(finish, 2400);
  if (app.childElementCount > 0 || app.textContent.trim()) finish();
  window.addEventListener('pageshow', () => {
    // bfcache restores should never leave the overlay blocking the page.
    if (performance.getEntriesByType('navigation')[0]?.type === 'back_forward') finish();
  }, { once: true });
}

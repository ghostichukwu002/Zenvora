// Store logos, keyed by merchant id. Each is a small monogram SVG in assets/merchants.
// A store without a logo shows nothing, so this degrades cleanly.
import { el } from './dom.js';

const LOGO_IDS = new Set([
  'm-sample-kitchen', 'm-sample-market', 'm-sample-tech',
  'm-sample-beauty', 'm-sample-games', 'm-sample-smoke',
]);

export function merchantLogo(merchant, size = 20) {
  if (!merchant?.id || !LOGO_IDS.has(merchant.id)) return null;
  return el('img', {
    class: 'merchant-logo',
    src: `assets/merchants/${merchant.id}.svg`,
    alt: '',
    width: String(size),
    height: String(size),
    loading: 'lazy',
  });
}

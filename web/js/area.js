// Delivery-area picker. The chosen area is stored in this browser and drives which stores
// the home page and shop show. The server still checks every area when a cart is priced.

import * as api from './api.js';
import { el } from './dom.js';
import { getArea, onAreaChange, setArea } from './state.js';
import { toast } from './ui.js';

let areaCache = null;

async function loadAreas() {
  if (!areaCache) {
    const res = await api.get('/api/areas');
    areaCache = res.items;
  }
  return areaCache;
}

export function renderAreaLabel() {
  const area = getArea();
  const label = document.getElementById('location-text');
  const button = document.getElementById('location-button');
  if (label) label.textContent = area ?? 'Choose area';
  // On narrow screens only the icon shows, so the accessible name carries the area.
  if (button) {
    button.setAttribute('aria-label', area ? `Delivery area: ${area}. Change area` : 'Choose delivery area');
    button.title = area ? `Delivering to ${area}` : 'Choose your delivery area';
  }
}

export async function openAreaDialog() {
  const dialog = document.getElementById('area-dialog');
  const select = document.getElementById('area-select');
  const stateSelect = document.getElementById('area-state');
  const customInput = document.getElementById('area-custom');
  select.replaceChildren(el('option', { value: '', text: 'Loading areas…' }));
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');

  try {
    const items = await loadAreas();
    const renderAreaOptions = () => {
      const state = stateSelect.value;
      const filtered = state ? items.filter((a) => a.state === state) : items;
      select.replaceChildren(
        el('option', { value: '', text: 'Choose a listed delivery area' }),
        ...filtered.map((a) => el('option', { value: a.name, text: `${a.name}, ${a.state}` })),
      );
      if (filtered.some((a) => a.name === getArea())) select.value = getArea();
    };
    renderAreaOptions();
    stateSelect.onchange = renderAreaOptions;
    customInput.value = '';
    const current = items.find((a) => a.name === getArea());
    if (current) stateSelect.value = current.state;
    renderAreaOptions();
    select.value = getArea() ?? '';
    select.focus();
  } catch (err) {
    select.replaceChildren(el('option', { value: '', text: 'Areas unavailable' }));
    toast(err.message, { tone: 'error' });
  }
}

function closeAreaDialog() {
  const dialog = document.getElementById('area-dialog');
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

export function initAreaDialog(onChanged) {
  const form = document.getElementById('area-form');
  const select = document.getElementById('area-select');
  const customInput = document.getElementById('area-custom');
  const location = document.getElementById('location-button');

  location.addEventListener('click', openAreaDialog);
  document.getElementById('area-cancel').addEventListener('click', closeAreaDialog);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const typedLocation = customInput.value.trim();
    const chosen = typedLocation || select.value;
    if (!chosen) {
      toast('Choose a listed delivery area or type your location.', { tone: 'error' });
      (customInput.value ? select : customInput).focus();
      return;
    }
    setArea(chosen);
    closeAreaDialog();
    toast(`Showing stores for ${chosen}`);
  });

  // Keep the header label in step with the stored area, and refresh the page when it changes.
  onAreaChange(() => {
    renderAreaLabel();
    onChanged();
  });
  renderAreaLabel();
}

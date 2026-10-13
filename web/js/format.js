// Money is stored as integer kobo on the server. Formatting happens only here.
const naira = new Intl.NumberFormat('en-NG', {
  style: 'currency',
  currency: 'NGN',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function formatNaira(kobo) {
  if (!Number.isInteger(kobo)) return '—';
  return naira.format(kobo / 100);
}

export function formatCount(n, singular, plural = `${singular}s`) {
  return `${n} ${n === 1 ? singular : plural}`;
}

export const AVAILABILITY_LABEL = {
  in_stock: 'In stock',
  low_stock: 'Few left',
  out_of_stock: 'Unavailable',
  made_to_order: 'Made to order',
};

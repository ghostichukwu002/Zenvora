// WhatsApp number that receives orders, in international format without "+" (for example 2348012345678).
// Set this to the store's number. While it is empty, checkout falls back to the order page.
export const WHATSAPP_ORDER_NUMBER = '2348166505543';

const naira = (kobo) => `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export function whatsappOrderUrl(order, formatMoney = naira) {
  if (!WHATSAPP_ORDER_NUMBER) return null;
  const lines = [
    `Hello, I have placed order ${order.id}.`,
    '',
    ...order.items.map((item) => `• ${item.quantity} × ${item.name} — ${formatMoney(item.lineKobo)}`),
    '',
    `Subtotal: ${formatMoney(order.subtotalKobo)}`,
    `Delivery: ${formatMoney(order.deliveryFeeKobo)}`,
    `Total: ${formatMoney(order.totalKobo)} (cash on delivery)`,
    '',
    `Name: ${order.delivery.name}`,
    `Phone: ${order.delivery.phone}`,
    `Address: ${order.delivery.address}`,
  ];
  return `https://wa.me/${WHATSAPP_ORDER_NUMBER}?text=${encodeURIComponent(lines.join('\n'))}`;
}

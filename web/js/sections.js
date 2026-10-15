// The two storefronts. Shop n Delight is the main shop; Puff & Sip is its own section with its
// own shop and checkout. Each product knows its section through its merchant.

export function sectionOf(product) {
  return product?.merchant?.section === 'puff' ? 'puff' : 'shop';
}

export function productHref(id, section = 'shop') {
  const path = `product/${encodeURIComponent(id)}`;
  return section === 'puff' ? `#/puff-sip/${path}` : `#/${path}`;
}

export function shopHref(section = 'shop') {
  return section === 'puff' ? '#/puff-sip/shop' : '#/shop';
}

export function checkoutHref(section = 'shop') {
  return section === 'puff' ? '#/puff-sip/checkout' : '#/checkout';
}

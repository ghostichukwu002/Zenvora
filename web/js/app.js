// Entry point. Registers routes, wires the header, and starts the router.
// Each view is a separate module, so a view's code only matters once that view is opened.

import { initAreaDialog } from './area.js';
import { refresh, route, start } from './router.js';
import { loadCart } from './state.js';
import { renderCart } from './views/cart.js';
import { renderHome } from './views/home.js';
import { renderProduct } from './views/product.js';
import { renderShop } from './views/shop.js';

route('/', {
  nav: 'home',
  title: 'Everything you need, closer than ever',
  render: () => renderHome(),
});

route('/shop', {
  nav: 'shop',
  title: 'Shop',
  render: ({ query }) => renderShop({ query }),
});

route('/search', {
  nav: 'search',
  title: 'Search',
  render: ({ query }) => renderShop({ query }),
});

route('/product/:id', {
  nav: 'shop',
  title: 'Product',
  render: (ctx) => renderProduct(ctx),
});

route('/cart', {
  nav: 'cart',
  title: 'Your cart',
  render: () => renderCart(),
});

initAreaDialog(() => refresh());

// The cart badge fills in as soon as the cart is known. The page does not wait for it.
loadCart();
start();

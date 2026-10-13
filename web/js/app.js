// Entry point. Registers routes, wires the header, and starts the router.
// Each view is a separate module, so a view's code only matters once that view is opened.

import { initAreaDialog } from './area.js';
import { initMotion } from './motion.js';
import { initLoadingScreen } from './loading.js';
import { refresh, route, start } from './router.js';
import { ensureUser, loadCart } from './state.js';
import { renderAccount } from './views/account.js';
import { renderForgot, renderLogin, renderRegister, renderReset } from './views/auth.js';
import { renderCart } from './views/cart.js';
import { renderCheckout } from './views/checkout.js';
import { renderOrder } from './views/order.js';
import { renderHome } from './views/home.js';
import { renderProduct } from './views/product.js';
import { renderShop } from './views/shop.js';

initLoadingScreen();

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

route('/login', { nav: 'account', title: 'Log in', render: (ctx) => renderLogin(ctx) });
route('/register', { nav: 'account', title: 'Create account', render: (ctx) => renderRegister(ctx) });
route('/forgot-password', { nav: 'account', title: 'Reset password', render: () => renderForgot() });
route('/reset-password', { nav: 'account', title: 'New password', render: (ctx) => renderReset(ctx) });
route('/account', { nav: 'account', title: 'Your account', render: () => renderAccount() });
route('/checkout', { nav: 'cart', title: 'Checkout', render: () => renderCheckout() });
route('/order/:id', { nav: 'account', title: 'Order', render: (ctx) => renderOrder(ctx) });

initAreaDialog(() => refresh());
initMotion();

// The cart badge and account link fill in as soon as they are known. The page does not wait for them.
loadCart();
ensureUser();
start();

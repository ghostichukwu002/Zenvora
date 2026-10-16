import * as api from '../api.js';
import { el, linkButton } from '../dom.js';
import { formatNaira } from '../format.js';
import { productHref } from '../sections.js';
import { stateBox, toast } from '../ui.js';

// Account-owned shopping tools. All mutations are authenticated server requests.
export function customerToolsPanel() {
  const wishlistList = el('div', { 'aria-busy': 'true' }, el('p', { class: 'muted', text: 'Loading your wishlist…' }));
  const addressList = el('div', { 'aria-busy': 'true' }, el('p', { class: 'muted', text: 'Loading saved addresses…' }));
  const message = el('p', { class: 'form-message', role: 'status', hidden: true });
  const input = (name, label, required = true) => {
    const control = el('input', { class: 'input', name, required, maxlength: name === 'address' ? 300 : 100, autocomplete: name === 'recipientName' ? 'name' : name === 'phone' ? 'tel' : 'off' });
    return { control, node: el('div', { class: 'field' }, el('label', { for: 'saved-' + name, text: label }), control) };
  };
  const fields = {
    label: input('label', 'Address label (Home, Work)'),
    recipientName: input('recipientName', 'Recipient name'),
    phone: input('phone', 'Phone number'),
    address: input('address', 'Street address'),
    area: input('area', 'Delivery area / neighbourhood'),
    city: input('city', 'City'),
    state: input('state', 'State'),
  };
  for (const [name, f] of Object.entries(fields)) f.control.id = 'saved-' + name;
  fields.label.control.value = 'Home';
  const submit = el('button', { type: 'submit', class: 'btn btn--primary btn--small', text: 'Save address' });
  const addressForm = el('form', { class: 'form saved-address-form' }, ...Object.values(fields).map((f) => f.node), submit);

  addressForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      await api.post('/api/account/addresses', Object.fromEntries(Object.entries(fields).map(([key, f]) => [key, f.control.value])));
      addressForm.reset();
      fields.label.control.value = 'Home';
      toast('Delivery address saved');
      await loadAddresses();
    } catch (err) {
      message.hidden = false;
      message.textContent = err.message || 'Could not save that address.';
    } finally {
      submit.disabled = false;
    }
  });

  async function loadWishlist() {
    try {
      const { items } = await api.get('/api/account/wishlist');
      wishlistList.replaceChildren();
      if (!items.length) {
        wishlistList.append(stateBox({ title: 'Your wishlist is empty', body: 'Tap the heart on products you want to keep for later.', actions: [linkButton({ href: '#/shop', text: 'Explore products' })], iconName: 'heart' }));
      } else {
        wishlistList.append(el('ul', { class: 'saved-tool-list' }, items.map((product) => {
          const remove = el('button', { type: 'button', class: 'btn btn--secondary btn--small', text: 'Remove', onclick: async () => {
            remove.disabled = true;
            try { await api.del('/api/account/wishlist/' + encodeURIComponent(product.id)); await loadWishlist(); toast('Removed from wishlist'); }
            catch (err) { toast(err.message, { tone: 'error' }); remove.disabled = false; }
          }});
          return el('li', { class: 'saved-tool-row' },
            el('a', { href: productHref(product.id, product.merchant.section), class: 'saved-tool-row__copy' },
              el('strong', { text: product.name }),
              el('small', { class: 'muted', text: product.merchant.name }),
              el('span', { class: 'price', text: formatNaira(product.effectivePriceKobo) }),
            ), remove);
        })));
      }
    } catch (err) {
      wishlistList.replaceChildren(stateBox({ tone: 'error', title: 'Wishlist unavailable', body: err.message, actions: [linkButton({ text: 'Try again', variant: 'secondary', small: true, onClick: loadWishlist })] }));
    } finally { wishlistList.removeAttribute('aria-busy'); }
  }

  async function loadAddresses() {
    try {
      const { items } = await api.get('/api/account/addresses');
      addressList.replaceChildren();
      if (!items.length) {
        addressList.append(el('p', { class: 'muted', text: 'No saved addresses yet. Add one below to speed up future checkouts.' }));
      } else {
        addressList.append(el('ul', { class: 'saved-tool-list' }, items.map((address) => {
          const remove = el('button', { type: 'button', class: 'btn btn--secondary btn--small', text: 'Delete', onclick: async () => {
            remove.disabled = true;
            try { await api.del('/api/account/addresses/' + encodeURIComponent(address.id)); await loadAddresses(); toast('Address deleted'); }
            catch (err) { toast(err.message, { tone: 'error' }); remove.disabled = false; }
          }});
          return el('li', { class: 'saved-tool-row' },
            el('div', { class: 'saved-tool-row__copy' },
              el('strong', { text: address.label + ' · ' + address.recipientName }),
              el('small', { text: address.phone }),
              el('small', { text: address.address }),
              el('small', { class: 'muted', text: [address.area, address.city, address.state].join(', ') }),
            ), remove);
        })));
      }
    } catch (err) {
      addressList.replaceChildren(stateBox({ tone: 'error', title: 'Saved addresses unavailable', body: err.message, actions: [linkButton({ text: 'Try again', variant: 'secondary', small: true, onClick: loadAddresses })] }));
    } finally { addressList.removeAttribute('aria-busy'); }
  }

  loadWishlist();
  loadAddresses();
  return el('div', { class: 'customer-tools-grid' },
    el('section', { class: 'account-panel', 'aria-labelledby': 'wishlist-title' },
      el('div', { class: 'account-panel__head' }, el('div', {}, el('p', { class: 'account-kicker', text: 'SAVE FOR LATER' }), el('h2', { id: 'wishlist-title', text: 'Your wishlist' }))),
      wishlistList),
    el('section', { class: 'account-panel', 'aria-labelledby': 'addresses-title' },
      el('div', { class: 'account-panel__head' }, el('div', {}, el('p', { class: 'account-kicker', text: 'FASTER CHECKOUT' }), el('h2', { id: 'addresses-title', text: 'Saved addresses' }))),
      addressList, message, addressForm),
  );
}

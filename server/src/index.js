import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { categories, merchants, products } from './catalogue.js';

const port = Number.parseInt(process.env.PORT ?? '4000', 10);
const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

const server = createServer(
  createApp({ catalogue: { categories, merchants, products }, webRoot }),
);

server.listen(port, () => {
  console.log(`ZENVORA running at http://localhost:${port}`);
  console.log('Catalogue is SAMPLE data for development.');
});

// Close cleanly on Ctrl+C so the process does not hang.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

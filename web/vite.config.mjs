import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    host: true,
  },
  plugins: [
    {
      name: 'clean-urls-middleware',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const [pathname, search] = req.url.split('?');
          const query = search ? `?${search}` : '';

          if (pathname === '/admin') {
            req.url = `/admin.html${query}`;
          } else if (pathname === '/finance') {
            req.url = `/finance.html${query}`;
          } else if (pathname === '/partnership' || pathname === '/partnerships') {
            req.url = `/partnership.html${query}`;
          } else if (pathname === '/checkin' || pathname === '/kiosk') {
            req.url = `/checkin.html${query}`;
          }
          next();
        });
      },
    },
  ],
});

import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Two ways to reach the platform API, switched by VITE_API_BASE_URL:
 *
 *  - unset (default): calls go to the relative path `/api/...` and this dev
 *    server proxies them to VITE_PLATFORM_API_URL. Same-origin from the
 *    browser's point of view, so no CORS preflight is involved. Works against
 *    any platform-api build.
 *
 *  - set to an absolute origin (e.g. https://api.example.com/public): the
 *    browser calls the API directly, cross-origin. This is the real customer
 *    topology and requires the API to send CORS headers and to allow this
 *    page's origin on the embed key (ENG-3640).
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: Number(env.VITE_PORT || 5174),
      proxy: {
        '/api': {
          target: env.VITE_PLATFORM_API_URL || 'http://localhost:8811/public',
          changeOrigin: true,
          secure: false,
          // SSE streams outlive the default connect timeout.
          timeout: 0,
          configure: (proxy) => {
            // proxyReq fires before the response socket exists, so clear the
            // socket timeouts once the upstream actually starts responding.
            proxy.on('proxyRes', (proxyRes, req, res) => {
              res.setTimeout(0);
              proxyRes.socket?.setTimeout?.(0);
              req.socket?.setTimeout?.(0);
            });
          },
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  };
});

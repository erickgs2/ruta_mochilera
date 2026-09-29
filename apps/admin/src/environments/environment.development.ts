export const environment = {
  // Relative, not absolute: the dev server (apps/admin/proxy.conf.json)
  // proxies /api/** to `pnpm nx serve api` (localhost:3000) same-origin, so
  // the browser never makes a cross-origin request and there is no CORS
  // configuration to maintain on the API for local development. This also
  // matches production, where nginx serves both behind one origin (Task 19).
  apiBaseUrl: '',
};

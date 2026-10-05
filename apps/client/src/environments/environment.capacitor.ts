export const environment = {
  // The packaged app (`nx build client --configuration=capacitor` + `cap
  // sync`) has no "same origin" with the API at all -- it loads from
  // `capacitor://localhost` (iOS) / `https://localhost` (Android), a
  // different origin than wherever the API is actually deployed (see
  // `apps/client/capacitor.config.ts` and Task 15's finding). So, unlike
  // `environment.ts` (the plain web build), this one needs a real, absolute
  // API origin -- there is no same-origin Nginx to make it implicit.
  //
  // `CHANGE_ME`, not a guess: this repo has no deployed production domain
  // yet (`.env.prod.example`'s `APP_BASE_URL=https://CHANGE_ME` is the same
  // placeholder, for the same reason). Fill this in with the real API
  // origin before shipping a release build, and make sure that origin's
  // `CORS_ALLOWED_ORIGINS` (see `apps/api`'s env) actually includes
  // `capacitor://localhost` and `https://localhost` -- otherwise the app
  // can build and install perfectly and still be unable to log in.
  //
  // For building and running against this machine's own `pnpm nx dev api`
  // (e.g. on the iOS Simulator, which shares the host's network stack) use
  // the `capacitor-development` configuration instead
  // (`environment.capacitor.development.ts`), not this one.
  apiBaseUrl: 'https://CHANGE_ME',
};

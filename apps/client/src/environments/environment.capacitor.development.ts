export const environment = {
  // For running the packaged app against this machine's own `pnpm nx dev
  // api` (real PostgreSQL, real routes) -- used to build the app that runs
  // on the iOS Simulator for Task 15b's re-verification. The iOS Simulator
  // shares the host Mac's network stack, so `localhost` from inside the
  // Simulator really does reach a server listening on the host's
  // `localhost:3000`; this would need the host's actual LAN IP instead on a
  // physical device or the Android emulator (`10.0.2.2` there), neither of
  // which this verification used.
  //
  // `apps/api`'s `CORS_ALLOWED_ORIGINS` must include `capacitor://localhost`
  // (iOS) for this to work at all -- see `.env`.
  //
  // Plain `http://` needs no App Transport Security exception here: Task
  // 15b's Simulator run reached `http://localhost` with the committed
  // Info.plist (no `NSAppTransportSecurity` key at all). A physical device
  // pointed at the host's LAN IP would need one -- add it to a Debug-only
  // configuration then, never to the Info.plist a release build ships.
  apiBaseUrl: 'http://localhost:3000',
};

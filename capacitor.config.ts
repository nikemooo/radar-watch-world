import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor wrapper for the App Store build.
 *
 * The app is server-rendered, so the native shell loads the hosted site
 * instead of a static bundle. Point `server.url` at the production domain
 * before an App Store submission; use the preview URL for TestFlight betas.
 */
const config: CapacitorConfig = {
  appId: "app.lovable.radar",
  appName: "Radar",
  webDir: "dist",
  server: {
    url: "https://radar-watch-world.lovable.app",
    cleartext: false,
  },
  ios: {
    contentInset: "always",
    backgroundColor: "#14171b",
  },
};

export default config;

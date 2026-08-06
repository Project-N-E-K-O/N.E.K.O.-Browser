import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const here = import.meta.dirname;
const browserSkillPackage = JSON.parse(
  readFileSync(resolve(here, "vendor/browser-skill/apps/extension/package.json"), "utf8"),
) as { version: string };

export default defineConfig({
  resolve: {
    alias: {
      "@/lib/popup-bridge": resolve(here, "src/browser-skill/popup-bridge.ts"),
      "@": resolve(here, "vendor/browser-skill/apps/extension/src"),
      "@browser-skill/i18n/react": resolve(
        here,
        "vendor/browser-skill/packages/i18n/src/react.tsx",
      ),
      "@browser-skill/i18n": resolve(here, "vendor/browser-skill/packages/i18n/src/index.ts"),
      "@browser-skill/vom": resolve(here, "vendor/browser-skill/packages/vom/src/index.ts"),
    },
  },
  define: {
    __BSK_EXT_VERSION__: JSON.stringify(browserSkillPackage.version),
    __BSK_DAEMON_WS_URL__: JSON.stringify("ws://127.0.0.1:52800"),
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    clearMocks: true,
  },
});

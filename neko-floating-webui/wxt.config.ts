import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type ResolvedPublicFile } from "wxt";
import { adaptBrowserSkillVomCapture } from "./src/browser-skill/vom-adapter";
import { PROTOCOL_VERSION as browserSkillProtocolVersion } from "./vendor/browser-skill/apps/extension/src/transport/handshake";

const here = dirname(fileURLToPath(import.meta.url));
const browserSkillRoot = resolve(here, "vendor/browser-skill");
const browserSkillExtension = resolve(browserSkillRoot, "apps/extension");
const browserSkillPackage = JSON.parse(
  readFileSync(resolve(browserSkillExtension, "package.json"), "utf8"),
) as { version: string };
const manifestBase = JSON.parse(
  readFileSync(resolve(here, "src/manifest-base.json"), "utf8"),
);
const browserSkillDaemonUrl = process.env.BSK_DAEMON_WS_URL ?? "ws://127.0.0.1:52800";
const browserSkillProtocolPlaceholder = "__NEKO_BSK_PROTOCOL_VERSION__";
const browserSkillDaemonOrigin = (() => {
  const url = new URL(browserSkillDaemonUrl);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("BSK_DAEMON_WS_URL must use the ws: or wss: protocol");
  }
  return url.origin;
})();
const manifest = {
  ...manifestBase,
  content_security_policy: {
    ...manifestBase.content_security_policy,
    extension_pages: [
      "script-src 'self'",
      "object-src 'self'",
      `connect-src http: https: ${browserSkillDaemonOrigin}`,
      "frame-src http: https:",
    ].join("; ") + ";",
  },
};

const runtimeFiles = [
  "content.js",
  "embedded-surface-main-world.js",
  "embedded-surface.css",
  "floating-frame.css",
  "floating-frame.html",
  "floating-frame.js",
  "mic-permission.html",
  "mic-permission.js",
  "offscreen.html",
  "offscreen.js",
  "pcm-audio-worklet.js",
  "popup.css",
  "popup.html",
  "popup.js",
  "sidepanel.css",
  "sidepanel.html",
  "sidepanel.js",
  "transparent-main-world.js",
  "transparent-page.css",
  "transparent-page.js",
];

function addPublicDirectory(
  files: ResolvedPublicFile[],
  directory: string,
  outputRoot: string,
) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      addPublicDirectory(files, absolute, outputRoot);
      continue;
    }
    files.push({
      absoluteSrc: absolute,
      relativeDest: relative(outputRoot, absolute).split(sep).join("/"),
    });
  }
}

function readRuntimeFile(fileName: string): Buffer {
  const source = readFileSync(resolve(here, fileName));
  if (fileName !== "popup.js") {
    return source;
  }

  const popupSource = source.toString("utf8");
  if (!popupSource.includes(browserSkillProtocolPlaceholder)) {
    throw new Error("popup.js is missing the BrowserSkill protocol version placeholder");
  }
  return Buffer.from(
    popupSource.replaceAll(browserSkillProtocolPlaceholder, browserSkillProtocolVersion),
  );
}

export default defineConfig({
  // Use BrowserSkill's source directory as WXT's alias root so its existing
  // `@/...` imports stay intact, while keeping the actual entrypoints owned by
  // the N.E.K.O extension project.
  srcDir: "vendor/browser-skill/apps/extension/src",
  entrypointsDir: resolve(here, "src/entrypoints"),
  outDir: "dist",
  modules: ["@wxt-dev/module-react"],
  alias: {
    "@/content/ControlOverlay": resolve(here, "src/browser-skill/ui/ControlOverlay.tsx"),
    "@/content/HelpRequestOverlay": resolve(
      here,
      "src/browser-skill/ui/HelpRequestOverlay.tsx",
    ),
    "@browser-skill-upstream/content/HelpRequestOverlay": resolve(
      browserSkillExtension,
      "src/content/HelpRequestOverlay.tsx",
    ),
    "@/lib/popup-bridge": resolve(here, "src/browser-skill/popup-bridge.ts"),
    "@browser-skill/i18n/react": resolve(browserSkillRoot, "packages/i18n/src/react.tsx"),
    "@browser-skill/i18n": resolve(browserSkillRoot, "packages/i18n/src/index.ts"),
    "@browser-skill/vom": resolve(browserSkillRoot, "packages/vom/src/index.ts"),
  },
  manifest,
  hooks: {
    "build:publicAssets"(_wxt, files) {
      for (const fileName of runtimeFiles) {
        if (fileName === "popup.js") {
          files.push({
            relativeDest: fileName,
            contents: readRuntimeFile(fileName).toString("utf8"),
          });
        } else {
          files.push({
            absoluteSrc: resolve(here, fileName),
            relativeDest: fileName,
          });
        }
      }
      addPublicDirectory(files, resolve(here, "assets"), here);
      files.push(
        {
          absoluteSrc: resolve(browserSkillExtension, "assets/logo.png"),
          relativeDest: "icon/logo.png",
        },
        {
          absoluteSrc: resolve(here, "../THIRD_PARTY_NOTICES.md"),
          relativeDest: "THIRD_PARTY_NOTICES.md",
        },
      );
    },
  },
  vite: () => ({
    // BrowserSkill is a pinned source submodule. Its own generated .wxt
    // tsconfig is intentionally absent, so prevent Vite/Oxc from walking up
    // to that project-local config and use this app's aliases instead.
    plugins: [
      {
        name: "neko-browser-skill-generated-tsconfig",
        enforce: "pre",
        buildStart() {
          // The pinned submodule intentionally does not commit WXT's generated
          // directory. Vite 8 resolves its project tsconfig before transforming
          // source files, so provide the ignored generated base during builds.
          const generatedDir = resolve(browserSkillExtension, ".wxt");
          mkdirSync(generatedDir, { recursive: true });
          writeFileSync(
            resolve(generatedDir, "tsconfig.json"),
            JSON.stringify(
              {
                compilerOptions: {
                  target: "ESNext",
                  module: "ESNext",
                  moduleResolution: "Bundler",
                  jsx: "react-jsx",
                },
              },
              null,
              2,
            ),
          );
        },
      },
      tailwindcss(),
      {
        name: "neko-browser-skill-vom-adapter",
        enforce: "pre",
        transform(code, id) {
          const normalized = id.split("\\").join("/").split("?")[0];
          if (!normalized.endsWith("/vendor/browser-skill/apps/extension/src/tools/vom/capture.ts")) {
            return null;
          }
          return { code: adaptBrowserSkillVomCapture(code), map: null };
        },
      },
    ],
    define: {
      __BSK_EXT_VERSION__: JSON.stringify(browserSkillPackage.version),
      __BSK_DAEMON_WS_URL__: JSON.stringify(browserSkillDaemonUrl),
    },
    resolve: {
      dedupe: ["react", "react-dom"],
    },
  }),
});

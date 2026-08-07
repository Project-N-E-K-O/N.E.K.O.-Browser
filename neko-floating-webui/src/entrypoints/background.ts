import browserSkillBackground from "../../vendor/browser-skill/apps/extension/src/entrypoints/background";
import { initNekoBackground } from "../../background.js";
import { installBrowserSkillIntegration } from "../browser-skill/integration";

export default defineBackground(() => {
  installBrowserSkillIntegration();
  initNekoBackground();
  browserSkillBackground.main();
});

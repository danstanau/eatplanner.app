import { createApp } from "./app.js";
import { extractRecipe, findRecipeImage, generatePlan, getStatus, stopCopilot } from "./copilot.js";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const server = createApp({ extractRecipe, findRecipeImage, generatePlan, getStatus }).listen(port, "127.0.0.1", () => {
  console.log(`eatplanner.app is ready at http://127.0.0.1:${port}`);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  try {
    await stopCopilot();
  } catch (error) {
    console.error("[eatplanner.app] Shutdown failed:", error);
    process.exitCode = 1;
  }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

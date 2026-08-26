import { join } from "node:path";
import { publishModelsCacheFromFile } from "../src/models-cache.js";
import { redisCommandClient } from "../src/redis.js";

async function main() {
  if (process.env.COHUB_NODE_ORIGIN !== "local") {
    throw new Error("Local model cache sync requires COHUB_NODE_ORIGIN=local");
  }
  const platformConfigRoot = process.env.PLATFORM_CONFIG_ROOT?.trim();
  if (!platformConfigRoot) {
    throw new Error("Local model cache sync requires PLATFORM_CONFIG_ROOT");
  }

  const cached = await publishModelsCacheFromFile({
    modelsPath: join(platformConfigRoot, "platform", ".cohub", "models.json"),
    scope: "platform",
  });
  console.log(`Local model catalog cache synced: ${cached.rev}`);
}

main()
  .then(() => redisCommandClient.quit())
  .catch(async (error) => {
    console.error(error);
    await redisCommandClient.quit().catch(() => undefined);
    process.exit(1);
  });

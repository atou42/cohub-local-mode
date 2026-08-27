import { publishSkillsCacheFromDir } from "../src/skills-cache.js";
import { redisCommandClient } from "../src/redis.js";

async function main() {
  if (process.env.COHUB_NODE_ORIGIN !== "local") {
    throw new Error("Local skills cache sync requires COHUB_NODE_ORIGIN=local");
  }
  const skillsDir = process.env.LOCAL_AGENT_SKILLS_PATH?.trim();
  if (!skillsDir) {
    throw new Error("Local skills cache sync requires LOCAL_AGENT_SKILLS_PATH");
  }
  const cached = await publishSkillsCacheFromDir({
    skillsDir,
    sandboxDir: skillsDir,
    scope: "platform",
  });
  console.log(
    `Local skills cache synced: ${cached.content?.skills.length ?? 0} skills (${cached.rev})`,
  );
}

main()
  .then(() => redisCommandClient.quit())
  .catch(async (error) => {
    console.error(error);
    await redisCommandClient.quit().catch(() => undefined);
    process.exit(1);
  });

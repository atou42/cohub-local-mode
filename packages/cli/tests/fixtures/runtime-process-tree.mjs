import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const leafCode = `process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);`;
const branchCode = `const{spawn}=require('node:child_process');const leaf=spawn(process.execPath,['-e',${JSON.stringify(leafCode)}],{stdio:['ignore','ignore','ignore','ipc']});leaf.once('message',()=>{process.send({branch:process.pid,leaf:leaf.pid});leaf.disconnect();process.exit(0);});`;
const branch = spawn(process.execPath, ["-e", branchCode], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
const pids = await new Promise((resolve) => branch.once("message", resolve));
branch.disconnect();
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  process.stdout.write(`${JSON.stringify({ id: request.id, result: pids })}\n`);
}

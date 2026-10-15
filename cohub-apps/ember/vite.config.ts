import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { build as bundle } from "rolldown";
import { defineConfig, type Plugin } from "vite";

const spiritAction = (): Plugin => ({
  name: "ember-spirit-action",
  apply: "build",
  async closeBundle() {
    await bundle({
      input: resolve(import.meta.dirname, "spirit/spirit.ts"),
      platform: "node",
      external: [/^node:/, "@neta-art/cohub"],
      logLevel: "warn",
      output: {
        file: resolve(import.meta.dirname, "dist/.cohub/actions/spirit.js"),
        format: "esm",
        codeSplitting: false,
      },
    });
  },
});

export default defineConfig({
  base: "./",
  plugins: [svelte(), spiritAction()],
  build: {
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "pixi", test: /node_modules\/pixi\.js\// },
            { name: "cohub", test: /node_modules\/@neta-art\/cohub\// },
          ],
        },
      },
    },
  },
});

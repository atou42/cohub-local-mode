import { mountResourceApp } from "../../shared/src/mount";

mountResourceApp("checkpoint", () => import("./CheckpointView.svelte"));

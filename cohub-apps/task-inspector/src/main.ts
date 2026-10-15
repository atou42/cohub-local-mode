import { mountResourceApp } from "../../shared/src/mount";

mountResourceApp("task", () => import("./TaskView.svelte"));

import { mountResourceApp } from "../../shared/src/mount";

mountResourceApp("app", () => import("./AppView.svelte"));

import { db } from "../db.js";
import { createRuntimeContextReader } from "./context-reader.js";

export const loadRuntimeContext = createRuntimeContextReader(db);

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { compileModule } from "svelte/compiler";

test("model catalogs are not exposed to another harness, origin or user", async () => {
	const filename = fileURLToPath(new URL("../lib/stores/models-catalog.svelte.ts", import.meta.url));
	const source = await readFile(filename, "utf8");
	const javascript = ts.transpileModule(source, {
		compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
	}).outputText;
	const compiled = compileModule(javascript, { filename, generate: "client" });
	const modules: Record<string, string> = {
		"$lib/cache/keys": "export const getCacheUserKey=()=>globalThis.__cohubCatalogScopeTest.user;",
		"$lib/model-catalog": "export const isModelHidden=item=>item.model.hidden===true;",
		"$lib/sdk": "export const sdkForSpaceOrigin=()=>({models:{list:harness=>globalThis.__cohubCatalogScopeTest.request(harness)}});",
		"$lib/stores/models-catalog-cache": "export const MODEL_CATALOG_CACHE_REFRESH_AFTER_MS=300000;export const readCachedModelsCatalog=()=>null;export const writeCachedModelsCatalog=()=>{};",
	};
	const dataUrl = (text: string) => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
	const parsed = ts.createSourceFile("catalog.js", compiled.js.code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
	const rewritten = ts.factory.updateSourceFile(parsed, parsed.statements.map(statement => {
		if (!ts.isImportDeclaration(statement)) return statement;
		assert.ok(ts.isStringLiteral(statement.moduleSpecifier));
		const specifier = statement.moduleSpecifier.text;
		const url = modules[specifier] ? dataUrl(modules[specifier]) : import.meta.resolve(specifier);
		return ts.factory.updateImportDeclaration(statement, statement.modifiers, statement.importClause, ts.factory.createStringLiteral(url), statement.attributes);
	}));
	const host = globalThis as typeof globalThis & {
		__cohubCatalogScopeTest?: { user: string; request: (harness: string) => Promise<unknown> };
	};
	let resolveCodex!: (value: unknown) => void;
	host.__cohubCatalogScopeTest = {
		user: "user-a",
		request: harness => harness === "codex"
			? new Promise(resolve => { resolveCodex = resolve; })
			: Promise.resolve({ openai: [{ provider: "openai", id: "pi-model", model: {} }] }),
	};
	try {
		const { createModelsCatalogStore } = await import(dataUrl(ts.createPrinter().printFile(rewritten)));
		const store = createModelsCatalogStore();
		await store.load({ origin: "local", agentHarness: "pi" });
		assert.equal(store.visibleItemsFor("local", "pi").length, 1);
		assert.equal(store.visibleItemsFor("local", "codex"), null);
		const pending = store.load({ origin: "local", agentHarness: "codex" });
		assert.equal(store.visibleItemsFor("local", "pi"), null);
		assert.equal(store.visibleItemsFor("local", "codex"), null);
		resolveCodex({ codex: [{ provider: "codex", id: "codex-model", model: {} }] });
		await pending;
		assert.equal(store.visibleItemsFor("local", "codex")[0].id, "codex-model");
		assert.equal(store.visibleItemsFor("cloud", "codex"), null);
		host.__cohubCatalogScopeTest.user = "user-b";
		assert.equal(store.visibleItemsFor("local", "codex"), null);
	} finally {
		delete host.__cohubCatalogScopeTest;
	}
});

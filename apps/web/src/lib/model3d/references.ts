export type GltfJson = {
	extensionsUsed?: string[];
	buffers?: { uri?: string }[];
	images?: { uri?: string }[];
};

const GLB_MAGIC = 0x46546c67; // "glTF"
const GLB_JSON_CHUNK = 0x4e4f534a; // "JSON"

export function readGlbJson(bytes: Uint8Array): GltfJson | null {
	if (bytes.byteLength < 20) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(0, true) !== GLB_MAGIC) return null;
	const length = view.getUint32(12, true);
	if (view.getUint32(16, true) !== GLB_JSON_CHUNK) return null;
	if (20 + length > bytes.byteLength) return null;
	try {
		return JSON.parse(
			new TextDecoder().decode(bytes.subarray(20, 20 + length)),
		) as GltfJson;
	} catch {
		return null;
	}
}

const isEmbedded = (uri: string) => /^(data|blob):/i.test(uri);

export function gltfReferences(json: GltfJson): string[] {
	const uris = new Set<string>();
	for (const { uri } of [...(json.buffers ?? []), ...(json.images ?? [])]) {
		if (uri && !isEmbedded(uri)) uris.add(uri);
	}
	return [...uris];
}

export function objMaterialLibraries(source: string): string[] {
	const libraries = [...source.matchAll(/^[ \t]*mtllib[ \t]+(.+?)[ \t]*$/gm)]
		.map((match) => match[1] ?? "")
		.filter(Boolean);
	return [...new Set(libraries)];
}

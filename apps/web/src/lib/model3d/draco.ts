import {
	DRACO_GLTF_CONFIG,
	DRACOLoader,
} from "three/addons/loaders/DRACOLoader.js";

export function createDracoLoader() {
	return new DRACOLoader().setDecoderPath(DRACO_GLTF_CONFIG);
}

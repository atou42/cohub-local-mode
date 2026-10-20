import {
	Box3,
	type Material,
	Mesh,
	NeutralToneMapping,
	type Object3D,
	PMREMGenerator,
	Scene,
	SkinnedMesh,
	Sphere,
	type Texture,
	Vector3,
	WebGLRenderer,
} from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const FIT_PADDING = 0.15;
export const MODEL_FOV = 38;

const VIEW_DIRECTION = new Vector3(0.55, 0.38, 1).normalize();
const VIEW_RIGHT = new Vector3(0, 1, 0).cross(VIEW_DIRECTION).normalize();
const VIEW_UP = VIEW_DIRECTION.clone().cross(VIEW_RIGHT);

export const unitBounds = () =>
	new Box3(new Vector3(-0.5, -0.5, -0.5), new Vector3(0.5, 0.5, 0.5));

export function modelBounds(root: Object3D): Box3 {
	root.updateMatrixWorld(true);
	const box = new Box3().setFromObject(root);
	return box.isEmpty() || box.getSize(new Vector3()).lengthSq() === 0
		? unitBounds()
		: box;
}

export type ModelView = {
	center: Vector3;
	position: Vector3;
	distance: number;
};

/** Fits against the box corners rather than the bounding sphere. */
export function fitModelView(
	bounds: Box3,
	fov: number,
	aspect: number,
): ModelView {
	const tanY = Math.tan((fov * Math.PI) / 360) * (1 - FIT_PADDING);
	const tanX = tanY * aspect;
	const center = bounds.getCenter(new Vector3());
	const corner = new Vector3();
	let distance = 0;
	for (let index = 0; index < 8; index += 1) {
		corner
			.set(
				index & 1 ? bounds.max.x : bounds.min.x,
				index & 2 ? bounds.max.y : bounds.min.y,
				index & 4 ? bounds.max.z : bounds.min.z,
			)
			.sub(center);
		const depth = corner.dot(VIEW_DIRECTION);
		distance = Math.max(
			distance,
			depth + Math.abs(corner.dot(VIEW_RIGHT)) / tanX,
			depth + Math.abs(corner.dot(VIEW_UP)) / tanY,
		);
	}
	return {
		center,
		position: center.clone().addScaledVector(VIEW_DIRECTION, distance),
		distance,
	};
}

export function modelRadius(bounds: Box3): number {
	return bounds.getBoundingSphere(new Sphere()).radius;
}

export function createModelRenderer(
	canvas: HTMLCanvasElement | OffscreenCanvas,
	options: { preserveDrawingBuffer?: boolean } = {},
) {
	const renderer = new WebGLRenderer({
		canvas,
		antialias: true,
		alpha: true,
		powerPreference: "high-performance",
		...options,
	});
	renderer.setClearColor(0x000000, 0);
	renderer.toneMapping = NeutralToneMapping;
	return renderer;
}

export function createStudioScene(renderer: WebGLRenderer) {
	const scene = new Scene();
	const pmrem = new PMREMGenerator(renderer);
	const room = new RoomEnvironment();
	const environment = pmrem.fromScene(room, 0.04).texture;
	room.dispose();
	pmrem.dispose();
	scene.environment = environment;
	return {
		scene,
		dispose() {
			scene.environment = null;
			environment.dispose();
		},
	};
}

export function materialsOf(root: Object3D): Material[] {
	const materials = new Set<Material>();
	root.traverse((object) => {
		if (!(object instanceof Mesh)) return;
		for (const material of [object.material].flat()) materials.add(material);
	});
	return [...materials];
}

export function disposeModel(root: Object3D) {
	root.traverse((object) => {
		if (object instanceof Mesh) object.geometry.dispose();
		if (object instanceof SkinnedMesh) object.skeleton.dispose();
	});
	for (const material of materialsOf(root)) {
		for (const value of Object.values(material)) {
			if ((value as Texture | null)?.isTexture) (value as Texture).dispose();
		}
		material.dispose();
	}
}

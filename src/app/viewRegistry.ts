import type * as THREE from 'three';

/** Live handles to the 3D view, for tools that work from the current camera. */
export const viewRegistry = {
  camera: null as THREE.Camera | null,
  size: { width: 1, height: 1 },
  meshes: new Map<string, THREE.Object3D>(),
};

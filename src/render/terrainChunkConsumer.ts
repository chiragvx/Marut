/**
 * src/render/terrainChunkConsumer.ts
 *
 * Turns an ingested TerrainChunkReadyMessage into a THREE.BufferGeometry +
 * the shared terrain material; tracks chunks by (chunkX,chunkZ,lod) key for
 * eviction. 08-render.md section 4.5/4.5.1.
 */

import * as THREE from 'three';
import type { TerrainChunkReadyMessage, Vec3Like } from '../contracts/core';
import type { SceneEnvironment } from '../contracts/render';
import { applyTerrainEnvironment, createTerrainMaterial } from './terrainMaterial';
import { applySettlementLayer } from './townLayer';
import { applyUrbanLayer, setUrbanQuality } from './urbanLayer';
import type { SettlementLayer } from '../contracts/terrain';
import { CASTER_LAYER } from './sunShadows';

function chunkKey(chunkX: number, chunkZ: number, lod: number): string {
  return `${chunkX}:${chunkZ}:${lod}`;
}

interface ChunkEntry {
  group: THREE.Group;
  mesh: THREE.Mesh;
}

export interface TerrainChunkConsumer {
  ingestChunk(msg: TerrainChunkReadyMessage): void;
  evictChunk(chunkX: number, chunkZ: number, lod: number): void;
  setFog(fogStartM: number, fogEndM: number): void;
  /** Display colour the terrain fades to with distance; must match the sky horizon. */
  setFogColor(color: THREE.Color): void;
  setSunDirection(dirWorld: Readonly<Vec3Like>): void;
  setEnvironment(env: Readonly<SceneEnvironment>): void;
  setSettlements(layer: SettlementLayer | null): void;
  /** Urban layer: whether 3D buildings stand near the camera (else footprints are drawn as roofs there too). */
  setUrbanQuality(has3dBuildings: boolean): void;
  /** Seconds, for animated water. */
  setTime(sec: number): void;
  /** Whether terrain chunks cast into the sun shadow map (sunShadows.ts; High/Ultra). */
  setShadowsEnabled(enabled: boolean): void;
  /** Repositions every resident chunk's root group from its absolute origin, section 4.3. */
  updateOrigin(originWorld: Readonly<Vec3Like>): void;
  dispose(): void;
}

export function createTerrainChunkConsumer(root: THREE.Object3D): TerrainChunkConsumer {
  const material = createTerrainMaterial();
  const chunks = new Map<string, ChunkEntry>();
  let shadowsEnabled = false;

  return {
    ingestChunk(msg) {
      const key = chunkKey(msg.chunkX, msg.chunkZ, msg.lod);
      const existing = chunks.get(key);
      if (existing) {
        root.remove(existing.group);
        existing.mesh.geometry.dispose();
        chunks.delete(key);
      }

      const positions = new Float32Array(msg.positions);
      const normals = new Float32Array(msg.normals);
      const indices = new Uint32Array(msg.indices);

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));

      const mesh = new THREE.Mesh(geometry, material);
      if (shadowsEnabled) mesh.layers.enable(CASTER_LAYER);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();

      const group = new THREE.Group();
      group.add(mesh);
      root.add(group);
      chunks.set(key, { group, mesh });
    },

    evictChunk(chunkX, chunkZ, lod) {
      const key = chunkKey(chunkX, chunkZ, lod);
      const entry = chunks.get(key);
      if (!entry) return;
      root.remove(entry.group);
      entry.mesh.geometry.dispose();
      chunks.delete(key);
    },

    setFog(fogStartM, fogEndM) {
      material.uniforms['uFogStart']!.value = fogStartM;
      material.uniforms['uFogEnd']!.value = fogEndM;
    },

    setFogColor(color) {
      (material.uniforms['uFogColor']!.value as THREE.Color).copy(color);
    },

    setSunDirection(dirWorld) {
      (material.uniforms['uSunDir']!.value as THREE.Vector3).set(dirWorld.x, dirWorld.y, dirWorld.z);
    },

    setEnvironment(env) {
      applyTerrainEnvironment(material, env);
    },

    setSettlements(layer) {
      applySettlementLayer(material, layer);
      applyUrbanLayer(material, layer?.urban);
    },

    setUrbanQuality(has3dBuildings) {
      setUrbanQuality(material, has3dBuildings);
    },

    setTime(sec) {
      material.uniforms['uTime']!.value = sec;
    },

    setShadowsEnabled(enabled) {
      shadowsEnabled = enabled;
      for (const entry of chunks.values()) {
        if (enabled) entry.mesh.layers.enable(CASTER_LAYER);
        else entry.mesh.layers.disable(CASTER_LAYER);
      }
    },

    updateOrigin(originWorld) {
      for (const entry of chunks.values()) {
        entry.group.position.set(-originWorld.x, -originWorld.y, -originWorld.z);
        entry.group.updateMatrix();
      }
    },

    dispose() {
      for (const entry of chunks.values()) {
        root.remove(entry.group);
        entry.mesh.geometry.dispose();
      }
      chunks.clear();
      material.dispose();
    },
  };
}

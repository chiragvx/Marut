/**
 * src/render/terrainChunkConsumer.ts
 *
 * Turns an ingested TerrainChunkReadyMessage into a THREE.BufferGeometry +
 * the shared terrain material; tracks chunks by (chunkX,chunkZ,lod) key for
 * eviction. 08-render.md section 4.5/4.5.1.
 */

import * as THREE from 'three';
import type { TerrainChunkReadyMessage, Vec3Like } from '../contracts/core';

function chunkKey(chunkX: number, chunkZ: number, lod: number): string {
  return `${chunkX}:${chunkZ}:${lod}`;
}

/**
 * 08-render.md section 4.5.1 — one shared ShaderMaterial for ALL chunks at all LODs.
 *
 * TESTING MODE: flat solid `uGroundColor` instead of the altitude/slope-tinted gradient this
 * originally had. Requested so terrain reads as one clean, uniform reference surface while
 * verifying flight-model/collision fixes visually (a solid color makes any aircraft-vs-ground
 * clipping or mesh artifact far easier to spot at a glance than a gradient). Also a little
 * cheaper per-fragment (no altitude branch chain, no slope mix) — a minor, secondary win, not a
 * fix for the real load-time cost (that's CPU-side chunk generation, see the perf investigation).
 * To restore the original altitude/slope coloring later, see git history for this file.
 */
export function createTerrainMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uFogColor: { value: new THREE.Color(0xbcd4e8) },
      uGroundColor: { value: new THREE.Color(0x4a6b3a) },
      uFogStart: { value: 1500 },
      uFogEnd: { value: 5000 },
    },
    vertexShader: `
      varying vec3 vViewPos;
      void main() {
        vec4 viewPos4 = modelViewMatrix * vec4(position, 1.0);
        vViewPos = viewPos4.xyz;
        gl_Position = projectionMatrix * viewPos4;
      }
    `,
    fragmentShader: `
      uniform vec3 uFogColor;
      uniform vec3 uGroundColor;
      uniform float uFogStart;
      uniform float uFogEnd;
      varying vec3 vViewPos;
      void main() {
        float fogT = clamp((length(vViewPos) - uFogStart) / max(uFogEnd - uFogStart, 1.0), 0.0, 1.0);
        gl_FragColor = vec4(mix(uGroundColor, uFogColor, fogT), 1.0);
      }
    `,
  });
}

interface ChunkEntry {
  group: THREE.Group;
  mesh: THREE.Mesh;
}

export interface TerrainChunkConsumer {
  ingestChunk(msg: TerrainChunkReadyMessage): void;
  evictChunk(chunkX: number, chunkZ: number, lod: number): void;
  setFog(fogStartM: number, fogEndM: number): void;
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
      mesh.receiveShadow = shadowsEnabled;
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

    setShadowsEnabled(enabled) {
      shadowsEnabled = enabled;
      for (const entry of chunks.values()) entry.mesh.receiveShadow = enabled;
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

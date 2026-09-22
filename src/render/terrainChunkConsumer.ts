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

/** 08-render.md section 4.5.1 — one shared ShaderMaterial for ALL chunks at all LODs. */
export function createTerrainMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uFogColor: { value: new THREE.Color(0xbcd4e8) },
      uFogStart: { value: 1500 },
      uFogEnd: { value: 5000 },
    },
    vertexShader: `
      varying float vAltitudeM;
      varying float vSlope;
      varying vec3 vViewPos;
      void main() {
        vAltitudeM = position.y;
        vSlope = 1.0 - dot(normalize(normal), vec3(0.0, 1.0, 0.0));
        vec4 viewPos4 = modelViewMatrix * vec4(position, 1.0);
        vViewPos = viewPos4.xyz;
        gl_Position = projectionMatrix * viewPos4;
      }
    `,
    fragmentShader: `
      uniform vec3 uFogColor;
      uniform float uFogStart;
      uniform float uFogEnd;
      varying float vAltitudeM;
      varying float vSlope;
      varying vec3 vViewPos;
      vec3 altitudeColor(float altM) {
        if (altM < 0.0)    return vec3(0.76, 0.70, 0.50);
        if (altM < 200.0)  return mix(vec3(0.20,0.45,0.15), vec3(0.35,0.55,0.20), altM/200.0);
        if (altM < 1200.0) return mix(vec3(0.35,0.55,0.20), vec3(0.45,0.40,0.30), (altM-200.0)/1000.0);
        return mix(vec3(0.45,0.40,0.30), vec3(0.95,0.95,0.97), clamp((altM-1200.0)/800.0, 0.0, 1.0));
      }
      void main() {
        vec3 base = mix(altitudeColor(vAltitudeM), vec3(0.5, 0.47, 0.45), clamp(vSlope*1.6, 0.0, 1.0));
        float fogT = clamp((length(vViewPos) - uFogStart) / max(uFogEnd - uFogStart, 1.0), 0.0, 1.0);
        gl_FragColor = vec4(mix(base, uFogColor, fogT), 1.0);
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

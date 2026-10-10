// Flat terrain for the sandbox: a grid of tiles with the biome's ground texture.
// (Height editing, biome painting and water come later.)

export const TILE = 3; // world units per grid tile, measured from fence segment lengths

export function buildTerrain(tilesX, tilesY, textureRepeatTiles = 2) {
  const w = tilesX * TILE, h = tilesY * TILE;
  const nx = tilesX, ny = tilesY;
  const positions = new Float32Array((nx + 1) * (ny + 1) * 3);
  const normals = new Float32Array((nx + 1) * (ny + 1) * 3);
  const uvs = new Float32Array((nx + 1) * (ny + 1) * 2);
  let p = 0, q = 0;
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = (i / nx) * w, y = (j / ny) * h;
      positions[p] = x; positions[p + 1] = y; positions[p + 2] = 0;
      normals[p + 2] = 1;
      p += 3;
      uvs[q++] = x / (TILE * textureRepeatTiles);
      uvs[q++] = y / (TILE * textureRepeatTiles);
    }
  }
  const indices = new Uint32Array(nx * ny * 6);
  let k = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      indices[k++] = a; indices[k++] = b; indices[k++] = d;
      indices[k++] = a; indices[k++] = d; indices[k++] = c;
    }
  }
  return {
    width: w,
    height: h,
    model: {
      meshes: [{
        positions, normals, uvs, colors: null, indices,
        texture: 'ground', textureWrap: true,
        material: { diffuse: [1, 1, 1], ambient: [1, 1, 1], emissive: [0, 0, 0], alpha: 1 },
        alphaBlend: false, alphaTest: false, alphaThreshold: 0, grid: 0,
      }],
      bounds: { min: [0, 0, 0], max: [w, h, 0] },
    },
  };
}

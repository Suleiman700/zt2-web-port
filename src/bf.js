// Parser and sampler for Blue Fang .bf skeletal animations (reverse engineered from the game files).
//
// File layout (little endian):
//   u32 version (2), f32 duration (seconds), u8 boneCount, u8, u8, u8 flags
//   boneCount x bone record:
//     char name[32], u16 channelCount, u16 pad, u32 recordSize (from name start), u32 unknown,
//     channelCount x channel: u16 type, u16 keyCount, u32 channelSize (incl. this 8-byte header), keys
//   optional trailer with named time markers ("start", "end", ...)
// Key times are u16 milliseconds. Channel types:
//   14: rotation, linear     [t, x, y, z, w] s16 / 10000
//   12: rotation, TBC        [t, x, y, z, w, tension, bias, continuity]
//    2: position, linear     [t, x, y, z] s16 / 1000 (millimetres)
//    1: position, bezier     [t, x, y, z, inX, inY, inZ, outX, outY, outZ]
//  6/7/8: X/Y/Z euler angle  [t, value, inTangent, outTangent] s16 / 1000 (radians)
//  3, 4, 16, 17: scale/visibility tracks (not used yet)

const td = new TextDecoder('latin1');

export function parseBF(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint32(0, true);
  const duration = dv.getFloat32(4, true);
  const boneCount = bytes[8];
  const flags = bytes[11];
  const bones = [];
  let p = 12;
  for (let b = 0; b < boneCount && p + 44 <= bytes.length; b++) {
    const nameBytes = bytes.subarray(p, p + 32);
    const end = nameBytes.indexOf(0);
    const name = td.decode(end >= 0 ? nameBytes.subarray(0, end) : nameBytes);
    const channelCount = dv.getUint16(p + 32, true);
    const recordSize = dv.getUint32(p + 36, true);
    const bone = { name, rotation: null, position: null, euler: [null, null, null] };
    let q = p + 44;
    for (let c = 0; c < channelCount; c++) {
      const type = dv.getUint16(q, true);
      const count = dv.getUint16(q + 2, true);
      const size = dv.getUint32(q + 4, true);
      const keySize = count ? (size - 8) / count : 0;
      const k0 = q + 8;
      const s16 = (k, i) => dv.getInt16(k0 + k * keySize + i * 2, true);
      const time = (k) => dv.getUint16(k0 + k * keySize, true) / 1000;
      if (type === 14 || type === 12) {
        const times = new Float32Array(count), values = new Float32Array(count * 4);
        for (let k = 0; k < count; k++) {
          times[k] = time(k);
          for (let i = 0; i < 4; i++) values[k * 4 + i] = s16(k, 1 + i) / 10000;
        }
        bone.rotation = { times, values };
      } else if (type === 2 || type === 1) {
        const times = new Float32Array(count), values = new Float32Array(count * 3);
        for (let k = 0; k < count; k++) {
          times[k] = time(k);
          for (let i = 0; i < 3; i++) values[k * 3 + i] = s16(k, 1 + i) / 1000;
        }
        bone.position = { times, values };
      } else if (type >= 6 && type <= 8) {
        const times = new Float32Array(count), values = new Float32Array(count);
        for (let k = 0; k < count; k++) { times[k] = time(k); values[k] = s16(k, 1) / 1000; }
        bone.euler[type - 6] = { times, values };
      }
      q += size;
    }
    bones.push(bone);
    p += recordSize;
  }
  return { version, duration, flags, bones };
}

// Finds the key interval for time t. Returns [index, fraction].
function locate(times, t) {
  const n = times.length;
  if (n === 1 || t <= times[0]) return [0, 0];
  if (t >= times[n - 1]) return [n - 1, 0];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
  return [lo, (t - times[lo]) / (times[hi] - times[lo])];
}

export function sampleRotation(track, t, out) {
  const [i, f] = locate(track.times, t);
  const v = track.values;
  const a = i * 4;
  if (f === 0) { out[0] = v[a]; out[1] = v[a + 1]; out[2] = v[a + 2]; out[3] = v[a + 3]; return out; }
  const b = a + 4;
  // Normalized lerp along the shortest path (close to slerp at 30 keys per second).
  const sign = v[a] * v[b] + v[a + 1] * v[b + 1] + v[a + 2] * v[b + 2] + v[a + 3] * v[b + 3] < 0 ? -1 : 1;
  for (let k = 0; k < 4; k++) out[k] = v[a + k] * (1 - f) + sign * v[b + k] * f;
  const l = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
  for (let k = 0; k < 4; k++) out[k] /= l;
  return out;
}

export function samplePosition(track, t, out) {
  const [i, f] = locate(track.times, t);
  const v = track.values, a = i * 3;
  if (f === 0) { out[0] = v[a]; out[1] = v[a + 1]; out[2] = v[a + 2]; return out; }
  for (let k = 0; k < 3; k++) out[k] = v[a + k] * (1 - f) + v[a + 3 + k] * f;
  return out;
}

export function sampleScalar(track, t) {
  const [i, f] = locate(track.times, t);
  const v = track.values;
  return f === 0 ? v[i] : v[i] * (1 - f) + v[i + 1] * f;
}

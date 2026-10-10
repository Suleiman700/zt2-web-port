// Orbit camera around a target point on a Z-up world. Also turns screen points into world rays.
import { mat4 } from './math.js';

export class Camera {
  constructor() {
    this.target = [0, 0, 0];
    this.yaw = -0.8;
    this.pitch = 0.6;
    this.distance = 40;
    // Vertical field of view of the original overhead camera (world/cameras/overheadcam.xml:
    // frustum up/down 0.48 at unit distance); the width follows the screen, as with the
    // widescreen patch (zWidescreen.z2f widens left/right only).
    this.fov = 2 * Math.atan(0.48);
    this.minDistance = 0.5;
    this.maxDistance = 400;
    this.minPitch = -1.5;
    this.maxPitch = 1.5;
  }

  eye() {
    const { target: t, distance: d, yaw, pitch } = this;
    return [t[0] + d * Math.cos(pitch) * Math.cos(yaw), t[1] + d * Math.cos(pitch) * Math.sin(yaw), t[2] + d * Math.sin(pitch)];
  }

  viewProj(aspect) {
    const proj = mat4.perspective(this.fov, aspect, Math.max(0.05, this.distance * 0.01), this.distance * 20 + 500);
    return mat4.multiply(proj, mat4.lookAt(this.eye(), this.target, [0, 0, 1]));
  }

  // Rotation and projection only, for things drawn around the eye (the sky).
  skyViewProj(aspect) {
    const eye = this.eye();
    const proj = mat4.perspective(this.fov, aspect, 0.1, 200);
    return mat4.multiply(proj, mat4.lookAt([0, 0, 0], sub(this.target, eye), [0, 0, 1]));
  }

  // Ray from normalized device coordinates (-1..1).
  ray(ndcX, ndcY, aspect) {
    const eye = this.eye();
    const f = norm(sub(this.target, eye));
    const r = norm(cross(f, [0, 0, 1]));
    const u = cross(r, f);
    const t = Math.tan(this.fov / 2);
    const dir = norm([0, 1, 2].map((i) => f[i] + r[i] * ndcX * t * aspect + u[i] * ndcY * t));
    return { origin: eye, dir };
  }

  orbit(dYaw, dPitch) {
    this.yaw += dYaw;
    this.pitch = Math.max(this.minPitch, Math.min(this.maxPitch, this.pitch + dPitch));
  }

  zoom(factor) {
    this.distance = Math.max(this.minDistance, Math.min(this.maxDistance, this.distance * factor));
  }

  // Pan along the ground plane, in screen-relative directions.
  pan(right, forward) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    // Camera looks toward -(cos yaw, sin yaw); screen-right is (-sin yaw, cos yaw).
    this.target[0] += -s * right - c * forward;
    this.target[1] += c * right - s * forward;
  }
}

// Intersects a ray with the horizontal plane z = height. Returns the hit point or null.
export function rayPlane(ray, height = 0) {
  if (Math.abs(ray.dir[2]) < 1e-6) return null;
  const t = (height - ray.origin[2]) / ray.dir[2];
  if (t < 0) return null;
  return [ray.origin[0] + ray.dir[0] * t, ray.origin[1] + ray.dir[1] * t, height];
}

// Distance along the ray to a sphere, or Infinity.
export function raySphere(ray, center, radius) {
  const oc = sub(ray.origin, center);
  const b = dot(oc, ray.dir), c = dot(oc, oc) - radius * radius;
  const h = b * b - c;
  if (h < 0) return Infinity;
  const t = -b - Math.sqrt(h);
  return t >= 0 ? t : Infinity;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

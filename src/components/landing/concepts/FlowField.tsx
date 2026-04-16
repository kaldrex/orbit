"use client";

import { useRef, useMemo, useEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";

const PARTICLE_COUNT = 600;

/* ─── Flow field attractor positions (network clusters) ─── */
const ATTRACTORS = [
  { x: 0, y: 0, strength: 0.8, radius: 1.5 },     // center — you
  { x: -2, y: 1.2, strength: 0.4, radius: 1.0 },
  { x: 1.8, y: 1.5, strength: 0.35, radius: 0.9 },
  { x: 2.2, y: -0.5, strength: 0.3, radius: 0.8 },
  { x: -1.2, y: -1.5, strength: 0.25, radius: 0.7 },
  { x: 0.5, y: -2, strength: 0.2, radius: 0.6 },
];

function Particles() {
  const pointsRef = useRef<THREE.Points>(null);

  const { positions, velocities, lifetimes, maxLifetimes } = useMemo(() => {
    const pos = new Float32Array(PARTICLE_COUNT * 3);
    const vel = new Float32Array(PARTICLE_COUNT * 3);
    const life = new Float32Array(PARTICLE_COUNT);
    const maxLife = new Float32Array(PARTICLE_COUNT);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 8;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 6;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 2;
      vel[i * 3] = 0;
      vel[i * 3 + 1] = 0;
      vel[i * 3 + 2] = 0;
      life[i] = Math.random() * 200;
      maxLife[i] = 150 + Math.random() * 100;
    }
    return { positions: pos, velocities: vel, lifetimes: life, maxLifetimes: maxLife };
  }, []);

  const colorsArr = useMemo(() => {
    const col = new Float32Array(PARTICLE_COUNT * 3);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      col[i * 3] = 0.7 + Math.random() * 0.3;
      col[i * 3 + 1] = 0.7 + Math.random() * 0.3;
      col[i * 3 + 2] = 0.8 + Math.random() * 0.2;
    }
    return col;
  }, []);

  useFrame(() => {
    if (!pointsRef.current) return;
    const posAttr = pointsRef.current.geometry.attributes.position;
    const arr = posAttr.array as Float32Array;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const ix = i * 3, iy = i * 3 + 1, iz = i * 3 + 2;

      // Compute flow field force from attractors
      let fx = 0, fy = 0;
      for (const a of ATTRACTORS) {
        const dx = a.x - arr[ix];
        const dy = a.y - arr[iy];
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.1;
        if (dist < a.radius * 2) {
          // Spiral toward attractor (tangential + radial)
          const force = a.strength / (dist * dist + 0.5);
          fx += dx * force * 0.3 + (-dy) * force * 0.7;
          fy += dy * force * 0.3 + dx * force * 0.7;
        }
      }

      // Add subtle curl noise
      const nx = arr[ix] * 0.5, ny = arr[iy] * 0.5;
      fx += Math.sin(ny * 2.5 + nx) * 0.002;
      fy += Math.cos(nx * 2.5 - ny) * 0.002;

      // Update velocity (damped)
      velocities[ix] = velocities[ix] * 0.96 + fx * 0.01;
      velocities[iy] = velocities[iy] * 0.96 + fy * 0.01;

      // Update position
      arr[ix] += velocities[ix];
      arr[iy] += velocities[iy];

      // Lifetime
      lifetimes[i]++;
      if (lifetimes[i] > maxLifetimes[i] || Math.abs(arr[ix]) > 5 || Math.abs(arr[iy]) > 4) {
        // Respawn at random edge
        const edge = Math.random() * 4;
        if (edge < 1) { arr[ix] = -5; arr[iy] = (Math.random() - 0.5) * 6; }
        else if (edge < 2) { arr[ix] = 5; arr[iy] = (Math.random() - 0.5) * 6; }
        else if (edge < 3) { arr[iy] = -4; arr[ix] = (Math.random() - 0.5) * 8; }
        else { arr[iy] = 4; arr[ix] = (Math.random() - 0.5) * 8; }
        arr[iz] = (Math.random() - 0.5) * 2;
        velocities[ix] = 0;
        velocities[iy] = 0;
        lifetimes[i] = 0;
        maxLifetimes[i] = 150 + Math.random() * 100;
      }
    }
    posAttr.needsUpdate = true;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={PARTICLE_COUNT} array={positions} itemSize={3} />
        <bufferAttribute attach="attributes-color" count={PARTICLE_COUNT} array={colorsArr} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial
        vertexColors
        transparent
        opacity={0.4}
        size={0.02}
        sizeAttenuation
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

/* ─── Subtle attractor markers ─── */
function AttractorMarkers() {
  return (
    <group>
      {ATTRACTORS.map((a, i) => (
        <mesh key={i} position={[a.x, a.y, 0]}>
          <ringGeometry args={[a.radius * 0.8, a.radius * 0.8 + 0.005, 64]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.02} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}

function CameraRig() {
  const { camera } = useThree();
  const mouse = useRef({ x: 0, y: 0 });
  const smooth = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const h = (e: MouseEvent) => {
      mouse.current.x = (e.clientX / window.innerWidth - 0.5) * 2;
      mouse.current.y = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener("mousemove", h);
    return () => window.removeEventListener("mousemove", h);
  }, []);
  useFrame(() => {
    smooth.current.x += (mouse.current.x * 0.2 - smooth.current.x) * 0.01;
    smooth.current.y += (mouse.current.y * 0.1 - smooth.current.y) * 0.01;
    camera.position.x = smooth.current.x;
    camera.position.y = smooth.current.y;
    camera.lookAt(0, 0, 0);
  });
  return null;
}

export default function FlowField() {
  return (
    <div className="absolute inset-0 w-full h-full">
      <Canvas
        camera={{ position: [0, 0, 5], fov: 50 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: true }}
        style={{ background: "transparent" }}
      >
        <CameraRig />
        <Particles />
        <AttractorMarkers />
        <EffectComposer>
          <Bloom luminanceThreshold={0.7} intensity={0.4} radius={0.5} />
        </EffectComposer>
      </Canvas>
    </div>
  );
}

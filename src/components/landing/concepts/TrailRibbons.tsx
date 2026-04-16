"use client";

import { useRef, Suspense } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Float, Trail, Stars, Environment } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";

/* ─── A node that orbits and leaves a trail ─── */
function TrailNode({
  radius,
  speed,
  tilt,
  color,
  size,
  yOffset,
  phase,
  trailWidth,
  trailLength,
}: {
  radius: number;
  speed: number;
  tilt: number;
  color: string;
  size: number;
  yOffset: number;
  phase: number;
  trailWidth: number;
  trailLength: number;
}) {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (meshRef.current) {
      const t = clock.getElapsedTime() * speed + phase;
      meshRef.current.position.x = Math.cos(t) * radius;
      meshRef.current.position.z = Math.sin(t) * radius;
      meshRef.current.position.y = yOffset + Math.sin(t * 1.5) * 0.3;
    }
  });

  return (
    <group rotation={[tilt, 0, tilt * 0.3]}>
      <Trail
        width={trailWidth}
        length={trailLength}
        color={new THREE.Color(color)}
        attenuation={(t: number) => t * t}
      >
        <mesh ref={meshRef}>
          <sphereGeometry args={[size, 16, 16]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={0.5}
            metalness={0.8}
            roughness={0.2}
          />
        </mesh>
      </Trail>
    </group>
  );
}

/* ─── Center "You" node ─── */
function CenterNode() {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (ref.current) {
      const s = 1 + Math.sin(clock.getElapsedTime() * 0.5) * 0.05;
      ref.current.scale.setScalar(s);
    }
  });

  return (
    <Float speed={1} floatIntensity={0.2}>
      <mesh ref={ref}>
        <sphereGeometry args={[0.12, 32, 32]} />
        <meshStandardMaterial
          color="#ffffff"
          emissive="#ffffff"
          emissiveIntensity={0.8}
          metalness={0.9}
          roughness={0.1}
        />
      </mesh>
    </Float>
  );
}

export default function TrailRibbons() {
  return (
    <div className="absolute inset-0 w-full h-full">
      <Canvas
        camera={{ position: [0, 1.5, 5], fov: 50 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: true }}
        style={{ background: "transparent" }}
      >
        <ambientLight intensity={0.15} />
        <pointLight position={[5, 5, 5]} intensity={0.5} />
        <Stars radius={40} depth={30} count={1000} factor={2} fade speed={0.3} />
        <CenterNode />
        {/* Inner orbit — fast, bright trails */}
        <TrailNode radius={1.2} speed={0.5} tilt={0.2} color="#3b82f6" size={0.05} yOffset={0} phase={0} trailWidth={3} trailLength={8} />
        <TrailNode radius={1.3} speed={0.45} tilt={-0.3} color="#22c55e" size={0.04} yOffset={0.1} phase={2} trailWidth={2.5} trailLength={7} />
        <TrailNode radius={1.1} speed={0.55} tilt={0.5} color="#f97316" size={0.045} yOffset={-0.1} phase={4} trailWidth={2.5} trailLength={7} />
        {/* Mid orbit */}
        <TrailNode radius={2.0} speed={0.3} tilt={-0.15} color="#8b5cf6" size={0.04} yOffset={0.2} phase={1} trailWidth={2} trailLength={10} />
        <TrailNode radius={2.2} speed={0.25} tilt={0.4} color="#ec4899" size={0.035} yOffset={-0.2} phase={3} trailWidth={2} trailLength={9} />
        <TrailNode radius={1.8} speed={0.35} tilt={-0.5} color="#06b6d4" size={0.04} yOffset={0} phase={5} trailWidth={2} trailLength={8} />
        {/* Outer orbit — slow, faint */}
        <TrailNode radius={3.0} speed={0.15} tilt={0.1} color="#64748b" size={0.025} yOffset={0.3} phase={0.5} trailWidth={1} trailLength={12} />
        <TrailNode radius={3.2} speed={0.12} tilt={-0.2} color="#475569" size={0.02} yOffset={-0.3} phase={2.5} trailWidth={1} trailLength={10} />
        <Suspense fallback={null}>
          <Environment preset="night" />
        </Suspense>
        <EffectComposer>
          <Bloom luminanceThreshold={0.4} intensity={0.6} radius={0.5} mipmapBlur />
          <Vignette eskil={false} offset={0.1} darkness={0.5} />
        </EffectComposer>
      </Canvas>
    </div>
  );
}

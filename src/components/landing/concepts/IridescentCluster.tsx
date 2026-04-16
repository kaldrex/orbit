"use client";

import { useRef, Suspense } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Float, MeshDistortMaterial, MeshTransmissionMaterial, Sparkles, Environment, ContactShadows } from "@react-three/drei";
import { EffectComposer, Bloom, ChromaticAberration, Vignette } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import * as THREE from "three";

function GlassSphere({
  position,
  scale,
  color,
  floatSpeed,
  floatIntensity,
  distort,
  speed,
}: {
  position: [number, number, number];
  scale: number;
  color: string;
  floatSpeed: number;
  floatIntensity: number;
  distort: number;
  speed: number;
}) {
  const ref = useRef<THREE.Mesh>(null);

  return (
    <Float speed={floatSpeed} rotationIntensity={0.2} floatIntensity={floatIntensity}>
      <mesh ref={ref} position={position} scale={scale}>
        <sphereGeometry args={[1, 64, 64]} />
        <MeshDistortMaterial
          color={color}
          roughness={0.05}
          metalness={0.85}
          distort={distort}
          speed={speed}
          envMapIntensity={2}
          transparent
          opacity={0.85}
        />
      </mesh>
    </Float>
  );
}

function GlassOrb({
  position,
  scale,
  floatSpeed,
}: {
  position: [number, number, number];
  scale: number;
  floatSpeed: number;
}) {
  return (
    <Float speed={floatSpeed} rotationIntensity={0.15} floatIntensity={0.4}>
      <mesh position={position} scale={scale}>
        <sphereGeometry args={[1, 64, 64]} />
        <meshPhysicalMaterial
          color="#ffffff"
          transmission={0.95}
          roughness={0}
          metalness={0}
          ior={1.5}
          thickness={0.5}
          envMapIntensity={1.5}
          transparent
          opacity={0.4}
        />
      </mesh>
    </Float>
  );
}

export default function IridescentCluster() {
  return (
    <div className="absolute inset-0 w-full h-full">
      <Canvas
        camera={{ position: [0, 0.5, 6], fov: 45 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: true }}
        style={{ background: "transparent" }}
      >
        <ambientLight intensity={0.2} />
        <directionalLight position={[5, 5, 3]} intensity={0.6} color="#aaccff" />
        <directionalLight position={[-3, 2, -2]} intensity={0.3} color="#ffaacc" />

        {/* Main cluster */}
        <GlassSphere position={[0.8, 0.5, 0]} scale={1.6} color="#2563eb" floatSpeed={1.5} floatIntensity={0.6} distort={0.3} speed={2} />
        <GlassSphere position={[-1.2, -0.3, -0.8]} scale={1.1} color="#7c3aed" floatSpeed={2} floatIntensity={0.4} distort={0.25} speed={2.5} />
        <GlassSphere position={[2.2, -0.5, -1]} scale={0.8} color="#0891b2" floatSpeed={1.8} floatIntensity={0.5} distort={0.2} speed={3} />
        <GlassSphere position={[-0.3, 1.5, -0.5]} scale={0.6} color="#059669" floatSpeed={2.5} floatIntensity={0.3} distort={0.35} speed={2} />
        <GlassSphere position={[1.8, 1.2, -1.5]} scale={0.5} color="#db2777" floatSpeed={2.2} floatIntensity={0.4} distort={0.2} speed={3.5} />

        {/* Glass overlay orbs for refraction */}
        <GlassOrb position={[-0.5, 0.8, 1]} scale={0.7} floatSpeed={1.2} />
        <GlassOrb position={[1.5, -0.3, 0.8]} scale={0.5} floatSpeed={1.8} />

        <Sparkles count={60} scale={8} size={2} speed={0.2} opacity={0.12} color="#8888ff" />

        <Suspense fallback={null}>
          <Environment preset="sunset" />
        </Suspense>

        <EffectComposer>
          <Bloom luminanceThreshold={0.5} intensity={0.5} radius={0.6} mipmapBlur />
          <ChromaticAberration offset={new THREE.Vector2(0.001, 0.001)} blendFunction={BlendFunction.NORMAL} />
          <Vignette eskil={false} offset={0.1} darkness={0.6} />
        </EffectComposer>
      </Canvas>
    </div>
  );
}

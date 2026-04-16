"use client";

import { useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Float, MeshDistortMaterial, Environment, Sparkles } from "@react-three/drei";
import { EffectComposer, Bloom, ChromaticAberration, Vignette } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import * as THREE from "three";

function Orb() {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (meshRef.current) {
      meshRef.current.rotation.x = clock.getElapsedTime() * 0.05;
      meshRef.current.rotation.z = clock.getElapsedTime() * 0.03;
    }
  });

  return (
    <Float speed={1.5} rotationIntensity={0.3} floatIntensity={0.8}>
      <mesh ref={meshRef} scale={2.2} position={[1.2, 0.3, 0]}>
        <sphereGeometry args={[1, 64, 64]} />
        <MeshDistortMaterial
          color="#1a6fff"
          roughness={0.1}
          metalness={0.8}
          distort={0.35}
          speed={1.8}
          envMapIntensity={1.5}
        />
      </mesh>
    </Float>
  );
}

function SecondaryOrb() {
  return (
    <Float speed={2} rotationIntensity={0.2} floatIntensity={0.5}>
      <mesh scale={0.8} position={[-2, -0.8, -1.5]}>
        <sphereGeometry args={[1, 32, 32]} />
        <MeshDistortMaterial
          color="#7c3aed"
          roughness={0.15}
          metalness={0.7}
          distort={0.25}
          speed={2.5}
          transparent
          opacity={0.6}
          envMapIntensity={1}
        />
      </mesh>
    </Float>
  );
}

export default function LiquidGlassOrb() {
  return (
    <div className="absolute inset-0 w-full h-full">
      <Canvas
        camera={{ position: [0, 0, 5], fov: 50 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: true }}
        style={{ background: "transparent" }}
      >
        <ambientLight intensity={0.3} />
        <directionalLight position={[5, 5, 5]} intensity={0.5} />
        <Orb />
        <SecondaryOrb />
        <Sparkles count={80} scale={8} size={1.5} speed={0.3} opacity={0.15} color="#4488ff" />
        <Environment preset="city" />
        <EffectComposer>
          <Bloom luminanceThreshold={0.6} intensity={0.4} radius={0.5} mipmapBlur />
          <ChromaticAberration offset={new THREE.Vector2(0.0008, 0.0008)} blendFunction={BlendFunction.NORMAL} />
          <Vignette eskil={false} offset={0.1} darkness={0.6} />
        </EffectComposer>
      </Canvas>
    </div>
  );
}

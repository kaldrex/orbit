"use client";

import { useRef, Suspense, useEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Float, MeshDistortMaterial, Environment, Sparkles, Stars } from "@react-three/drei";
import * as THREE from "three";

/*
  FIXES APPLIED:
  1. IcosahedronGeometry detail=0 (raw 20-face, sharp edges, no subdivision)
  2. All Y positions aligned: shape at 0, camera at 0, lookAt at 0
  3. Float: rotation only, no position drift (floatIntensity=0)
  4. MeshDistortMaterial distort very low on core, keeps faceted look
  5. Scale 1.8 — visible but not clipping
*/

function HeroGeometry() {
  const groupRef = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (groupRef.current) {
      groupRef.current.rotation.y = t * 0.08;
      groupRef.current.rotation.x = Math.sin(t * 0.05) * 0.08 + 0.12;
    }
  });

  return (
    // Float: rotation only, NO position drift
    <Float speed={0.8} rotationIntensity={0.03} floatIntensity={0}>
      <group ref={groupRef} position={[0, 0, 0]} scale={1.8}>
        {/* Dark reflective core — detail=0 for SHARP icosahedron faces */}
        <mesh>
          <icosahedronGeometry args={[1, 0]} />
          <MeshDistortMaterial
            color="#0d1424"
            roughness={0.15}
            metalness={0.9}
            distort={0.03}
            speed={1}
            envMapIntensity={1.2}
          />
        </mesh>
        {/* Blue wireframe — detail=0, sharp edges */}
        <mesh>
          <icosahedronGeometry args={[1.005, 0]} />
          <meshBasicMaterial color="#3b82f6" wireframe transparent opacity={0.3} />
        </mesh>
        {/* Cyan outer wireframe — slight distort for subtle life */}
        <mesh>
          <icosahedronGeometry args={[1.08, 0]} />
          <MeshDistortMaterial
            color="#06b6d4"
            wireframe
            transparent
            opacity={0.08}
            distort={0.05}
            speed={1.5}
          />
        </mesh>
        {/* Purple faint outer shell */}
        <mesh>
          <icosahedronGeometry args={[1.2, 0]} />
          <MeshDistortMaterial
            color="#7c3aed"
            wireframe
            transparent
            opacity={0.04}
            distort={0.06}
            speed={1.2}
          />
        </mesh>
        {/* Vertex dots at icosahedron vertices (detail=0 = 12 vertices) */}
        {[
          [0, 1, 0], [0, -1, 0],
          [0.894, 0.447, 0], [-0.894, 0.447, 0],
          [0.894, -0.447, 0], [-0.894, -0.447, 0],
          [0.276, 0.447, 0.851], [-0.276, 0.447, -0.851],
          [0.276, -0.447, -0.851], [-0.276, -0.447, 0.851],
          [0.724, 0.447, -0.526], [-0.724, -0.447, 0.526],
        ].map((pos, i) => (
          <mesh key={i} position={pos as [number, number, number]} scale={0.015}>
            <sphereGeometry args={[1, 8, 8]} />
            <meshBasicMaterial color="#60a5fa" transparent opacity={0.5} />
          </mesh>
        ))}
      </group>
    </Float>
  );
}

function CameraRig() {
  const { camera } = useThree();
  const mouse = useRef({ x: 0, y: 0 });
  const smooth = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      mouse.current.x = (e.clientX / window.innerWidth - 0.5) * 2;
      mouse.current.y = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener("mousemove", handler);
    return () => window.removeEventListener("mousemove", handler);
  }, []);

  useFrame(() => {
    smooth.current.x += (mouse.current.x * 0.4 - smooth.current.x) * 0.008;
    smooth.current.y += (mouse.current.y * 0.2 - smooth.current.y) * 0.008;
    // Camera centered at origin, only parallax shifts it
    camera.position.x = smooth.current.x;
    camera.position.y = smooth.current.y;
    camera.position.z = 5;
    camera.lookAt(0, 0, 0);
  });

  return null;
}

export default function ConstellationScene() {
  return (
    <div className="absolute inset-0 w-full h-full">
      <Canvas
        camera={{ position: [0, 0, 5], fov: 50 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: true }}
        style={{ background: "transparent" }}
      >
        <CameraRig />
        <ambientLight intensity={0.15} />
        <directionalLight position={[5, 5, 3]} intensity={0.6} color="#4488ff" />
        <directionalLight position={[-4, 3, -2]} intensity={0.3} color="#8844ff" />
        <pointLight position={[0, -3, 2]} intensity={0.2} color="#0ea5e9" />
        <Stars radius={60} depth={40} count={2500} factor={3} fade speed={0.4} />
        <HeroGeometry />
        <Sparkles count={100} scale={20} size={1.5} speed={0.15} opacity={0.12} color="#5577bb" />
        <Suspense fallback={null}>
          <Environment preset="city" />
        </Suspense>
      </Canvas>
    </div>
  );
}

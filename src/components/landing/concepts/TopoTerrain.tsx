"use client";

import { useRef, useMemo, useEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";

/* ─── Heightmap terrain from network density ─── */
function Terrain() {
  const meshRef = useRef<THREE.Mesh>(null);

  const { geometry, wireGeo } = useMemo(() => {
    const size = 80;
    const geo = new THREE.PlaneGeometry(10, 10, size, size);
    const pos = geo.attributes.position;

    // Generate peaks at "cluster" locations
    const peaks = [
      { x: 0, y: 0, h: 0.8, r: 1.5 },    // center — you
      { x: -2, y: 1.5, h: 0.5, r: 1.2 },  // cluster
      { x: 1.8, y: -1, h: 0.4, r: 1.0 },
      { x: -1, y: -2, h: 0.3, r: 0.9 },
      { x: 2.5, y: 1.5, h: 0.35, r: 1.1 },
      { x: -2.5, y: -0.5, h: 0.2, r: 0.8 },
    ];

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      let z = 0;
      for (const peak of peaks) {
        const dist = Math.sqrt((x - peak.x) ** 2 + (y - peak.y) ** 2);
        z += peak.h * Math.exp(-(dist * dist) / (peak.r * peak.r));
      }
      // Subtle noise
      z += Math.sin(x * 3) * Math.cos(y * 2.5) * 0.02;
      pos.setZ(i, z);
    }
    geo.computeVertexNormals();

    // Wireframe copy
    const wire = geo.clone();
    return { geometry: geo, wireGeo: wire };
  }, []);

  useFrame(({ clock }) => {
    if (meshRef.current) {
      meshRef.current.rotation.z = Math.sin(clock.getElapsedTime() * 0.1) * 0.02;
    }
  });

  return (
    <group ref={meshRef} rotation={[-Math.PI * 0.45, 0, 0.1]} position={[0, -0.5, 0]}>
      {/* Solid dark surface */}
      <mesh geometry={geometry}>
        <meshBasicMaterial color="#0c0c10" side={THREE.DoubleSide} />
      </mesh>
      {/* Contour wireframe */}
      <mesh geometry={wireGeo} position={[0, 0, 0.002]}>
        <meshBasicMaterial
          color="#00f0ff"
          wireframe
          transparent
          opacity={0.06}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {/* Peak labels */}
      {[
        [0, 0, 0.85],
        [-2, 1.5, 0.55],
        [1.8, -1, 0.45],
      ].map((p, i) => (
        <mesh key={i} position={[p[0], p[1], p[2] + 0.05]}>
          <sphereGeometry args={[0.03, 8, 8]} />
          <meshBasicMaterial color={i === 0 ? "#ffffff" : "#00f0ff"} />
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
    smooth.current.x += (mouse.current.x * 0.4 - smooth.current.x) * 0.01;
    smooth.current.y += (mouse.current.y * 0.2 - smooth.current.y) * 0.01;
    camera.position.x = smooth.current.x;
    camera.position.y = 3 + smooth.current.y;
    camera.lookAt(0, 0, 0);
  });
  return null;
}

export default function TopoTerrain() {
  return (
    <div className="absolute inset-0 w-full h-full">
      <Canvas
        camera={{ position: [0, 3, 4.5], fov: 50 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: true }}
        style={{ background: "transparent" }}
      >
        <CameraRig />
        <Terrain />
        <EffectComposer>
          <Bloom luminanceThreshold={0.85} intensity={0.25} radius={0.3} />
        </EffectComposer>
      </Canvas>
    </div>
  );
}

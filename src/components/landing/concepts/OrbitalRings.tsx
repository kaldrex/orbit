"use client";

import { useRef, useMemo, useEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";

/* ─── A single orbital ring with contacts on it ─── */
function Ring({ radius, speed, tilt, contacts }: {
  radius: number;
  speed: number;
  tilt: number;
  contacts: { angle: number; color: string; size: number }[];
}) {
  const groupRef = useRef<THREE.Group>(null);

  // Ring line
  const ringGeo = useMemo(() => {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
    }
    return new THREE.BufferGeometry().setFromPoints(points);
  }, [radius]);

  useFrame(({ clock }) => {
    if (groupRef.current) {
      groupRef.current.rotation.y = clock.getElapsedTime() * speed;
    }
  });

  return (
    <group rotation={[tilt, 0, tilt * 0.3]}>
      <group ref={groupRef}>
        {/* Ring line */}
        <line geometry={ringGeo}>
          <lineBasicMaterial color="#ffffff" transparent opacity={0.04} depthWrite={false} />
        </line>
        {/* Contacts on ring */}
        {contacts.map((c, i) => {
          const x = Math.cos(c.angle) * radius;
          const z = Math.sin(c.angle) * radius;
          return (
            <mesh key={i} position={[x, 0, z]}>
              <sphereGeometry args={[c.size, 12, 12]} />
              <meshBasicMaterial color={c.color} />
            </mesh>
          );
        })}
      </group>
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
    smooth.current.x += (mouse.current.x * 0.3 - smooth.current.x) * 0.01;
    smooth.current.y += (mouse.current.y * 0.15 - smooth.current.y) * 0.01;
    camera.position.x = smooth.current.x;
    camera.position.y = 2.5 + smooth.current.y;
    camera.lookAt(0, 0, 0);
  });
  return null;
}

export default function OrbitalRings() {
  return (
    <div className="absolute inset-0 w-full h-full">
      <Canvas
        camera={{ position: [0, 2.5, 5], fov: 50 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: true }}
        style={{ background: "transparent" }}
      >
        <CameraRig />
        {/* Center: You */}
        <mesh position={[0, 0, 0]}>
          <sphereGeometry args={[0.04, 16, 16]} />
          <meshBasicMaterial color="#ffffff" />
        </mesh>
        {/* Inner ring — close contacts */}
        <Ring radius={1.2} speed={0.08} tilt={0.15} contacts={[
          { angle: 0, color: "#3b82f6", size: 0.025 },
          { angle: 1.8, color: "#22c55e", size: 0.02 },
          { angle: 3.5, color: "#f97316", size: 0.025 },
          { angle: 5.2, color: "#ec4899", size: 0.02 },
        ]} />
        {/* Mid ring */}
        <Ring radius={2.0} speed={0.05} tilt={-0.1} contacts={[
          { angle: 0.5, color: "#8b5cf6", size: 0.018 },
          { angle: 2.0, color: "#06b6d4", size: 0.015 },
          { angle: 3.8, color: "#eab308", size: 0.018 },
          { angle: 5.5, color: "#14b8a6", size: 0.015 },
        ]} />
        {/* Outer ring — weak connections */}
        <Ring radius={3.0} speed={0.12} tilt={0.2} contacts={[
          { angle: 1.0, color: "#64748b", size: 0.01 },
          { angle: 2.8, color: "#475569", size: 0.008 },
          { angle: 4.5, color: "#64748b", size: 0.01 },
        ]} />
        <EffectComposer>
          <Bloom luminanceThreshold={0.85} intensity={0.3} radius={0.4} />
        </EffectComposer>
      </Canvas>
    </div>
  );
}

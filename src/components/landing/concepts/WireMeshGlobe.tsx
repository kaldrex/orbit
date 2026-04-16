"use client";

import { useRef, useMemo, useEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";

/* ─── Wireframe sphere with contact points ─── */
function Globe() {
  const groupRef = useRef<THREE.Group>(null);
  const wireRef = useRef<THREE.Mesh>(null);

  // Contact positions on sphere surface
  const contacts = useMemo(() => {
    const pts: { pos: THREE.Vector3; color: string; size: number }[] = [];
    const colors = ["#3b82f6", "#22c55e", "#f97316", "#ec4899", "#8b5cf6", "#06b6d4", "#eab308", "#14b8a6"];
    // Place contacts at specific lat/long for visual balance
    const positions = [
      [0.3, 0.8], [1.2, 0.5], [2.0, 1.0], [2.8, 0.3],
      [0.8, -0.6], [1.5, -0.8], [2.5, -0.3], [3.5, 0.6],
      [4.0, -0.5], [4.8, 0.2], [5.3, -0.7], [0.5, -0.2],
    ];
    const r = 2;
    positions.forEach((p, i) => {
      const theta = p[0];
      const phi = Math.acos(p[1] / 1.2);
      pts.push({
        pos: new THREE.Vector3(
          r * Math.sin(phi) * Math.cos(theta),
          r * Math.cos(phi),
          r * Math.sin(phi) * Math.sin(theta),
        ),
        color: colors[i % colors.length],
        size: 0.015 + Math.random() * 0.01,
      });
    });
    return pts;
  }, []);

  // Connection lines between nearby contacts
  const connectionGeos = useMemo(() => {
    const geos: THREE.BufferGeometry[] = [];
    for (let i = 0; i < contacts.length; i++) {
      for (let j = i + 1; j < contacts.length; j++) {
        if (contacts[i].pos.distanceTo(contacts[j].pos) < 2.5) {
          // Arc on sphere surface
          const points: THREE.Vector3[] = [];
          for (let t = 0; t <= 20; t++) {
            const p = new THREE.Vector3().lerpVectors(contacts[i].pos, contacts[j].pos, t / 20);
            p.normalize().multiplyScalar(2.02); // slightly above surface
            points.push(p);
          }
          geos.push(new THREE.BufferGeometry().setFromPoints(points));
        }
      }
    }
    return geos;
  }, [contacts]);

  useFrame(({ clock }) => {
    if (groupRef.current) {
      groupRef.current.rotation.y = clock.getElapsedTime() * 0.06;
    }
  });

  return (
    <group ref={groupRef}>
      {/* Wireframe sphere */}
      <mesh ref={wireRef}>
        <sphereGeometry args={[2, 32, 24]} />
        <meshBasicMaterial color="#ffffff" wireframe transparent opacity={0.025} depthWrite={false} />
      </mesh>
      {/* Solid dark inner sphere for backface occlusion */}
      <mesh>
        <sphereGeometry args={[1.98, 32, 24]} />
        <meshBasicMaterial color="#0a0a0c" />
      </mesh>
      {/* Contact points */}
      {contacts.map((c, i) => (
        <mesh key={i} position={c.pos}>
          <sphereGeometry args={[c.size, 10, 10]} />
          <meshBasicMaterial color={c.color} />
        </mesh>
      ))}
      {/* Connection arcs */}
      {connectionGeos.map((geo, i) => (
        <line key={`conn-${i}`} geometry={geo}>
          <lineBasicMaterial color="#ffffff" transparent opacity={0.03} depthWrite={false} />
        </line>
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
    smooth.current.x += (mouse.current.x * 0.3 - smooth.current.x) * 0.01;
    smooth.current.y += (mouse.current.y * 0.15 - smooth.current.y) * 0.01;
    camera.position.x = smooth.current.x + 0.5;
    camera.position.y = 0.8 + smooth.current.y;
    camera.lookAt(0, 0, 0);
  });
  return null;
}

export default function WireMeshGlobe() {
  return (
    <div className="absolute inset-0 w-full h-full">
      <Canvas
        camera={{ position: [0.5, 0.8, 4.5], fov: 50 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: true }}
        style={{ background: "transparent" }}
      >
        <CameraRig />
        <Globe />
        <EffectComposer>
          <Bloom luminanceThreshold={0.85} intensity={0.25} radius={0.3} />
        </EffectComposer>
      </Canvas>
    </div>
  );
}

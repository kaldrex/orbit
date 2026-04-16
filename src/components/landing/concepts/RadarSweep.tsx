"use client";

import { useRef, useMemo, useEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";

const CONTACTS = [
  { angle: 0.4, dist: 0.8, color: "#3b82f6", size: 0.02 },
  { angle: 1.2, dist: 1.2, color: "#22c55e", size: 0.018 },
  { angle: 2.1, dist: 0.6, color: "#f97316", size: 0.022 },
  { angle: 2.8, dist: 1.5, color: "#ec4899", size: 0.015 },
  { angle: 3.5, dist: 0.9, color: "#8b5cf6", size: 0.02 },
  { angle: 4.2, dist: 1.8, color: "#06b6d4", size: 0.012 },
  { angle: 4.9, dist: 1.1, color: "#eab308", size: 0.018 },
  { angle: 5.5, dist: 2.0, color: "#14b8a6", size: 0.01 },
  { angle: 0.9, dist: 2.2, color: "#64748b", size: 0.008 },
  { angle: 1.8, dist: 2.5, color: "#475569", size: 0.007 },
  { angle: 3.1, dist: 2.3, color: "#475569", size: 0.007 },
  { angle: 5.0, dist: 0.4, color: "#ffffff", size: 0.015 },
];

/* ─── Range rings ─── */
function RangeRings() {
  const rings = useMemo(() => {
    return [0.8, 1.4, 2.0, 2.6].map((r) => {
      const points: THREE.Vector3[] = [];
      for (let i = 0; i <= 128; i++) {
        const a = (i / 128) * Math.PI * 2;
        points.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0));
      }
      return new THREE.BufferGeometry().setFromPoints(points);
    });
  }, []);

  return (
    <group>
      {rings.map((geo, i) => (
        <line key={i} geometry={geo}>
          <lineBasicMaterial color="#ffffff" transparent opacity={0.03} depthWrite={false} />
        </line>
      ))}
      {/* Cross hairs */}
      {[0, Math.PI / 2, Math.PI, Math.PI * 1.5].map((a, i) => {
        const geo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(Math.cos(a) * 2.8, Math.sin(a) * 2.8, 0),
        ]);
        return (
          <line key={`ch-${i}`} geometry={geo}>
            <lineBasicMaterial color="#ffffff" transparent opacity={0.02} depthWrite={false} />
          </line>
        );
      })}
    </group>
  );
}

/* ─── Sweep beam ─── */
function SweepBeam() {
  const meshRef = useRef<THREE.Mesh>(null);

  const geo = useMemo(() => {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    const sweepAngle = 0.4; // radians wide
    for (let i = 0; i <= 32; i++) {
      const a = (i / 32) * sweepAngle;
      shape.lineTo(Math.cos(a) * 3, Math.sin(a) * 3);
    }
    shape.lineTo(0, 0);
    return new THREE.ShapeGeometry(shape);
  }, []);

  useFrame(({ clock }) => {
    if (meshRef.current) {
      meshRef.current.rotation.z = -clock.getElapsedTime() * 0.4;
    }
  });

  return (
    <mesh ref={meshRef} geometry={geo}>
      <meshBasicMaterial
        color="#22c55e"
        transparent
        opacity={0.04}
        depthWrite={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

/* ─── Contact blips that brighten when swept ─── */
function Blips() {
  const refs = useRef<(THREE.Mesh | null)[]>([]);

  useFrame(({ clock }) => {
    const sweepAngle = (-clock.getElapsedTime() * 0.4) % (Math.PI * 2);
    refs.current.forEach((mesh, i) => {
      if (!mesh) return;
      const c = CONTACTS[i];
      let angleDiff = ((c.angle - sweepAngle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      // Fade: bright right after sweep, then fade over ~3 seconds
      const fade = angleDiff < 0.5 ? 1 : Math.max(0, 1 - (angleDiff - 0.5) / 4);
      (mesh.material as THREE.MeshBasicMaterial).opacity = 0.1 + fade * 0.9;
    });
  });

  return (
    <group>
      {CONTACTS.map((c, i) => (
        <mesh
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          position={[Math.cos(c.angle) * c.dist, Math.sin(c.angle) * c.dist, 0.01]}
        >
          <sphereGeometry args={[c.size, 10, 10]} />
          <meshBasicMaterial color={c.color} transparent opacity={0.5} />
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

export default function RadarSweep() {
  return (
    <div className="absolute inset-0 w-full h-full">
      <Canvas
        camera={{ position: [0, 0, 5], fov: 50 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: true }}
        style={{ background: "transparent" }}
      >
        <CameraRig />
        <RangeRings />
        <SweepBeam />
        <Blips />
        {/* Center dot */}
        <mesh position={[0, 0, 0.01]}>
          <sphereGeometry args={[0.03, 12, 12]} />
          <meshBasicMaterial color="#ffffff" />
        </mesh>
        <EffectComposer>
          <Bloom luminanceThreshold={0.8} intensity={0.3} radius={0.3} />
        </EffectComposer>
      </Canvas>
    </div>
  );
}

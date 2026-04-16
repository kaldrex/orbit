"use client";

import { useRef, Suspense, useEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Float, MeshDistortMaterial, Stars, Line, Environment } from "@react-three/drei";
import { EffectComposer, Bloom, ChromaticAberration, Vignette } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import * as THREE from "three";

/* ─── Network nodes positioned in 3D space ─── */
const NETWORK_NODES = [
  { pos: [0, 0, -8] as const, color: "#ffffff", size: 0.15, isCenter: true },
  { pos: [-1.5, 1, -10] as const, color: "#3b82f6", size: 0.08 },
  { pos: [1.8, 0.5, -11] as const, color: "#22c55e", size: 0.07 },
  { pos: [-0.5, -1.2, -12] as const, color: "#f97316", size: 0.08 },
  { pos: [1, 1.5, -13] as const, color: "#8b5cf6", size: 0.06 },
  { pos: [-2, -0.5, -14] as const, color: "#06b6d4", size: 0.07 },
  { pos: [2.5, -0.8, -15] as const, color: "#ec4899", size: 0.06 },
  { pos: [-1, 2, -16] as const, color: "#eab308", size: 0.05 },
  { pos: [0.5, -2, -17] as const, color: "#14b8a6", size: 0.05 },
];

const CONNECTIONS: [number, number][] = [
  [0, 1], [0, 2], [0, 3], [1, 4], [2, 5], [3, 6], [4, 7], [5, 8], [1, 2], [3, 5],
];

function NetworkNode({ pos, color, size, isCenter }: {
  pos: readonly [number, number, number];
  color: string;
  size: number;
  isCenter?: boolean;
}) {
  return (
    <Float speed={1.5} rotationIntensity={0.1} floatIntensity={0.3}>
      <mesh position={[pos[0], pos[1], pos[2]]}>
        <sphereGeometry args={[size, isCenter ? 32 : 16, isCenter ? 32 : 16]} />
        {isCenter ? (
          <MeshDistortMaterial
            color={color}
            metalness={0.9}
            roughness={0.1}
            distort={0.2}
            speed={2}
            envMapIntensity={2}
          />
        ) : (
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={0.3}
            metalness={0.8}
            roughness={0.2}
          />
        )}
      </mesh>
    </Float>
  );
}

function Connections() {
  return (
    <group>
      {CONNECTIONS.map(([a, b], i) => {
        const start = NETWORK_NODES[a].pos;
        const end = NETWORK_NODES[b].pos;
        const mid: [number, number, number] = [
          (start[0] + end[0]) / 2 + (Math.random() - 0.5) * 0.5,
          (start[1] + end[1]) / 2 + (Math.random() - 0.5) * 0.5,
          (start[2] + end[2]) / 2,
        ];
        return (
          <Line
            key={i}
            points={[[...start], mid, [...end]]}
            color="#334466"
            lineWidth={0.5}
            transparent
            opacity={0.2}
          />
        );
      })}
    </group>
  );
}

/* ─── Scroll-driven camera ─── */
function ScrollCamera() {
  const { camera } = useThree();
  const scrollRef = useRef(0);
  const mouse = useRef({ x: 0, y: 0 });
  const smooth = useRef({ x: 0, y: 0, scroll: 0 });

  useEffect(() => {
    const handleScroll = () => {
      scrollRef.current = window.scrollY / (document.body.scrollHeight - window.innerHeight);
    };
    const handleMouse = (e: MouseEvent) => {
      mouse.current.x = (e.clientX / window.innerWidth - 0.5) * 2;
      mouse.current.y = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener("scroll", handleScroll);
    window.addEventListener("mousemove", handleMouse);
    return () => {
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("mousemove", handleMouse);
    };
  }, []);

  useFrame(() => {
    smooth.current.scroll += (scrollRef.current - smooth.current.scroll) * 0.05;
    smooth.current.x += (mouse.current.x * 0.3 - smooth.current.x) * 0.01;
    smooth.current.y += (mouse.current.y * 0.15 - smooth.current.y) * 0.01;

    // Fly from z=5 to z=-15 based on scroll
    const z = 5 - smooth.current.scroll * 20;
    camera.position.set(
      smooth.current.x,
      smooth.current.y,
      z,
    );
    camera.lookAt(0, 0, z - 5);
  });

  return null;
}

export default function ScrollFlythrough() {
  return (
    <div className="absolute inset-0 w-full h-full">
      <Canvas
        camera={{ position: [0, 0, 5], fov: 55 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: true }}
        style={{ background: "transparent" }}
      >
        <ScrollCamera />
        <ambientLight intensity={0.15} />
        <pointLight position={[3, 3, 3]} intensity={0.4} color="#aaccff" />
        <Stars radius={50} depth={50} count={2000} factor={3} fade speed={0.3} />
        {NETWORK_NODES.map((node, i) => (
          <NetworkNode key={i} {...node} />
        ))}
        <Connections />
        <Suspense fallback={null}>
          <Environment preset="night" />
        </Suspense>
        <EffectComposer>
          <Bloom luminanceThreshold={0.5} intensity={0.5} radius={0.4} mipmapBlur />
          <ChromaticAberration offset={new THREE.Vector2(0.0005, 0.0005)} blendFunction={BlendFunction.NORMAL} />
          <Vignette eskil={false} offset={0.15} darkness={0.7} />
        </EffectComposer>
      </Canvas>
    </div>
  );
}

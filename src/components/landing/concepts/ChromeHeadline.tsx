"use client";

import { useRef, useEffect, Suspense } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Text, Float, Stars, Environment } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";

function HeadlineText() {
  const groupRef = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    if (groupRef.current) {
      groupRef.current.rotation.y = Math.sin(clock.getElapsedTime() * 0.1) * 0.08;
      groupRef.current.rotation.x = Math.sin(clock.getElapsedTime() * 0.07) * 0.03;
    }
  });

  return (
    <Float speed={0.8} rotationIntensity={0.05} floatIntensity={0.3}>
      <group ref={groupRef} position={[0, 0.3, 0]}>
        <Text
          font="/fonts/DMSans-Bold.woff"
          fontSize={1.2}
          maxWidth={10}
          textAlign="center"
          position={[0, 0.6, 0]}
          color="#ffffff"
        >
          Your network is your
          <meshStandardMaterial
            color="#ffffff"
            metalness={0.9}
            roughness={0.1}
            envMapIntensity={2}
          />
        </Text>
        <Text
          font="/fonts/InstrumentSerif-Italic.woff"
          fontSize={1.4}
          textAlign="center"
          position={[0, -0.8, 0]}
          color="#888899"
        >
          net worth
          <meshStandardMaterial
            color="#8888aa"
            metalness={0.95}
            roughness={0.05}
            envMapIntensity={2.5}
          />
        </Text>
      </group>
    </Float>
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
    smooth.current.x += (mouse.current.x * 0.5 - smooth.current.x) * 0.01;
    smooth.current.y += (mouse.current.y * 0.25 - smooth.current.y) * 0.01;
    camera.position.x = smooth.current.x;
    camera.position.y = smooth.current.y;
    camera.lookAt(0, 0, 0);
  });

  return null;
}

export default function ChromeHeadline() {
  return (
    <div className="absolute inset-0 w-full h-full">
      <Canvas
        camera={{ position: [0, 0, 6], fov: 45 }}
        dpr={[1, 1.5]}
        gl={{ antialias: true, alpha: true }}
        style={{ background: "transparent" }}
      >
        <CameraRig />
        <ambientLight intensity={0.2} />
        <directionalLight position={[5, 5, 5]} intensity={0.8} />
        <Stars radius={50} depth={30} count={1500} factor={3} fade speed={0.5} />
        <Suspense fallback={null}>
          <HeadlineText />
          <Environment preset="city" />
        </Suspense>
        <EffectComposer>
          <Bloom luminanceThreshold={0.7} intensity={0.3} radius={0.4} mipmapBlur />
          <Vignette eskil={false} offset={0.1} darkness={0.5} />
        </EffectComposer>
      </Canvas>
    </div>
  );
}

export function OrbitLogo({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Orbital ring */}
      <ellipse
        cx="16"
        cy="16"
        rx="13.5"
        ry="5.5"
        transform="rotate(-30 16 16)"
        stroke="url(#ring-gradient)"
        strokeWidth="1.2"
        fill="none"
      />
      {/* Core */}
      <circle cx="16" cy="16" r="3.5" fill="white" />
      {/* Orbiting node */}
      <circle cx="26.5" cy="10.5" r="2" fill="#3b82f6" />
      {/* Second small node */}
      <circle cx="6" cy="21" r="1.2" fill="#6366f1" opacity="0.6" />
      <defs>
        <linearGradient id="ring-gradient" x1="2" y1="16" x2="30" y2="16" gradientUnits="userSpaceOnUse">
          <stop stopColor="#3b82f6" stopOpacity="0.15" />
          <stop offset="0.4" stopColor="#3b82f6" stopOpacity="0.6" />
          <stop offset="0.7" stopColor="#6366f1" stopOpacity="0.5" />
          <stop offset="1" stopColor="#6366f1" stopOpacity="0.15" />
        </linearGradient>
      </defs>
    </svg>
  );
}

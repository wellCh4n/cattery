import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained `.next/standalone` tree so the Docker runtime stage
  // can ship a slim image without node_modules. Required by web/Dockerfile.
  output: "standalone",
};

export default nextConfig;

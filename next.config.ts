import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Docker image runs the self-contained server; `npm start` uses the normal build.
  output: process.env.BUILD_STANDALONE ? "standalone" : undefined,
  // Prompts are read from disk at runtime; make sure the standalone bundle carries them.
  outputFileTracingIncludes: {
    "/api/**/*": ["./prompts/**/*"],
  },
};

export default nextConfig;

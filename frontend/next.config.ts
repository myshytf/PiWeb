import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  output: "export",
  distDir: "out",
  images: {
    unoptimized: true,
  },
  turbopack: {
    root: process.cwd(),
  },
  // During development, proxy API and WS requests to the backend server.
  ...(isDev
    ? {
        async rewrites() {
          return [
            {
              source: "/api/:path*",
              destination: "http://localhost:9876/api/:path*",
            },
            {
              source: "/ws",
              destination: "http://localhost:9876/ws",
            },
          ];
        },
      }
    : {}),
};

export default nextConfig;

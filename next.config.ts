import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every API route talks to Nebius on each request; nothing may be statically cached.
  experimental: { proxyTimeout: 60_000 },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=()" },
        ],
      },
    ];
  },
};

export default nextConfig;

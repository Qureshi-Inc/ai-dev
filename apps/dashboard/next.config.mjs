/** @type {import('next').NextConfig} */
const backendUrl = process.env.AI_DEV_BACKEND_URL || "http://localhost:8088";

const nextConfig = {
  output: "standalone",
  basePath: "/dashboard",
  reactStrictMode: true,
  transpilePackages: ["@ai-dev/shared"],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${backendUrl}/api/:path*`,
        basePath: false,
      },
      {
        source: "/events/:path*",
        destination: `${backendUrl}/events/:path*`,
        basePath: false,
      },
      {
        source: "/healthz",
        destination: `${backendUrl}/healthz`,
        basePath: false,
      },
    ];
  },
};

export default nextConfig;

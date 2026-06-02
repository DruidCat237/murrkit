/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow next/image to load assets served by the local backend.
  images: {
    remotePatterns: [
      { protocol: "http", hostname: "localhost", port: "8000", pathname: "/**" },
      { protocol: "http", hostname: "127.0.0.1", port: "8000", pathname: "/**" },
    ],
  },
  // Hide Next.js's dev-only on-page indicators in the bottom-left corner
  // (route-type badge + "compiling…" spinner). Dev-server overlays only —
  // no effect on production builds.
  devIndicators: {
    appIsrStatus: false,
    buildActivity: false,
  },
};

export default nextConfig;

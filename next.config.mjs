/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Keep `next dev` isolated from `next build`. Sharing `.next` allows a
  // production build to invalidate a running development server's route
  // modules and can surface as short-lived API 500 responses.
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next"
};

export default nextConfig;

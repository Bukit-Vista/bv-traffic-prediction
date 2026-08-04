const basePath = "/asteria";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Keep `next dev` isolated from `next build`. Sharing `.next` allows a
  // production build to invalidate a running development server's route
  // modules and can surface as short-lived API 500 responses.
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  basePath,
  // `basePath` is applied automatically by Next.js navigation, but browser
  // fetches and third-party map sources need the deployment prefix explicitly.
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // The cockpit has no workspace dependencies, so tracing and file watching
  // stay inside this app instead of walking the whole monorepo.
  outputFileTracingRoot: import.meta.dirname,
  env: {
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000',
  },
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@recourse/receipts", "@recourse/sdk"],
  // Self-contained server for Docker (set NEXT_STANDALONE=1); Vercel does not need it.
  ...(process.env.NEXT_STANDALONE === "1" ? { output: "standalone" } : {}),
  reactStrictMode: true,
  // The browser verifier only needs @recourse/receipts' browser-safe entry.
  webpack: (config) => {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};

export default nextConfig;

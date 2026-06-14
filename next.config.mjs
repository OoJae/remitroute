/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // pino and pg are server-only; keep them out of the client bundle. thirdweb is
  // heavy and well-formed ESM, so keep it external. The Mento SDK must be bundled
  // by webpack (its esm build omits import extensions, which Node's external ESM
  // loader rejects but webpack resolves), so it is NOT in this list.
  serverExternalPackages: ["pino", "pg", "langfuse", "thirdweb"],
  // Serve the static brand/marketing pages (in public/site/) at clean routes,
  // and the ERC-8004 registration file at the well-known path. beforeFiles runs
  // ahead of filesystem + dynamic routes, so "/" maps to the landing page now
  // that the functional MiniPay app lives at "/app". The React routes "/app"
  // and "/dashboard" are NOT rewritten and keep working as real pages.
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/", destination: "/site/landing.html" },
        { source: "/how-it-works", destination: "/site/how-it-works.html" },
        { source: "/about", destination: "/site/about.html" },
        { source: "/docs", destination: "/site/docs.html" },
        { source: "/brand", destination: "/site/brand.html" },
        { source: "/minipay", destination: "/site/minipay.html" },
        { source: "/.well-known/agent.json", destination: "/api/well-known-agent" },
      ],
    };
  },
  // The shared modules and skill scripts use ESM-style .js extensions on
  // relative TypeScript imports (required by tsx and Node ESM). Tell webpack a
  // .js import may resolve to the .ts source so the app and scripts share code.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;

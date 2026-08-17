import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
      },
    ],
  },
  // The completed-form PDF generators (src/lib/completed-form-pdf*.ts)
  // read the official form templates from disk at runtime — ensure
  // Vercel's serverless function bundling includes them (they aren't
  // otherwise reachable by static import-tracing).
  outputFileTracingIncludes: {
    "/**": ["./templates/forms/**/*.pdf"],
  },
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // /r and /repair read the Windows 7 script from the repo at request time; make sure it is part of the serverless trace.
  outputFileTracingIncludes: {
    "/r": ["./agent/win7-repair/repair.bat"],
    "/repair": ["./agent/win7-repair/repair.bat"],
  },
};

export default nextConfig;

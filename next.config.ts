import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // /r, /repair and /s read the Windows 7 scripts from the repo at request time; make sure it is part of the serverless trace.
  outputFileTracingIncludes: {
    "/s": ["./agent/win7-speedup/speedup.bat"],
    "/r": ["./agent/win7-repair/repair.bat"],
    "/repair": ["./agent/win7-repair/repair.bat"],
  },
};

export default nextConfig;

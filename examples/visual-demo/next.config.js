/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Keep heavy Node deps out of the browser bundle
    serverComponentsExternalPackages: [
      '@0gfoundation/0g-ts-sdk',
      '@0glabs/0g-serving-broker',
      'ethers',
    ],
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Polyfill Node builtins that 0G SDK needs only on the server
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        crypto: false,
      };
    }
    return config;
  },
};

module.exports = nextConfig;

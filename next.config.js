/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    domains: ['places.googleapis.com'],
  },
  // Handle static files
  async rewrites() {
    return [
      {
        source: '/:path*.html',
        destination: '/:path*.html',
      },
      {
        source: '/api/chat',
        destination: '/api/chat/',
      }
    ]
  },
  async redirects() {
    return [
      {
        source: '/travel-rizz.html',
        destination: '/travel-form',
        permanent: true,
      },
    ]
  },
  webpack: (config) => {
    config.watchOptions = {
      poll: 1000,
      aggregateTimeout: 300,
      ignored: ['**/.git/**', '**/node_modules/**', '**/.next/**']
    };
    return config;
  },
  // Ensure static files are served correctly
  assetPrefix: process.env.NODE_ENV === 'production' ? '/' : '',
  trailingSlash: true,
}

module.exports = nextConfig
/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable strict mode for better development experience
  reactStrictMode: true,
  // `next dev` and `next build` must not mutate the same artifact directory.
  // Otherwise a production build can replace chunks beneath a running dev
  // server, leaving hard refreshes stuck on server-rendered loading markup.
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
};

export default nextConfig;
